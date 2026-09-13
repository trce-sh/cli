import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isCodingAgentId } from './coding-agents.js'
import type { HarnessName, TeamCatalogProvenance } from './types.js'
import { asRecord, homeRelativePath, isoTimestamp, stringValue } from './value.js'

export type InstallDistribution = 'private' | 'team_catalog'

export type ManagedInstallTarget = {
  harness: HarnessName
  path: string
}

export type ManagedInstall = {
  distribution: InstallDistribution
  fingerprint: string
  installedAt: string
  /** Local executable-mode state, separate from the dashboard's content fingerprint. */
  modeFingerprint?: string
  name: string
  source: {
    path: string
    ref: string
    repository: string
    resolvedRef: string
  }
  targets: ManagedInstallTarget[]
  updatedAt: string
}

export type InstallManifest = {
  installs: ManagedInstall[]
  pendingEvents: DistributionEvent[]
  version: 1
}

export type DistributionEvent = {
  fingerprint: string
  harnesses: HarnessName[]
  id: string
  kind: 'installed' | 'removed' | 'updated'
  name: string
  occurredAt: string
  previousFingerprint: string | null
  sourceRepo: string
}

export function installManifestPath(homeDirectory: string) {
  return join(homeDirectory, '.trce', 'installs.json')
}

/** Serialize file changes and manifest read-modify-write across CLI processes and hook pushes. */
export async function withInstallLock<T>(homeDirectory: string, operation: () => Promise<T>) {
  const directory = join(homeDirectory, '.trce')
  const lock = join(directory, 'installs.lock')
  await mkdir(directory, { mode: 0o700, recursive: true })
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if (asRecord(error)?.code !== 'EEXIST') throw error
    throw new Error(
      'Install records are locked by another or interrupted trce operation. Retry after it finishes. ' +
        'If no trce command is running, remove ~/.trce/installs.lock and retry.',
    )
  }
  try {
    return await operation()
  } finally {
    await rmdir(lock)
  }
}

export async function readInstallManifest(homeDirectory: string): Promise<InstallManifest> {
  const path = installManifestPath(homeDirectory)
  const unreadable = `Could not read ${homeRelativePath(path, homeDirectory)}. Nothing changed.`
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') {
      return { installs: [], pendingEvents: [], version: 1 }
    }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error(unreadable)
  }
  const record = asRecord(value)
  if (record?.version !== 1 || !Array.isArray(record.installs)) {
    throw new Error(unreadable)
  }
  const installs = record.installs.map(parseManagedInstall)
  const pendingEvents = Array.isArray(record.pendingEvents)
    ? record.pendingEvents.map(parseDistributionEvent)
    : null
  if (
    !installs.every((install): install is ManagedInstall => install !== null) ||
    pendingEvents === null ||
    !pendingEvents.every((event): event is DistributionEvent => event !== null)
  ) {
    throw new Error(unreadable)
  }
  const names = new Set(installs.map((install) => install.name))
  const targets = installs.flatMap((install) => install.targets.map((target) => target.path))
  if (names.size !== installs.length || new Set(targets).size !== targets.length) {
    throw new Error(unreadable)
  }
  return { installs, pendingEvents, version: 1 }
}

export async function writeInstallManifest(homeDirectory: string, manifest: InstallManifest) {
  const path = installManifestPath(homeDirectory)
  const directory = dirname(path)
  const temporary = join(directory, `.installs.${process.pid}.${Date.now()}.tmp`)
  await mkdir(directory, { mode: 0o700, recursive: true })
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

export function provenanceForDirectory(
  manifest: InstallManifest,
  directory: string,
): TeamCatalogProvenance | null {
  const install = manifest.installs.find(
    (candidate) =>
      candidate.distribution === 'team_catalog' &&
      candidate.targets.some((target) => target.path === directory),
  )
  return install
    ? {
        kind: 'team_catalog',
        path: install.source.path,
        ref: install.source.resolvedRef,
        repository: install.source.repository,
      }
    : null
}

export async function clearInstallEvents(homeDirectory: string, eventIds: ReadonlySet<string>) {
  if (eventIds.size === 0) return
  await withInstallLock(homeDirectory, async () => {
    const manifest = await readInstallManifest(homeDirectory)
    const pendingEvents = manifest.pendingEvents.filter((event) => !eventIds.has(event.id))
    if (pendingEvents.length === manifest.pendingEvents.length) return
    await writeInstallManifest(homeDirectory, { ...manifest, pendingEvents })
  })
}

function parseManagedInstall(value: unknown): ManagedInstall | null {
  const record = asRecord(value)
  const distribution = record?.distribution
  const fingerprint = stringValue(record?.fingerprint)
  const installedAt = isoTimestamp(record?.installedAt)
  const modeFingerprint = stringValue(record?.modeFingerprint)
  const name = stringValue(record?.name)
  const source = asRecord(record?.source)
  const path = stringValue(source?.path)
  const ref = stringValue(source?.ref)
  const repository = stringValue(source?.repository)
  const storedResolvedRef = stringValue(source?.resolvedRef)
  const updatedAt = isoTimestamp(record?.updatedAt)
  if (
    (distribution !== 'private' && distribution !== 'team_catalog') ||
    !fingerprint ||
    !installedAt ||
    !name ||
    !path ||
    !ref ||
    !repository ||
    !updatedAt ||
    !Array.isArray(record?.targets) ||
    (record.modeFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(modeFingerprint ?? ''))
  ) {
    return null
  }
  const targets = record.targets.flatMap<ManagedInstallTarget>((candidate) => {
    const target = asRecord(candidate)
    const harness = target?.harness
    const targetPath = stringValue(target?.path)
    return typeof harness === 'string' && isCodingAgentId(harness) && targetPath
      ? [{ harness, path: targetPath }]
      : []
  })
  if (targets.length === 0) return null
  const resolvedRef = storedResolvedRef ?? ref
  return {
    distribution,
    fingerprint,
    installedAt,
    ...(modeFingerprint ? { modeFingerprint } : {}),
    name,
    source: { path, ref, repository, resolvedRef },
    targets,
    updatedAt,
  }
}

function parseDistributionEvent(value: unknown): DistributionEvent | null {
  const record = asRecord(value)
  const fingerprint = stringValue(record?.fingerprint)
  const id = stringValue(record?.id)
  const kind = record?.kind
  const name = stringValue(record?.name)
  const occurredAt = isoTimestamp(record?.occurredAt)
  const previousFingerprint =
    record?.previousFingerprint === null ? null : stringValue(record?.previousFingerprint)
  const sourceRepo = stringValue(record?.sourceRepo)
  const harnesses = Array.isArray(record?.harnesses)
    ? record.harnesses.filter(
        (harness): harness is HarnessName =>
          typeof harness === 'string' && isCodingAgentId(harness),
      )
    : []
  if (
    !fingerprint ||
    !id ||
    (kind !== 'installed' && kind !== 'removed' && kind !== 'updated') ||
    !name ||
    !occurredAt ||
    previousFingerprint === undefined ||
    !sourceRepo ||
    harnesses.length === 0
  ) {
    return null
  }
  return {
    fingerprint,
    harnesses,
    id,
    kind,
    name,
    occurredAt,
    previousFingerprint,
    sourceRepo,
  }
}
