import { cliVersion } from './meta.js'

export type ColorLevel = 'none' | '256' | 'truecolor'
export type TerminalBackground = 'dark' | 'light'
export type TerminalTone = 'accent' | 'danger' | 'dim' | 'faint' | 'strong' | 'success' | 'warning'

type Environment = Readonly<Record<string, string | undefined>>
type TerminalContext = { env?: Environment; isTTY?: boolean }

type Rgb = readonly [number, number, number]
type Swatch = { index: number; rgb: Rgb }

/**
 * Indigo accent: `#635bff` on light backgrounds, `#9d98ff` on dark. The other tones read on both.
 * `index` is the nearest xterm-256 color for terminals without truecolor.
 */
const swatches: Record<Exclude<TerminalTone, 'strong'>, Record<TerminalBackground, Swatch>> = {
  accent: {
    dark: { index: 99, rgb: [157, 152, 255] },
    light: { index: 62, rgb: [99, 91, 255] },
  },
  danger: {
    dark: { index: 167, rgb: [221, 95, 85] },
    light: { index: 124, rgb: [185, 58, 48] },
  },
  dim: {
    dark: { index: 245, rgb: [145, 142, 137] },
    light: { index: 242, rgb: [107, 104, 117] },
  },
  /** Quieter than `dim`: the empty part of a bar, the line a trace has not reached yet. */
  faint: {
    dark: { index: 239, rgb: [78, 76, 84] },
    light: { index: 250, rgb: [188, 186, 192] },
  },
  success: {
    dark: { index: 71, rgb: [86, 179, 102] },
    light: { index: 28, rgb: [47, 125, 63] },
  },
  warning: {
    dark: { index: 214, rgb: [255, 157, 54] },
    light: { index: 130, rgb: [179, 90, 0] },
  },
}

const bold = '\u001B[1m'
const reset = '\u001B[0m'
const osc8 = '\u001B]8;;'
const stringTerminator = '\u001B\\'

/**
 * Color decision, most explicit signal first:
 *
 * 1. `NO_COLOR` set (any value) → none. Nothing overrides a user who asked for no color.
 * 2. `FORCE_COLOR` set to anything but `0` → on, even when stdout is a pipe (CI logs, `less -R`).
 *    `FORCE_COLOR=0` reads as an explicit no.
 * 3. `TERM=dumb` → none.
 * 4. Otherwise stdout must be a TTY. `CI` on its own changes nothing: runners that want color set
 *    `FORCE_COLOR`, and the rest have no TTY, so the TTY rule already turns color off for them.
 *
 * Depth is a separate question, see `colorDepth`.
 */
export function colorLevel({
  env = process.env,
  isTTY = process.stdout.isTTY === true,
}: TerminalContext = {}): ColorLevel {
  if (env.NO_COLOR !== undefined) return 'none'
  const force = env.FORCE_COLOR
  if (force !== undefined) return force === '0' ? 'none' : colorDepth(env)
  if (env.TERM === 'dumb' || !isTTY) return 'none'
  return colorDepth(env)
}

/**
 * Truecolor only when the terminal says so (`COLORTERM=truecolor` or `24bit`). Everything else
 * gets 256-color codes, which every terminal from the last two decades renders.
 */
export function colorDepth(env: Environment = process.env): Exclude<ColorLevel, 'none'> {
  const colorterm = env.COLORTERM?.toLowerCase()
  return colorterm === 'truecolor' || colorterm === '24bit' ? 'truecolor' : '256'
}

let detectedBackground: TerminalBackground | null = null

/** Records what the terminal answered when asked for its background; see `runtime.ts`. */
export function setTerminalBackground(background: TerminalBackground | null) {
  detectedBackground = background
}

/**
 * Light or dark, so the palette can pick tones that read on the actual background. A detected
 * answer wins; otherwise `COLORFGBG`, which a few terminals set; otherwise dark, the common case.
 */
export function terminalBackground(env: Environment = process.env): TerminalBackground {
  if (detectedBackground) return detectedBackground
  const value = env.COLORFGBG
  if (!value) return 'dark'
  const background = Number(value.split(';').at(-1))
  if (!Number.isInteger(background)) return 'dark'
  return background === 7 || background >= 9 ? 'light' : 'dark'
}

export function supportsColor(context: TerminalContext = {}) {
  return colorLevel(context) !== 'none'
}

/**
 * OSC 8 hyperlinks follow the color rules plus a real TTY: `FORCE_COLOR` may push color into a
 * pipe for CI logs, but a hyperlink escape in a log file is only noise.
 */
export function supportsHyperlinks({
  env = process.env,
  isTTY = process.stdout.isTTY === true,
}: TerminalContext = {}) {
  return isTTY && colorLevel({ env, isTTY }) !== 'none'
}

/**
 * Plain ASCII glyphs when the terminal probably cannot draw the Unicode ones: the legacy Windows
 * console (Windows Terminal sets `WT_SESSION` and is fine), or a locale that is not UTF-8
 * (`LC_ALL`, then `LC_CTYPE`, then `LANG`; unset means we trust the terminal).
 */
export function asciiMode({
  env = process.env,
  platform = process.platform,
}: {
  env?: Environment
  platform?: NodeJS.Platform
} = {}) {
  if (platform === 'win32' && !env.WT_SESSION) return true
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG
  return locale !== undefined && locale !== '' && !/utf-?8/iu.test(locale)
}

export type Glyphs = {
  arrow: string
  bar: string
  /** Filled cell of a proportion bar. */
  block: string
  /** A finished progress line. */
  check: string
  /** Light cell of a proportion bar: installed, no calls. */
  blockLight: string
  both: string
  called: string
  corners: { bottomLeft: string; bottomRight: string; topLeft: string; topRight: string }
  dot: string
  ellipsis: string
  gte: string
  noCalls: string
  notMeasured: string
  range: string
  rule: string
  /** Hatched cell of a proportion bar: the part that could not be measured. */
  shade: string
  spinner: readonly string[]
  /** Cell of a per-row call bar. */
  tick: string
  /**
   * The trace mark from the wordmark, two rows of six cells: a faint expected line on top, the
   * trace leaving the lower dot and joining it. `faint` cells print quieter than `trace` cells.
   */
  trace: { faint: string; top: string; bottom: string }
}

const unicodeGlyphs: Glyphs = {
  arrow: '→',
  bar: '│',
  block: '█',
  blockLight: '░',
  both: '↔',
  check: '✓',
  called: '●',
  corners: { bottomLeft: '└', bottomRight: '┘', topLeft: '┌', topRight: '┐' },
  dot: '·',
  ellipsis: '…',
  gte: '≥',
  noCalls: '○',
  notMeasured: '?',
  range: '–',
  rule: '─',
  shade: '▒',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  tick: '▇',
  trace: { faint: '○──', top: '╭─●', bottom: '●──╯' },
}

const asciiGlyphs: Glyphs = {
  arrow: '->',
  bar: '|',
  block: '#',
  blockLight: '-',
  both: '<->',
  check: '+',
  called: '*',
  corners: { bottomLeft: '+', bottomRight: '+', topLeft: '+', topRight: '+' },
  dot: '-',
  ellipsis: '...',
  gte: '>=',
  noCalls: 'o',
  notMeasured: '?',
  range: '-',
  rule: '-',
  shade: '?',
  spinner: ['-', '\\', '|', '/'],
  tick: '#',
  trace: { faint: 'o--', top: '+-*', bottom: '*--+' },
}

export function glyphs(ascii = asciiMode()): Glyphs {
  return ascii ? asciiGlyphs : unicodeGlyphs
}

function openCode(
  tone: TerminalTone,
  depth: Exclude<ColorLevel, 'none'>,
  background: TerminalBackground,
) {
  if (tone === 'strong') return bold
  const swatch = swatches[tone][background]
  return depth === 'truecolor'
    ? `\u001B[38;2;${swatch.rgb.join(';')}m`
    : `\u001B[38;5;${swatch.index}m`
}

/**
 * `color` says whether to emit codes at all; the codes themselves follow the terminal's depth and
 * background. `strong` is bold in the default foreground, so it reads on light terminals too.
 */
export function terminalText(
  value: string,
  tone: TerminalTone,
  { color = supportsColor() }: { color?: boolean } = {},
) {
  if (!color) return value
  return `${openCode(tone, colorDepth(), terminalBackground())}${value}${reset}`
}

export function terminalLink(
  url: string,
  {
    color = supportsColor(),
    hyperlinks = supportsHyperlinks(),
    label = url,
    tone = 'accent',
  }: {
    color?: boolean
    hyperlinks?: boolean
    label?: string
    tone?: TerminalTone
  } = {},
) {
  const styledLabel = terminalText(label, tone, { color })
  if (!hyperlinks) return styledLabel
  return `${osc8}${url}${stringTerminator}${styledLabel}${osc8}${stringTerminator}`
}

export function brand({
  ascii = asciiMode(),
  color = supportsColor(),
  hyperlinks = supportsHyperlinks(),
  traceProgress = 1,
}: {
  ascii?: boolean
  color?: boolean
  hyperlinks?: boolean
  /** 0 to 1: how much of the trace has been drawn; the reveal animates this. */
  traceProgress?: number
} = {}) {
  if (!color) return 'trce'
  const mark = glyphs(ascii).trace
  const link = terminalLink('https://trce.sh', {
    color,
    hyperlinks,
    label: 'trce.sh',
    tone: 'accent',
  })
  const tagline = terminalText('Review system for your agent skills', 'strong', { color })
  const version = terminalText(`CLI ${glyphs(ascii).dot} ${cliVersion}`, 'dim', { color })
  const markWidth = mark.faint.length + mark.top.length
  const gap = '   '
  const textColumn = ' '.repeat(markWidth + gap.length)
  // The trace draws from the lower dot, up the curve, then along the top to the target dot.
  const drawn = Math.round(
    Math.max(0, Math.min(1, traceProgress)) * (mark.bottom.length + mark.top.length),
  )
  const bottom = mark.bottom.slice(0, drawn).padEnd(mark.bottom.length)
  const top = mark.top.slice(0, Math.max(0, drawn - mark.bottom.length)).padEnd(mark.top.length)
  return [
    `${terminalText(mark.faint, 'faint', { color })}${terminalText(top, 'strong', { color })}${gap}${link}`,
    `${terminalText(bottom, 'strong', { color })}${' '.repeat(markWidth - mark.bottom.length)}${gap}${tagline}`,
    `${textColumn}${version}`,
  ].join('\n')
}
