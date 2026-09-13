import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { driftGroups, duplicateCandidates } from './analysis.js'
import { scanInventory } from './inventory.js'
import { parseClaudeTranscript } from './parsers/claude.js'
import { parseCodexRollout } from './parsers/codex.js'
import { assertPayloadPrivacy, buildPushPayload, serializePushPayload } from './payload.js'
import type { LocalReport } from './types.js'

const fixtureDirectory = fileURLToPath(new URL('../fixtures/parsers/', import.meta.url))
const fixtureHome = fileURLToPath(new URL('../fixtures/home-synthetic/', import.meta.url))

describe('payload v1.2 scoped privacy boundary', () => {
  it.each(['codex-command-execution', 'codex-relative-command'])(
    'exports %s metadata without code-mode input, output, or local paths',
    async (fixture) => {
      const parsed = parseCodexRollout(
        await readFile(`${fixtureDirectory}/${fixture}.jsonl`, 'utf8'),
        'fallback',
      )
      const report: LocalReport = {
        drift: [],
        duplicateCandidates: [],
        generatedAt: '2026-09-11T11:05:00.000Z',
        historyRoots: [],
        parserCoverage: [parsed.coverage],
        sessions: parsed.sessions.map((session) => ({ ...session, repo: 'acme/app' })),
        skills: await scanInventory({ homeDirectory: fixtureHome }),
        window: { from: '2026-08-20T00:00:00.000Z', to: '2026-09-11T11:05:00.000Z' },
      }
      const payload = buildPushPayload(report, '0.2.0-development', {
        catalogRepositories: [],
        repositories: ['acme/app'],
        version: 'team-repositories@1',
      })
      expect(payload.invocations).toHaveLength(1)
      expect(payload.invocations[0]).toMatchObject({
        confidence: 'inferred',
        parserVersion: 'codex-rollout@5',
        skillName: 'pr-review',
      })
      const serialized = serializePushPayload(payload)
      expect(() => assertPayloadPrivacy(serialized)).not.toThrow()
      expect(serialized).not.toMatch(
        /MUST_NOT_LEAVE_MACHINE|exec_command|parsed_cmd|exec-fixture|relative-exec|codex-command-fixture|codex-relative-fixture|\/fixture\//,
      )
    },
  )

  it('keeps local source data out and counts one session total for multiple invocations', async () => {
    const [claudeText, codexText, skills] = await Promise.all([
      readFile(`${fixtureDirectory}/claude-session.jsonl`, 'utf8'),
      readFile(`${fixtureDirectory}/codex-session.jsonl`, 'utf8'),
      scanInventory({ homeDirectory: fixtureHome }),
    ])
    const claude = parseClaudeTranscript(claudeText, 'claude-fallback')
    const codex = parseCodexRollout(codexText, 'codex-fallback')
    const privateTemplate = skills[0]
    const privateSession = claude.sessions[0]
    const privateInvocation = privateSession?.invocations[0]
    if (!privateTemplate || !privateSession || !privateInvocation) {
      throw new Error('Fixture is incomplete')
    }
    const aliasedSkill = skills.find(
      (skill) => skill.harness === privateSession.harness && skill.name === 'pr-review',
    )
    if (!aliasedSkill) throw new Error('Aliased skill fixture is incomplete')
    const privateSkill = {
      ...privateTemplate,
      description: 'private-skill-description-must-stay-local',
      fingerprint: '8'.repeat(64),
      name: 'private-never-used',
      skillMdFingerprint: '9'.repeat(64),
    }
    const report: LocalReport = {
      drift: driftGroups(skills),
      duplicateCandidates: duplicateCandidates(skills),
      generatedAt: '2026-08-20T11:05:00.000Z',
      historyRoots: [],
      parserCoverage: [claude.coverage, codex.coverage],
      sessions: [
        ...[...claude.sessions, ...codex.sessions].map((session, sessionIndex) => ({
          ...session,
          invocations: session.invocations.map((invocation, invocationIndex) =>
            sessionIndex === 0 && invocationIndex === 0
              ? {
                  ...invocation,
                  nativeSkillPath: aliasedSkill.directory,
                  skillName: 'review:pr-review',
                }
              : invocation,
          ),
          repo: 'acme/app',
        })),
        {
          ...privateSession,
          invocations: [
            {
              ...privateInvocation,
              confidence: 'verified' as const,
              nativeSkillPath: null,
              skillName: privateSkill.name,
            },
          ],
          nativeId: 'private-session',
          repo: 'personal/secret-project',
        },
      ],
      skills: [...skills, privateSkill],
      window: {
        from: '2026-07-21T11:05:00.000Z',
        to: '2026-08-20T11:05:00.000Z',
      },
    }

    const payload = buildPushPayload(
      report,
      '0.1.0',
      {
        catalogRepositories: ['acme/catalog'],
        repositories: ['acme/app', 'acme/catalog'],
        version: 'team-repositories@1',
      },
      [
        {
          fingerprint: '7'.repeat(64),
          harnesses: ['codex'],
          id: '6'.repeat(64),
          kind: 'installed',
          name: 'catalog-install',
          occurredAt: '2026-08-20T11:04:00.000Z',
          previousFingerprint: null,
          sourceRepo: 'acme/catalog',
        },
        {
          fingerprint: '5'.repeat(64),
          harnesses: ['codex'],
          id: '4'.repeat(64),
          kind: 'installed',
          name: 'out-of-scope-catalog-install',
          occurredAt: '2026-08-20T11:04:00.000Z',
          previousFingerprint: null,
          sourceRepo: 'personal/catalog',
        },
      ],
    )
    const shiftedReport = structuredClone(report)
    const shiftedInvocation = shiftedReport.sessions[0]?.invocations[0]
    if (!shiftedInvocation) throw new Error('Shifted invocation fixture is incomplete')
    shiftedInvocation.ordinal = 99
    for (const skill of shiftedReport.skills) skill.fingerprint = '7'.repeat(64)
    const shiftedPayload = buildPushPayload(shiftedReport, '0.1.0', {
      catalogRepositories: ['acme/catalog'],
      repositories: ['acme/app', 'acme/catalog'],
      version: 'team-repositories@1',
    })
    const serialized = serializePushPayload(payload)

    expect(() => assertPayloadPrivacy(serialized)).not.toThrow()
    expect(payload.version).toBe('1.2')
    expect(payload.sessions).toHaveLength(2)
    expect(payload.invocations).toHaveLength(3)
    expect(payload.distributionEvents).toEqual([
      expect.objectContaining({ name: 'catalog-install', sourceRepo: 'acme/catalog' }),
    ])
    expect(payload.invocations.every((invocation) => invocation.confidence !== 'unknown')).toBe(
      true,
    )
    expect(payload.invocations.some((invocation) => invocation.skillName === 'pr-review')).toBe(
      true,
    )
    expect(shiftedPayload.invocations[0]?.id).toBe(payload.invocations[0]?.id)
    expect(serialized).not.toContain('review:pr-review')
    expect(payload.sessions.find((session) => session.harness === 'codex')?.tokenSegments).toEqual([
      expect.objectContaining({ nativeTotalTokens: 1620 }),
    ])
    expect(
      payload.invocations.filter((invocation) => invocation.sessionId === payload.sessions[1]?.id),
    ).toHaveLength(2)
    expect(serialized).toContain('Reviews pull requests for correctness')
    for (const privateValue of [
      '/fixture/',
      'redacted before parsing output',
      'Please review this change.',
      'Sanitized result.',
      'Legacy instructions without frontmatter.',
      'no-frontmatter',
      'outside.txt',
      'private-never-used',
      'private-skill-description-must-stay-local',
      'personal/secret-project',
      'out-of-scope-catalog-install',
      'personal/catalog',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('rejects an unapproved field even when TypeScript is bypassed', () => {
    expect(() => assertPayloadPrivacy('{"version":"1.2","localPath":"/private/value"}')).toThrow(
      'Privacy boundary rejected payload key: localPath',
    )
    expect(() => assertPayloadPrivacy('{"version":"1.2","description":"/private/value"}')).toThrow(
      'Privacy boundary rejected a path-like value',
    )
    expect(() =>
      assertPayloadPrivacy('{"version":"1.2","description":"\\\\Users\\\\alice\\\\secret"}'),
    ).toThrow('Privacy boundary rejected a path-like value')
    // A path anywhere inside a description is refused, not only at the start of the string.
    for (const description of [
      'Reads notes from /Users/alice/notes before answering',
      'Cache lives in /home/dev/.cache',
      'See ~/.claude/skills/review for the template',
      'Windows copy at C:\\\\Users\\\\dev\\\\skills',
    ]) {
      expect(() => assertPayloadPrivacy(JSON.stringify({ description, version: '1.2' }))).toThrow(
        'Privacy boundary rejected a path-like value',
      )
    }
    expect(() =>
      assertPayloadPrivacy(
        '{"version":"1.2","description":"Reviews pull requests for /api routes"}',
      ),
    ).not.toThrow()
    expect(() => assertPayloadPrivacy('{"version":"1.2","secret":"redacted"}')).toThrow(
      'Privacy boundary rejected payload key: secret',
    )
  })
})

describe('looksLikeLocalPath', () => {
  it('rejects home-relative and machine paths but not a bare tilde', async () => {
    const { looksLikeLocalPath } = await import('./privacy-boundary.js')
    expect(looksLikeLocalPath('see ~/notes for details')).toBe(true)
    expect(looksLikeLocalPath('copied from /Users/dev/skills')).toBe(true)
    expect(looksLikeLocalPath('lives in C:\\skills\\review')).toBe(true)
    expect(looksLikeLocalPath('takes about ~5 minutes')).toBe(false)
    expect(looksLikeLocalPath('a plain description')).toBe(false)
  })
})
