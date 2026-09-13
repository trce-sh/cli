import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { asRecord, homeRelativePath, isoTimestamp, stringValue } from './value.js'

export type LinkedConfig = {
  baseUrl: string
  deviceId: string
  linkedAt: string
  token: string
  version: 1
}

export const configFileName = 'config.json'
/** The beta file name. Read when `config.json` is absent; never written again. */
export const legacyConfigFileName = 'skills.json'

export function configPath(homeDirectory: string) {
  return join(homeDirectory, '.trce', configFileName)
}

export type ReadLinkedConfigOptions = {
  /** Used to print the file home-relative in the permission warning. */
  homeDirectory?: string
  /** Receives the permission warning; defaults to stderr. */
  warn?: (message: string) => void
}

/** Paths already warned about in this process; the warning prints once, like ssh's. */
const warnedPaths = new Set<string>()

export async function readLinkedConfig(
  path: string,
  options: ReadLinkedConfigOptions = {},
): Promise<LinkedConfig | null> {
  let text = await readTextOrNull(path, options.homeDirectory)
  let readPath = path
  if (text === null && basename(path) === configFileName) {
    readPath = join(dirname(path), legacyConfigFileName)
    text = await readTextOrNull(readPath, options.homeDirectory)
  }
  if (text === null) return null
  await warnIfShared(readPath, options)
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return null
  }
  const record = asRecord(value)
  const baseUrl = normalizedBaseUrl(stringValue(record?.baseUrl))
  const deviceId = stringValue(record?.deviceId)
  const linkedAt = isoTimestamp(record?.linkedAt)
  const token = stringValue(record?.token)
  if (record?.version !== 1 || !baseUrl || !deviceId || !linkedAt || !token) return null
  return { baseUrl, deviceId, linkedAt, token, version: 1 }
}

export function sharedConfigWarning(path: string, homeDirectory: string | undefined) {
  const shown = homeRelativePath(path, homeDirectory)
  return `${shown} is readable by other users. Run chmod 600 ${shown}.`
}

async function warnIfShared(path: string, options: ReadLinkedConfigOptions) {
  if (process.platform === 'win32' || warnedPaths.has(path)) return
  let mode: number
  try {
    mode = (await stat(path)).mode
  } catch {
    return
  }
  if ((mode & 0o077) === 0) return
  warnedPaths.add(path)
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`))
  warn(sharedConfigWarning(path, options.homeDirectory))
}

async function readTextOrNull(path: string, homeDirectory: string | undefined) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') return null
    throw new Error(
      `Could not read ${homeRelativePath(path, homeDirectory)}. Check its permissions and file type.`,
    )
  }
}

/** Writes the link to `path` (`config.json`) atomically with owner-only permissions. */
export async function writeLinkedConfig(path: string, config: LinkedConfig) {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await mkdir(directory, { mode: 0o700, recursive: true })
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

export function normalizedBaseUrl(value: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    return url.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

/** `localhost`, `127.0.0.0/8`, and `::1`: the only hosts allowed plain `http://` by default. */
export function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
}
