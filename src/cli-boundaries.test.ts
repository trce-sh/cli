import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.js'
import { writeLinkedConfig } from './config.js'

describe('command and credential failure boundaries', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    'rejects inherited command %s even with help',
    async (command) => {
      const result = await runCli([command, '--help'], { color: false })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(`Unknown command: ${command}`)
    },
  )

  it('does not fall back to a stale credential when the new config is unreadable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trce-link-failure-'))
    try {
      await writeLinkedConfig(join(home, '.trce', 'skills.json'), {
        baseUrl: 'http://localhost:3000',
        deviceId: 'fixture',
        linkedAt: '2026-09-06T00:00:00Z',
        token: 'synthetic-stale-token',
        version: 1,
      })
      await mkdir(join(home, '.trce', 'config.json'))
      const fetch = vi.fn(async () => Response.json({}))
      const result = await runCli(['push'], { homeDirectory: home, env: {}, fetch })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Could not read ~/.trce/config.json')
      expect(result.stderr).not.toContain(home)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
