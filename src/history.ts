import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { type AgentHomes, agentHomes, codingAgentList } from './coding-agents.js'
import { compareCodePoints } from './hash.js'
import { isIgnoredDirectoryName } from './inventory.js'
import { claudeParserVersion, parseClaudeTranscriptLines } from './parsers/claude.js'
import { codexParserVersion, parseCodexRolloutLines } from './parsers/codex.js'
import type {
  HarnessName,
  HistoryRoot,
  LocalInvocation,
  LocalSession,
  ParsedHarness,
  ParserCoverage,
  SessionTokenSegment,
} from './types.js'

const execFileAsync = promisify(execFile)

type ScanHistoryOptions = {
  claudeProjectsDirectory?: string
  codexSessionsDirectory?: string
  /** Environment used to locate relocated agent homes. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  from: string
  historyDirectories?: Partial<Record<HarnessName, string>>
  homeDirectory: string
  /** Called after each session file is considered, so a spinner can show the scan moving. */
  onProgress?: (progress: HistoryScanProgress) => void
  repositorySlugForCwd?: (cwd: string) => Promise<string | null>
}

export type HistoryScanProgress = {
  /** Session files considered so far under this harness root, skipped ones included. */
  filesRead: number
  filesTotal: number
  harness: HarnessName
}

/**
 * Parser coverage plus what the scan itself could not do: session files it was not allowed to
 * read. Output should name that count next to the parser summary so a report that looks empty
 * because of permissions does not pass for an empty machine.
 */
export type HistoryParserCoverage = ParserCoverage & {
  unreadableFiles: number
}

type HistoryAdapter = {
  defaultDirectory: (homes: AgentHomes) => string
  harness: HarnessName
  parseLines: (lines: AsyncIterable<string>, fallbackId: string) => Promise<ParsedHarness>
  version: string
}

const historyAdapters: Partial<Record<HarnessName, HistoryAdapter>> = {
  'claude-code': {
    defaultDirectory: (homes) => join(homes.claude, 'projects'),
    harness: 'claude-code',
    parseLines: parseClaudeTranscriptLines,
    version: claudeParserVersion,
  },
  codex: {
    defaultDirectory: (homes) => join(homes.codex, 'sessions'),
    harness: 'codex',
    parseLines: parseCodexRolloutLines,
    version: codexParserVersion,
  },
}

export async function scanHistory(options: ScanHistoryOptions) {
  const resolveRepository = options.repositorySlugForCwd ?? repositorySlug
  const homes = agentHomes(options.env ?? process.env, options.homeDirectory)
  const legacyDirectories: Partial<Record<HarnessName, string>> = {
    ...(options.claudeProjectsDirectory ? { 'claude-code': options.claudeProjectsDirectory } : {}),
    ...(options.codexSessionsDirectory ? { codex: options.codexSessionsDirectory } : {}),
  }
  const parsedHarnesses = await Promise.all(
    codingAgentList.flatMap((agent) => {
      if (agent.usageEvidence === 'unavailable') return []
      const adapter = historyAdapters[agent.id]
      if (!adapter) throw new Error(`Missing history adapter for ${agent.id}`)
      const root =
        options.historyDirectories?.[adapter.harness] ??
        legacyDirectories[adapter.harness] ??
        adapter.defaultDirectory(homes)
      return scanFiles(root, options.from, adapter, options.onProgress)
    }),
  )
  const sessions = parsedHarnesses.flatMap((parsed) => parsed.sessions)
  const roots: HistoryRoot[] = parsedHarnesses.map((parsed) => ({
    directory: parsed.root,
    files: parsed.files,
    harness: parsed.coverage.harness,
    sessions: parsed.coverage.sessionsParsed,
    unreadableFiles: parsed.coverage.unreadableFiles,
  }))
  const repoCache = new Map<string, string | null>()
  for (const session of sessions) {
    if (!session.nativeCwd) continue
    let repo = repoCache.get(session.nativeCwd)
    if (repo === undefined) {
      repo = await resolveRepository(session.nativeCwd)
      repoCache.set(session.nativeCwd, repo)
    }
    session.repo = repo
  }
  return {
    parserCoverage: parsedHarnesses.map((parsed) => parsed.coverage),
    roots,
    sessions: sessions.toSorted((left, right) =>
      compareCodePoints(
        `${left.startedAt ?? ''}:${left.harness}:${left.nativeId}`,
        `${right.startedAt ?? ''}:${right.harness}:${right.nativeId}`,
      ),
    ),
  }
}

type ScannedHarness = {
  coverage: HistoryParserCoverage
  files: number
  root: string
  sessions: LocalSession[]
}

async function scanFiles(
  root: string,
  from: string,
  adapter: HistoryAdapter,
  onProgress?: (progress: HistoryScanProgress) => void,
): Promise<ScannedHarness> {
  const files = await jsonlFiles(root)
  const windowStart = Date.parse(from)
  const parsed: ParsedHarness[] = []
  let unreadableFiles = 0
  let filesRead = 0
  const progress = () => {
    filesRead += 1
    onProgress?.({ filesRead, filesTotal: files.length, harness: adapter.harness })
  }
  onProgress?.({ filesRead, filesTotal: files.length, harness: adapter.harness })
  for (const file of files) {
    let result: ParsedHarness | null
    try {
      // A file cannot hold a record newer than its own modification time, so anything last
      // written before the window opened is skipped without being opened.
      const stats = await stat(file)
      if (Number.isFinite(windowStart) && stats.mtimeMs < windowStart) continue
      result = await parseFile(file, adapter)
    } catch {
      unreadableFiles += 1
      continue
    } finally {
      progress()
    }
    const session = result.sessions[0]
    if (!session || sessionIsInWindow(session, from)) parsed.push(result)
  }
  return { ...mergeParsedHarness(adapter, parsed, unreadableFiles), files: files.length, root }
}

/** Streams one session file through the adapter a line at a time. */
async function parseFile(file: string, adapter: HistoryAdapter) {
  const fallbackId = basename(file, extname(file))
  const handle = await open(file, 'r')
  try {
    const stream = handle.createReadStream({ encoding: 'utf8' })
    const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream })
    try {
      return await adapter.parseLines(lines, fallbackId)
    } finally {
      lines.close()
      stream.destroy()
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function mergeParsedHarness(
  adapter: HistoryAdapter,
  parsed: readonly ParsedHarness[],
  unreadableFiles: number,
) {
  const sessions = mergeNativeSessions(parsed.flatMap((item) => item.sessions))
  const coverage: HistoryParserCoverage = {
    harness: adapter.harness,
    parseFailures: sum(parsed, 'parseFailures'),
    sessionsParsed: sessions.length,
    sessionsScanned: parsed.length,
    unknownRecords: sum(parsed, 'unknownRecords'),
    unreadableFiles,
    version: adapter.version,
  }
  return { coverage, sessions }
}

export function mergeNativeSessions(sessions: readonly LocalSession[]) {
  const grouped = new Map<string, LocalSession>()
  for (const session of sessions) {
    const key = `${session.harness}\u0000${session.nativeId}`
    const current = grouped.get(key)
    if (!current) {
      grouped.set(key, {
        ...session,
        catalogSkillPaths: [...session.catalogSkillPaths],
        invocations: [...session.invocations],
        tokenSegments: [...session.tokenSegments],
      })
      continue
    }
    grouped.set(key, mergeSession(current, session))
  }
  return [...grouped.values()]
}

function mergeSession(left: LocalSession, right: LocalSession): LocalSession {
  const evidence =
    left.tokenEvidence && right.tokenEvidence
      ? mergeTokenEvidence(left.tokenEvidence, right.tokenEvidence)
      : null
  return {
    ...left,
    catalogSkillPaths: [...new Set([...left.catalogSkillPaths, ...right.catalogSkillPaths])],
    endedAt: laterTimestamp(left.endedAt, right.endedAt),
    harnessVersion: right.harnessVersion === 'unknown' ? left.harnessVersion : right.harnessVersion,
    invocations: mergeInvocations(left.invocations, right.invocations),
    modelFallback: right.modelFallback ?? left.modelFallback,
    nativeCwd: left.nativeCwd ?? right.nativeCwd,
    startedAt: earlierTimestamp(left.startedAt, right.startedAt),
    status: mergedStatus(left.status, right.status),
    tokenSegments: evidence
      ? mergeTokenSegments(
          [],
          evidence.map((entry) => entry.segment),
        )
      : mergeTokenSegments(left.tokenSegments, right.tokenSegments),
    ...(evidence ? { tokenEvidence: evidence } : {}),
  }
}

function mergeTokenEvidence(
  left: NonNullable<LocalSession['tokenEvidence']>,
  right: NonNullable<LocalSession['tokenEvidence']>,
) {
  const entries = new Map<string, (typeof left)[number]>()
  for (const entry of [...left, ...right]) {
    const key = `${entry.id}\u0000${entry.segment.model}\u0000${entry.segment.normalizationVersion}`
    const existing = entries.get(key)
    const total = (segment: SessionTokenSegment) =>
      segment.nativeTotalTokens ??
      (segment.uncachedInputTokens ?? 0) +
        (segment.cachedInputTokens ?? 0) +
        (segment.cacheWriteInputTokens ?? 0) +
        (segment.outputTokens ?? 0)
    if (!existing || total(entry.segment) > total(existing.segment)) entries.set(key, entry)
  }
  return [...entries.values()]
}

function mergeInvocations(left: readonly LocalInvocation[], right: readonly LocalInvocation[]) {
  const unique = new Map<string, LocalInvocation>()
  for (const invocation of [...left, ...right]) {
    const key = JSON.stringify([
      invocation.harness,
      invocation.nativeInvocationId ?? `${invocation.timestamp ?? ''}:${invocation.ordinal}`,
      invocation.skillName,
    ])
    const previous = unique.get(key)
    unique.set(
      key,
      previous
        ? {
            ...invocation,
            nativeSkillPath: invocation.nativeSkillPath ?? previous.nativeSkillPath,
            outcome: invocation.outcome === 'unknown' ? previous.outcome : invocation.outcome,
            tokenSegment: invocation.tokenSegment ?? previous.tokenSegment,
            tokenScope:
              invocation.tokenScope === 'unavailable' ? previous.tokenScope : invocation.tokenScope,
          }
        : invocation,
    )
  }
  return [...unique.values()]
    .toSorted((a, b) =>
      compareCodePoints(
        `${a.timestamp ?? ''}:${a.skillName}:${a.ordinal}`,
        `${b.timestamp ?? ''}:${b.skillName}:${b.ordinal}`,
      ),
    )
    .map((invocation, ordinal) => ({ ...invocation, ordinal }))
}

function mergeTokenSegments(
  left: readonly SessionTokenSegment[],
  right: readonly SessionTokenSegment[],
) {
  const grouped = new Map<string, SessionTokenSegment>()
  for (const segment of [...left, ...right]) {
    const key = `${segment.model}\u0000${segment.normalizationVersion}`
    const current = grouped.get(key)
    grouped.set(key, current ? sumTokenSegments(current, segment) : { ...segment })
  }
  return [...grouped.values()]
}

function sumTokenSegments(
  left: SessionTokenSegment,
  right: SessionTokenSegment,
): SessionTokenSegment {
  return {
    cacheWriteInputTokens: sumNullable(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    cachedInputTokens: sumNullable(left.cachedInputTokens, right.cachedInputTokens),
    model: left.model,
    nativeTotalTokens: sumNullable(left.nativeTotalTokens, right.nativeTotalTokens),
    normalizationVersion: left.normalizationVersion,
    outputTokens: sumNullable(left.outputTokens, right.outputTokens),
    reasoningTokens: sumNullable(left.reasoningTokens, right.reasoningTokens),
    uncachedInputTokens: sumNullable(left.uncachedInputTokens, right.uncachedInputTokens),
  }
}

function sumNullable(left: number | null, right: number | null) {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}

function earlierTimestamp(left: string | null, right: string | null) {
  if (left === null) return right
  if (right === null) return left
  return left < right ? left : right
}

function laterTimestamp(left: string | null, right: string | null) {
  if (left === null) return right
  if (right === null) return left
  return left > right ? left : right
}

function mergedStatus(left: LocalSession['status'], right: LocalSession['status']) {
  const statuses = new Set([left, right])
  if (statuses.has('failure')) return 'failure'
  if (statuses.has('aborted')) return 'aborted'
  if (statuses.has('success')) return 'success'
  return 'unknown'
}

function sum(parsed: readonly ParsedHarness[], field: keyof ParserCoverage) {
  return parsed.reduce((total, item) => {
    const value = item.coverage[field]
    return total + (typeof value === 'number' ? value : 0)
  }, 0)
}

function sessionIsInWindow(session: LocalSession, from: string) {
  const timestamp = session.endedAt ?? session.startedAt
  return timestamp === null || timestamp >= from
}

/**
 * Every `.jsonl` under the root. Symlinked directories are followed once each by real path, so
 * a project directory linked into the session tree is scanned and a link cycle ends.
 */
async function jsonlFiles(root: string) {
  const files: string[] = []
  const visited = new Set<string>()
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    const canonical = await realpathOrNull(current)
    if (!canonical || visited.has(canonical)) continue
    visited.add(canonical)
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!isIgnoredDirectoryName(entry.name)) queue.push(candidate)
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.jsonl')) files.push(candidate)
      } else if (entry.isSymbolicLink()) {
        const target = await statOrNull(candidate)
        if (target?.isDirectory()) {
          if (!isIgnoredDirectoryName(entry.name)) queue.push(candidate)
        } else if (target?.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(candidate)
        }
      }
    }
  }
  return files.toSorted(compareCodePoints)
}

async function realpathOrNull(path: string) {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

async function statOrNull(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

export async function repositorySlug(cwd: string) {
  try {
    if (!(await stat(cwd)).isDirectory()) return null
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'config', '--get', 'remote.origin.url'],
      {
        encoding: 'utf8',
        timeout: 2000,
      },
    )
    return normalizeRepositorySlug(stdout.trim())
  } catch {
    return null
  }
}

export function normalizeRepositorySlug(remote: string) {
  let path: string
  try {
    const url = new URL(remote)
    if (
      url.hostname.toLowerCase() !== 'github.com' ||
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      url.port
    )
      return null
    path = url.pathname
  } catch {
    const scpStyle = /^git@github\.com:([^\s]+)$/iu.exec(remote)
    if (!scpStyle?.[1]) return null
    path = scpStyle[1]
  }
  const slug = path.replace(/^\//u, '').replace(/\.git$/u, '')
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/u.test(slug) &&
    !['.', '..'].includes(slug.split('/')[1] ?? '')
    ? slug.toLowerCase()
    : null
}
