import { describe, expect, it } from 'vitest'
import { detectTerminalBackground, parseBackgroundReply } from './terminal-background.js'

const esc = String.fromCharCode(27)

describe('parseBackgroundReply', () => {
  it('reads light and dark backgrounds at any component width', () => {
    expect(parseBackgroundReply(`${esc}]11;rgb:ffff/ffff/ffff${esc}\\`)).toBe('light')
    expect(parseBackgroundReply(`${esc}]11;rgb:0f0f/0f0f/1414${esc}\\`)).toBe('dark')
    expect(parseBackgroundReply(`${esc}]11;rgb:f5/f4/f7${esc}\\`)).toBe('light')
    expect(parseBackgroundReply(`${esc}]11;rgb:ffff/ffff/ffff`)).toBeNull()
    expect(parseBackgroundReply(`${esc}]11;rgb:f/f/f${String.fromCharCode(7)}`)).toBe('light')
    expect(parseBackgroundReply('nothing here')).toBeNull()
  })
})

describe('detectTerminalBackground', () => {
  it('skips pipes without touching the streams', async () => {
    let wrote = ''
    const result = await detectTerminalBackground({
      stdin: { isTTY: false, off() {}, on() {}, pause() {}, resume() {} },
      stdout: { isTTY: false, write: (value) => (wrote += value) },
    })
    expect(result).toBeNull()
    expect(wrote).toBe('')
  })

  it('asks, reads the reply, and restores the terminal', async () => {
    const handlers: { data: ((chunk: Buffer | string) => void) | undefined } = { data: undefined }
    const modes: boolean[] = []
    let wrote = ''
    const stdin = {
      isRaw: false,
      isTTY: true,
      off() {
        handlers.data = undefined
      },
      on(_event: 'data', next: (chunk: Buffer | string) => void) {
        handlers.data = next
      },
      pause() {},
      resume() {},
      setRawMode(mode: boolean) {
        modes.push(mode)
      },
    }
    const pending = detectTerminalBackground({
      stdin,
      stdout: { isTTY: true, write: (value) => (wrote += value) },
    })
    expect(wrote).toBe(`${esc}]11;?${esc}\\`)
    handlers.data?.(`${esc}]11;rgb:ffff/ffff/0`)
    expect(modes).toEqual([true])
    handlers.data?.(`000${esc}\\`)
    expect(await pending).toBe('light')
    expect(modes).toEqual([true, false])
  })

  it('gives up after the timeout', async () => {
    const result = await detectTerminalBackground({
      stdin: { isTTY: true, off() {}, on() {}, pause() {}, resume() {}, setRawMode() {} },
      stdout: { isTTY: true, write() {} },
      timeoutMs: 5,
    })
    expect(result).toBeNull()
  })
})
