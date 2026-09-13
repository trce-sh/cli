import { sep } from 'node:path'

export type UnknownRecord = Record<string, unknown>

export function asRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

export function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function booleanValue(value: unknown) {
  return typeof value === 'boolean' ? value : null
}

export function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function isoTimestamp(value: unknown) {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString()
}

export function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : []
}

export function parseJsonLine(line: string) {
  try {
    return { kind: 'parsed' as const, value: JSON.parse(line) as unknown }
  } catch {
    return { kind: 'invalid' as const }
  }
}

/**
 * Terminal display width. East Asian wide and fullwidth characters, CJK ideographs, Hangul, and
 * emoji presentation take two cells; combining marks, zero-width joiners, and variation selectors
 * take none; ANSI color and OSC 8 hyperlink sequences are invisible. Used wherever padding or
 * truncation would otherwise trust `.length`.
 */
export function displayWidth(value: string) {
  let width = 0
  let previousWidth = 0
  for (const character of stripTerminalSequences(value)) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === emojiPresentationSelector) {
      if (previousWidth === 1) width += 1
      previousWidth = 2
      continue
    }
    const characterWidth = codePointWidth(codePoint)
    width += characterWidth
    previousWidth = characterWidth
  }
  return width
}

/** The longest prefix (by code points) whose display width fits in `width`. */
export function takeDisplayPrefix(value: string, width: number) {
  let taken = ''
  for (const character of value) {
    const candidate = `${taken}${character}`
    if (displayWidth(candidate) > width) break
    taken = candidate
  }
  return taken
}

/** The longest suffix (by code points) whose display width fits in `width`. */
export function takeDisplaySuffix(value: string, width: number) {
  let taken = ''
  for (const character of Array.from(value).toReversed()) {
    const candidate = `${character}${taken}`
    if (displayWidth(candidate) > width) break
    taken = candidate
  }
  return taken
}

export function padDisplayEnd(value: string, width: number) {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`
}

export function padDisplayStart(value: string, width: number) {
  return `${' '.repeat(Math.max(0, width - displayWidth(value)))}${value}`
}

const emojiPresentationSelector = 0xfe0f
const escapeCharacter = String.fromCharCode(27)
const bell = String.fromCharCode(7)
const terminalSequencePattern = new RegExp(
  `${escapeCharacter}\\[[0-9;]*m|${escapeCharacter}\\]8;;[^${escapeCharacter}${bell}]*(?:${escapeCharacter}\\\\|${bell})`,
  'gu',
)

function stripTerminalSequences(value: string) {
  return value.replaceAll(terminalSequencePattern, '')
}

type CodePointRange = readonly [number, number]

const zeroWidthRanges: readonly CodePointRange[] = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x200b, 0x200f], // zero-width space, joiners, direction marks
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0x1f3fb, 0x1f3ff], // emoji skin tone modifiers
  [0xe0100, 0xe01ef], // variation selectors supplement
]

const wideRanges: readonly CodePointRange[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, ideographic description, CJK punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility, enclosed CJK
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // miscellaneous symbols and pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport and map symbols
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff], // symbols and pictographs extended-A
  [0x20000, 0x3fffd], // CJK unified ideographs extensions B and later
]

function codePointWidth(codePoint: number) {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  if (inRanges(codePoint, zeroWidthRanges)) return 0
  return inRanges(codePoint, wideRanges) ? 2 : 1
}

function inRanges(codePoint: number, ranges: readonly CodePointRange[]) {
  return ranges.some(([from, to]) => codePoint >= from && codePoint <= to)
}

/**
 * `~/.claude/projects` for a path under the home directory, otherwise the path unchanged. Every
 * user-facing message that names a local file goes through this so terminals and pasted bug
 * reports never carry the user name.
 */
export function homeRelativePath(path: string, homeDirectory: string | undefined) {
  if (!homeDirectory) return path
  if (path === homeDirectory) return '~'
  const prefix = homeDirectory.endsWith(sep) ? homeDirectory : `${homeDirectory}${sep}`
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length).split(sep).join('/')}` : path
}
