import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { capabilityBadgesFor, estimateTokens, keywordCategory } from './analysis.js'
import { agentHomes, codingAgentList, resolveAgentRoot } from './coding-agents.js'
import { parseSkillFrontmatter } from './frontmatter.js'
import {
  compareCodePoints,
  isTextSkillFile,
  mayBeTextSkillFile,
  sha256,
  skillFingerprintHasher,
} from './hash.js'
import { provenanceForDirectory, readInstallManifest } from './installs.js'
import type { HarnessName, LintFinding, LocalSkill, SkillSource } from './types.js'

type InventoryRoot = {
  harness: HarnessName
  mode: 'direct' | 'recursive'
  path: string
  repo: string | null
  source: SkillSource
}

type ScanInventoryOptions = {
  /** Environment used to locate relocated agent homes. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  homeDirectory: string
  /** Platform whose filesystem case rules apply to lint. Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  projectDirectory?: string
  projectRepo?: string | null
}

/**
 * Normalize larger text files as streams instead of buffering them. The size threshold must
 * not change a file's fingerprint.
 */
const maxNormalizedTextBytes = 8_000_000

/**
 * Directory names a skill or plugin walk never enters: version control, vendored packages, and
 * hidden directories are not part of a skill's content.
 */
export function isIgnoredDirectoryName(name: string) {
  return name === '.git' || name === 'node_modules' || name.startsWith('.')
}

/**
 * Operating-system litter (`.DS_Store`, `Thumbs.db`) is not skill content: it never enters a
 * fingerprint and never travels with `promote` or `unify`.
 */
export function isIgnoredFileName(name: string) {
  return name === '.DS_Store' || name === 'Thumbs.db'
}

export async function scanInventory(options: ScanInventoryOptions) {
  const roots = inventoryRoots(options)
  const installManifest = await readInstallManifest(options.homeDirectory)
  const platform = options.platform ?? process.platform
  const skills: LocalSkill[] = []
  const seen = new Set<string>()
  const seenContent = new Set<string>()

  for (const root of roots) {
    const directories =
      root.mode === 'direct'
        ? await directSkillDirectories(root.path)
        : await recursiveSkillDirectories(root.path)
    for (const directory of directories) {
      const canonical = await realpathOrNull(directory)
      if (!canonical) continue
      const key = `${root.harness}\u0000${canonical}\u0000${root.source}\u0000${root.repo ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const skill = await readSkill({ directory, installManifest, platform, root })
      if (!skill) continue
      const contentKey = `${skill.harness}\u0000${skill.name}\u0000${skill.fingerprint}\u0000${skill.source}\u0000${skill.repo ?? ''}`
      if (seenContent.has(contentKey)) continue
      seenContent.add(contentKey)
      skills.push(skill)
    }
  }

  return skills.toSorted((left, right) =>
    compareCodePoints(
      `${left.name}:${left.harness}:${left.source}`,
      `${right.name}:${right.harness}:${right.source}`,
    ),
  )
}

function inventoryRoots(options: ScanInventoryOptions): InventoryRoot[] {
  const home = options.homeDirectory
  const homes = agentHomes(options.env ?? process.env, home)
  const roots: InventoryRoot[] = codingAgentList.flatMap((agent) =>
    agent.inventoryRoots.map((root) => ({
      harness: agent.id,
      mode: root.mode,
      path: resolveAgentRoot(homes, home, root),
      repo: null,
      source: root.source,
    })),
  )

  if (options.projectDirectory) {
    roots.push(
      ...codingAgentList.flatMap((agent) =>
        agent.projectRoots.map((path) => ({
          harness: agent.id,
          mode: 'direct' as const,
          path: join(options.projectDirectory ?? '', ...path),
          repo: options.projectRepo ?? null,
          source: 'project' as const,
        })),
      ),
    )
  }
  return roots
}

async function directSkillDirectories(root: string) {
  const entries = await directoryEntries(root)
  const directories: string[] = []
  for (const entry of entries) {
    const candidate = join(root, entry.name)
    if (
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      (await fileExists(join(candidate, 'SKILL.md')))
    ) {
      directories.push(candidate)
    }
  }
  return directories
}

async function recursiveSkillDirectories(root: string) {
  const directories: string[] = []
  const queue = [{ depth: 0, path: root }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || current.depth > 8) continue
    const entries = await directoryEntries(current.path)
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (isIgnoredDirectoryName(entry.name)) continue
      const candidate = join(current.path, entry.name)
      if (await fileExists(join(candidate, 'SKILL.md'))) {
        directories.push(candidate)
      } else if (!entry.isSymbolicLink()) {
        queue.push({ depth: current.depth + 1, path: candidate })
      }
    }
  }
  return directories
}

async function readSkill({
  directory,
  installManifest,
  platform,
  root,
}: {
  directory: string
  installManifest: Awaited<ReturnType<typeof readInstallManifest>>
  platform: NodeJS.Platform
  root: InventoryRoot
}) {
  const realDirectory = await realpathOrNull(directory)
  if (!realDirectory) return null
  const skillMdPath = join(realDirectory, 'SKILL.md')
  let skillMdText: string
  try {
    skillMdText = await readFile(skillMdPath, 'utf8')
  } catch {
    return null
  }

  const files = await regularFiles(realDirectory)
  const fingerprint = await fingerprintFiles(realDirectory, files)
  const frontmatter = parseSkillFrontmatter(skillMdText)
  const directoryName = basename(realDirectory)
  const name = frontmatter.name ?? directoryName
  const lint: LintFinding[] = []
  if (!frontmatter.present) lint.push('no-frontmatter')
  if (!frontmatter.description) lint.push('missing-description')
  if (frontmatter.name && !nameMatchesDirectory(frontmatter.name, directoryName, platform)) {
    lint.push('name-directory-mismatch')
  }
  if (Buffer.byteLength(skillMdText, 'utf8') > 100_000) lint.push('oversized-skill-md')

  const auxiliaryText = await readableAuxiliaryText(realDirectory, files)
  return {
    badges: capabilityBadgesFor({
      fileNames: files.map((file) => toPosix(relative(realDirectory, file))),
      text: `${skillMdText}\n${auxiliaryText}`,
    }),
    category: keywordCategory(name, frontmatter.description),
    definitionTokens: estimateTokens(skillMdText),
    description: frontmatter.description,
    descriptionTokens: estimateTokens(frontmatter.description ?? ''),
    directory,
    fingerprint,
    harness: root.harness,
    lint,
    name,
    provenance: provenanceForDirectory(installManifest, directory),
    realDirectory,
    repo: root.repo,
    skillMdFingerprint: sha256(skillMdText),
    skillMdText,
    source: root.source,
  } satisfies LocalSkill
}

/**
 * macOS and Windows default to case-insensitive filesystems, where `Review` and `review` name
 * the same directory; only a spelling difference is a mismatch there.
 */
export function nameMatchesDirectory(
  name: string,
  directoryName: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (name === directoryName) return true
  if (platform !== 'darwin' && platform !== 'win32') return false
  return name.toLowerCase() === directoryName.toLowerCase()
}

async function regularFiles(root: string) {
  const files: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    for (const entry of await directoryEntries(current)) {
      const candidate = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!isIgnoredDirectoryName(entry.name)) queue.push(candidate)
      } else if (isIgnoredFileName(entry.name)) {
      } else if (entry.isFile() && isInside(root, candidate)) {
        files.push(candidate)
      } else if (entry.isSymbolicLink()) {
        const target = await realpathOrNull(candidate)
        if (target && isInside(root, target) && (await isRegularFile(target))) files.push(candidate)
      }
    }
  }
  return files.toSorted((left, right) =>
    compareCodePoints(toPosix(relative(root, left)), toPosix(relative(root, right))),
  )
}

async function fingerprintFiles(root: string, files: readonly string[]) {
  const hasher = skillFingerprintHasher()
  for (const file of files) {
    const name = toPosix(relative(root, file))
    if (mayBeTextSkillFile(name) && (await fileSize(file)) <= maxNormalizedTextBytes) {
      hasher.addFile(name, await readFile(file))
    } else if (
      mayBeTextSkillFile(name) &&
      (isTextSkillFile(name, Uint8Array.of(0)) || !(await containsNul(file)))
    ) {
      await hasher.addTextFile(name, createReadStream(file))
    } else {
      await hasher.addBinaryFile(name, createReadStream(file))
    }
  }
  return hasher.digest()
}

// Extensionless files are binary if any byte is NUL. Inspect before streaming normalization;
// a late NUL must not leave the beginning of a binary file normalized differently.
async function containsNul(path: string) {
  for await (const chunk of createReadStream(path)) {
    if (Buffer.isBuffer(chunk) && chunk.includes(0)) return true
  }
  return false
}

async function readableAuxiliaryText(root: string, files: readonly string[]) {
  const chunks: string[] = []
  for (const file of files.slice(0, 40)) {
    if (!/\.(?:cjs|js|md|mjs|py|sh|ts|txt)$/u.test(file)) continue
    if (resolve(file) === resolve(join(root, 'SKILL.md'))) continue
    try {
      const stat = await lstat(file)
      if (stat.size <= 256_000) chunks.push(await readFile(file, 'utf8'))
    } catch {
      // A changing auxiliary file should not abort the inventory.
    }
  }
  return chunks.join('\n')
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function fileExists(path: string) {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function isRegularFile(path: string) {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function fileSize(path: string) {
  try {
    return (await stat(path)).size
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

async function realpathOrNull(path: string) {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function isInside(root: string, candidate: string) {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function toPosix(path: string) {
  return path.split(sep).join('/')
}
