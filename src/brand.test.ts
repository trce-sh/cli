import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../package.json' with { type: 'json' }
import {
  asciiMode,
  brand,
  colorDepth,
  colorLevel,
  glyphs,
  supportsColor,
  supportsHyperlinks,
  terminalBackground,
  terminalLink,
  terminalText,
} from './brand.js'

const esc = String.fromCharCode(27)

afterEach(() => vi.unstubAllEnvs())

describe('terminal branding', () => {
  it('renders the compact lockup and a clickable visible domain in an interactive terminal', () => {
    vi.stubEnv('COLORTERM', 'truecolor')
    vi.stubEnv('COLORFGBG', undefined)
    vi.stubEnv('LC_ALL', 'en_US.UTF-8')
    const output = brand({ color: true, hyperlinks: true })

    expect(output.split('\n')).toHaveLength(3)
    expect(output).toContain(`${esc}[38;2;157;152;255mtrce.sh${esc}[0m`)
    expect(output).toContain(`${esc}[1mReview system for your agent skills${esc}[0m`)
    expect(output).toContain(`CLI · ${manifest.version}`)
    expect(output).toContain(`${esc}]8;;https://trce.sh${esc}\\`)
  })

  it('collapses to deterministic plain text without terminal styling', () => {
    expect(brand({ color: false, hyperlinks: true })).toBe('trce')
    expect(terminalLink('https://trce.sh', { color: false, hyperlinks: false })).toBe(
      'https://trce.sh',
    )
  })
})

describe('color level', () => {
  it('turns color off under NO_COLOR, whatever else is set', () => {
    expect(
      colorLevel({ env: { COLORTERM: 'truecolor', FORCE_COLOR: '1', NO_COLOR: '' }, isTTY: true }),
    ).toBe('none')
    expect(colorLevel({ env: { NO_COLOR: '1' }, isTTY: true })).toBe('none')
  })

  it('forces color into a pipe under FORCE_COLOR, except FORCE_COLOR=0', () => {
    expect(colorLevel({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe('256')
    expect(colorLevel({ env: { FORCE_COLOR: '' }, isTTY: false })).toBe('256')
    expect(colorLevel({ env: { COLORTERM: 'truecolor', FORCE_COLOR: '3' }, isTTY: false })).toBe(
      'truecolor',
    )
    expect(colorLevel({ env: { FORCE_COLOR: '1', TERM: 'dumb' }, isTTY: false })).toBe('256')
    expect(colorLevel({ env: { FORCE_COLOR: '0' }, isTTY: true })).toBe('none')
  })

  it('turns color off for TERM=dumb and for a non-TTY', () => {
    expect(colorLevel({ env: { TERM: 'dumb' }, isTTY: true })).toBe('none')
    expect(colorLevel({ env: {}, isTTY: false })).toBe('none')
    expect(colorLevel({ env: {}, isTTY: true })).toBe('256')
  })

  it('leaves CI on its own to the TTY rule', () => {
    expect(colorLevel({ env: { CI: 'true' }, isTTY: true })).toBe('256')
    expect(colorLevel({ env: { CI: 'true' }, isTTY: false })).toBe('none')
  })

  it('claims truecolor only when COLORTERM says so', () => {
    expect(colorDepth({})).toBe('256')
    expect(colorDepth({ COLORTERM: 'yes' })).toBe('256')
    expect(colorDepth({ COLORTERM: 'truecolor' })).toBe('truecolor')
    expect(colorDepth({ COLORTERM: 'TrueColor' })).toBe('truecolor')
    expect(colorDepth({ COLORTERM: '24bit' })).toBe('truecolor')
  })

  it('keeps hyperlinks on the same rules plus a real TTY', () => {
    expect(supportsColor({ env: {}, isTTY: true })).toBe(true)
    expect(supportsHyperlinks({ env: {}, isTTY: true })).toBe(true)
    expect(supportsColor({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true)
    expect(supportsHyperlinks({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(false)
    expect(supportsColor({ env: { NO_COLOR: '' }, isTTY: true })).toBe(false)
    expect(supportsHyperlinks({ env: { NO_COLOR: '' }, isTTY: true })).toBe(false)
    expect(supportsHyperlinks({ env: { TERM: 'dumb' }, isTTY: true })).toBe(false)
  })

  it('reads the background hint from COLORFGBG and assumes dark otherwise', () => {
    expect(terminalBackground({})).toBe('dark')
    expect(terminalBackground({ COLORFGBG: '' })).toBe('dark')
    expect(terminalBackground({ COLORFGBG: '15;0' })).toBe('dark')
    expect(terminalBackground({ COLORFGBG: '0;8' })).toBe('dark')
    expect(terminalBackground({ COLORFGBG: 'default;default' })).toBe('dark')
    expect(terminalBackground({ COLORFGBG: '0;15' })).toBe('light')
    expect(terminalBackground({ COLORFGBG: '0;7' })).toBe('light')
    expect(terminalBackground({ COLORFGBG: '0;default;15' })).toBe('light')
  })
})

describe('palette', () => {
  it('emits 256-color codes unless the terminal claims truecolor', () => {
    vi.stubEnv('COLORTERM', undefined)
    vi.stubEnv('COLORFGBG', undefined)

    expect(terminalText('x', 'accent', { color: true })).toBe(`${esc}[38;5;99mx${esc}[0m`)
    expect(terminalText('x', 'success', { color: true })).toBe(`${esc}[38;5;71mx${esc}[0m`)
    expect(terminalText('x', 'warning', { color: true })).toBe(`${esc}[38;5;214mx${esc}[0m`)
    expect(terminalText('x', 'danger', { color: true })).toBe(`${esc}[38;5;167mx${esc}[0m`)
    expect(terminalText('x', 'dim', { color: true })).toBe(`${esc}[38;5;245mx${esc}[0m`)
  })

  it('uses the indigo accent for the terminal background', () => {
    vi.stubEnv('COLORTERM', 'truecolor')
    vi.stubEnv('COLORFGBG', undefined)
    expect(terminalText('x', 'accent', { color: true })).toBe(`${esc}[38;2;157;152;255mx${esc}[0m`)

    vi.stubEnv('COLORFGBG', '0;15')
    expect(terminalText('x', 'accent', { color: true })).toBe(`${esc}[38;2;99;91;255mx${esc}[0m`)

    vi.stubEnv('COLORTERM', undefined)
    expect(terminalText('x', 'accent', { color: true })).toBe(`${esc}[38;5;62mx${esc}[0m`)
  })

  it('renders strong as bold in the default foreground', () => {
    vi.stubEnv('COLORTERM', 'truecolor')
    expect(terminalText('x', 'strong', { color: true })).toBe(`${esc}[1mx${esc}[0m`)
    vi.stubEnv('COLORTERM', undefined)
    expect(terminalText('x', 'strong', { color: true })).toBe(`${esc}[1mx${esc}[0m`)
    expect(terminalText('x', 'strong', { color: false })).toBe('x')
  })
})

describe('ascii mode', () => {
  it('falls back on the legacy Windows console but not in Windows Terminal', () => {
    expect(asciiMode({ env: {}, platform: 'win32' })).toBe(true)
    expect(asciiMode({ env: { WT_SESSION: 'abc' }, platform: 'win32' })).toBe(false)
  })

  it('falls back when the locale is not UTF-8 and trusts an unset locale', () => {
    expect(asciiMode({ env: {}, platform: 'linux' })).toBe(false)
    expect(asciiMode({ env: { LANG: '' }, platform: 'linux' })).toBe(false)
    expect(asciiMode({ env: { LANG: 'C' }, platform: 'linux' })).toBe(true)
    expect(asciiMode({ env: { LANG: 'POSIX' }, platform: 'darwin' })).toBe(true)
    expect(asciiMode({ env: { LANG: 'en_US.UTF-8' }, platform: 'linux' })).toBe(false)
    expect(asciiMode({ env: { LANG: 'C.utf8' }, platform: 'linux' })).toBe(false)
    expect(asciiMode({ env: { LANG: 'en_US.UTF-8', LC_ALL: 'C' }, platform: 'linux' })).toBe(true)
    expect(asciiMode({ env: { LANG: 'C', LC_CTYPE: 'en_US.UTF-8' }, platform: 'linux' })).toBe(
      false,
    )
  })

  it('swaps every drawing glyph for an ASCII stand-in', () => {
    const unicode = glyphs(false)
    const ascii = glyphs(true)

    expect(unicode).toMatchObject({ arrow: '→', both: '↔', called: '●', dot: '·', noCalls: '○' })
    expect(ascii).toMatchObject({
      arrow: '->',
      bar: '|',
      both: '<->',
      called: '*',
      corners: { bottomLeft: '+', bottomRight: '+', topLeft: '+', topRight: '+' },
      dot: '-',
      ellipsis: '...',
      gte: '>=',
      noCalls: 'o',
      notMeasured: '?',
      rule: '-',
    })
    expect(ascii.spinner).toEqual(['-', '\\', '|', '/'])
    expect(unicode.spinner).toHaveLength(10)
  })
})
