import { createHash } from 'node:crypto'

export function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

export function opaqueId(namespace: string, ...parts: readonly string[]) {
  return sha256([namespace, ...parts].join('\u0000'))
}

/**
 * Orders strings by Unicode code point. `localeCompare` depends on the ICU data and the
 * `LANG` of the machine that runs it, so it cannot feed a fingerprint or a stable sort.
 */
export function compareCodePoints(left: string, right: string) {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex) ?? 0
    const rightPoint = right.codePointAt(rightIndex) ?? 0
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1
    leftIndex += leftPoint > 0xffff ? 2 : 1
    rightIndex += rightPoint > 0xffff ? 2 : 1
  }
  if (leftIndex < left.length) return 1
  if (rightIndex < right.length) return -1
  return 0
}

export type SkillFingerprintFile = {
  contents: Uint8Array
  path: string
}

const textExtensions = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.toml',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
])

/** True when the extension marks a file as text, or when it has no extension to decide by. */
export function mayBeTextSkillFile(path: string) {
  const extension = fileExtension(path)
  return extension === null || textExtensions.has(extension)
}

/**
 * Text files get their line endings normalized before hashing so a checkout with `autocrlf`
 * fingerprints like the same skill on a Unix machine. Files without an extension count as text
 * unless they contain a NUL byte. Everything else is hashed byte for byte.
 */
export function isTextSkillFile(path: string, contents: Uint8Array) {
  const extension = fileExtension(path)
  if (extension !== null) return textExtensions.has(extension)
  return !contents.includes(0)
}

export function normalizeLineEndings(contents: Uint8Array): Uint8Array {
  if (!contents.includes(13)) return contents
  const normalized = new Uint8Array(contents.length)
  let length = 0
  for (let index = 0; index < contents.length; index += 1) {
    const byte = contents[index]
    if (byte === undefined) break
    if (byte === 13 && contents[index + 1] === 10) continue
    normalized[length] = byte
    length += 1
  }
  return normalized.subarray(0, length)
}

/** The bytes a skill file contributes to its fingerprint. */
export function fingerprintBytes(path: string, contents: Uint8Array) {
  return isTextSkillFile(path, contents) ? normalizeLineEndings(contents) : contents
}

/**
 * One incremental skill fingerprint. Callers add files in `compareCodePoints` order of their
 * POSIX-relative paths; `fingerprintSkillFiles` does that for in-memory file lists.
 */
export function skillFingerprintHasher() {
  const hash = createHash('sha256')
  const frame = (path: string) => {
    hash.update(`${Buffer.byteLength(path, 'utf8')}:`)
    hash.update(path)
    hash.update(':')
  }
  return {
    /** CRLF normalization with bounded memory, including CR/LF split across stream chunks. */
    async addTextFile(path: string, chunks: AsyncIterable<Uint8Array>) {
      frame(path)
      let pendingCr = false
      for await (const chunk of chunks) {
        if (chunk.length === 0) continue
        if (pendingCr && chunk[0] !== 10) hash.update('\r')
        pendingCr = chunk.at(-1) === 13
        const body = pendingCr ? chunk.subarray(0, -1) : chunk
        hash.update(normalizeLineEndings(body))
      }
      if (pendingCr) hash.update('\r')
      hash.update('\u0000')
    },
    /** Hashes a file byte for byte. Only for files `mayBeTextSkillFile` rejects. */
    async addBinaryFile(path: string, chunks: AsyncIterable<Uint8Array>) {
      frame(path)
      for await (const chunk of chunks) hash.update(chunk)
      hash.update('\u0000')
    },
    addFile(path: string, contents: Uint8Array) {
      frame(path)
      hash.update(fingerprintBytes(path, contents))
      hash.update('\u0000')
    },
    digest() {
      return hash.digest('hex')
    },
  }
}

export function fingerprintSkillFiles(files: readonly SkillFingerprintFile[]) {
  const hasher = skillFingerprintHasher()
  for (const file of files.toSorted((left, right) => compareCodePoints(left.path, right.path))) {
    hasher.addFile(file.path, file.contents)
  }
  return hasher.digest()
}

function fileExtension(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : null
}
