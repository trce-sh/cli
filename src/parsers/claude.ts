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
  booleanValue,
  isoTimestamp,
  nonNegativeInteger,
  parseJsonLine,
  stringValue,
} from '../value.js'

export const claudeParserVersion = 'claude-jsonl@2'
const claudeNormalizationVersion = 'claude-usage@1'

type InvocationDraft = LocalInvocation & {
  assistantUuid: string | null
  toolUseId: string | null
}

export function parseClaudeTranscript(text: string, fallbackSessionId: string): ParsedHarness {
  const reader = claudeTranscriptReader(fallbackSessionId)
  for (const line of text.split(/\r?\n/u)) reader.addLine(line)
  return reader.finish()
}

/**
 * Same result as `parseClaudeTranscript`, fed one line at a time so a session file never has
 * to be held in memory whole. Lines arrive without their line terminator.
 */
export async function parseClaudeTranscriptLines(
  lines: AsyncIterable<string> | Iterable<string>,
  fallbackSessionId: string,
): Promise<ParsedHarness> {
  const reader = claudeTranscriptReader(fallbackSessionId)
  for await (const line of lines) reader.addLine(line)
  return reader.finish()
}

function claudeTranscriptReader(fallbackSessionId: string) {
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
          harness: 'claude-code',
          parseFailures,
          sessionsParsed: session ? 1 : 0,
          sessionsScanned: 1,
          unknownRecords,
          version: claudeParserVersion,
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
  let modelFallback: string | null = null
  const parentByUuid = new Map<string, string | null>()
  const invocations: InvocationDraft[] = []
  const toolOutcomes = new Map<string, Outcome>()
  const associations: {
    parent: string | null
    outcome: Outcome | null
    nested: boolean
    path: string | null
  }[] = []
  const tokensByModel = new Map<string, TokenCounts>()
  const tokenEvidence: NonNullable<LocalSession['tokenEvidence']> = []
  const seenMessageIds = new Set<string>()
  let recognizedRecords = 0

  for (let record = yield; record !== null; record = yield) {
    recordCount += 1
    const type = stringValue(record.type)
    const uuid = stringValue(record.uuid)
    if (uuid) parentByUuid.set(uuid, stringValue(record.parentUuid))
    nativeId = stringValue(record.sessionId) ?? nativeId
    nativeCwd = stringValue(record.cwd) ?? nativeCwd
    harnessVersion = stringValue(record.version) ?? harnessVersion
    const timestamp = isoTimestamp(record.timestamp)
    if (timestamp) {
      startedAt = earlierTimestamp(startedAt, timestamp)
      endedAt = laterTimestamp(endedAt, timestamp)
    }

    if (type === 'assistant') {
      recognizedRecords += 1
      const message = asRecord(record.message)
      if (!message) continue
      const model = stringValue(message.model)
      modelFallback = model ?? modelFallback
      const usage = tokenCounts(asRecord(message.usage))
      const messageId = stringValue(message.id) ?? uuid
      if (usage && messageId && !seenMessageIds.has(messageId)) {
        seenMessageIds.add(messageId)
        tokenEvidence.push({
          id: messageId,
          segment: {
            ...usage,
            model: model ?? 'unknown',
            normalizationVersion: claudeNormalizationVersion,
          },
        })
        addTokenCounts(tokensByModel, model ?? 'unknown', usage)
      }
      for (const part of arrayValue(message.content)) {
        const content = asRecord(part)
        if (content?.type !== 'tool_use' || content.name !== 'Skill') continue
        const input = asRecord(content.input)
        const skillName = stringValue(input?.skill)
        if (!skillName) continue
        invocations.push({
          assistantUuid: uuid,
          confidence: 'verified',
          harness: 'claude-code',
          model,
          nativeInvocationId: stringValue(content.id) ?? uuid,
          nativeSkillPath: null,
          ordinal: invocations.length,
          outcome: 'unknown',
          skillName,
          timestamp,
          tokenScope: usage ? 'assistant_record' : 'unavailable',
          tokenSegment: usage,
          toolUseId: stringValue(content.id),
          trigger: 'auto',
        })
      }
      continue
    }

    if (type === 'user') {
      recognizedRecords += 1
      const message = asRecord(record.message)
      const content = message?.content
      for (const part of arrayValue(content)) {
        const toolResult = asRecord(part)
        if (toolResult?.type !== 'tool_result') continue
        const id = stringValue(toolResult.tool_use_id)
        const isError = booleanValue(toolResult.is_error)
        if (id && isError !== null) toolOutcomes.set(id, isError ? 'failure' : 'success')
      }
      const result = asRecord(record.toolUseResult)
      const text = record.isMeta === true ? firstText(content) : null
      const path = text
        ? (/^Base directory for this skill:\s*(.+)$/mu.exec(text)?.[1]?.trim() ?? null)
        : null
      if (result || path)
        associations.push({
          parent: stringValue(record.parentUuid),
          outcome: result ? resultOutcome(result) : null,
          nested: result?.status === 'forked' || result?.background === true,
          path,
        })
      for (const [manualIndex, name] of manualSkillNames(content).entries()) {
        invocations.push({
          assistantUuid: null,
          confidence: 'verified',
          harness: 'claude-code',
          model: modelFallback,
          nativeInvocationId: uuid ? `${uuid}:manual:${manualIndex}:${name}` : null,
          nativeSkillPath: null,
          ordinal: invocations.length,
          outcome: 'unknown',
          skillName: name,
          timestamp,
          tokenScope: 'unavailable',
          tokenSegment: null,
          toolUseId: null,
          trigger: 'manual',
        })
      }
      continue
    }

    if (type === 'result') {
      recognizedRecords += 1
      status = booleanValue(record.is_error) === true ? 'failure' : 'success'
      continue
    }
    if (
      type === 'queue-operation' ||
      type === 'attachment' ||
      type === 'system' ||
      type === 'progress'
    ) {
      recognizedRecords += 1
    }
  }

  for (const association of associations) {
    const invocation = findInvocationForParent(invocations, association.parent, parentByUuid)
    if (!invocation) continue
    if (association.outcome !== null) invocation.outcome = association.outcome
    if (association.nested) invocation.trigger = 'nested'
    if (association.path) invocation.nativeSkillPath = association.path
  }
  for (const invocation of invocations) {
    const outcome = invocation.toolUseId ? toolOutcomes.get(invocation.toolUseId) : undefined
    if (outcome) invocation.outcome = outcome
  }

  addUnknown(Math.max(0, recordCount - recognizedRecords))
  if (recordCount === 0) return null
  return {
    catalogSkillPaths: [],
    endedAt,
    harness: 'claude-code',
    harnessVersion,
    invocations: invocations.map(
      ({ assistantUuid: _assistantUuid, toolUseId: _toolUseId, ...invocation }) => invocation,
    ),
    modelFallback,
    nativeCwd,
    nativeId,
    parserVersion: claudeParserVersion,
    repo: null,
    startedAt,
    status,
    tokenSegments: sessionTokenSegments(tokensByModel),
    ...(tokenEvidence.length ? { tokenEvidence } : {}),
  }
}

function tokenCounts(usage: Record<string, unknown> | null): InvocationTokenSegment | null {
  if (!usage) return null
  const uncachedInputTokens = nonNegativeInteger(usage.input_tokens)
  const cachedInputTokens = nonNegativeInteger(usage.cache_read_input_tokens)
  const cacheWriteInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens)
  const outputTokens = nonNegativeInteger(usage.output_tokens)
  const nativeTotalTokens = nonNegativeInteger(usage.total_tokens)
  if (
    uncachedInputTokens === null &&
    cachedInputTokens === null &&
    cacheWriteInputTokens === null &&
    outputTokens === null &&
    nativeTotalTokens === null
  ) {
    return null
  }
  return {
    cacheWriteInputTokens,
    cachedInputTokens,
    nativeTotalTokens,
    outputTokens,
    reasoningTokens: null,
    uncachedInputTokens,
  }
}

function addTokenCounts(target: Map<string, TokenCounts>, model: string, counts: TokenCounts) {
  const current = target.get(model)
  target.set(model, current ? sumTokenCounts(current, counts) : counts)
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

function sessionTokenSegments(
  tokensByModel: ReadonlyMap<string, TokenCounts>,
): SessionTokenSegment[] {
  return [...tokensByModel].map(([model, counts]) => ({
    ...counts,
    model,
    normalizationVersion: claudeNormalizationVersion,
  }))
}

function manualSkillNames(content: unknown) {
  const text = typeof content === 'string' ? content : firstText(content)
  if (!text) return []
  return [...text.matchAll(/<command-name>\/([^<\s]+)<\/command-name>/gu)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name))
}

function firstText(content: unknown) {
  for (const item of arrayValue(content)) {
    const record = asRecord(item)
    const text = stringValue(record?.text)
    if (text) return text
  }
  return typeof content === 'string' ? content : null
}

function findInvocationForParent(
  invocations: readonly InvocationDraft[],
  initialParent: string | null,
  parentByUuid: ReadonlyMap<string, string | null>,
) {
  let parent = initialParent
  for (let depth = 0; parent && depth < 20; depth += 1) {
    const invocation = invocations.findLast((candidate) => candidate.assistantUuid === parent)
    if (invocation) return invocation
    parent = parentByUuid.get(parent) ?? null
  }
  return null
}

function resultOutcome(result: Record<string, unknown>): Outcome {
  if (result.success === true) return 'success'
  if (result.success === false) return 'failure'
  if (result.status === 'aborted' || result.status === 'cancelled') return 'aborted'
  if (result.status === 'forked') return 'unknown'
  return 'unknown'
}

function earlierTimestamp(current: string | null, candidate: string) {
  return current === null || candidate < current ? candidate : current
}

function laterTimestamp(current: string | null, candidate: string) {
  return current === null || candidate > current ? candidate : current
}
