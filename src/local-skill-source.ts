import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { compareCodePoints, fingerprintSkillFiles } from './hash.js'
import { isIgnoredDirectoryName, isIgnoredFileName } from './inventory.js'
import type { LocalSkill } from './types.js'

const maxFiles = 100
const maxBytes = 2_000_000

/** `.env` and `.env.*` hold secrets more often than not; the upload is refused, not filtered. */
export function isSecretEnvFile(name: string) {
  return name === '.env' || name.startsWith('.env.')
}

export function secretFileRefusal(path: string) {
  return `The skill contains ${path}, which may hold secrets. Remove it before sharing. Nothing changed.`
}

export type LocalSkillFile = {
  contents: Uint8Array
  executable: boolean
  path: string
}

export function selectActionSkill(
  skills: readonly LocalSkill[],
  input: { fingerprint: string; name: string },
) {
  const candidates = [
    ...new Map(
      skills
        .filter((skill) => skill.name === input.name && skill.fingerprint === input.fingerprint)
        .map((skill) => [skill.realDirectory, skill]),
    ).values(),
  ]
  const selected = candidates.toSorted((left, right) =>
    left.realDirectory.localeCompare(right.realDirectory),
  )[0]
  if (!selected) {
    throw new Error(
      `This machine does not have the selected version of ${input.name}. Nothing changed.`,
    )
  }
  return selected
}

export async function loadLocalSkillFiles(skill: LocalSkill): Promise<LocalSkillFile[]> {
  const files: LocalSkillFile[] = []
  const queue = [skill.realDirectory]
  let bytes = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (!isInside(skill.realDirectory, path)) {
        throw new Error('The skill contains an unsafe path. Nothing changed.')
      }
      if (entry.isSymbolicLink()) {
        throw new Error('Skills with symbolic links cannot be added to a repository.')
      }
      if (entry.isDirectory()) {
        // The inventory fingerprint skips these too; the upload must match it file for file.
        if (!isIgnoredDirectoryName(entry.name)) queue.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (isIgnoredFileName(entry.name)) continue
      const relativePath = toPosix(relative(skill.realDirectory, path))
      if (isSecretEnvFile(entry.name)) throw new Error(secretFileRefusal(relativePath))
      const stats = await lstat(path)
      const contents = Uint8Array.from(await readFile(path))
      bytes += contents.byteLength
      files.push({
        contents,
        executable: (stats.mode & 0o111) !== 0,
        path: relativePath,
      })
      if (files.length > maxFiles) throw new Error(`Skills may contain at most ${maxFiles} files`)
      if (bytes > maxBytes) throw new Error('The skill is larger than the 2 MB action limit')
    }
  }
  const sorted = files.toSorted((left, right) => compareCodePoints(left.path, right.path))
  if (!sorted.some((file) => file.path === 'SKILL.md')) {
    throw new Error('The selected skill does not contain SKILL.md')
  }
  // The same fingerprint the inventory computed (line endings normalized, code-point order), so
  // a CRLF checkout or a mixed-case tree does not read as "changed during preparation".
  if (fingerprintSkillFiles(sorted) !== skill.fingerprint) {
    throw new Error('The selected skill changed during preparation. Run the action again.')
  }
  return sorted
}

function toPosix(path: string) {
  return path.split(sep).join('/')
}

function isInside(root: string, candidate: string) {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}
