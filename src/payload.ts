import { dirname, resolve } from 'node:path'
import { duplicateCandidates } from './analysis.js'
import { codingAgentIds, codingAgents } from './coding-agents.js'
import { opaqueId } from './hash.js'
import type { DistributionEvent } from './installs.js'
import { looksLikeLocalPath } from './privacy-boundary.js'
import type {
  CapabilityBadge,
  Confidence,
  HarnessName,
  LocalReport,
  LocalSession,
  LocalSkill,
  Outcome,
  SessionTokenSegment,
  SkillSource,
  TeamScope,
  TriggerMode,
} from './types.js'

type Distribution = 'dependency' | 'project' | 'team_catalog'
type ScopedSession = LocalSession & { repo: string }

type ScopedParserCoverage = {
  harness: HarnessName
  includedSessions: number
  version: string
}

export type PushPayload = {
  batch: {
    cliVersion: string
    generatedAt: string
    id: string
    parsers: ScopedParserCoverage[]
    scope: {
      repositories: string[]
      version: TeamScope['version']
    }
    window: { from: string; to: string }
  }
  duplicateCandidates: Array<{
    leftFingerprint: string
    leftSkillName: string
    method: 'word-5-shingle-jaccard'
    methodVersion: '1'
    rightFingerprint: string
    rightSkillName: string
    similarity: number
  }>
  distributionEvents: DistributionEvent[]
  inventorySnapshots: InventorySnapshotPayload[]
  invocations: InvocationPayload[]
  sessions: SessionPayload[]
  version: '1.2'
}

type InventorySnapshotPayload = {
  capturedAt: string
  harness: HarnessName
  harnessVersion: string
  id: string
  skills: Array<{
    badges: CapabilityBadge[]
    definitionTokens: number
    description?: string
    descriptionTokens: number
    distribution: Distribution
    exposure: {
      evidence: 'observed_catalog' | 'harness_rule' | 'unknown'
      ruleVersion: string | null
    }
    fingerprint: string
    name: string
    repo: string | null
    sourceRepo: string | null
    skillMdFingerprint: string
    source: SkillSource
    tokenEstimator: { name: 'unicode-chars-div-4'; version: '1' }
  }>
}

type SessionPayload = {
  endedAt: string | null
  harness: HarnessName
  harnessVersion: string
  id: string
  inventoryAssociation: 'captured_at_session_end' | 'nearest' | 'unknown'
  inventorySnapshotId: string | null
  repo: string
  startedAt: string | null
  status: Outcome
  tokenSegments: SessionTokenSegment[]
}

type InvocationPayload = {
  confidence: Confidence
  harness: HarnessName
  id: string
  model: string | null
  ordinal: number
  outcome: Outcome
  parserVersion: string
  sessionId: string
  skillFingerprint: string
  skillName: string
  timestamp: string | null
  tokenScope: 'assistant_record' | 'turn' | 'unavailable'
  tokenSegment: LocalSession['invocations'][number]['tokenSegment']
  trigger: TriggerMode
}

export function buildPushPayload(
  report: LocalReport,
  cliVersion: string,
  scope: TeamScope,
  pendingDistributionEvents: readonly DistributionEvent[] = [],
): PushPayload {
  const repositories = [...new Set(scope.repositories)].toSorted()
  const activeRepositories = new Set(repositories)
  const catalogRepositories = new Set(scope.catalogRepositories)
  const distributionEvents = pendingDistributionEvents.filter((event) =>
    catalogRepositories.has(event.sourceRepo),
  )
  const scopedSessions = report.sessions.filter(
    (session): session is ScopedSession =>
      session.repo !== null && activeRepositories.has(session.repo),
  )
  const scopedSkills = skillsForScope({
    catalogRepositories,
    report,
    repositories: activeRepositories,
    sessions: scopedSessions,
  })
  const inventorySnapshots = buildInventorySnapshots(
    scopedSkills,
    scopedSessions,
    report.generatedAt,
  )
  const snapshotByHarness = new Map(
    inventorySnapshots.map((snapshot) => [snapshot.harness, snapshot]),
  )
  const sessions = scopedSessions.map((session) =>
    sessionPayload(session, snapshotByHarness, report.generatedAt),
  )
  const sessionIdByNativeKey = new Map(
    scopedSessions.map((session, index) => [
      nativeSessionKey(session, index),
      sessions[index]?.id ?? '',
    ]),
  )
  const invocations = scopedSessions.flatMap((session, sessionIndex) =>
    session.invocations.flatMap((invocation) => {
      if (invocation.confidence === 'unknown') return []
      const skill = matchSkill(
        scopedSkills,
        session,
        invocation.skillName,
        invocation.nativeSkillPath,
      )
      if (!skill) return []
      const skillFingerprint = skill.fingerprint
      const sessionId = sessionIdByNativeKey.get(nativeSessionKey(session, sessionIndex)) ?? ''
      return [
        {
          confidence: invocation.confidence,
          harness: invocation.harness,
          id: opaqueId(
            'invocation@2',
            sessionId,
            invocation.skillName,
            invocation.nativeInvocationId ??
              `${invocation.timestamp ?? 'unknown'}:${invocation.ordinal}`,
          ),
          model: invocation.model,
          ordinal: invocation.ordinal,
          outcome: invocation.outcome,
          parserVersion: session.parserVersion,
          sessionId,
          skillFingerprint,
          skillName: skill.name,
          timestamp: invocation.timestamp,
          tokenScope: invocation.tokenScope,
          tokenSegment: invocation.tokenSegment,
          trigger: invocation.trigger,
        } satisfies InvocationPayload,
      ]
    }),
  )
  const candidates = duplicateCandidates(scopedSkills).map((candidate) => ({
    leftFingerprint: candidate.left.fingerprint,
    leftSkillName: candidate.left.name,
    method: candidate.method,
    methodVersion: candidate.methodVersion,
    rightFingerprint: candidate.right.fingerprint,
    rightSkillName: candidate.right.name,
    similarity: roundSimilarity(candidate.similarity),
  }))
  const batchWithoutId = {
    cliVersion,
    generatedAt: report.generatedAt,
    parsers: report.parserCoverage.map((parser) => ({
      harness: parser.harness,
      includedSessions: scopedSessions.filter((session) => session.harness === parser.harness)
        .length,
      version: parser.version,
    })),
    scope: { repositories, version: scope.version },
    window: report.window,
  }
  const id = opaqueId(
    'batch',
    JSON.stringify(batchWithoutId),
    JSON.stringify(inventorySnapshots),
    JSON.stringify(sessions),
    JSON.stringify(invocations),
    JSON.stringify(candidates),
    JSON.stringify(distributionEvents),
  )
  return {
    batch: { ...batchWithoutId, id },
    duplicateCandidates: candidates,
    distributionEvents,
    inventorySnapshots,
    invocations,
    sessions,
    version: '1.2',
  }
}

export function buildLocalReportExport(report: LocalReport) {
  return {
    duplicateCandidates: report.duplicateCandidates.map((candidate) => ({
      leftFingerprint: candidate.left.fingerprint,
      leftSkillName: candidate.left.name,
      rightFingerprint: candidate.right.fingerprint,
      rightSkillName: candidate.right.name,
      similarity: roundSimilarity(candidate.similarity),
    })),
    generatedAt: report.generatedAt,
    parserCoverage: report.parserCoverage,
    sessions: report.sessions.map((session, index) => ({
      endedAt: session.endedAt,
      harness: session.harness,
      harnessVersion: session.harnessVersion,
      id: opaqueId('local-session', session.harness, session.nativeId, String(index)),
      invocations: session.invocations.map((invocation) => ({
        confidence: invocation.confidence,
        model: invocation.model,
        ordinal: invocation.ordinal,
        outcome: invocation.outcome,
        skillName: invocation.skillName,
        timestamp: invocation.timestamp,
        tokenScope: invocation.tokenScope,
        tokenSegment: invocation.tokenSegment,
        trigger: invocation.trigger,
      })),
      repo: session.repo,
      startedAt: session.startedAt,
      status: session.status,
      tokenSegments: session.tokenSegments,
    })),
    skills: report.skills.map((skill) => ({
      badges: skill.badges,
      category: skill.category,
      definitionTokens: skill.definitionTokens,
      description: capDescription(skill.description),
      descriptionTokens: skill.descriptionTokens,
      fingerprint: skill.fingerprint,
      harness: skill.harness,
      lint: skill.lint,
      name: skill.name,
      provenance: skill.provenance
        ? {
            kind: skill.provenance.kind,
            repository: skill.provenance.repository,
          }
        : null,
      repo: skill.repo,
      skillMdFingerprint: skill.skillMdFingerprint,
      source: skill.source,
    })),
    version: 'local-report@1' as const,
    window: report.window,
  }
}

function buildInventorySnapshots(
  reportSkills: readonly LocalSkill[],
  reportSessions: readonly LocalSession[],
  generatedAt: string,
) {
  const snapshots: InventorySnapshotPayload[] = []
  for (const harness of codingAgentIds) {
    const localSkills = reportSkills.filter((skill) => skill.harness === harness)
    const harnessSessions = reportSessions.filter((session) => session.harness === harness)
    const harnessVersion = latestHarnessVersion(harnessSessions)
    const skills = localSkills.map((skill) => {
      const description = capDescription(skill.description)
      const distribution = distributionForSkill(skill)
      return {
        badges: skill.badges,
        definitionTokens: skill.definitionTokens,
        ...(description ? { description } : {}),
        descriptionTokens: skill.descriptionTokens,
        distribution: distribution.kind,
        exposure: exposureForSkill(skill, harnessSessions),
        fingerprint: skill.fingerprint,
        name: skill.name,
        repo: skill.repo,
        sourceRepo: distribution.sourceRepo,
        skillMdFingerprint: skill.skillMdFingerprint,
        source: skill.source,
        tokenEstimator: { name: 'unicode-chars-div-4', version: '1' },
      } as const
    })
    const id = opaqueId('inventory', harness, harnessVersion, JSON.stringify(skills))
    snapshots.push({
      capturedAt: generatedAt,
      harness,
      harnessVersion,
      id,
      skills,
    })
  }
  return snapshots
}

function skillsForScope(input: {
  catalogRepositories: ReadonlySet<string>
  report: LocalReport
  repositories: ReadonlySet<string>
  sessions: readonly LocalSession[]
}) {
  const included = new Set<LocalSkill>()
  for (const skill of input.report.skills) {
    if (skill.source === 'project' && skill.repo && input.repositories.has(skill.repo)) {
      included.add(skill)
      continue
    }
    if (
      skill.provenance?.kind === 'team_catalog' &&
      input.catalogRepositories.has(skill.provenance.repository)
    ) {
      included.add(skill)
    }
  }
  for (const session of input.sessions) {
    for (const invocation of session.invocations) {
      if (invocation.confidence === 'unknown') continue
      const skill = matchSkill(
        input.report.skills,
        session,
        invocation.skillName,
        invocation.nativeSkillPath,
      )
      if (skill && skill.source !== 'project') included.add(skill)
    }
  }
  return [...included].toSorted((left, right) =>
    `${left.name}:${left.harness}:${left.source}`.localeCompare(
      `${right.name}:${right.harness}:${right.source}`,
    ),
  )
}

function distributionForSkill(skill: LocalSkill): {
  kind: Distribution
  sourceRepo: string | null
} {
  if (skill.provenance?.kind === 'team_catalog') {
    return { kind: 'team_catalog', sourceRepo: skill.provenance.repository }
  }
  if (skill.source === 'project' && skill.repo) {
    return { kind: 'project', sourceRepo: skill.repo }
  }
  return { kind: 'dependency', sourceRepo: null }
}

function sessionPayload(
  session: ScopedSession,
  snapshotByHarness: ReadonlyMap<HarnessName, InventorySnapshotPayload>,
  generatedAt: string,
): SessionPayload {
  const snapshot = snapshotByHarness.get(session.harness)
  const capturedAtSessionEnd = isCapturedAtSessionEnd(session.endedAt, generatedAt)
  return {
    endedAt: session.endedAt,
    harness: session.harness,
    harnessVersion: session.harnessVersion,
    id: opaqueId('session', session.harness, session.nativeId),
    inventoryAssociation: capturedAtSessionEnd ? 'captured_at_session_end' : 'unknown',
    inventorySnapshotId: capturedAtSessionEnd ? (snapshot?.id ?? null) : null,
    repo: session.repo,
    startedAt: session.startedAt,
    status: session.status,
    tokenSegments: session.tokenSegments,
  }
}

function exposureForSkill(skill: LocalSkill, sessions: readonly LocalSession[]) {
  const ruleVersion = codingAgents[skill.harness].catalogObservationRule
  if (!ruleVersion) {
    return { evidence: 'unknown' as const, ruleVersion: null }
  }
  const aliases = new Set([
    resolve(skill.directory, 'SKILL.md'),
    resolve(skill.realDirectory, 'SKILL.md'),
  ])
  const observed = sessions.some((session) =>
    session.catalogSkillPaths.some((path) => aliases.has(resolve(path))),
  )
  return observed
    ? { evidence: 'observed_catalog' as const, ruleVersion }
    : { evidence: 'unknown' as const, ruleVersion: null }
}

function matchSkill(
  skills: readonly LocalSkill[],
  session: LocalSession,
  name: string,
  nativeSkillPath: string | null,
) {
  if (nativeSkillPath) {
    const directory = nativeSkillPath.endsWith('SKILL.md')
      ? dirname(nativeSkillPath)
      : nativeSkillPath
    const exact = skills.find(
      (skill) =>
        skill.harness === session.harness &&
        (resolve(skill.directory) === resolve(directory) ||
          resolve(skill.realDirectory) === resolve(directory)),
    )
    if (exact) return exact
  }
  const candidates = skills.filter(
    (skill) => skill.harness === session.harness && skill.name === name,
  )
  const projectCandidates = candidates.filter(
    (skill) => skill.source === 'project' && skill.repo === session.repo,
  )
  if (projectCandidates.length === 1) return projectCandidates[0]
  return candidates.length === 1 ? candidates[0] : undefined
}

function latestHarnessVersion(sessions: readonly LocalSession[]) {
  const version = sessions.findLast(
    (session) => session.harnessVersion !== 'unknown',
  )?.harnessVersion
  return version ?? 'unknown'
}

function capDescription(description: string | null) {
  if (!description) return null
  return Array.from(description).slice(0, 500).join('')
}

function isCapturedAtSessionEnd(endedAt: string | null, generatedAt: string) {
  if (!endedAt) return false
  const delta = Date.parse(generatedAt) - Date.parse(endedAt)
  return delta >= 0 && delta <= 15 * 60 * 1000
}

function nativeSessionKey(session: LocalSession, index: number) {
  return `${session.harness}\u0000${session.nativeId}\u0000${index}`
}

function roundSimilarity(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function serializePushPayload(payload: PushPayload) {
  return `${JSON.stringify(payload, null, 2)}\n`
}

export function assertPayloadPrivacy(serialized: string) {
  const value = JSON.parse(serialized) as unknown
  walkPayload(value)
}

const approvedPayloadKeys = new Set([
  'badges',
  'batch',
  'cacheWriteInputTokens',
  'cachedInputTokens',
  'capturedAt',
  'cliVersion',
  'confidence',
  'definitionTokens',
  'description',
  'descriptionTokens',
  'distribution',
  'distributionEvents',
  'duplicateCandidates',
  'endedAt',
  'evidence',
  'exposure',
  'fingerprint',
  'from',
  'generatedAt',
  'harness',
  'harnessVersion',
  'harnesses',
  'id',
  'includedSessions',
  'inventoryAssociation',
  'inventorySnapshotId',
  'inventorySnapshots',
  'invocations',
  'kind',
  'leftFingerprint',
  'leftSkillName',
  'method',
  'methodVersion',
  'model',
  'name',
  'nativeTotalTokens',
  'normalizationVersion',
  'occurredAt',
  'ordinal',
  'outcome',
  'outputTokens',
  'parserVersion',
  'parsers',
  'previousFingerprint',
  'reasoningTokens',
  'repo',
  'repositories',
  'rightFingerprint',
  'rightSkillName',
  'ruleVersion',
  'scope',
  'sessionId',
  'sessions',
  'similarity',
  'skillFingerprint',
  'skillMdFingerprint',
  'skillName',
  'skills',
  'source',
  'sourceRepo',
  'startedAt',
  'status',
  'timestamp',
  'to',
  'tokenEstimator',
  'tokenScope',
  'tokenSegment',
  'tokenSegments',
  'trigger',
  'uncachedInputTokens',
  'version',
  'window',
])

function walkPayload(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) walkPayload(item)
    return
  }
  if (typeof value === 'string') {
    if (looksLikeLocalPath(value)) {
      throw new Error('Privacy boundary rejected a path-like value')
    }
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (!approvedPayloadKeys.has(key)) {
      throw new Error(`Privacy boundary rejected payload key: ${key}`)
    }
    walkPayload(child)
  }
}
