import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type CliContext, runCli } from './cli.js'
import { readLinkedConfig, sharedConfigWarning, writeLinkedConfig } from './config.js'
import { defaultMachineLabel } from './device.js'
import { notLinkedMessage } from './team-link.js'

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** What undici throws when a connection is refused: a TypeError with the system error as cause. */
function connectionRefused() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
      code: 'ECONNREFUSED',
    }),
  })
}

describe('device link and push', () => {
  it('links an identifiable machine and stores the token in a private config file', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'trce-link-'))
    const configFile = join(temporary, '.trce', 'config.json')
    const now = new Date('2026-08-20T12:00:00.000Z')
    const openedUrls: string[] = []
    const requests: Array<{ body: unknown; url: string }> = []
    let polls = 0
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ body: JSON.parse(String(init?.body)) as unknown, url })
      if (url.endsWith('/start')) {
        return Response.json(
          { code: 'ABCDEFG', deviceId: 'device-fixture', expiresAt: now.getTime() + 60_000 },
          { status: 201 },
        )
      }
      polls += 1
      return Response.json(
        polls === 1 ? { status: 'pending' } : { status: 'approved', token: 'trce_dev_fixture' },
      )
    }

    const result = await runCli(['init', '--no-hooks', '--url', 'http://localhost:3000'], {
      configFile,
      fetch: fetch as typeof globalThis.fetch,
      homeDirectory: temporary,
      machineName: 'Tairs-MacBook-Pro.local',
      now,
      openUrl: async (url) => {
        openedUrls.push(url)
        return true
      },
      platform: 'fixture-os',
      sleep: async () => {
        now.setTime(now.getTime() + 1500)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Machine  Tairs-MacBook-Pro · fixture-os')
    expect(result.stdout).toContain('Code     ABCDEFG')
    expect(result.stdout).toContain('Open     http://localhost:3000/setup?code=ABCDEFG')
    expect(result.stdout).toContain(
      'Sign in with GitHub, then confirm this machine in your browser.',
    )
    expect(result.stdout).toContain('✓ Opened the confirmation page in your browser\n')
    expect(result.stdout).toContain('✓ Machine linked\n')
    expect(result.stdout).toContain('Hooks skipped · Run `trce push` to push by hand.')
    expect(openedUrls).toEqual(['http://localhost:3000/setup?code=ABCDEFG'])
    expect(requests[0]?.body).toEqual({ label: 'Tairs-MacBook-Pro', platform: 'fixture-os' })
    expect(JSON.stringify(requests)).not.toContain(temporary)
    expect(await readLinkedConfig(configFile)).toMatchObject({
      baseUrl: 'http://localhost:3000',
      deviceId: 'device-fixture',
      token: 'trce_dev_fixture',
    })
  })

  it('derives a compact machine label with a platform fallback', () => {
    expect(defaultMachineLabel('Tairs-MacBook-Pro.local', 'darwin')).toBe('Tairs-MacBook-Pro')
    expect(defaultMachineLabel('  build-runner.internal  ', 'linux')).toBe('build-runner')
    expect(defaultMachineLabel('', 'linux')).toBe('Linux machine')
  })

  it('supports headless linking without calling the browser opener', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'trce-headless-link-'))
    const now = new Date('2026-08-20T12:00:00.000Z')
    let openerCalls = 0
    const result = await runCli(
      ['init', '--no-browser', '--no-hooks', '--url', 'http://localhost:3000'],
      {
        configFile: join(temporary, '.trce', 'config.json'),
        fetch: (async (input: string | URL | Request) => {
          if (String(input).endsWith('/start')) {
            return Response.json(
              { code: 'ABCDEFG', deviceId: 'device-fixture', expiresAt: now.getTime() + 60_000 },
              { status: 201 },
            )
          }
          return Response.json({ status: 'approved', token: 'trce_dev_fixture' })
        }) as typeof globalThis.fetch,
        homeDirectory: temporary,
        machineName: 'build-runner',
        now,
        openUrl: async () => {
          openerCalls += 1
          return true
        },
        sleep: async () => {
          now.setTime(now.getTime() + 1500)
        },
        platform: 'darwin',
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Machine  build-runner · macOS')
    expect(result.stdout).toContain('Code     ABCDEFG')
    expect(result.stdout).toContain('Open     http://localhost:3000/setup?code=ABCDEFG')
    expect(result.stdout).not.toContain('Opened the confirmation page')
    expect(openerCalls).toBe(0)
  })

  it('installs hooks on an already linked laptop without creating another device', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'trce-hooks-only-'))
    const configFile = join(temporary, '.trce', 'config.json')
    await writeLinkedConfig(configFile, {
      baseUrl: 'http://localhost:3000',
      deviceId: 'device-fixture',
      linkedAt: '2026-08-20T12:00:00.000Z',
      token: 'trce_dev_fixture',
      version: 1,
    })
    let fetchCalls = 0

    const result = await runCli(['init', '--hooks-only'], {
      configFile,
      executable: '/fixture/node',
      fetch: (async () => {
        fetchCalls += 1
        throw new Error('Hooks-only setup must not contact the dashboard')
      }) as typeof globalThis.fetch,
      homeDirectory: temporary,
      scriptPath: '/fixture/trce/dist/bin.js',
    })

    expect(result).toEqual({
      exitCode: 0,
      stderr: '',
      stdout:
        '✓ Hooks installed · Claude installed · Codex installed\nAfter each session, the hook pushes in the background. Nothing to run by hand.\n',
    })
    expect(fetchCalls).toBe(0)
    expect(await readFile(join(temporary, '.claude', 'settings.json'), 'utf8')).toContain(
      'trce-hook-v1',
    )
    expect(await readFile(join(temporary, '.codex', 'config.toml'), 'utf8')).toContain('notify =')
  })

  it('refuses hooks-only setup before the laptop is linked', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'trce-hooks-unlinked-'))
    await expect(
      runCli(['init', '--hooks-only'], { env: {}, homeDirectory: temporary }),
    ).resolves.toEqual({
      exitCode: 2,
      stderr: notLinkedMessage('trce', 'https://trce.sh'),
      stdout: '',
    })
  })

  it('keeps a beta link readable from skills.json and writes config.json from then on', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'trce-config-fallback-'))
    const legacy = join(temporary, '.trce', 'skills.json')
    const current = join(temporary, '.trce', 'config.json')
    await writeLinkedConfig(legacy, {
      baseUrl: 'http://localhost:3000',
      deviceId: 'device-beta',
      linkedAt: '2026-08-20T12:00:00.000Z',
      token: 'trce_beta_token',
      version: 1,
    })

    // A beta machine still counts as linked: the gate reads skills.json when config.json is absent.
    await expect(readLinkedConfig(current)).resolves.toMatchObject({ deviceId: 'device-beta' })
    const { configFile: _ignored, ...withoutConfigFile } = await pushContext()
    const gated = await runCli(['push', '--dry-run'], {
      ...withoutConfigFile,
      homeDirectory: temporary,
    })
    expect(gated.exitCode).toBe(0)
    await expect(stat(current)).rejects.toMatchObject({ code: 'ENOENT' })

    // Relinking writes config.json only; skills.json is never written again.
    const legacyBefore = await readFile(legacy, 'utf8')
    const now = new Date('2026-08-20T12:00:00.000Z')
    const relinked = await runCli(
      ['init', '--no-hooks', '--no-browser', '--url', 'http://localhost:3000'],
      {
        env: {},
        fetch: (async (input: string | URL | Request) => {
          if (String(input).endsWith('/start')) {
            return Response.json(
              { code: 'ABCDEFG', deviceId: 'device-new', expiresAt: now.getTime() + 60_000 },
              { status: 201 },
            )
          }
          return Response.json({ status: 'approved', token: 'trce_new_token' })
        }) as typeof globalThis.fetch,
        homeDirectory: temporary,
        now,
        sleep: async () => {
          now.setTime(now.getTime() + 1500)
        },
      },
    )
    expect(relinked.exitCode).toBe(0)
    await expect(readLinkedConfig(current)).resolves.toMatchObject({ deviceId: 'device-new' })
    expect(await readFile(legacy, 'utf8')).toBe(legacyBefore)
    // config.json now wins over the stale beta file.
    await expect(readLinkedConfig(current)).resolves.toMatchObject({ token: 'trce_new_token' })
  })

  it('warns once when the config file is readable by other users', async () => {
    if (process.platform === 'win32') return
    const temporary = await mkdtemp(join(tmpdir(), 'trce-config-mode-'))
    const configFile = join(temporary, '.trce', 'config.json')
    await writeLinkedConfig(configFile, {
      baseUrl: 'http://localhost:3000',
      deviceId: 'device-fixture',
      linkedAt: '2026-08-20T12:00:00.000Z',
      token: 'trce_dev_fixture',
      version: 1,
    })
    await chmod(configFile, 0o644)
    const warnings: string[] = []
    const context = { configFile, homeDirectory: temporary, warn: (m: string) => warnings.push(m) }

    const first = await runCli(['push', '--dry-run'], { ...(await pushContext()), ...context })
    const second = await runCli(['push', '--dry-run'], { ...(await pushContext()), ...context })

    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
    expect(warnings).toEqual([
      '~/.trce/config.json is readable by other users. Run chmod 600 ~/.trce/config.json.',
    ])
    expect(sharedConfigWarning('/x/.trce/config.json', '/x')).toBe(warnings[0])
    expect(first.stderr).toBe('')
  })

  it('names the configured origin in the not-linked hint', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'trce-unlinked-origin-'))
    const base = { configFile: join(temporary, 'missing.json'), homeDirectory: temporary }

    const publicHint = await runCli(['push'], { ...base, env: {} })
    const selfHosted = await runCli(['push'], {
      ...base,
      env: { TRCE_URL: 'http://localhost:3000/' },
    })

    expect(publicHint.exitCode).toBe(2)
    expect(publicHint.stderr).toContain('confirm at https://trce.sh/setup.')
    expect(selfHosted.exitCode).toBe(2)
    expect(selfHosted.stderr).toContain('confirm at http://localhost:3000/setup.')
    expect(selfHosted.stderr).not.toContain('trce.sh')
  })

  it('allows plain http only for loopback hosts unless --insecure-http is passed', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'trce-insecure-http-'))
    let starts = 0
    const fetch = (async () => {
      starts += 1
      return Response.json({ status: 'expired' })
    }) as typeof globalThis.fetch
    const warnings: string[] = []
    const base = {
      configFile: join(temporary, '.trce', 'config.json'),
      env: {},
      fetch,
      homeDirectory: temporary,
      warn: (message: string) => warnings.push(message),
    }

    const refused = await runCli(
      ['init', '--no-hooks', '--no-browser', '--url', 'http://dashboard.internal:3000'],
      base,
    )
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toBe(
      'http://dashboard.internal:3000 is plain http and not localhost, so the machine token would travel unencrypted. Use https, or pass --insecure-http to allow it.\n',
    )
    expect(starts).toBe(0)

    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const loopback = await runCli(['init', '--no-hooks', '--no-browser', '--url', url], base)
      expect(loopback.stderr).not.toContain('plain http')
    }
    expect(starts).toBe(3)
    expect(warnings).toEqual([])

    const allowed = await runCli(
      [
        'init',
        '--no-hooks',
        '--no-browser',
        '--url=http://dashboard.internal:3000',
        '--insecure-http',
      ],
      base,
    )
    expect(allowed.stderr).not.toContain('plain http and not localhost')
    expect(starts).toBe(4)
    expect(warnings).toEqual([
      '! http://dashboard.internal:3000 is plain http: the machine token travels unencrypted.',
    ])

    // TRCE_URL is validated the same way as --url.
    const viaEnv = await runCli(['init', '--no-hooks', '--no-browser'], {
      ...base,
      env: { TRCE_URL: 'http://dashboard.internal:3000' },
    })
    expect(viaEnv.exitCode).toBe(1)
    expect(viaEnv.stderr).toContain('pass --insecure-http')
  })

  it('fails closed with a hint when no connected repository is active', async () => {
    const context = await pushContext()
    let ingestCalls = 0
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/device/scope')) {
        return Response.json({
          catalogRepositories: [],
          repositories: [],
          version: 'team-repositories@1',
        })
      }
      ingestCalls += 1
      throw new Error(`Unexpected request: ${String(input)}`)
    }) as typeof globalThis.fetch
    const refusal = {
      exitCode: 1,
      stderr:
        'Nothing to push: this team has no connected repositories. Connect one at http://localhost:3000/repositories, then push again.\n',
      stdout: '',
    }

    await expect(runCli(['push'], { ...context, fetch })).resolves.toEqual(refusal)
    await expect(runCli(['push', '--dry-run'], { ...context, fetch })).resolves.toEqual(refusal)
    expect(ingestCalls).toBe(0)
  })

  it('fails closed on an unreachable, unsupported, or inconsistent scope', async () => {
    const context = await pushContext()
    let ingestCalls = 0
    const scopeFetch = (answer: () => Response | Promise<Response>) =>
      (async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/device/scope')) return answer()
        ingestCalls += 1
        throw new Error(`Unexpected request: ${String(input)}`)
      }) as typeof globalThis.fetch
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      [
        'Could not load the team reporting scope from http://localhost:3000 (connection refused). Nothing was sent.',
        () => Promise.reject(connectionRefused()),
      ],
      [
        'Could not load the team reporting scope from http://localhost:3000 (timed out). Nothing was sent.',
        () => Promise.reject(new DOMException('The operation was aborted', 'TimeoutError')),
      ],
      [
        'Could not load the team reporting scope from http://localhost:3000 (HTTP 401: invalid_device_token). Nothing was sent.',
        () => Response.json({ error: 'invalid_device_token' }, { status: 401 }),
      ],
      [
        // Server-provided text is printed without control characters or escape sequences.
        'Could not load the team reporting scope from http://localhost:3000 (HTTP 500: bad thing). Nothing was sent.',
        () => Response.json({ error: 'bad\u001B[31m thing\u0007\n' }, { status: 500 }),
      ],
      [
        'The dashboard at http://localhost:3000 returned an unsupported reporting scope. Nothing was sent.',
        () =>
          Response.json({
            catalogRepositories: [],
            repositories: ['acme/app'],
            version: 'team-repositories@2',
          }),
      ],
      [
        'The dashboard at http://localhost:3000 returned an invalid reporting scope. Nothing was sent.',
        () =>
          Response.json({
            catalogRepositories: [],
            repositories: ['acme/app', 7],
            version: 'team-repositories@1',
          }),
      ],
      [
        'The dashboard at http://localhost:3000 returned an invalid shared-library scope. Nothing was sent.',
        () =>
          Response.json({
            catalogRepositories: ['acme/other'],
            repositories: ['acme/app'],
            version: 'team-repositories@1',
          }),
      ],
    ]

    for (const [message, answer] of cases) {
      for (const args of [['push'], ['push', '--dry-run']]) {
        const result = await runCli(args, {
          ...context,
          fetch: scopeFetch(answer),
          sleep: async () => undefined,
        })
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(message)
        expect(result.stdout).toBe('')
      }
    }
    expect(ingestCalls).toBe(0)
  })

  it('sends byte-for-byte what dry-run prints', async () => {
    const context = await pushContext()
    const dryRun = await runCli(['push', '--dry-run'], context)
    let sentBody = ''
    let authorization = ''
    const inits: RequestInit[] = []
    const result = await runCli(['push'], {
      ...context,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init) inits.push(init)
        if (String(input).endsWith('/api/device/scope')) return scopeResponse()
        sentBody = String(init?.body)
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return Response.json({
          batchId: 'batch-fixture',
          invocations: 4,
          sessions: 2,
          skills: 5,
        })
      }) as typeof globalThis.fetch,
    })

    expect(result.stdout).toBe('✓ Report pushed\n  5 skills · 2 sessions · 4 calls\n')
    expect(sentBody).toBe(dryRun.stdout)
    expect(authorization).toBe('Bearer trce_dev_fixture')
    expect(sentBody).not.toContain('trce_dev_fixture')
    // Every token-bearing request times out and refuses redirects.
    expect(inits).toHaveLength(2)
    for (const init of inits) {
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.signal?.aborted).toBe(false)
    }
    // A dashboard that predates the pending list leaves no file behind.
    await expect(stat(pendingFile(context))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shows honest progress for manual pushes and keeps hook pushes silent', async () => {
    const context = await pushContext()
    const manualProgress: string[] = []
    const dryRunProgress: string[] = []
    const hookProgress: string[] = []

    await runCli(['push'], {
      ...context,
      fetch: ingestFetch([]),
      onStatus: (message) => manualProgress.push(String(message)),
    })
    await runCli(['push', '--dry-run'], {
      ...context,
      onStatus: (message) => dryRunProgress.push(String(message)),
    })
    await runCli(['push', '--quiet'], {
      ...context,
      fetch: ingestFetch([]),
      onStatus: (message) => hookProgress.push(String(message)),
    })

    expect(manualProgress).toEqual([
      'Loading team scope…',
      'Scanning skills and local session history…',
      'Sending report…',
    ])
    expect(dryRunProgress).toEqual([
      'Loading team scope…',
      'Scanning skills and local session history…',
    ])
    expect(hookProgress).toEqual([])
  })

  it('stores the changes waiting for this machine from the push response and prints them first', async () => {
    const context = await pushContext()
    const pending = {
      command:
        'npx @trce/cli promote test-triage --pr --repo acme/skills-library --distribution shared --action a1b2c3',
      id: 'a1b2c3',
      kind: 'share',
      skillName: 'test-triage',
      targetRepository: 'acme/skills-library',
    }
    const result = await runCli(['push'], {
      ...context,
      commandPrefix: 'npx @trce/cli',
      fetch: ingestFetch([pending]),
    })

    expect(result).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: [
        '1 change is waiting for this machine',
        '  Share test-triage with the team → run: npx @trce/cli promote test-triage --pr --repo acme/skills-library --distribution shared --action a1b2c3',
        '',
        '✓ Report pushed',
        '  5 skills · 2 sessions · 4 calls',
        '',
      ].join('\n'),
    })
    expect(JSON.parse(await readFile(pendingFile(context), 'utf8'))).toEqual({
      actions: [pending],
      fetchedAt: '2026-08-20T11:05:00.000Z',
      version: 1,
    })
    if (process.platform !== 'win32') {
      expect((await stat(pendingFile(context))).mode & 0o777).toBe(0o600)
    }

    // The silent hook push refreshes the file without printing anything.
    const quiet = await runCli(['push', '--quiet'], {
      ...context,
      fetch: ingestFetch([
        pending,
        { ...pending, id: 'b2c3d4', command: pending.command.replace('a1b2c3', 'b2c3d4') },
      ]),
    })
    expect(quiet).toEqual({ exitCode: 0, stderr: '', stdout: '' })
    expect(JSON.parse(await readFile(pendingFile(context), 'utf8'))).toMatchObject({
      actions: [{ id: 'a1b2c3' }, { id: 'b2c3d4' }],
    })

    // An empty list clears the file; nothing waiting prints nothing extra.
    const cleared = await runCli(['push'], { ...context, fetch: ingestFetch([]) })
    expect(cleared.stdout).toBe('✓ Report pushed\n  5 skills · 2 sessions · 4 calls\n')
    await expect(stat(pendingFile(context))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a pending list outside the allowlisted shape', async () => {
    const context = await pushContext()
    const result = await runCli(['push'], {
      ...context,
      fetch: ingestFetch([
        {
          command: 'npx @trce/cli promote test-triage --pr --repo acme/web --action a1b2c3',
          id: 'a1b2c3',
          kind: 'add',
          skillName: 'test-triage',
          targetRepository: 'acme/web',
          body: 'must never reach the laptop',
        },
      ]),
    })
    expect(result).toEqual({
      exitCode: 1,
      stderr: 'The dashboard at http://localhost:3000 returned an invalid ingest result.\n',
      stdout: '',
    })
    await expect(stat(pendingFile(context))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never writes the pending file on a dry run', async () => {
    const context = await pushContext()
    const pending = {
      command: 'npx @trce/cli unify pr-review --pr --repo acme/app --action d4e5f6',
      id: 'd4e5f6',
      kind: 'standardize',
      skillName: 'pr-review',
      targetRepository: 'acme/app',
    }
    let ingestCalls = 0
    const dryRun = await runCli(['push', '--dry-run'], {
      ...context,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/api/device/scope')) return scopeResponse()
        ingestCalls += 1
        return ingestFetch([pending])(input, init)
      }) as typeof globalThis.fetch,
    })

    expect(dryRun.exitCode).toBe(0)
    expect(dryRun.stdout.startsWith('{')).toBe(true)
    expect(dryRun.stdout).not.toContain('waiting for this machine')
    expect(ingestCalls).toBe(0)
    await expect(stat(pendingFile(context))).rejects.toMatchObject({ code: 'ENOENT' })

    // Even with a file already present, dry-run output stays the exact request body.
    await runCli(['push'], { ...context, fetch: ingestFetch([pending]) })
    const again = await runCli(['push', '--dry-run'], context)
    expect(again.stdout).toBe(dryRun.stdout)
  })
})

describe('push resilience', () => {
  it('pluralizes the push summary for a single-session replay', async () => {
    const context = await pushContext()
    const result = await runCli(['push'], {
      ...context,
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/device/scope')) return scopeResponse()
        return Response.json({ batchId: 'batch-fixture', invocations: 0, sessions: 1, skills: 1 })
      }) as typeof globalThis.fetch,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('✓ Report pushed\n  1 skill · 1 session · 0 calls\n')
  })

  it('retries one transient connection failure after 2 s and then pushes', async () => {
    const context = await pushContext()
    const sleeps: number[] = []
    let failed = false
    const result = await runCli(['push'], {
      ...context,
      fetch: (async (input: string | URL | Request) => {
        if (!failed) {
          failed = true
          throw new TypeError('fetch failed')
        }
        if (String(input).endsWith('/api/device/scope')) return scopeResponse()
        return Response.json({ batchId: 'batch-fixture', invocations: 4, sessions: 2, skills: 5 })
      }) as typeof globalThis.fetch,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    })

    expect(sleeps).toEqual([2000])
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).toBe('✓ Report pushed\n  5 skills · 2 sessions · 4 calls\n')
  })

  it('keeps the exact messages when the connection fails twice', async () => {
    const context = await pushContext()
    const scopeSleeps: number[] = []
    const scopeDown = await runCli(['push'], {
      ...context,
      fetch: (async () => {
        throw connectionRefused()
      }) as typeof globalThis.fetch,
      sleep: async (milliseconds) => {
        scopeSleeps.push(milliseconds)
      },
    })
    expect(scopeSleeps).toEqual([2000])
    expect(scopeDown.exitCode).toBe(1)
    expect(scopeDown.stderr).toBe(
      'Could not load the team reporting scope from http://localhost:3000 (connection refused). Nothing was sent.\n',
    )

    const ingestSleeps: number[] = []
    const ingestDown = await runCli(['push'], {
      ...context,
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/device/scope')) return scopeResponse()
        throw connectionRefused()
      }) as typeof globalThis.fetch,
      sleep: async (milliseconds) => {
        ingestSleeps.push(milliseconds)
      },
    })
    expect(ingestSleeps).toEqual([2000])
    expect(ingestDown.exitCode).toBe(1)
    expect(ingestDown.stderr).toBe(
      'Could not push the report to http://localhost:3000 (connection refused).\n',
    )

    const rejected = await runCli(['push'], {
      ...context,
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/device/scope')) return scopeResponse()
        return Response.json({ error: 'payload_too_large' }, { status: 413 })
      }) as typeof globalThis.fetch,
    })
    expect(rejected.stderr).toBe(
      'Could not push the report to http://localhost:3000 (HTTP 413: payload_too_large).\n',
    )
  })

  it('refuses a redirect from the dashboard instead of following it with the token', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no server address')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      const context = await pushContext()
      await writeFile(
        context.configFile ?? '',
        JSON.stringify({
          baseUrl: origin,
          deviceId: 'device-fixture',
          linkedAt: '2026-08-20T11:00:00.000Z',
          token: 'trce_dev_fixture',
          version: 1,
        }),
        { mode: 0o600 },
      )
      const result = await runCli(['push', '--dry-run'], {
        ...context,
        fetch: globalThis.fetch,
        sleep: async () => undefined,
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe(
        `Could not load the team reporting scope from ${origin} (redirect refused). Nothing was sent.\n`,
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('lets push override the linked origin with --url or TRCE_URL like init', async () => {
    const context = await pushContext()
    const urls: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return scopeResponse()
    }) as typeof globalThis.fetch

    await runCli(['push', '--dry-run', '--url', 'http://127.0.0.1:4000'], { ...context, fetch })
    await runCli(['push', '--dry-run'], {
      ...context,
      env: { TRCE_URL: 'http://localhost:5000' },
      fetch,
    })
    await runCli(['push', '--dry-run'], { ...context, env: {}, fetch })

    expect(urls).toEqual([
      'http://127.0.0.1:4000/api/device/scope',
      'http://localhost:5000/api/device/scope',
      'http://localhost:3000/api/device/scope',
    ])
    const insecure = await runCli(['push', '--dry-run', '--url', 'http://dashboard.internal'], {
      ...context,
      fetch,
    })
    expect(insecure.exitCode).toBe(1)
    expect(insecure.stderr).toContain('pass --insecure-http')
    expect(urls).toHaveLength(3)
  })

  it('retries the shared-install scope fetch once before answering', async () => {
    const context = await pushContext()
    const sleeps: number[] = []
    let failed = false
    const result = await runCli(
      ['add', 'acme/skills-library:.trce/skills/test-triage', '--shared', '--dry-run'],
      {
        ...context,
        fetch: (async () => {
          if (!failed) {
            failed = true
            throw new TypeError('fetch failed')
          }
          return scopeResponse()
        }) as typeof globalThis.fetch,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
        },
      },
    )

    // The retry reached the dashboard: the answer is the normal role refusal, not a network error.
    expect(sleeps).toEqual([2000])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('does not have the Skills library role')
  })
})

function pendingFile(context: CliContext) {
  return join(dirname(context.configFile ?? ''), 'pending.json')
}

function ingestFetch(pendingActions: unknown[]) {
  return (async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/device/scope')) return scopeResponse()
    if (!String(input).endsWith('/api/ingest'))
      throw new Error(`Unexpected request: ${String(input)}`)
    return Response.json({
      batchId: 'batch-fixture',
      invocations: 4,
      kind: 'accepted',
      pendingActions,
      sessions: 2,
      skills: 5,
    })
  }) as typeof globalThis.fetch
}

async function pushContext(): Promise<CliContext> {
  const temporary = await mkdtemp(join(tmpdir(), 'trce-push-'))
  const claudeDirectory = join(temporary, 'claude')
  const codexDirectory = join(temporary, 'codex')
  const projectDirectory = join(temporary, 'project')
  const configFile = join(temporary, '.trce', 'config.json')
  await Promise.all([
    mkdir(claudeDirectory, { recursive: true }),
    mkdir(codexDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(join(temporary, '.trce'), { recursive: true }),
  ])
  await Promise.all([
    copyFile(
      join(fixtureRoot, 'parsers', 'claude-session.jsonl'),
      join(claudeDirectory, 'session.jsonl'),
    ),
    copyFile(
      join(fixtureRoot, 'parsers', 'codex-session.jsonl'),
      join(codexDirectory, 'rollout.jsonl'),
    ),
    writeFile(
      configFile,
      JSON.stringify({
        baseUrl: 'http://localhost:3000',
        deviceId: 'device-fixture',
        linkedAt: '2026-08-20T11:00:00.000Z',
        token: 'trce_dev_fixture',
        version: 1,
      }),
      { mode: 0o600 },
    ),
  ])
  return {
    claudeProjectsDirectory: claudeDirectory,
    codexSessionsDirectory: codexDirectory,
    configFile,
    cwd: projectDirectory,
    env: { LC_ALL: 'en_US.UTF-8', WT_SESSION: 'trce-test-terminal' },
    homeDirectory: join(fixtureRoot, 'home-synthetic'),
    now: new Date('2026-08-20T11:05:00.000Z'),
    fetch: (async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/device/scope')) return scopeResponse()
      throw new Error(`Unexpected request: ${String(input)}`)
    }) as typeof globalThis.fetch,
    repositorySlugForCwd: async () => 'acme/app',
  }
}

function scopeResponse() {
  return Response.json({
    catalogRepositories: [],
    repositories: ['acme/app'],
    version: 'team-repositories@1',
  })
}
