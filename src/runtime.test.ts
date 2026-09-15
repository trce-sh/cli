import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.js'
import { createRuntimeContext, ignoreClosedPipes, main, type RuntimeStream } from './runtime.js'
import * as background from './terminal-background.js'

function stream(isTTY: boolean) {
  const writes: string[] = []
  const target: RuntimeStream = { isTTY, write: (value) => writes.push(value) }
  return { target, writes }
}

function runtime(stdoutIsTTY: boolean) {
  const stdout = stream(stdoutIsTTY)
  const stderr = stream(false)
  return {
    process: {
      argv: ['/usr/bin/node', '/fixture/trce/dist/bin.js'],
      env: { LC_ALL: 'en_US.UTF-8' } as NodeJS.ProcessEnv,
      execPath: '/usr/bin/node',
      platform: 'linux' as const,
      stderr: stderr.target,
      stdout: stdout.target,
    },
    stderr,
    stdout,
  }
}

const inactiveStatus = { stop() {}, update() {} }

describe('process runtime', () => {
  it.each(['report', 'dedupe', 'diff', 'push'])(
    'does not query the terminal for %s help or JSON',
    async (command) => {
      const detect = vi.spyOn(background, 'detectTerminalBackground').mockResolvedValue(null)
      try {
        const tty = runtime(true)
        tty.process.argv.push(command, '--json', '--help')
        await main(tty.process)
        expect(detect).not.toHaveBeenCalled()
      } finally {
        detect.mockRestore()
      }
    },
  )

  it('prints the device code right away on stderr when stdout is not a terminal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trce-runtime-init-'))
    const piped = runtime(false)
    const { context, finish } = createRuntimeContext(piped.process, inactiveStatus)
    const now = new Date('2026-08-20T12:00:00.000Z')
    let stderrAtPoll = ''
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/start')) {
        return Response.json(
          { code: 'ABCDEFG', deviceId: 'device-fixture', expiresAt: now.getTime() + 60_000 },
          { status: 201 },
        )
      }
      // By the first poll the code has already been written, not deferred to the end.
      stderrAtPoll = piped.stderr.writes.join('')
      return Response.json({ status: 'expired' })
    }) as typeof globalThis.fetch

    const result = await runCli(
      ['init', '--no-hooks', '--no-browser', '--url', 'http://localhost:3000'],
      {
        ...context,
        fetch,
        homeDirectory: home,
        machineName: 'build-runner',
        now,
        sleep: async () => {
          now.setTime(now.getTime() + 1500)
        },
      },
    )
    finish(result)

    expect(context.interactive).toBe(false)
    expect(context.color).toBe(false)
    expect(stderrAtPoll).toContain('Code     ABCDEFG')
    expect(stderrAtPoll).toContain('Open     http://localhost:3000/setup?code=ABCDEFG')
    expect(piped.stdout.writes.join('')).toBe('')
    expect(result.exitCode).toBe(1)
    expect(piped.stderr.writes.at(-1)).toContain('The code expired before it was confirmed.')
  })

  it('prints progress on stdout in a terminal and keeps the status line on stderr', async () => {
    const tty = runtime(true)
    const stops: string[] = []
    const { context } = createRuntimeContext(tty.process, {
      stop: () => stops.push('stop'),
      update: (message) => stops.push(`update:${message}`),
    })

    context.onProgress?.('hello')
    context.onStatus?.('Scanning…')
    context.warn?.('careful')

    expect(context.interactive).toBe(true)
    expect(tty.stdout.writes).toEqual(['hello\n'])
    expect(tty.stderr.writes).toEqual(['careful\n'])
    expect(stops).toEqual(['stop', 'update:Scanning…', 'stop'])
  })

  it('exits 0 instead of throwing when a reader closes the pipe', async () => {
    const exits: number[] = []
    const closed = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      },
    })
    ignoreClosedPipes([closed], (code) => exits.push(code))

    closed.write('{"version":"local-report@1"}\n')
    await new Promise((resolve) => setImmediate(resolve))

    expect(exits).toEqual([0])

    // Any other stream error still surfaces.
    const other = new EventEmitter()
    ignoreClosedPipes([other], (code) => exits.push(code))
    expect(() => other.emit('error', Object.assign(new Error('boom'), { code: 'EIO' }))).toThrow(
      'boom',
    )
    expect(exits).toEqual([0])
  })
})
