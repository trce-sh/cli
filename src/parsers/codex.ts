import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  InvocationTokenSegment,
  LocalInvocation,
  LocalSession,
  Outcome,
  ParsedHarness,
  SessionTokenSegment,
  TokenCounts,
} from '../types.js'
import {
  arrayValue,
  asRecord,
  isoTimestamp,
  nonNegativeInteger,
  parseJsonLine,
  stringValue,
} from '../value.js'

export const codexParserVersion = 'codex-rollout@5'
const codexNormalizationVersion = 'codex-turn-usage@2'

type InvocationDraft = LocalInvocation & { turnId: string | null }

type TurnUsage = {
  counts: TokenCounts
  model: string
}

export function parseCodexRollout(text: string, fallbackSessionId: string): ParsedHarness {
  const reader = codexRolloutReader(fallbackSessionId)
  for (const line of text.split(/\r?\n/u)) reader.addLine(line)
  return reader.finish()
}

/**
 * Same result as `parseCodexRollout`, fed one line at a time so a rollout file never has to be
 * held in memory whole. Lines arrive without their line terminator.
 */
export async function parseCodexRolloutLines(
  lines: AsyncIterable<string> | Iterable<string>,
  fallbackSessionId: string,
): Promise<ParsedHarness> {
  const reader = codexRolloutReader(fallbackSessionId)
  for await (const line of lines) reader.addLine(line)
  return reader.finish()
}

function codexRolloutReader(fallbackSessionId: string) {
  let parseFailures = 0
  let unknownRecords = 0
  const builder = buildSession(fallbackSessionId, (count) => {
    unknownRecords += count
  })
  builder.next()
  return {
    addLine(line: string) {
      if (line.trim().length === 0) return
      const parsed = parseJsonLine(line)
      if (parsed.kind === 'invalid') {
        parseFailures += 1
        return
      }
      const record = asRecord(parsed.value)
      if (!record) {
        unknownRecords += 1
        return
      }
      builder.next(record)
    },
    finish(): ParsedHarness {
      const result = builder.next(null)
      const session = result.done ? result.value : null
      return {
        coverage: {
          harness: 'codex',
          parseFailures,
          sessionsParsed: session ? 1 : 0,
          sessionsScanned: 1,
          unknownRecords,
          version: codexParserVersion,
        },
        sessions: session ? [session] : [],
      }
    },
  }
}

function* buildSession(
  fallbackSessionId: string,
  addUnknown: (count: number) => void,
): Generator<void, LocalSession | null, Record<string, unknown> | null> {
  let recordCount = 0
  let nativeId = fallbackSessionId
  let nativeCwd: string | null = null
  let harnessVersion = 'unknown'
  let startedAt: string | null = null
  let endedAt: string | null = null
  let status: Outcome = 'unknown'
  let currentTurn: string | null = null
  let currentModel: string | null = null
  let modelFallback: string | null = null
  let recognizedRecords = 0
  const turnModels = new Map<string, string>()
  const catalog = new Map<string, string>()
  const skillRoots = new Map<string, string>()
  const invocations: InvocationDraft[] = []
  const turnUsage = new Map<string, TurnUsage>()
  const inferredSkills = new Set<string>()
  const manualMentions = new Set<string>()
  let previousCumulative: TokenCounts | null = null
  const cumulativeTurns = new Set<string>()

  function addInferredRead(
    argumentsText: string,
    turnId: string | null,
    model: string | null,
    timestamp: string | null,
    nativeSourceId: string | null,
  ) {
    for (const [name, path] of catalog) {
      const key = `${turnId ?? ''}\u0000${name}`
      if (!mentionsExactPath(argumentsText, path) || inferredSkills.has(key)) continue
      inferredSkills.add(key)
      invocations.push({
        confidence: 'inferred',
        harness: 'codex',
        model,
        nativeInvocationId:
          nativeSourceId ?? `${turnId ?? 'unknown'}:${timestamp ?? 'unknown'}:${name}`,
        nativeSkillPath: path,
        ordinal: invocations.length,
        outcome: 'unknown',
        skillName: name,
        timestamp,
        tokenScope: 'unavailable',
        tokenSegment: null,
        trigger: 'auto',
        turnId,
      })
    }
  }

  for (let record = yield; record !== null; record = yield) {
    recordCount += 1
    const timestamp = isoTimestamp(record.timestamp)
    if (timestamp) {
      startedAt = earlierTimestamp(startedAt, timestamp)
      endedAt = laterTimestamp(endedAt, timestamp)
    }
    const type = stringValue(record.type)
    const payload = asRecord(record.payload)

    if (type === 'session_meta') {
      recognizedRecords += 1
      nativeId = stringValue(payload?.id) ?? stringValue(payload?.session_id) ?? nativeId
      nativeCwd = stringValue(payload?.cwd) ?? nativeCwd
      harnessVersion = stringValue(payload?.cli_version) ?? harnessVersion
      continue
    }

    if (type === 'turn_context') {
      recognizedRecords += 1
      currentTurn = stringValue(payload?.turn_id)
      currentModel = stringValue(payload?.model)
      modelFallback = currentModel ?? modelFallback
      if (currentTurn && currentModel) turnModels.set(currentTurn, currentModel)
      nativeCwd = stringValue(payload?.cwd) ?? nativeCwd
      continue
    }

    if (type === 'response_item') {
      recognizedRecords += 1
      const role = stringValue(payload?.role)
      const itemType = stringValue(payload?.type)
      const text = responseText(payload)
      if (role === 'developer' && itemType === 'message' && text) {
        addCatalogEntries(catalog, skillRoots, text)
      }
      if (role === 'user' && itemType === 'message' && text) {
        addManualInvocations(
          invocations,
          text,
          currentTurn,
          currentModel,
          timestamp,
          catalog,
          stringValue(payload?.id) ?? stringValue(payload?.call_id) ?? currentTurn,
          manualMentions,
        )
      }
      if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        addInferredRead(
          skillReadArguments(payload),
          currentTurn,
          currentModel,
          timestamp,
          stringValue(payload?.call_id) ?? stringValue(payload?.id),
        )
      }
      continue
    }

    if (type === 'event_msg') {
      recognizedRecords += 1
      const eventType = stringValue(payload?.type)
      const turnId = stringValue(payload?.turn_id) ?? currentTurn
      if (eventType === 'item_completed') {
        const item = asRecord(payload?.item)
        const id = stringValue(item?.id)
        if (
          item?.type === 'CommandExecution' &&
          item.status === 'completed' &&
          item.exit_code === 0 &&
          id
        ) {
          // Code-mode input is JavaScript, not JSON arguments. Use native read evidence only;
          // neither executing that input nor interpreting stdout is needed to identify a skill.
          for (const value of arrayValue(item.parsed_cmd)) {
            const command = asRecord(value)
            const path = stringValue(command?.path)
            if (command?.type !== 'read' || !path) continue
            const normalizedPath = normalizedSkillPath(path)
            if (!mentionsExactPath(simpleReadCommand(command.cmd), normalizedPath)) continue
            const absolutePath = nativeReadPath(normalizedPath, stringValue(item.cwd))
            if (!absolutePath) continue
            addInferredRead(
              absolutePath,
              turnId,
              (turnId ? turnModels.get(turnId) : null) ?? currentModel,
              timestamp,
              id,
            )
          }
        }
      } else if (eventType === 'user_message') {
        const text = stringValue(payload?.message)
        if (text) {
          addManualInvocations(
            invocations,
            text,
            turnId,
            currentModel,
            timestamp,
            catalog,
            turnId,
            manualMentions,
          )
        }
      } else if (eventType === 'token_count') {
        const info = asRecord(payload?.info)
        const cumulative = codexUsage(asRecord(info?.total_token_usage))
        const last = codexUsage(asRecord(info?.last_token_usage))
        if (!turnId) {
          if (cumulative) previousCumulative = cumulative
          continue
        }
        if (cumulative) {
          // Cumulative counters advance only for new usage; rate-limit notifications replay them.
          const delta = subtractTokenCounts(cumulative, previousCumulative)
          previousCumulative = cumulative
          const current = cumulativeTurns.has(turnId) ? turnUsage.get(turnId) : null
          cumulativeTurns.add(turnId)
          turnUsage.set(turnId, {
            counts: current ? sumTokenCounts(current.counts, delta) : delta,
            model: turnModels.get(turnId) ?? currentModel ?? 'unknown',
          })
        } else if (last && !cumulativeTurns.has(turnId)) {
          // Older records without cumulative usage only prove the latest request snapshot.
          // Do not sum replayed snapshots as if they were additional requests.
          turnUsage.set(turnId, {
            counts: last,
            model: turnModels.get(turnId) ?? currentModel ?? 'unknown',
          })
        }
      } else if (eventType === 'task_complete') {
        status = 'success'
        const completedAt = epochTimestamp(payload?.completed_at)
        if (completedAt) endedAt = laterTimestamp(endedAt, completedAt)
      } else if (eventType === 'turn_aborted' || eventType === 'task_aborted') {
        status = 'aborted'
      } else if (eventType === 'stream_error' || eventType === 'task_failed') {
        status = 'failure'
      }
      continue
    }

    if (type === 'compacted') recognizedRecords += 1
  }

  const manualSkills = new Set(
    invocations
      .filter((invocation) => invocation.confidence === 'verified')
      .map((invocation) => `${invocation.turnId ?? ''}\u0000${invocation.skillName}`),
  )
  const deduped = invocations.filter(
    (invocation) =>
      invocation.confidence !== 'inferred' ||
      !manualSkills.has(`${invocation.turnId ?? ''}\u0000${invocation.skillName}`),
  )
  const countByTurn = new Map<string, number>()
  for (const invocation of deduped) {
    if (!invocation.turnId) continue
    countByTurn.set(invocation.turnId, (countByTurn.get(invocation.turnId) ?? 0) + 1)
  }
  for (const invocation of deduped) {
    if (!invocation.turnId || countByTurn.get(invocation.turnId) !== 1) continue
    const usage = turnUsage.get(invocation.turnId)
    if (!usage) continue
    invocation.tokenScope = 'turn'
    invocation.tokenSegment = usage.counts
    invocation.model = usage.model
  }

  addUnknown(Math.max(0, recordCount - recognizedRecords))
  if (recordCount === 0) return null
  return {
    catalogSkillPaths: [...catalog.values()].toSorted(),
    endedAt,
    harness: 'codex',
    harnessVersion,
    invocations: deduped.map(({ turnId: _turnId, ...invocation }) => invocation),
    modelFallback,
    nativeCwd,
    nativeId,
    parserVersion: codexParserVersion,
    repo: null,
    startedAt,
    status,
    tokenSegments: aggregateTurnUsage(turnUsage),
    ...(turnUsage.size
      ? {
          tokenEvidence: [...turnUsage].map(([id, usage]) => ({
            id,
            segment: {
              ...usage.counts,
              model: usage.model,
              normalizationVersion: codexNormalizationVersion,
            },
          })),
        }
      : {}),
  }
}

function addCatalogEntries(
  catalog: Map<string, string>,
  skillRoots: Map<string, string>,
  text: string,
) {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    const root = /^- `([^`]+)` = `([^`]+)`$/u.exec(trimmed)
    if (root?.[1] && root[2]) {
      skillRoots.set(root[1], normalizedSkillPath(root[2]))
      continue
    }
    if (!trimmed.startsWith('- ') || !trimmed.endsWith(')')) continue
    const fileMarker = ' (file: '
    const markerIndex = trimmed.lastIndexOf(fileMarker)
    if (markerIndex === -1) continue
    const advertisedPath = trimmed.slice(markerIndex + fileMarker.length, -1)
    if (!advertisedPath.endsWith('/SKILL.md')) continue
    const label = trimmed.slice(2, markerIndex)
    const delimiter = label.indexOf(': ')
    if (delimiter <= 0) continue
    const name = label.slice(0, delimiter).trim()
    if (name) catalog.set(name, resolvedSkillPath(advertisedPath, skillRoots))
  }
}

function resolvedSkillPath(path: string, skillRoots: ReadonlyMap<string, string>) {
  const separator = path.indexOf('/')
  if (separator <= 0) return normalizedSkillPath(path)
  const root = skillRoots.get(path.slice(0, separator))
  if (!root) return normalizedSkillPath(path)
  return `${root.replace(/\/$/u, '')}/${path.slice(separator + 1)}`
}

function normalizedSkillPath(path: string) {
  return path.replaceAll('\\', '/')
}

/** Resolve recorded paths only. Never use the CLI's cwd or evaluate shell input. */
function nativeReadPath(path: string, directory: string | null): string | null {
  if (posix.isAbsolute(path) || /^[A-Za-z]:\//u.test(path)) return path
  if (!directory) return null
  let cwd = normalizedSkillPath(directory)
  if (cwd.startsWith('file:')) {
    try {
      const url = new URL(cwd)
      if (url.search || url.hash) return null
      cwd = normalizedSkillPath(
        fileURLToPath(url, {
          windows: /^\/[A-Za-z]:\//u.test(url.pathname) || Boolean(url.hostname),
        }),
      )
    } catch {
      return null
    }
  }
  if (/^[A-Za-z]:\//u.test(cwd) || cwd.startsWith('//')) {
    return normalizedSkillPath(win32.resolve(cwd, path))
  }
  if (!posix.isAbsolute(cwd)) return null
  return posix.resolve(cwd, path)
}

function normalizedToolArguments(value: string) {
  return value.replaceAll('\\\\', '/').replaceAll('\\', '/')
}

function mentionsExactPath(text: string, path: string) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[\\s'"])${escaped}(?=$|[\\s'"])`, 'u').test(text)
}

/** Conservative read recognition. Mentioning a catalog path in arbitrary tool arguments is not a read. */
function skillReadArguments(payload: Record<string, unknown> | null) {
  if (!payload) return ''
  const parsed = parseJsonLine(toolArgumentsText(payload))
  const args = parsed.kind === 'parsed' ? asRecord(parsed.value) : null
  if (!args) return ''
  if (payload.name === 'read_file' || payload.name === 'Read') {
    return normalizedToolArguments(stringValue(args.path) ?? stringValue(args.file_path) ?? '')
  }
  if (!['exec_command', 'shell_command', 'shell'].includes(stringValue(payload.name) ?? ''))
    return ''
  return simpleReadCommand(stringValue(args.cmd) ?? stringValue(args.command))
}

function simpleReadCommand(value: unknown) {
  const command = stringValue(value) ?? ''
  if (
    !/^\s*(?:cat|sed|head|tail|bat|Get-Content)\s/u.test(command) ||
    /[;|&`\n]|\$\(/u.test(command)
  )
    return ''
  return normalizedToolArguments(command)
}

/**
 * Explicit `$skill-name` mentions in a user message. Only a name the session's own skill catalog
 * lists is evidence of a skill: `$HOME`, `$PATH`, `$1` and the like are shell text, and prompt
 * words must never become skill names. Codex persists one user turn both as an `event_msg`
 * and as a `response_item`, so a mention counts once per turn.
 */
function addManualInvocations(
  invocations: InvocationDraft[],
  text: string,
  turnId: string | null,
  model: string | null,
  timestamp: string | null,
  catalog: ReadonlyMap<string, string>,
  nativeSourceId: string | null,
  mentioned: Set<string>,
) {
  const names = [...text.matchAll(/(?:^|\s)\$([a-zA-Z0-9_.:-]+)/gu)]
    .map((match) => match[1])
    .filter((name): name is string => typeof name === 'string' && catalog.has(name))
  for (const [manualIndex, name] of names.entries()) {
    const mentionKey = `${turnId ?? ''}\u0000${name}`
    if (mentioned.has(mentionKey)) continue
    mentioned.add(mentionKey)
    invocations.push({
      confidence: 'verified',
      harness: 'codex',
      model,
      nativeInvocationId: nativeSourceId ? `${nativeSourceId}:manual:${manualIndex}:${name}` : null,
      nativeSkillPath: catalog.get(name) ?? null,
      ordinal: invocations.length,
      outcome: 'unknown',
      skillName: name,
      timestamp,
      tokenScope: 'unavailable',
      tokenSegment: null,
      trigger: 'manual',
      turnId,
    })
  }
}

function responseText(payload: Record<string, unknown> | null) {
  if (!payload) return null
  const chunks: string[] = []
  for (const item of arrayValue(payload.content)) {
    const content = asRecord(item)
    const text = stringValue(content?.text)
    if (text) chunks.push(text)
  }
  return chunks.length > 0 ? chunks.join('\n') : null
}

function toolArgumentsText(payload: Record<string, unknown> | null) {
  if (!payload) return ''
  const value = payload.arguments ?? payload.input
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function codexUsage(usage: Record<string, unknown> | null): InvocationTokenSegment | null {
  if (!usage) return null
  const input = nonNegativeInteger(usage.input_tokens)
  const cached = nonNegativeInteger(usage.cached_input_tokens)
  const output = nonNegativeInteger(usage.output_tokens)
  const reasoning = nonNegativeInteger(usage.reasoning_output_tokens)
  const total = nonNegativeInteger(usage.total_tokens)
  if (input === null && cached === null && output === null && reasoning === null && total === null)
    return null
  return {
    cacheWriteInputTokens: null,
    cachedInputTokens: cached,
    nativeTotalTokens: total,
    outputTokens: output,
    reasoningTokens: reasoning,
    uncachedInputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
  }
}

function aggregateTurnUsage(turnUsage: ReadonlyMap<string, TurnUsage>): SessionTokenSegment[] {
  const byModel = new Map<string, TokenCounts>()
  for (const usage of turnUsage.values()) {
    const current = byModel.get(usage.model)
    byModel.set(usage.model, current ? sumTokenCounts(current, usage.counts) : usage.counts)
  }
  return [...byModel].map(([model, counts]) => ({
    ...counts,
    model,
    normalizationVersion: codexNormalizationVersion,
  }))
}

function subtractTokenCounts(current: TokenCounts, previous: TokenCounts | null): TokenCounts {
  const delta = (value: number | null, before: number | null | undefined) =>
    value === null ? null : Math.max(0, value - (before ?? 0))
  return {
    cacheWriteInputTokens: delta(current.cacheWriteInputTokens, previous?.cacheWriteInputTokens),
    cachedInputTokens: delta(current.cachedInputTokens, previous?.cachedInputTokens),
    nativeTotalTokens: delta(current.nativeTotalTokens, previous?.nativeTotalTokens),
    outputTokens: delta(current.outputTokens, previous?.outputTokens),
    reasoningTokens: delta(current.reasoningTokens, previous?.reasoningTokens),
    uncachedInputTokens: delta(current.uncachedInputTokens, previous?.uncachedInputTokens),
  }
}

function sumTokenCounts(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    cacheWriteInputTokens: sumNullable(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    cachedInputTokens: sumNullable(left.cachedInputTokens, right.cachedInputTokens),
    nativeTotalTokens: sumNullable(left.nativeTotalTokens, right.nativeTotalTokens),
    outputTokens: sumNullable(left.outputTokens, right.outputTokens),
    reasoningTokens: sumNullable(left.reasoningTokens, right.reasoningTokens),
    uncachedInputTokens: sumNullable(left.uncachedInputTokens, right.uncachedInputTokens),
  }
}

function sumNullable(left: number | null, right: number | null) {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}

function epochTimestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const millis = value < 10_000_000_000 ? value * 1000 : value
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function earlierTimestamp(current: string | null, candidate: string) {
  return current === null || candidate < current ? candidate : current
}

function laterTimestamp(current: string | null, candidate: string) {
  return current === null || candidate > current ? candidate : current
}
