import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { parseCodexRollout, parseCodexRolloutLines } from './codex.js'

const fixture = await readFile(
  new URL('../../fixtures/parsers/codex-command-execution.jsonl', import.meta.url),
  'utf8',
)
const skillPath = '/fixture/home/.agents/skills/pr-review/SKILL.md'
const relativeFixture = await readFile(
  new URL('../../fixtures/parsers/codex-relative-command.jsonl', import.meta.url),
  'utf8',
)
const executionLine = fixture.split('\n').find((line) => line.includes('"item_completed"'))
if (!executionLine) throw new Error('Missing execution fixture record')

it('resolves a native relative read against the command working directory', async () => {
  const parsed = parseCodexRollout(relativeFixture, 'fallback')
  expect(parsed.sessions[0]?.invocations).toEqual([
    {
      confidence: 'inferred',
      harness: 'codex',
      model: 'gpt-fixture',
      nativeInvocationId: 'relative-exec',
      nativeSkillPath: '/fixture/repo/.agents/skills/pr-review/SKILL.md',
      ordinal: 0,
      outcome: 'unknown',
      skillName: 'pr-review',
      timestamp: '2026-09-11T10:00:04.000Z',
      tokenScope: 'unavailable',
      tokenSegment: null,
      trigger: 'auto',
    },
  ])
  expect(JSON.stringify(parsed)).not.toMatch(/MUST_NOT_LEAVE_MACHINE|exec_command|parsed_cmd/)
  await expect(parseCodexRolloutLines(relativeFixture.split('\n'), 'fallback')).resolves.toEqual(
    parsed,
  )
})

it.each([
  ['plain directory', '/fixture/repo', 1],
  ['different directory', 'file:///fixture/other', 0],
  ['relative directory', 'fixture/repo', 0],
  ['non-file URL', 'https://fixture/repo', 0],
  ['malformed file URL', 'file:///%zz', 0],
])('handles a %s for native relative reads', (_name, cwd, expected) => {
  const changed = relativeFixture.replace(
    '"cwd":"file:///fixture/repo"',
    JSON.stringify({ cwd }).slice(1, -1),
  )
  expect(parseCodexRollout(changed, 'fallback').sessions[0]?.invocations).toHaveLength(expected)
})

it('does not guess a missing command directory from a later turn', () => {
  const changed = relativeFixture.replace('"cwd":"file:///fixture/repo",', '')
  expect(parseCodexRollout(changed, 'fallback').sessions[0]?.invocations).toHaveLength(0)
})

it('resolves Windows file URLs on every host platform', () => {
  const changed = relativeFixture
    .replaceAll('/fixture/repo', 'C:/fixture/repo')
    .replace('file://C:/', 'file:///C:/')
  expect(parseCodexRollout(changed, 'fallback').sessions[0]?.invocations).toMatchObject([
    { nativeSkillPath: 'C:/fixture/repo/.agents/skills/pr-review/SKILL.md' },
  ])
})

it('infers a successful native command read without retaining code-mode input or output', async () => {
  const parsed = parseCodexRollout(fixture, 'fallback')
  expect(parsed.coverage).toEqual({
    harness: 'codex',
    parseFailures: 0,
    sessionsParsed: 1,
    sessionsScanned: 1,
    unknownRecords: 0,
    version: 'codex-rollout@5',
  })
  expect(parsed.sessions[0]?.invocations).toEqual([
    {
      confidence: 'inferred',
      harness: 'codex',
      model: 'gpt-fixture',
      nativeInvocationId: 'exec-fixture',
      nativeSkillPath: skillPath,
      ordinal: 0,
      outcome: 'unknown',
      skillName: 'pr-review',
      timestamp: '2026-08-20T10:00:04.000Z',
      tokenScope: 'turn',
      tokenSegment: {
        cacheWriteInputTokens: null,
        cachedInputTokens: 20,
        nativeTotalTokens: 110,
        outputTokens: 10,
        reasoningTokens: null,
        uncachedInputTokens: 80,
      },
      trigger: 'auto',
    },
  ])
  expect(JSON.stringify(parsed)).not.toMatch(/MUST_NOT_LEAVE_MACHINE|exec_command|parsed_cmd/)
  await expect(parseCodexRolloutLines(fixture.split('\n'), 'fallback')).resolves.toEqual(parsed)
})

it.each([
  ['failed read', '"exit_code":0', '"exit_code":1'],
  ['missing exit status', '"exit_code":0', '"exit_code":null'],
  ['string exit status', '"exit_code":0', '"exit_code":"0"'],
  ['unfinished command', '"status":"completed"', '"status":"in_progress"'],
  ['unrecognized item', '"type":"CommandExecution"', '"type":"AgentMessage"'],
  ['non-read command', '"type":"read"', '"type":"unknown"'],
  ['unadvertised path', `"path":"${skillPath}"`, '"path":"/fixture/other/SKILL.md"'],
  ['mere path mention', `"cmd":"cat ${skillPath}"`, `"cmd":"echo ${skillPath}"`],
  ['compound shell command', `"cmd":"cat ${skillPath}"`, `"cmd":"cat ${skillPath} && true"`],
  ['missing native id', '"id":"exec-fixture"', '"id":null'],
  ['malformed parsed command', '"parsed_cmd":[{', '"parsed_cmd":[null,{"ignored":true},{'],
])('handles %s conservatively', (_name, before, after) => {
  const changed = executionLine.replace(before, after)
  const parsed = parseCodexRollout(fixture.replace(executionLine, changed), 'fallback')
  expect(parsed.coverage.parseFailures).toBe(0)
  // Invalid entries do not discard a valid sibling read.
  expect(parsed.sessions[0]?.invocations).toHaveLength(_name === 'malformed parsed command' ? 1 : 0)
})

it('does not infer usage from code-mode source without a successful native read record', () => {
  expect(
    parseCodexRollout(fixture.replace(executionLine, ''), 'fallback').sessions[0]?.invocations,
  ).toEqual([])
})

it('deduplicates native replay and legacy read evidence in either order', () => {
  const legacy = JSON.stringify({
    payload: {
      arguments: JSON.stringify({ cmd: `cat ${skillPath}` }),
      call_id: 'legacy-read',
      name: 'exec_command',
      type: 'function_call',
    },
    type: 'response_item',
  })
  for (const records of [
    [executionLine, executionLine],
    [executionLine, legacy],
    [legacy, executionLine],
  ]) {
    const text = fixture.replace(executionLine, records.join('\n'))
    expect(parseCodexRollout(text, 'fallback').sessions[0]?.invocations).toHaveLength(1)
  }
})

it('keeps manual evidence when the same turn also reads the skill', () => {
  const manual = JSON.stringify({
    payload: { message: '$pr-review', turn_id: 'turn-1', type: 'user_message' },
    type: 'event_msg',
  })
  const parsed = parseCodexRollout(`${fixture}\n${manual}`, 'fallback')
  expect(parsed.sessions[0]?.invocations).toMatchObject([
    { confidence: 'verified', skillName: 'pr-review', trigger: 'manual' },
  ])
  expect(parsed.sessions[0]?.invocations).toHaveLength(1)
})

it('uses the event turn id even after the current turn advances', () => {
  const nextTurn = JSON.stringify({
    payload: { model: 'gpt-next', turn_id: 'turn-2' },
    type: 'turn_context',
  })
  const text = fixture.replace(executionLine, `${nextTurn}\n${executionLine}`)
  const nextRead = executionLine
    .replaceAll('turn-1', 'turn-2')
    .replaceAll('exec-fixture', 'exec-next')
  const parsed = parseCodexRollout(`${text}\n${nextRead}`, 'fallback')
  expect(parsed.sessions[0]?.invocations).toMatchObject([
    { model: 'gpt-fixture', nativeInvocationId: 'exec-fixture', tokenScope: 'turn' },
    { model: 'gpt-next', nativeInvocationId: 'exec-next', tokenScope: 'unavailable' },
  ])
  expect(parsed.sessions[0]?.invocations).toHaveLength(2)
})
