import { createHash } from 'node:crypto'
import {
  type GitHubCredential,
  isUnderKnownSkillRoot,
  type LaptopActionPlan,
  skillRootRefusal,
} from './device-actions.js'
import { describeFetchFailure, requestInit } from './http.js'
import type { LocalSkillFile } from './local-skill-source.js'
import { asRecord, nonNegativeInteger, stringValue } from './value.js'

type PullRequestResult = {
  number: number
  url: string
}

type GitHubRequestOptions = {
  allowNotFound?: boolean
  body?: unknown
  method?: 'GET' | 'POST'
}

type TreeEntry = {
  mode: string
  path: string
  sha: string
  type: 'blob' | 'commit' | 'tree'
}

export async function openLaptopPullRequest(input: {
  action: LaptopActionPlan
  fetch: typeof globalThis.fetch
  files: readonly LocalSkillFile[]
  github: GitHubCredential
}): Promise<PullRequestResult> {
  if (Date.parse(input.github.expiresAt) <= Date.now()) {
    throw new Error('The GitHub credential expired. Run the action again.')
  }
  for (const target of input.action.targets) {
    if (!isUnderKnownSkillRoot(target.path)) throw new Error(skillRootRefusal(target.path))
  }
  assertNonOverlappingTargets(input.action.targets.map((target) => target.path))
  const repository = repositoryParts(input.action.repository)
  const root = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
  const existingHead = await reference(input, root, input.action.head, true)

  const baseReference = await reference(input, root, input.action.base, false)
  if (!baseReference) throw new Error('GitHub did not return the base branch')
  const baseCommit = commitRecord(
    await githubRequest(input, `${root}/git/commits/${encodeURIComponent(baseReference.sha)}`),
  )
  const tree = treeRecord(
    await githubRequest(
      input,
      `${root}/git/trees/${encodeURIComponent(baseCommit.treeSha)}?recursive=1`,
    ),
  )
  await assertTargetsMatch(input, root, tree.entries)

  const uploaded = new Map<string, string>()
  for (const file of input.files) {
    const blob = asRecord(
      await githubRequest(input, `${root}/git/blobs`, {
        body: { content: Buffer.from(file.contents).toString('base64'), encoding: 'base64' },
        method: 'POST',
      }),
    )
    const sha = stringValue(blob?.sha)
    if (!sha) throw new Error('GitHub returned an invalid blob')
    uploaded.set(file.path, sha)
  }

  const treeChanges: Array<{
    mode?: '100644' | '100755'
    path: string
    sha: string | null
    type?: 'blob'
  }> = []
  for (const target of input.action.targets) {
    const prefix = `${target.path}/`
    const desiredPaths = new Set(input.files.map((file) => `${prefix}${file.path}`))
    for (const entry of tree.entries) {
      if (entry.path.startsWith(prefix) && entry.type !== 'tree' && !desiredPaths.has(entry.path)) {
        treeChanges.push({ path: entry.path, sha: null })
      }
    }
    for (const file of input.files) {
      const sha = uploaded.get(file.path)
      if (!sha) throw new Error('GitHub did not create every skill file')
      treeChanges.push({
        mode: file.executable ? '100755' : '100644',
        path: `${prefix}${file.path}`,
        sha,
        type: 'blob',
      })
    }
  }
  const createdTree = asRecord(
    await githubRequest(input, `${root}/git/trees`, {
      body: { base_tree: baseCommit.treeSha, tree: treeChanges },
      method: 'POST',
    }),
  )
  const treeSha = stringValue(createdTree?.sha)
  if (!treeSha) throw new Error('GitHub returned an invalid tree')
  if (treeSha === baseCommit.treeSha)
    throw new Error('The selected version is already in the repository')

  const createdCommit = asRecord(
    await githubRequest(input, `${root}/git/commits`, {
      body: {
        message: `chore(skills): ${input.action.command} ${input.action.skillName}`,
        parents: [baseReference.sha],
        tree: treeSha,
      },
      method: 'POST',
    }),
  )
  const headSha = stringValue(createdCommit?.sha)
  if (!headSha) throw new Error('GitHub returned an invalid commit')

  if (existingHead) {
    const existingCommit = commitRecord(
      await githubRequest(input, `${root}/git/commits/${encodeURIComponent(existingHead.sha)}`),
    )
    if (existingCommit.treeSha !== treeSha || !existingCommit.parents.includes(baseReference.sha)) {
      throw new Error('The action branch already exists with different changes')
    }
  } else {
    await githubRequest(input, `${root}/git/refs`, {
      body: { ref: `refs/heads/${input.action.head}`, sha: headSha },
      method: 'POST',
    })
  }

  try {
    return pullRequestRecord(
      await githubRequest(input, `${root}/pulls`, {
        body: {
          base: input.action.base,
          body: input.action.body,
          head: input.action.head,
          title: input.action.title,
        },
        method: 'POST',
      }),
    )
  } catch (error) {
    if (!(error instanceof GitHubHttpError) || error.status !== 422) throw error
    const existing = await findPullRequest(input, root, repository.owner)
    if (!existing) throw new Error('GitHub could not open the pull request')
    return existing
  }
}

async function assertTargetsMatch(
  input: Parameters<typeof openLaptopPullRequest>[0],
  root: string,
  entries: readonly TreeEntry[],
) {
  for (const target of input.action.targets) {
    const prefix = `${target.path}/`
    const existing = entries.filter(
      (entry) => entry.path === target.path || entry.path.startsWith(prefix),
    )
    if (target.expectedSkillMdHash === null) {
      if (existing.length > 0) {
        throw new Error(`${input.action.skillName} already exists at a reviewed destination`)
      }
      continue
    }
    if (existing.some((entry) => entry.type === 'commit')) {
      throw new Error('Repository skill directories cannot contain submodules')
    }
    // v1 action plans attest only SKILL.md, not the surrounding directory. Until the app
    // supplies an expected full manifest, never delete or replace unreviewed auxiliary bytes.
    for (const entry of existing) {
      if (entry.type === 'tree' || entry.path === `${target.path}/SKILL.md`) continue
      const desired = input.files.find((file) => `${prefix}${file.path}` === entry.path)
      if (
        !desired ||
        entry.mode !== (desired.executable ? '100755' : '100644') ||
        entry.sha !== gitBlobSha(desired.contents)
      ) {
        throw new Error(
          'Cannot replace auxiliary skill files: this action only verifies SKILL.md. A full-directory review is required. Nothing was uploaded.',
        )
      }
    }
    const skillMd = existing.find(
      (entry) => entry.path === `${target.path}/SKILL.md` && entry.type === 'blob',
    )
    if (!skillMd) throw new Error('A reviewed repository copy no longer contains SKILL.md')
    const blob = asRecord(
      await githubRequest(input, `${root}/git/blobs/${encodeURIComponent(skillMd.sha)}`),
    )
    const content = stringValue(blob?.content)
    if (blob?.encoding !== 'base64' || !content) throw new Error('GitHub returned an invalid blob')
    const actual = createHash('sha256')
      .update(Buffer.from(content.replace(/\s/gu, ''), 'base64'))
      .digest('hex')
    if (actual !== target.expectedSkillMdHash) {
      throw new Error('A reviewed repository copy changed. Create a new action before retrying.')
    }
  }
}

function gitBlobSha(contents: Uint8Array) {
  return createHash('sha1').update(`blob ${contents.length}\u0000`).update(contents).digest('hex')
}

async function findPullRequest(
  input: Parameters<typeof openLaptopPullRequest>[0],
  root: string,
  owner: string,
) {
  const query = new URLSearchParams({
    head: `${owner}:${input.action.head}`,
    per_page: '10',
    state: 'open',
  })
  const value = await githubRequest(input, `${root}/pulls?${query}`)
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid pull request list')
  for (const candidate of value) {
    const record = asRecord(candidate)
    const base = asRecord(record?.base)
    const head = asRecord(record?.head)
    if (
      stringValue(record?.body) === input.action.body &&
      stringValue(base?.ref) === input.action.base &&
      stringValue(head?.ref) === input.action.head
    ) {
      return pullRequestRecord(candidate)
    }
  }
  return null
}

async function reference(
  input: Parameters<typeof openLaptopPullRequest>[0],
  root: string,
  ref: string,
  allowNotFound: boolean,
) {
  const value = await githubRequest(input, `${root}/git/ref/heads/${encodeRef(ref)}`, {
    allowNotFound,
  })
  if (value === null) return null
  const record = asRecord(value)
  const object = asRecord(record?.object)
  const sha = stringValue(object?.sha)
  return sha ? { sha } : null
}

async function githubRequest(
  input: Parameters<typeof openLaptopPullRequest>[0],
  path: string,
  options: GitHubRequestOptions = {},
): Promise<unknown> {
  let response: Response
  try {
    response = await input.fetch(
      `${input.github.apiUrl}${path}`,
      requestInit(
        {
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${input.github.token}`,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            'User-Agent': 'trce',
            'X-GitHub-Api-Version': '2026-03-10',
          },
          method: options.method ?? 'GET',
        },
        { bearer: true },
      ),
    )
  } catch (error) {
    throw new Error(`Could not reach GitHub (${describeFetchFailure(error)})`)
  }
  if (options.allowNotFound && response.status === 404) return null
  if (!response.ok) throw new GitHubHttpError(response.status)
  return response.json().catch(() => null)
}

class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super(`GitHub returned HTTP ${status}`)
    this.name = 'GitHubHttpError'
  }
}

function treeRecord(value: unknown) {
  const record = asRecord(value)
  if (record?.truncated === true || !Array.isArray(record?.tree)) {
    throw new Error('GitHub returned an incomplete repository tree')
  }
  const entries = record.tree.map((item) => {
    const entry = asRecord(item)
    const mode = stringValue(entry?.mode)
    const path = stringValue(entry?.path)
    const sha = stringValue(entry?.sha)
    const type =
      entry?.type === 'blob' || entry?.type === 'tree' || entry?.type === 'commit'
        ? entry.type
        : null
    return mode && path && sha && type ? { mode, path, sha, type } : null
  })
  if (!entries.every((entry): entry is TreeEntry => entry !== null)) {
    throw new Error('GitHub returned an invalid repository tree')
  }
  return { entries }
}

function commitRecord(value: unknown) {
  const record = asRecord(value)
  const tree = asRecord(record?.tree)
  const treeSha = stringValue(tree?.sha)
  const parentValues = Array.isArray(record?.parents) ? record.parents : []
  const parents = parentValues.map((parent) => stringValue(asRecord(parent)?.sha))
  if (!treeSha || !parents.every((parent): parent is string => parent !== null)) {
    throw new Error('GitHub returned an invalid commit')
  }
  return { parents, treeSha }
}

function pullRequestRecord(value: unknown): PullRequestResult {
  const record = asRecord(value)
  const number = nonNegativeInteger(record?.number)
  const url = safeHttpsUrl(record?.html_url)
  if (number === null || number === 0 || !url)
    throw new Error('GitHub returned an invalid pull request')
  return { number, url }
}

function repositoryParts(value: string) {
  const [owner, name, ...extra] = value.split('/')
  if (!owner || !name || extra.length > 0) throw new Error('GitHub repository must use owner/name')
  return { name, owner }
}

function encodeRef(ref: string) {
  return ref
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function safeHttpsUrl(value: unknown) {
  const url = stringValue(value)
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function assertNonOverlappingTargets(paths: readonly string[]) {
  const sorted = [...new Set(paths)].toSorted()
  if (sorted.length !== paths.length) throw new Error('Dashboard returned duplicate destinations')
  for (const [index, path] of sorted.entries()) {
    if (sorted.some((other, otherIndex) => otherIndex !== index && path.startsWith(`${other}/`))) {
      throw new Error('Dashboard returned overlapping destinations')
    }
  }
}
