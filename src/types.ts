import { type CodingAgentId, codingAgentIds } from './coding-agents.js'

export const harnessNames = codingAgentIds
export const confidenceLevels = ['verified', 'inferred', 'unknown'] as const
export const triggerModes = ['manual', 'auto', 'nested'] as const
export const outcomes = ['success', 'failure', 'aborted', 'unknown'] as const
export const skillSources = ['project', 'user', 'plugin', 'bundled'] as const
export const capabilityBadges = ['scripts', 'shell', 'network', 'install', 'env'] as const

export type HarnessName = CodingAgentId
export type Confidence = (typeof confidenceLevels)[number]
export type TriggerMode = (typeof triggerModes)[number]
export type Outcome = (typeof outcomes)[number]
export type SkillSource = (typeof skillSources)[number]
export type CapabilityBadge = (typeof capabilityBadges)[number]

export type TeamScope = {
  catalogRepositories: string[]
  repositories: string[]
  version: 'team-repositories@1'
}

export type TeamCatalogProvenance = {
  kind: 'team_catalog'
  path: string
  ref: string
  repository: string
}

export type TokenCounts = {
  cacheWriteInputTokens: number | null
  cachedInputTokens: number | null
  nativeTotalTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  uncachedInputTokens: number | null
}

export type SessionTokenSegment = TokenCounts & {
  model: string
  normalizationVersion: string
}

export type InvocationTokenSegment = TokenCounts

export type ParserCoverage = {
  harness: HarnessName
  parseFailures: number
  sessionsParsed: number
  sessionsScanned: number
  unknownRecords: number
  version: string
}

export type LocalInvocation = {
  confidence: Confidence
  harness: HarnessName
  model: string | null
  nativeInvocationId?: string | null
  nativeSkillPath: string | null
  ordinal: number
  outcome: Outcome
  skillName: string
  timestamp: string | null
  tokenScope: 'assistant_record' | 'turn' | 'unavailable'
  tokenSegment: InvocationTokenSegment | null
  trigger: TriggerMode
}

export type LocalSession = {
  catalogSkillPaths: string[]
  endedAt: string | null
  harness: HarnessName
  harnessVersion: string
  invocations: LocalInvocation[]
  modelFallback: string | null
  nativeCwd: string | null
  nativeId: string
  parserVersion: string
  repo: string | null
  startedAt: string | null
  status: Outcome
  tokenSegments: SessionTokenSegment[]
  /** Local-only native accounting keys, used to deduplicate copied or overlapping transcripts. */
  tokenEvidence?: { id: string; segment: SessionTokenSegment }[]
}

export type LintFinding =
  | 'missing-description'
  | 'name-directory-mismatch'
  | 'no-frontmatter'
  | 'oversized-skill-md'

export type SkillCategory =
  | 'code-quality'
  | 'frontend-design'
  | 'testing-e2e'
  | 'docs-release'
  | 'data-analytics'
  | 'databases'
  | 'devops-infra'
  | 'security'
  | 'agent-workflows'
  | 'marketing-content'
  | 'writing'
  | 'product-planning'
  | 'personal'
  | 'other'

export type LocalSkill = {
  badges: CapabilityBadge[]
  category: SkillCategory
  definitionTokens: number
  description: string | null
  descriptionTokens: number
  directory: string
  fingerprint: string
  harness: HarnessName
  lint: LintFinding[]
  name: string
  provenance: TeamCatalogProvenance | null
  realDirectory: string
  repo: string | null
  skillMdFingerprint: string
  skillMdText: string
  source: SkillSource
}

export type DuplicateCandidate = {
  left: LocalSkill
  method: 'word-5-shingle-jaccard'
  methodVersion: '1'
  right: LocalSkill
  similarity: number
}

export type DriftGroup = {
  name: string
  versions: LocalSkill[]
}

export type ParsedHarness = {
  coverage: ParserCoverage
  sessions: LocalSession[]
}

/** One native session directory the history scan looked at. Local only; never exported. */
export type HistoryRoot = {
  directory: string
  /** `.jsonl` files found under the root, in or out of the window. */
  files: number
  harness: HarnessName
  /** Sessions parsed inside the report window. */
  sessions: number
  /** Session files the scan could not open or parse (permissions, truncated writes). */
  unreadableFiles: number
}

export type LocalReport = {
  duplicateCandidates: DuplicateCandidate[]
  drift: DriftGroup[]
  generatedAt: string
  historyRoots: HistoryRoot[]
  parserCoverage: ParserCoverage[]
  sessions: LocalSession[]
  skills: LocalSkill[]
  window: { from: string; to: string }
}
