import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mergeNativeSessions } from '../history.js'
import { parseClaudeTranscript, parseClaudeTranscriptLines } from './claude.js'
import { parseCodexRollout, parseCodexRolloutLines } from './codex.js'

const fixtureDirectory = fileURLToPath(new URL('../../fixtures/parsers/', import.meta.url))

/** The same line source `scanHistory` uses: readline over a byte stream, CRLF folded. */
function streamedLines(text: string) {
  return createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: Readable.from([Buffer.from(text, 'utf8')]),
  })
}

describe('Claude parser', () => {
  it('matches native tool errors to the exact skill call without retaining result text', async () => {
    const text = await readFile(`${fixtureDirectory}/claude-tool-errors.jsonl`, 'utf8')
    const parsed = parseClaudeTranscript(text, 'fallback')
    expect(
      parsed.sessions[0]?.invocations.map(({ nativeInvocationId, outcome, skillName }) => ({
        nativeInvocationId,
        outcome,
        skillName,
      })),
    ).toEqual([
      { nativeInvocationId: 'failed-skill', outcome: 'failure', skillName: 'missing-fixture' },
      { nativeInvocationId: 'good-skill', outcome: 'success', skillName: 'review-fixture' },
    ])
    expect(parsed.sessions[0]?.status).toBe('success')
    expect(JSON.stringify(parsed)).not.toMatch(/MUST_NOT_LEAVE_MACHINE|unrelated-tool/)
    await expect(parseClaudeTranscriptLines(streamedLines(text), 'fallback')).resolves.toEqual(
      parsed,
    )
  })
  it('attributes verified automatic and manual use without double-counting repeated usage', async () => {
    const text = await readFile(`${fixtureDirectory}/claude-session.jsonl`, 'utf8')
    const parsed = parseClaudeTranscript(text, 'fallback')

    expect(parsed.coverage).toEqual({
      harness: 'claude-code',
      parseFailures: 1,
      sessionsParsed: 1,
      sessionsScanned: 1,
      unknownRecords: 1,
      version: 'claude-jsonl@2',
    })
    expect(parsed.sessions[0]?.invocations).toMatchObject([
      {
        confidence: 'verified',
        nativeInvocationId: 'tool-1',
        nativeSkillPath: '/fixture/home/.claude/skills/pr-review',
        outcome: 'success',
        skillName: 'pr-review',
        tokenScope: 'assistant_record',
        trigger: 'auto',
      },
      {
        confidence: 'verified',
        skillName: 'release-notes',
        tokenScope: 'unavailable',
        trigger: 'manual',
      },
    ])
    expect(parsed.sessions[0]?.tokenSegments).toEqual([
      {
        cacheWriteInputTokens: 20,
        cachedInputTokens: 30,
        model: 'claude-fixture',
        nativeTotalTokens: null,
        normalizationVersion: 'claude-usage@1',
        outputTokens: 10,
        reasoningTokens: null,
        uncachedInputTokens: 100,
      },
    ])
    const session = parsed.sessions[0]
    if (!session) throw new Error('Missing fixture session')
    expect(mergeNativeSessions([session, structuredClone(session)])[0]?.tokenSegments).toEqual(
      session.tokenSegments,
    )
    const partial = parseClaudeTranscript(text.split('\n').slice(0, 2).join('\n'), 'fallback')
      .sessions[0]
    if (!partial) throw new Error('Missing partial fixture session')
    const merged = mergeNativeSessions([partial, session])[0]
    expect(merged?.invocations).toHaveLength(2)
    expect(merged?.tokenSegments).toEqual(session.tokenSegments)
  })

  it('produces the same result and counters when fed line by line', async () => {
    const text = await readFile(`${fixtureDirectory}/claude-session.jsonl`, 'utf8')
    const truncated = `${text.trimEnd()}\n{"type":"assistant","message":{"model":"claude-fix`
    const crlf = truncated.replaceAll('\n', '\r\n')

    await expect(parseClaudeTranscriptLines(streamedLines(text), 'fallback')).resolves.toEqual(
      parseClaudeTranscript(text, 'fallback'),
    )
    await expect(parseClaudeTranscriptLines(streamedLines(truncated), 'fallback')).resolves.toEqual(
      parseClaudeTranscript(truncated, 'fallback'),
    )
    await expect(parseClaudeTranscriptLines(streamedLines(crlf), 'fallback')).resolves.toEqual(
      parseClaudeTranscript(truncated, 'fallback'),
    )
    expect(parseClaudeTranscript(truncated, 'fallback').coverage.parseFailures).toBe(2)
  })
})

describe('Codex parser', () => {
  it('uses cumulative usage, ignores replay, and recognizes reads separately in each turn', async () => {
    const text = await readFile(`${fixtureDirectory}/codex-cumulative.jsonl`, 'utf8')
    const parsed = parseCodexRollout(text, 'fallback')
    const session = parsed.sessions[0]
    if (!session) throw new Error('Missing fixture session')
    expect(
      session.invocations.map(({ confidence, nativeInvocationId, tokenSegment }) => ({
        confidence,
        nativeInvocationId,
        total: tokenSegment?.nativeTotalTokens ?? null,
      })),
    ).toEqual([
      { confidence: 'inferred', nativeInvocationId: 'read-1', total: 330 },
      { confidence: 'inferred', nativeInvocationId: 'read-2', total: 110 },
      { confidence: 'verified', nativeInvocationId: 'turn-3:manual:0:pr-review', total: null },
    ])
    expect(session.tokenSegments).toEqual([
      {
        cacheWriteInputTokens: null,
        cachedInputTokens: 90,
        model: 'gpt-fixture',
        nativeTotalTokens: 440,
        normalizationVersion: 'codex-turn-usage@2',
        outputTokens: 40,
        reasoningTokens: null,
        uncachedInputTokens: 310,
      },
    ])
    expect(mergeNativeSessions([session, structuredClone(session)])[0]?.tokenSegments).toEqual(
      session.tokenSegments,
    )
    await expect(parseCodexRolloutLines(streamedLines(text), 'fallback')).resolves.toEqual(parsed)
  })
  it('keeps inferred reads distinct from explicit manual use and sums per-turn usage once', async () => {
    const text = await readFile(`${fixtureDirectory}/codex-session.jsonl`, 'utf8')
    const parsed = parseCodexRollout(text, 'fallback')

    expect(parsed.coverage).toEqual({
      harness: 'codex',
      parseFailures: 1,
      sessionsParsed: 1,
      sessionsScanned: 1,
      unknownRecords: 1,
      version: 'codex-rollout@5',
    })
    expect(parsed.sessions[0]?.status).toBe('success')
    expect(parsed.sessions[0]?.invocations).toMatchObject([
      {
        confidence: 'inferred',
        nativeInvocationId: 'turn-1:2026-08-20T11:00:03.000Z:pr-review',
        nativeSkillPath: '/fixture/home/.agents/skills/pr-review/SKILL.md',
        skillName: 'pr-review',
        tokenScope: 'turn',
        trigger: 'auto',
      },
      {
        confidence: 'verified',
        skillName: 'release-notes',
        tokenScope: 'turn',
        trigger: 'manual',
      },
    ])
    // The same user turn is persisted as an event_msg and as a response_item, mentions the skill
    // twice, and carries shell variables: one verified call, and no skill named HOME, PATH, or 1.
    expect(parsed.sessions[0]?.invocations).toHaveLength(2)
    expect(parsed.sessions[0]?.invocations.map((invocation) => invocation.skillName)).toEqual([
      'pr-review',
      'release-notes',
    ])
    expect(parsed.sessions[0]?.tokenSegments).toEqual([
      {
        cacheWriteInputTokens: null,
        cachedInputTokens: 700,
        model: 'gpt-fixture',
        nativeTotalTokens: 1620,
        normalizationVersion: 'codex-turn-usage@2',
        outputTokens: 120,
        reasoningTokens: 20,
        uncachedInputTokens: 800,
      },
    ])
  })

  it('produces the same result and counters when fed line by line', async () => {
    const text = await readFile(`${fixtureDirectory}/codex-session.jsonl`, 'utf8')
    const truncated = `${text.trimEnd()}\n{"type":"event_msg","payload":{"type":"task_comp`
    const crlf = truncated.replaceAll('\n', '\r\n')

    await expect(parseCodexRolloutLines(streamedLines(text), 'fallback')).resolves.toEqual(
      parseCodexRollout(text, 'fallback'),
    )
    await expect(parseCodexRolloutLines(streamedLines(truncated), 'fallback')).resolves.toEqual(
      parseCodexRollout(truncated, 'fallback'),
    )
    await expect(parseCodexRolloutLines(streamedLines(crlf), 'fallback')).resolves.toEqual(
      parseCodexRollout(truncated, 'fallback'),
    )
    expect(parseCodexRollout(truncated, 'fallback').coverage.parseFailures).toBe(2)
  })

  it('ignores an out-of-range epoch instead of aborting the session scan', async () => {
    const text = await readFile(`${fixtureDirectory}/codex-out-of-range-timestamp.jsonl`, 'utf8')

    expect(parseCodexRollout(text, 'fallback')).toEqual({
      coverage: {
        harness: 'codex',
        parseFailures: 0,
        sessionsParsed: 1,
        sessionsScanned: 1,
        unknownRecords: 0,
        version: 'codex-rollout@5',
      },
      sessions: [
        {
          catalogSkillPaths: [],
          endedAt: '2026-08-20T12:00:00.000Z',
          harness: 'codex',
          harnessVersion: '0.142.5',
          invocations: [],
          modelFallback: null,
          nativeCwd: '/fixture/repo',
          nativeId: 'codex-invalid-time',
          parserVersion: 'codex-rollout@5',
          repo: null,
          startedAt: '2026-08-20T12:00:00.000Z',
          status: 'success',
          tokenSegments: [],
        },
      ],
    })
  })
})
