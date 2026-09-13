import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { mergeNativeSessions, normalizeRepositorySlug, scanHistory } from './history.js'
import { parseClaudeTranscript } from './parsers/claude.js'
import type { LocalSession } from './types.js'

const fixtureDirectory = fileURLToPath(new URL('../fixtures/parsers/', import.meta.url))
const claudeFixture = join(fixtureDirectory, 'claude-session.jsonl')
const codexFixture = join(fixtureDirectory, 'codex-session.jsonl')
/** The fixture sessions ran on 2026-08-20; this window holds them. */
const from = '2026-08-01T00:00:00.000Z'
const noEnv: NodeJS.ProcessEnv = {}
const noRepository = async () => null
/** File permissions do not stop root, and Windows has no mode bits to drop. */
const canDropReadPermission = process.platform !== 'win32' && process.getuid?.() !== 0

const temporaryDirectories: string[] = []

describe('GitHub reporting identity', () => {
  it.each([
    'https://github.com/Acme/App.git',
    'git@github.com:Acme/App.git',
    'ssh://git@github.com/Acme/App.git',
  ])('recognizes %s', (remote) => {
    expect(normalizeRepositorySlug(remote)).toBe('acme/app')
  })
  it.each([
    'https://gitlab.com/acme/app.git',
    'git@gitlab.com:acme/app.git',
    '/tmp/acme/app',
    'acme/app',
    'file:///tmp/acme/app',
    'https://github.com.evil.example/acme/app',
    'https://github.com/nested/acme/app',
    'https://github.com/acme/app?private=1',
    'https://github.com:444/acme/app',
  ])('does not confuse %s with GitHub', (remote) => {
    expect(normalizeRepositorySlug(remote)).toBeNull()
  })
})

async function temporaryHome(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function copySession(fixture: string, target: string) {
  await mkdir(join(target, '..'), { recursive: true })
  await copyFile(fixture, target)
  return target
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

function session(input: {
  endedAt: string
  name: string
  startedAt: string
  tokens: number
}): LocalSession {
  return {
    catalogSkillPaths: [],
    endedAt: input.endedAt,
    harness: 'claude-code',
    harnessVersion: '2.1.240',
    invocations: [
      {
        confidence: 'verified',
        harness: 'claude-code',
        model: 'claude-fixture',
        nativeSkillPath: null,
        ordinal: 0,
        outcome: 'success',
        skillName: input.name,
        timestamp: input.startedAt,
        tokenScope: 'assistant_record',
        tokenSegment: {
          cacheWriteInputTokens: null,
          cachedInputTokens: null,
          nativeTotalTokens: null,
          outputTokens: input.tokens,
          reasoningTokens: null,
          uncachedInputTokens: input.tokens,
        },
        trigger: 'auto',
      },
    ],
    modelFallback: 'claude-fixture',
    nativeCwd: '/fixture/repo',
    nativeId: 'shared-native-session',
    parserVersion: 'claude-jsonl@1',
    repo: 'acme/app',
    startedAt: input.startedAt,
    status: 'success',
    tokenSegments: [
      {
        cacheWriteInputTokens: null,
        cachedInputTokens: null,
        model: 'claude-fixture',
        nativeTotalTokens: null,
        normalizationVersion: 'claude-usage@1',
        outputTokens: input.tokens,
        reasoningTokens: null,
        uncachedInputTokens: input.tokens,
      },
    ],
  }
}

describe('native session merging', () => {
  it('combines Claude main and subagent transcripts into one session total', () => {
    const merged = mergeNativeSessions([
      session({
        endedAt: '2026-08-20T10:00:02.000Z',
        name: 'pr-review',
        startedAt: '2026-08-20T10:00:00.000Z',
        tokens: 10,
      }),
      session({
        endedAt: '2026-08-20T10:00:05.000Z',
        name: 'test-triage',
        startedAt: '2026-08-20T10:00:03.000Z',
        tokens: 20,
      }),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      endedAt: '2026-08-20T10:00:05.000Z',
      invocations: [
        { ordinal: 0, skillName: 'pr-review' },
        { ordinal: 1, skillName: 'test-triage' },
      ],
      startedAt: '2026-08-20T10:00:00.000Z',
      tokenSegments: [
        {
          outputTokens: 30,
          uncachedInputTokens: 30,
        },
      ],
    })
  })

  it('does not merge sessions from different coding agents', () => {
    const claude = session({
      endedAt: '2026-08-20T10:00:02.000Z',
      name: 'pr-review',
      startedAt: '2026-08-20T10:00:00.000Z',
      tokens: 10,
    })
    const codex: LocalSession = {
      ...claude,
      harness: 'codex',
      invocations: claude.invocations.map((invocation) => ({
        ...invocation,
        harness: 'codex',
      })),
      parserVersion: 'codex-rollout@1',
    }

    expect(mergeNativeSessions([claude, codex])).toHaveLength(2)
  })
})

describe('session history scan', () => {
  it('streams session files with the same coverage as the whole-text parser', async () => {
    const home = await temporaryHome('trce-history-stream-')
    await copySession(claudeFixture, join(home, '.claude', 'projects', '-fixture', 'one.jsonl'))
    await copySession(codexFixture, join(home, '.codex', 'sessions', '2026', 'rollout.jsonl'))
    const wholeText = parseClaudeTranscript(await readFile(claudeFixture, 'utf8'), 'one')

    const history = await scanHistory({
      env: noEnv,
      from,
      homeDirectory: home,
      repositorySlugForCwd: noRepository,
    })

    expect(history.parserCoverage).toEqual([
      { ...wholeText.coverage, unreadableFiles: 0 },
      expect.objectContaining({ harness: 'codex', sessionsParsed: 1, unreadableFiles: 0 }),
    ])
    expect(history.sessions.map((item) => item.harness)).toEqual(['claude-code', 'codex'])
    expect(history.sessions[0]).toEqual({ ...wholeText.sessions[0], repo: null })
  })

  it('reads relocated Claude Code and Codex homes from the environment', async () => {
    const home = await temporaryHome('trce-history-relocated-')
    const claudeHome = join(home, 'elsewhere', 'claude')
    const codexHome = join(home, 'elsewhere', 'codex')
    await copySession(claudeFixture, join(claudeHome, 'projects', '-fixture', 'one.jsonl'))
    await copySession(codexFixture, join(codexHome, 'sessions', '2026', 'rollout.jsonl'))
    const options = { from, homeDirectory: home, repositorySlugForCwd: noRepository }

    const relocated = await scanHistory({
      ...options,
      env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
    })
    const standard = await scanHistory({ ...options, env: noEnv })

    expect(relocated.roots.map((root) => [root.directory, root.files, root.sessions])).toEqual([
      [join(claudeHome, 'projects'), 1, 1],
      [join(codexHome, 'sessions'), 1, 1],
    ])
    expect(standard.roots.map((root) => [root.directory, root.files, root.sessions])).toEqual([
      [join(home, '.claude', 'projects'), 0, 0],
      [join(home, '.codex', 'sessions'), 0, 0],
    ])
  })

  it('skips files last modified before the window without opening them', async () => {
    const home = await temporaryHome('trce-history-mtime-')
    const stale = await copySession(
      claudeFixture,
      join(home, '.claude', 'projects', '-fixture', 'stale.jsonl'),
    )
    const before = new Date('2026-07-01T00:00:00.000Z')
    await utimes(stale, before, before)
    if (canDropReadPermission) await chmod(stale, 0o000)

    const history = await scanHistory({
      env: noEnv,
      from,
      homeDirectory: home,
      repositorySlugForCwd: noRepository,
    })

    expect(history.roots[0]).toMatchObject({ files: 1, harness: 'claude-code', sessions: 0 })
    expect(history.parserCoverage[0]).toMatchObject({
      parseFailures: 0,
      sessionsScanned: 0,
      unreadableFiles: 0,
    })
  })

  it('follows symlinked session directories once and survives link cycles', async () => {
    const home = await temporaryHome('trce-history-symlink-')
    const projects = join(home, '.claude', 'projects')
    const elsewhere = join(home, 'elsewhere', 'project')
    await copySession(claudeFixture, join(elsewhere, 'one.jsonl'))
    await mkdir(projects, { recursive: true })
    await symlink(elsewhere, join(projects, 'linked'))
    await symlink(elsewhere, join(elsewhere, 'self'))
    await symlink(projects, join(elsewhere, 'up'))

    const history = await scanHistory({
      env: noEnv,
      from,
      homeDirectory: home,
      repositorySlugForCwd: noRepository,
    })

    expect(history.roots[0]).toMatchObject({ files: 1, sessions: 1 })
    expect(history.sessions).toHaveLength(1)
  })

  it('ignores .git, node_modules, and dot directories under a session root', async () => {
    const home = await temporaryHome('trce-history-ignored-')
    const projects = join(home, '.claude', 'projects')
    await copySession(claudeFixture, join(projects, 'node_modules', 'one.jsonl'))
    await copySession(claudeFixture, join(projects, '.hidden', 'one.jsonl'))
    await copySession(claudeFixture, join(projects, '-fixture', '.git', 'one.jsonl'))
    await copySession(claudeFixture, join(projects, '-fixture', 'kept.jsonl'))

    const history = await scanHistory({
      env: noEnv,
      from,
      homeDirectory: home,
      repositorySlugForCwd: noRepository,
    })

    expect(history.roots[0]).toMatchObject({ files: 1, sessions: 1 })
  })

  it.skipIf(!canDropReadPermission)('counts session files it may not read', async () => {
    const home = await temporaryHome('trce-history-unreadable-')
    const projects = join(home, '.claude', 'projects', '-fixture')
    const secret = await copySession(claudeFixture, join(projects, 'secret.jsonl'))
    await copySession(claudeFixture, join(projects, 'open.jsonl'))
    await chmod(secret, 0o000)

    const history = await scanHistory({
      env: noEnv,
      from,
      homeDirectory: home,
      repositorySlugForCwd: noRepository,
    })

    expect(history.roots[0]).toMatchObject({ files: 2, sessions: 1 })
    expect(history.parserCoverage[0]).toMatchObject({ sessionsScanned: 1, unreadableFiles: 1 })
  })
})
