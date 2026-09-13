import type { LinkedConfig } from './config.js'
import { describeFetchFailure, httpFailure, originOf, requestInit } from './http.js'
import { asRecord, isoTimestamp, nonNegativeInteger, stringValue } from './value.js'

/**
 * A reviewed action may only write under a known skill root. The dashboard chooses the
 * destination, but the machine holds the files, so it refuses anything else before GitHub sees
 * a byte.
 */
export const knownSkillRoots = [
  '.claude/skills/',
  '.agents/skills/',
  '.codex/skills/',
  '.trce/skills/',
  'skills/',
] as const

export function isUnderKnownSkillRoot(path: string) {
  return knownSkillRoots.some((root) => path.startsWith(root) && path.length > root.length)
}

export function skillRootRefusal(path: string) {
  return `Refusing to write ${path}: reviewed actions only write under ${knownSkillRoots.join(', ')}. Nothing changed.`
}

export type LaptopActionTarget = {
  expectedSkillMdHash: string | null
  path: string
}

export type LaptopActionPlan = {
  actionId: string
  base: string
  body: string
  command: 'promote' | 'unify'
  head: string
  repository: string
  skillFingerprint: string
  skillName: string
  targets: LaptopActionTarget[]
  title: string
}

export type GitHubCredential = {
  apiUrl: 'https://api.github.com'
  expiresAt: string
  token: string
}

export type ClaimedLaptopAction =
  | { kind: 'opened'; number: number; url: string }
  | { action: LaptopActionPlan; github: GitHubCredential; kind: 'ready' }

export type CompletedLaptopAction = {
  number: number
  url: string
}

export async function claimLaptopAction(
  config: LinkedConfig,
  actionId: string,
  fetch: typeof globalThis.fetch,
): Promise<ClaimedLaptopAction> {
  const value = await actionRequest(config, { actionId, kind: 'claim' }, fetch)
  if (value?.kind === 'opened') {
    const number = nonNegativeInteger(value.number)
    const url = safeUrl(value.url)
    if (number === null || number === 0 || !url)
      throw new Error('Dashboard returned an invalid action')
    return { kind: 'opened', number, url }
  }
  if (value?.kind !== 'ready') throw new Error('Dashboard returned an invalid action')
  const action = parseAction(value.action)
  const github = parseCredential(value.github)
  if (!action || !github) throw new Error('Dashboard returned an invalid action')
  return { action, github, kind: 'ready' }
}

export async function completeLaptopAction(
  config: LinkedConfig,
  actionId: string,
  pullRequestNumber: number,
  fetch: typeof globalThis.fetch,
): Promise<CompletedLaptopAction> {
  const value = await actionRequest(
    config,
    { actionId, kind: 'complete', pullRequestNumber },
    fetch,
  )
  const number = nonNegativeInteger(value?.number)
  const url = safeUrl(value?.url)
  if (value?.kind !== 'opened' || number === null || number === 0 || !url) {
    throw new Error('Dashboard returned an invalid action completion')
  }
  return { number, url }
}

async function actionRequest(
  config: LinkedConfig,
  body:
    | { actionId: string; kind: 'claim' }
    | { actionId: string; kind: 'complete'; pullRequestNumber: number },
  fetch: typeof globalThis.fetch,
) {
  const origin = originOf(config.baseUrl)
  let response: Response
  try {
    response = await fetch(
      `${config.baseUrl}/api/device/actions`,
      requestInit(
        {
          body: JSON.stringify(body),
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        },
        { bearer: true },
      ),
    )
  } catch (error) {
    throw new Error(`Could not reach ${origin} (${describeFetchFailure(error)}). Nothing changed.`)
  }
  const value = asRecord(await response.json().catch(() => null))
  if (!response.ok) {
    throw new Error(
      `The dashboard at ${origin} refused the action (${httpFailure(response.status, value)}). Nothing changed.`,
    )
  }
  return value
}

function parseAction(value: unknown): LaptopActionPlan | null {
  const record = asRecord(value)
  const actionId = stringValue(record?.actionId)
  const base = stringValue(record?.base)
  const body = stringValue(record?.body)
  const command =
    record?.command === 'promote' || record?.command === 'unify' ? record.command : null
  const head = stringValue(record?.head)
  const repository = repositoryValue(record?.repository)
  const skillFingerprint = sha256Value(record?.skillFingerprint)
  const skillName = skillNameValue(record?.skillName)
  const title = stringValue(record?.title)
  const targets = parseTargets(record?.targets)
  if (
    !actionId ||
    !base ||
    !body ||
    !command ||
    !head ||
    !repository ||
    !skillFingerprint ||
    !skillName ||
    !targets ||
    !title
  ) {
    return null
  }
  return {
    actionId,
    base,
    body,
    command,
    head,
    repository,
    skillFingerprint,
    skillName,
    targets,
    title,
  }
}

function parseCredential(value: unknown): GitHubCredential | null {
  const record = asRecord(value)
  const expiresAt = isoTimestamp(record?.expiresAt)
  const token = stringValue(record?.token)
  if (record?.apiUrl !== 'https://api.github.com' || !expiresAt || !token) return null
  return { apiUrl: 'https://api.github.com', expiresAt, token }
}

function parseTargets(value: unknown): LaptopActionTarget[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null
  const targets = value.map((item) => {
    const record = asRecord(item)
    const path = safeRelativePath(record?.path)
    if (path && !isUnderKnownSkillRoot(path)) throw new Error(skillRootRefusal(path))
    const expected = record?.expectedSkillMdHash
    const expectedSkillMdHash = expected === null ? null : sha256Value(expected)
    return path && (expected === null || expectedSkillMdHash) ? { expectedSkillMdHash, path } : null
  })
  return targets.every((target): target is LaptopActionTarget => target !== null) ? targets : null
}

function safeRelativePath(value: unknown) {
  const path = stringValue(value)
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null
  }
  return path
}

function repositoryValue(value: unknown) {
  const repository = stringValue(value)
  return repository && /^[^/\s]+\/[^/\s]+$/u.test(repository) ? repository : null
}

function skillNameValue(value: unknown) {
  const name = stringValue(value)
  return name && /^[a-z0-9][a-z0-9._-]*$/u.test(name) ? name : null
}

function sha256Value(value: unknown) {
  const hash = stringValue(value)
  return hash && /^[a-f0-9]{64}$/u.test(hash) ? hash : null
}

function safeUrl(value: unknown) {
  const url = stringValue(value)
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}
