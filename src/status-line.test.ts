import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalStatusLine } from './status-line.js'
import { displayWidth } from './value.js'

const clearLine = `\r${String.fromCharCode(27)}[2K`

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function withStderrTTY(isTTY: boolean, run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: isTTY })
  try {
    run()
  } finally {
    if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor)
    else Reflect.deleteProperty(process.stderr, 'isTTY')
  }
}

describe('terminal status line', () => {
  it('animates one bounded line, updates its stage, and clears on stop', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T08:00:00.000Z'))
    const writes: string[] = []
    const status = createTerminalStatusLine({
      ascii: false,
      color: false,
      stream: { columns: 42, write: (value) => writes.push(value) },
    })

    status.update('Loading team scope…')
    expect(writes.at(-1)).toBe(`${clearLine}⠋ Loading team scope…`)

    vi.advanceTimersByTime(1200)
    expect(writes.at(-1)).toBe(`${clearLine}⠹ Loading team scope… 1s`)

    status.update('Scanning skills and local session history…')
    expect(writes.at(-1)).toBe(`${clearLine}⠹ Scanning skills and local session h… 1s`)

    status.stop()
    expect(writes.at(-1)).toBe(clearLine)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('normalizes multiline status text before rendering it', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const status = createTerminalStatusLine({
      ascii: false,
      color: false,
      stream: { write: (value) => writes.push(value) },
    })

    status.update('Waiting\nfor   confirmation…')

    expect(writes.at(-1)).toBe(`${clearLine}⠋ Waiting for confirmation…`)
    status.stop()
  })

  it('uses ASCII spinner frames and ellipsis in ascii mode', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const status = createTerminalStatusLine({
      ascii: true,
      color: false,
      stream: { columns: 20, write: (value) => writes.push(value) },
    })

    status.update('Loading')
    expect(writes.at(-1)).toBe(`${clearLine}- Loading`)

    vi.advanceTimersByTime(100)
    expect(writes.at(-1)).toBe(`${clearLine}\\ Loading`)

    status.update('Scanning skills and local session history')
    expect(writes.at(-1)).toBe(`${clearLine}\\ Scanning skill...`)
    status.stop()
  })

  it('truncates by display width so wide characters never overflow the line', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const status = createTerminalStatusLine({
      ascii: false,
      color: false,
      stream: { columns: 20, write: (value) => writes.push(value) },
    })

    status.update('日本語のスキルを読み込み中です')
    const line = (writes.at(-1) ?? '').replace(clearLine, '')

    expect(displayWidth(line)).toBeLessThanOrEqual(20)
    expect(line.endsWith('…')).toBe(true)
    status.stop()
  })

  it('writes to stderr by default when stderr is a TTY', () => {
    vi.useFakeTimers()
    const stderrWrites: string[] = []
    const stdoutWrites: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
      stderrWrites.push(String(value))
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      stdoutWrites.push(String(value))
      return true
    })
    withStderrTTY(true, () => {
      const status = createTerminalStatusLine({ ascii: false, color: false })
      status.update('Loading')
      status.stop()
    })

    expect(stderrWrites).toEqual([`${clearLine}⠋ Loading`, clearLine])
    expect(stdoutWrites).toEqual([])
  })

  it('stays silent without a TTY', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const status = createTerminalStatusLine({
      ascii: false,
      color: false,
      stream: { isTTY: false, write: (value) => writes.push(value) },
    })
    status.update('Loading')
    vi.advanceTimersByTime(500)
    status.stop()
    expect(writes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    withStderrTTY(false, () => {
      const silent = createTerminalStatusLine({ ascii: false, color: false })
      silent.update('Loading')
      silent.stop()
    })
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})
