import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { CatalogCredential } from './catalog-access.js'
import { codingAgentInstallPath } from './coding-agents.js'
import { parseSkillFrontmatter } from './frontmatter.js'
import { compareCodePoints, fingerprintSkillFiles } from './hash.js'
import { describeFetchFailure, requestInit, requestTimeoutMs } from './http.js'
import {
  type DistributionEvent,
  type InstallDistribution,
  type ManagedInstall,
  readInstallManifest,
  withInstallLock,
  writeInstallManifest,
} from './installs.js'
import { defaultCommandPrefix } from './invocation.js'
import type { HarnessName } from './types.js'
import { asRecord, nonNegativeInteger, stringValue } from './value.js'

const execFileAsync = promisify(execFile)
const maxFiles = 100
const maxBytes = 2_000_000

export type CatalogSource = {
  path: string
  ref: string
  repository: string
}

export type SkillSourceFile = {
  contents: Uint8Array
  executable: boolean
  path: string
}

export type LoadedSkillSource = {
  files: SkillSourceFile[]
  resolvedRef: string
}

export type SkillSourceLoader = (source: CatalogSource) => Promise<LoadedSkillSource>

export type InstallRequest = {
  commandPrefix?: string
  distribution: InstallDistribution
  dryRun: boolean
  harnesses: HarnessName[]
  homeDirectory: string
  loadSource: SkillSourceLoader
  now: Date
  source: CatalogSource
}

export function parseCatalogSource(value: string, ref = 'HEAD'): CatalogSource {
  const separator = value.indexOf(':')
  const repository = separator === -1 ? '' : value.slice(0, separator)
  const path = separator === -1 ? '' : value.slice(separator + 1)
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository) || !safeRelativePath(path)) {
    throw new Error('Use a source in the form owner/repository:path/to/skill')
  }
  if (!ref.trim()) throw new Error('--ref cannot be empty')
  return { path: normalizeRelativePath(path), ref: ref.trim(), repository }
}

export async function installCatalogSkill(request: InstallRequest) {
  return request.dryRun
    ? installCatalogSkillUnlocked(request)
    : withInstallLock(request.homeDirectory, () => installCatalogSkillUnlocked(request))
}

async function installCatalogSkillUnlocked(request: InstallRequest) {
  const loaded = validateLoadedSource(await request.loadSource(request.source))
  const skillMd = loaded.files.find((file) => file.path === 'SKILL.md')
  if (!skillMd) throw new Error('The selected directory does not contain SKILL.md')
  const frontmatter = parseSkillFrontmatter(Buffer.from(skillMd.contents).toString('utf8'))
  const name = frontmatter.name ?? basename(request.source.path)
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new Error(
      'The skill name must use lowercase letters, numbers, dots, underscores, or hyphens',
    )
  }
  const fingerprint = fingerprintSource(loaded.files)
  const targets = request.harnesses.map((harness) => ({
    harness,
    path: targetPath(request.homeDirectory, harness, name),
  }))
  const manifest = await readInstallManifest(request.homeDirectory)
  if (manifest.installs.some((install) => install.name === name)) {
    throw new Error(
      `${name} is already managed by trce. Run ${request.commandPrefix ?? defaultCommandPrefix} update ${name}.`,
    )
  }
  for (const target of targets) {
    if (await pathExists(target.path)) {
      throw new Error(`${name} is already installed outside trce. Nothing changed.`)
    }
  }
  const source = { ...request.source, resolvedRef: loaded.resolvedRef }
  const installedAt = request.now.toISOString()
  const install: ManagedInstall = {
    distribution: request.distribution,
    fingerprint,
    installedAt,
    modeFingerprint: fingerprintModes(loaded.files),
    name,
    source,
    targets,
    updatedAt: installedAt,
  }
  if (request.dryRun) return install

  const staging: Array<{ target: string; temporary: string }> = []
  const installedTargets: string[] = []
  try {
    for (const target of targets) {
      const temporary = `${target.path}.trce-${process.pid}-${Date.now()}`
      await writeSource(temporary, loaded.files)
      staging.push({ target: target.path, temporary })
    }
    for (const entry of staging) {
      await mkdir(dirname(entry.target), { recursive: true })
      await rename(entry.temporary, entry.target)
      installedTargets.push(entry.target)
    }
    await writeInstallManifest(request.homeDirectory, {
      installs: [...manifest.installs, install],
      pendingEvents:
        request.distribution === 'team_catalog'
          ? [...manifest.pendingEvents, distributionEvent(install, 'installed', null)]
          : manifest.pendingEvents,
      version: 1,
    })
  } catch (error) {
    await Promise.allSettled([
      ...staging.map((entry) => rm(entry.temporary, { force: true, recursive: true })),
      ...installedTargets.map((target) => rm(target, { force: true, recursive: true })),
    ])
    throw error
  }
  return install
}

export async function removeCatalogSkill(input: Parameters<typeof removeCatalogSkillUnlocked>[0]) {
  return input.dryRun
    ? removeCatalogSkillUnlocked(input)
    : withInstallLock(input.homeDirectory, () => removeCatalogSkillUnlocked(input))
}

async function removeCatalogSkillUnlocked(input: {
  dryRun: boolean
  homeDirectory: string
  name: string
  now: Date
}) {
  const manifest = await readInstallManifest(input.homeDirectory)
  const install = manifest.installs.find((candidate) => candidate.name === input.name)
  if (!install) throw new Error(`${input.name} is not managed by trce`)
  const trashRoot = join(
    input.homeDirectory,
    '.trce',
    'trash',
    `${input.now.toISOString().replace(/[:.]/gu, '-')}-${install.name}`,
  )
  if (input.dryRun) return { install, trashRoot }
  await mkdir(trashRoot, { mode: 0o700, recursive: true })
  const moved: Array<{ target: string; trash: string }> = []
  try {
    for (const target of install.targets) {
      if (!(await pathExists(target.path))) continue
      const trash = join(trashRoot, target.harness)
      await rename(target.path, trash)
      moved.push({ target: target.path, trash })
    }
    await writeInstallManifest(input.homeDirectory, {
      installs: manifest.installs.filter((candidate) => candidate !== install),
      pendingEvents:
        install.distribution === 'team_catalog'
          ? [
              ...manifest.pendingEvents,
              distributionEvent(
                { ...install, updatedAt: input.now.toISOString() },
                'removed',
                null,
              ),
            ]
          : manifest.pendingEvents,
      version: 1,
    })
  } catch (error) {
    for (const entry of moved.toReversed()) {
      await rename(entry.trash, entry.target).catch(() => undefined)
    }
    throw error
  }
  return { install, trashRoot }
}

export async function updateCatalogSkill(input: Parameters<typeof updateCatalogSkillUnlocked>[0]) {
  return input.dryRun
    ? updateCatalogSkillUnlocked(input)
    : withInstallLock(input.homeDirectory, () => updateCatalogSkillUnlocked(input))
}

async function updateCatalogSkillUnlocked(input: {
  dryRun: boolean
  homeDirectory: string
  loadSource: SkillSourceLoader
  name: string
  now: Date
}) {
  const manifest = await readInstallManifest(input.homeDirectory)
  const existing = manifest.installs.find((install) => install.name === input.name)
  if (!existing) throw new Error(`${input.name} is not managed by trce`)
  if (!existing.modeFingerprint) {
    throw new Error(
      `${input.name} has no executable-mode record. Save local edits, then remove and add the skill again before updating.`,
    )
  }
  const loaded = validateLoadedSource(await input.loadSource(existing.source))
  const fingerprint = fingerprintSource(loaded.files)
  const modeFingerprint = fingerprintModes(loaded.files)
  // A dry run and an unchanged upstream still need an intact local installation.
  // Validate every target before reporting success or swapping any files.
  for (const target of existing.targets) {
    if (!(await pathExists(target.path))) {
      throw new Error(`${target.path} is missing; reinstall instead of updating`)
    }
    const current = await fingerprintDirectory(target.path)
    if (
      current.fingerprint !== existing.fingerprint ||
      current.modeFingerprint !== existing.modeFingerprint
    ) {
      throw new Error(`${existing.name} has local changes; update stopped without changing files`)
    }
  }
  if (fingerprint === existing.fingerprint && modeFingerprint === existing.modeFingerprint) {
    return { changed: false, install: existing }
  }
  const updated: ManagedInstall = {
    ...existing,
    fingerprint,
    modeFingerprint,
    source: { ...existing.source, resolvedRef: loaded.resolvedRef },
    updatedAt: input.now.toISOString(),
  }
  if (input.dryRun) return { changed: true, install: updated }
  const nonce = `${process.pid}-${Date.now()}`
  const staged: Array<{ previous: string; target: string; temporary: string }> = []
  try {
    for (const target of existing.targets) {
      const temporary = `${target.path}.trce-${nonce}`
      await writeSource(temporary, loaded.files)
      staged.push({
        previous: `${target.path}.trce-previous-${nonce}`,
        target: target.path,
        temporary,
      })
    }
  } catch (error) {
    await Promise.allSettled(
      staged.map((entry) => rm(entry.temporary, { force: true, recursive: true })),
    )
    throw error
  }
  const swapped: typeof staged = []
  try {
    for (const entry of staged) {
      await rename(entry.target, entry.previous)
      swapped.push(entry)
      await rename(entry.temporary, entry.target)
    }
    await writeInstallManifest(input.homeDirectory, {
      installs: manifest.installs.map((install) => (install === existing ? updated : install)),
      pendingEvents:
        existing.distribution === 'team_catalog'
          ? [...manifest.pendingEvents, distributionEvent(updated, 'updated', existing.fingerprint)]
          : manifest.pendingEvents,
      version: 1,
    })
  } catch (error) {
    for (const entry of swapped.toReversed()) {
      await rm(entry.target, { force: true, recursive: true })
      await rename(entry.previous, entry.target).catch(() => undefined)
    }
    await Promise.allSettled(
      staged.map((entry) => rm(entry.temporary, { force: true, recursive: true })),
    )
    throw error
  }
  await Promise.all(swapped.map((entry) => rm(entry.previous, { force: true, recursive: true })))
  return { changed: true, install: updated }
}

export async function loadGitHubSkillSource(source: CatalogSource): Promise<LoadedSkillSource> {
  return loadGitHubSkillSourceUsing(source, { kind: 'github-cli' })
}

export async function loadGitHubSkillSourceWithCredential(input: {
  credential: CatalogCredential
  fetch: typeof globalThis.fetch
  source: CatalogSource
}): Promise<LoadedSkillSource> {
  return loadGitHubSkillSourceUsing(input.source, {
    credential: input.credential,
    fetch: input.fetch,
    kind: 'credential',
  })
}

type GitHubAccess =
  | { kind: 'github-cli' }
  | {
      credential: CatalogCredential
      fetch: typeof globalThis.fetch
      kind: 'credential'
    }

async function loadGitHubSkillSourceUsing(
  source: CatalogSource,
  access: GitHubAccess,
): Promise<LoadedSkillSource> {
  const commit = await ghJson(
    `repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`,
    access,
  )
  const resolvedRef = stringValue(commit?.sha)
  const treeSha = stringValue(asRecord(asRecord(commit?.commit)?.tree)?.sha)
  if (!resolvedRef || !treeSha) throw new Error('GitHub returned an invalid commit')
  const tree = await ghJson(`repos/${source.repository}/git/trees/${treeSha}?recursive=1`, access)
  if (tree?.truncated === true)
    throw new Error('The repository tree is too large to inspect safely')
  if (!Array.isArray(tree?.tree)) throw new Error('GitHub returned an invalid repository tree')
  const prefix = `${source.path}/`
  const entries = tree.tree.flatMap((candidate) => {
    const entry = asRecord(candidate)
    const path = stringValue(entry?.path)
    const sha = stringValue(entry?.sha)
    const type = stringValue(entry?.type)
    const mode = stringValue(entry?.mode)
    if (!path?.startsWith(prefix)) return []
    if (type === 'tree') return []
    const size = nonNegativeInteger(entry?.size)
    if (type !== 'blob' || !sha || !mode || size === null) {
      throw new Error('Skill directories cannot contain submodules or unsupported entries')
    }
    if (mode === '120000') throw new Error('Skill directories cannot contain symbolic links')
    const relativePath = path.slice(prefix.length)
    if (!safeRelativePath(relativePath)) throw new Error('GitHub returned an unsafe skill path')
    return [{ executable: mode === '100755', path: relativePath, sha, size }]
  })
  if (entries.length > maxFiles) throw new Error(`Skills may contain at most ${maxFiles} files`)
  if (entries.reduce((total, entry) => total + entry.size, 0) > maxBytes) {
    throw new Error('The skill is larger than the 2 MB install limit')
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const blob = await ghJson(`repos/${source.repository}/git/blobs/${entry.sha}`, access)
      const encoded = typeof blob?.content === 'string' ? blob.content.replace(/\s/gu, '') : null
      if (blob?.encoding !== 'base64' || encoded === null)
        throw new Error('GitHub returned an invalid blob')
      return {
        contents: Uint8Array.from(Buffer.from(encoded, 'base64')),
        executable: entry.executable,
        path: entry.path,
      }
    }),
  )
  validateLoadedSource({ files, resolvedRef })
  return { files, resolvedRef }
}

function targetPath(homeDirectory: string, harness: HarnessName, name: string) {
  return codingAgentInstallPath(homeDirectory, harness, name)
}

function validateLoadedSource(source: LoadedSkillSource) {
  if (!source.resolvedRef.trim()) throw new Error('The source ref is empty')
  if (source.files.length === 0) throw new Error('The selected skill directory is empty')
  if (source.files.length > maxFiles)
    throw new Error(`Skills may contain at most ${maxFiles} files`)
  let bytes = 0
  const paths = new Set<string>()
  for (const file of source.files) {
    if (!safeRelativePath(file.path) || paths.has(file.path)) {
      throw new Error('The skill contains duplicate or unsafe paths')
    }
    paths.add(file.path)
    bytes += file.contents.byteLength
  }
  if (bytes > maxBytes) throw new Error('The skill is larger than the 2 MB install limit')
  return {
    ...source,
    files: source.files.toSorted((left, right) => compareCodePoints(left.path, right.path)),
  }
}

async function writeSource(root: string, files: readonly SkillSourceFile[]) {
  await mkdir(dirname(root), { recursive: true })
  await mkdir(root, { mode: 0o700, recursive: false })
  try {
    for (const file of files) {
      const path = join(root, file.path)
      if (!isInside(root, path)) throw new Error('The skill contains an unsafe path')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.contents, { mode: file.executable ? 0o755 : 0o644 })
      if (file.executable) await chmod(path, 0o755)
    }
  } catch (error) {
    await rm(root, { force: true, recursive: true })
    throw error
  }
}

/** Same algorithm as the inventory fingerprint, so an installed copy matches its source. */
function fingerprintSource(files: readonly SkillSourceFile[]) {
  return fingerprintSkillFiles(files)
}

function fingerprintModes(files: readonly SkillSourceFile[]) {
  // Windows does not expose Unix executable bits. Do not invent permission drift there.
  const modes = files
    .toSorted((left, right) => compareCodePoints(left.path, right.path))
    .map((file) => [file.path, process.platform !== 'win32' && file.executable])
  return createHash('sha256').update(JSON.stringify(modes)).digest('hex')
}

function distributionEvent(
  install: ManagedInstall,
  kind: DistributionEvent['kind'],
  previousFingerprint: string | null,
): DistributionEvent {
  const harnesses = [...new Set(install.targets.map((target) => target.harness))].toSorted()
  const occurredAt = install.updatedAt
  return {
    fingerprint: install.fingerprint,
    harnesses,
    id: createHash('sha256')
      .update(
        [
          'distribution-event@1',
          kind,
          install.name,
          install.source.repository,
          install.fingerprint,
          previousFingerprint ?? '',
          occurredAt,
          ...harnesses,
        ].join('\u0000'),
      )
      .digest('hex'),
    kind,
    name: install.name,
    occurredAt,
    previousFingerprint,
    sourceRepo: install.source.repository,
  }
}

async function fingerprintDirectory(root: string) {
  const files: SkillSourceFile[] = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile()) {
        const mode = (await stat(path)).mode
        files.push({
          contents: Uint8Array.from(await readFile(path)),
          executable: (mode & 0o111) !== 0,
          path: normalizeRelativePath(relative(root, path)),
        })
      } else {
        throw new Error('Managed skills cannot contain symbolic links')
      }
    }
  }
  return { fingerprint: fingerprintSource(files), modeFingerprint: fingerprintModes(files) }
}

async function ghJson(endpoint: string, access: GitHubAccess) {
  let body: string
  if (access.kind === 'github-cli') {
    try {
      ;({ stdout: body } = await execFileAsync('gh', ['api', endpoint], {
        encoding: 'utf8',
        maxBuffer: 10_000_000,
        timeout: requestTimeoutMs,
      }))
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') {
        throw new Error(
          'Personal installs require the GitHub CLI. Install gh and run gh auth login, then retry. Nothing changed.',
        )
      }
      if (asRecord(error)?.killed === true) {
        throw new Error('GitHub CLI request timed out after 15 seconds. Nothing changed.')
      }
      throw new Error('Could not read the skill from GitHub. Check gh auth and repository access.')
    }
  } else {
    let response: Response
    try {
      response = await access.fetch(
        `${access.credential.apiUrl}/${endpoint}`,
        requestInit(
          {
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${access.credential.token}`,
              'x-github-api-version': '2022-11-28',
            },
          },
          { bearer: true },
        ),
      )
      body = await response.text()
    } catch (error) {
      throw new Error(
        `Could not read the Shared skill from GitHub (${describeFetchFailure(error)}). Nothing changed.`,
      )
    }
    if (!response.ok || Buffer.byteLength(body, 'utf8') > 10_000_000) {
      throw new Error('Could not read the Shared skill from GitHub. Nothing changed.')
    }
  }
  try {
    return asRecord(JSON.parse(body) as unknown)
  } catch {
    throw new Error('GitHub returned invalid JSON')
  }
}

async function pathExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function safeRelativePath(path: string) {
  if (!path || isAbsolute(path) || path.includes('\\')) return false
  const normalized = normalizeRelativePath(path)
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../')
}

function normalizeRelativePath(path: string) {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/\/{2,}/gu, '/')
    .replace(/\/$/u, '')
}

function isInside(root: string, candidate: string) {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}
