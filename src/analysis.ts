import type {
  CapabilityBadge,
  DriftGroup,
  DuplicateCandidate,
  LocalSkill,
  SkillCategory,
} from './types.js'

const scriptExtension = /\.(?:cjs|js|mjs|py|sh|ts)$/u
const shellPattern = /```(?:bash|sh|shell|zsh)|(?<![\w.])(?:bash |exec\(|subprocess|npx |chmod )/iu
const networkPattern =
  /(?<![\w])(?:curl |fetch\(|https?:\/\/api\.|requests\.(?:get|post)|wget |WebFetch|axios)/iu
const installPattern =
  /(?:npm i(?:nstall)?|pnpm (?:add|i)\b|pip3? install|brew install|uv add|yarn add|npx )/iu
const envPattern =
  /(?:\$\{?[A-Z][A-Z0-9_]{3,}\}?|process\.env|os\.environ|API[_ ]?KEY|SECRET|TOKEN)/u

export function capabilityBadgesFor({ fileNames, text }: { fileNames: string[]; text: string }) {
  const badges: CapabilityBadge[] = []
  if (fileNames.some((name) => name.includes('/scripts/') || scriptExtension.test(name))) {
    badges.push('scripts')
  }
  if (fileNames.some((name) => name.endsWith('.sh')) || shellPattern.test(text))
    badges.push('shell')
  if (networkPattern.test(text)) badges.push('network')
  if (installPattern.test(text)) badges.push('install')
  if (envPattern.test(text)) badges.push('env')
  return badges
}

/**
 * Deterministic keyword fallback. Rules run top to bottom and the first match wins, so specific
 * categories sit above generic ones, and every keyword matches whole words. Bare substrings
 * mislabeled real skills on the 2026-08-30 laptop run: `ci` inside "pricing" sent copywriting to
 * devops-infra, `audit` beat the more specific `seo` for seo-audit, and a request-schema mention
 * sent openai-docs to databases. When nothing matches, the honest answer is `other`, never a
 * guess. The hosted app maintains the same fallback table and verifies the shared contract.
 */
const categoryRules: ReadonlyArray<readonly [SkillCategory, RegExp]> = [
  ['writing', /\b(?:writing|writers?|copywrit\w*|copy|copyedit\w*|essays?|blogs?|prose|voice)\b/u],
  ['marketing-content', /\bseo\b/u],
  ['docs-release', /\b(?:docs?|documentation|changelogs?|readme|releases?|reference)\b/u],
  [
    'security',
    /\b(?:security|vulnerab\w*|threats?|secrets?|permissions?|auth|authn|authz|authentication|authorization|oauth|owasp|audits?|auditing)\b/u,
  ],
  [
    'frontend-design',
    /\b(?:frontend|design\w*|interface|shadcn|figma|css|tailwind|react|components?|ui|ux)\b/u,
  ],
  [
    'testing-e2e',
    /\b(?:tests?|testing|e2e|playwright|vitest|jest|qa|browsers?|triage|fixtures?)\b/u,
  ],
  [
    'databases',
    /\b(?:databases?|postgres\w*|mysql|sqlite|sql|schemas?|migrations?|convex|redis)\b/u,
  ],
  [
    'data-analytics',
    /\b(?:analytics|tracking|posthog|metrics?|warehouses?|spreadsheets?|datasets?|data)\b/u,
  ],
  [
    'devops-infra',
    /\b(?:deploy\w*|cloud|infra|infrastructure|docker|kubernetes|terraform|ci|cd|hosting|vercel)\b|\bgithub actions?\b/u,
  ],
  [
    'agent-workflows',
    /\b(?:agents?|skills?|prompts?|mcp|codex|claude|workflows?|automation|plugins?)\b/u,
  ],
  ['marketing-content', /\b(?:marketing|campaigns?|social|brand\w*|content|launch\w*|growth)\b/u],
  [
    'product-planning',
    /\b(?:products?|planning|roadmaps?|strategy|research|discovery|prioriti\w*)\b/u,
  ],
  ['personal', /\b(?:personal|brain|journal\w*|notes?|inbox|calendar|music|fitness)\b/u],
  [
    'code-quality',
    /\b(?:code|reviews?|lint\w*|typescript|debug\w*|refactor\w*|performance|dependenc\w*|api)\b/u,
  ],
]

function categoryForText(value: string): SkillCategory {
  const normalized = value.toLowerCase().replaceAll(/[-_./]/gu, ' ')
  for (const [category, pattern] of categoryRules) {
    if (pattern.test(normalized)) return category
  }
  return 'other'
}

export function keywordCategory(name: string, description: string | null): SkillCategory {
  const nameCategory = categoryForText(name)
  // A specific skill name is stronger evidence than incidental words in its description. Generic
  // review/code names still let the description provide the more useful category.
  if (nameCategory !== 'other' && nameCategory !== 'code-quality') return nameCategory
  const descriptionCategory = categoryForText(description ?? '')
  return descriptionCategory === 'other' ? nameCategory : descriptionCategory
}

export function estimateTokens(text: string) {
  return Math.ceil(Array.from(text).length / 4)
}

export function wordShingles(text: string, size = 5) {
  const words = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
  const shingles = new Set<string>()
  for (let index = 0; index + size <= words.length; index += 1) {
    shingles.add(words.slice(index, index + size).join(' '))
  }
  return shingles
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

/** Pairs above this Jaccard similarity are duplicate candidates; `dedupe` lists every one. */
export const duplicateSimilarityFloor = 0.3

/**
 * Pairs at or above this similarity are likely duplicates. Only these reach the report headline:
 * a 168-install laptop produced 191 candidates above the floor, which made the overview count
 * noise (docs/qa/log-2026-08.md, 2026-08-30).
 */
export const likelyDuplicateSimilarity = 0.5

export function likelyDuplicates(candidates: readonly DuplicateCandidate[]) {
  return candidates.filter((candidate) => candidate.similarity >= likelyDuplicateSimilarity)
}

export function duplicateCandidates(skills: readonly LocalSkill[]) {
  const unique = uniqueContentLocations(skills)
  const shingles = new Map(unique.map((skill) => [skill, wordShingles(skill.skillMdText)]))
  const candidates: DuplicateCandidate[] = []
  for (let leftIndex = 0; leftIndex < unique.length; leftIndex += 1) {
    const left = unique[leftIndex]
    if (!left) continue
    for (let rightIndex = leftIndex + 1; rightIndex < unique.length; rightIndex += 1) {
      const right = unique[rightIndex]
      if (!right || left.name === right.name) continue
      const leftShingles = shingles.get(left)
      const rightShingles = shingles.get(right)
      if (!leftShingles || !rightShingles) continue
      const similarity = jaccard(leftShingles, rightShingles)
      if (similarity > duplicateSimilarityFloor) {
        candidates.push({
          left,
          method: 'word-5-shingle-jaccard',
          methodVersion: '1',
          right,
          similarity,
        })
      }
    }
  }
  return candidates.toSorted((left, right) => right.similarity - left.similarity)
}

export function driftGroups(skills: readonly LocalSkill[]) {
  const byName = new Map<string, LocalSkill[]>()
  for (const skill of skills) {
    const key = `${skill.name}\u0000${skillLineage(skill)}`
    const copies = byName.get(key) ?? []
    copies.push(skill)
    byName.set(key, copies)
  }
  const groups: DriftGroup[] = []
  for (const copies of byName.values()) {
    const versions = uniqueFingerprints(copies)
    const name = copies[0]?.name
    if (name && versions.length > 1) groups.push({ name, versions })
  }
  return groups.toSorted((left, right) => left.name.localeCompare(right.name))
}

function skillLineage(skill: LocalSkill) {
  if (skill.provenance) {
    return `team_catalog:${skill.provenance.repository}:${skill.provenance.path}`
  }
  if (skill.source === 'project') return `project:${skill.repo ?? 'unknown'}`
  if (skill.source === 'user') return 'dependency:user'
  return `${skill.source}:${skill.harness}:${skill.realDirectory}`
}

function uniqueContentLocations(skills: readonly LocalSkill[]) {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    const key = `${skill.realDirectory}\u0000${skill.fingerprint}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueFingerprints(skills: readonly LocalSkill[]) {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.fingerprint)) return false
    seen.add(skill.fingerprint)
    return true
  })
}
