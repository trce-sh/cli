import { chmod, copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { terminalLink } from './brand.js'
import { runCli } from './cli.js'
import { writeLinkedConfig } from './config.js'
import { commandHelpText } from './help.js'
import { scanInventory } from './inventory.js'
import { pendingActionsPath, readPendingActions, writePendingActions } from './pending.js'
import { notLinkedMessage } from './team-link.js'

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))
const canDropReadPermission = process.platform !== 'win32' && process.getuid?.() !== 0

/**
 * The goldens must not depend on the developer's shell: a UTF-8 locale, no truecolor hint, no
 * relocated agent homes, no dashboard override. The same env goes into every context and into
 * `process.env` for the few brand helpers that read it directly.
 */
const fixedEnv: NodeJS.ProcessEnv = { LC_ALL: 'en_US.UTF-8', WT_SESSION: 'trce-test-terminal' }

beforeAll(() => {
  vi.stubEnv('LC_ALL', 'en_US.UTF-8')
  for (const name of [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'COLORFGBG',
    'COLORTERM',
    'FORCE_COLOR',
    'NO_COLOR',
    'TRCE_URL',
  ]) {
    vi.stubEnv(name, undefined)
  }
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('offline CLI commands', () => {
  it('matches the synthetic report golden without a team link or server contact', async () => {
    const context = await unlinkedContext()
    let fetchCalls = 0
    const fetch = (async () => {
      fetchCalls += 1
      throw new Error('report must stay offline')
    }) as typeof globalThis.fetch
    const result = await runCli(['report', '--since', '30d'], { ...context, fetch })
    const golden = await readFile(join(fixtureRoot, 'golden', 'report.txt'), 'utf8')

    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: golden })
    expect(fetchCalls).toBe(0)
  })

  it('shows progress for an interactive report without touching JSON output', async () => {
    const context = await fixtureContext()
    const progress: string[] = []
    const withProgress = {
      ...context,
      onStatus: (message: string) => progress.push(message),
    }

    await runCli(['report'], withProgress)
    const json = await runCli(['report', '--json'], withProgress)

    expect(progress).toEqual(['Scanning skills and local session history…'])
    expect(json.stdout.startsWith('{')).toBe(true)

    // The ellipsis follows the locale like every other glyph.
    const ascii: string[] = []
    await runCli(['report'], {
      ...withProgress,
      env: { LC_ALL: 'C' },
      onStatus: (m) => ascii.push(m),
    })
    expect(ascii).toEqual(['Scanning skills and local session history...'])
  })

  it('lists the complete inventory only when requested', async () => {
    const context = await fixtureContext()
    const summary = await runCli(['report'], context)
    const complete = await runCli(['report', '--all'], context)

    expect(summary.stdout).toContain('4 other installations hidden')
    expect(summary.stdout).toContain('No calls · 2')
    expect(summary.stdout).toContain('  code-review')
    expect(summary.stdout.indexOf('Recent activity · 3')).toBeLessThan(
      summary.stdout.indexOf('Needs attention · 1'),
    )
    expect(summary.stdout.indexOf('Needs attention · 1')).toBeLessThan(
      summary.stdout.indexOf('No calls · 2'),
    )
    expect(complete.stdout).toContain('All installations · 10')
    expect(complete.stdout).toContain('  ○ code-review · no calls\n    Claude Code')
    expect(complete.stdout).not.toContain('installations hidden')
  })

  it('reads the terminal width after scanning', async () => {
    const context = await fixtureContext()
    let terminalWidth = 88
    const result = await runCli(['report'], {
      ...context,
      onStatus: () => {
        terminalWidth = 56
      },
      readTerminalWidth: () => terminalWidth,
      terminalWidth: 88,
    })

    expect(result.stdout).toContain('○ code-review · no calls')
    expect(result.stdout).not.toContain('  SKILL')
    expect(result.stdout.split('\n').every((line) => line.length <= 56)).toBe(true)
  })

  it('prints privacy-safe JSON and useful dedupe and diff output', async () => {
    const context = await fixtureContext()
    const report = await runCli(['report', '--json'], context)
    const dedupe = await runCli(['dedupe'], context)
    const diff = await runCli(['diff', 'pr-review'], context)

    expect(report.exitCode).toBe(0)
    expect(JSON.parse(report.stdout)).toMatchObject({ version: 'local-report@1' })
    expect(report.stdout).not.toContain('/fixture/')
    expect(dedupe.stdout).toContain('code-review ↔ pr-review')
    expect(diff.stdout).toContain('--- Claude Code · Personal')
    expect(diff.stdout).toContain('+++ Codex · Personal')
  })

  it('lists the scanned directories when the window holds no sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trce-empty-home-'))
    await mkdir(join(home, '.claude', 'projects'), { recursive: true })
    const configFile = join(home, 'config.json')
    await writeLinkedConfig(configFile, {
      baseUrl: 'http://dashboard.test',
      deviceId: 'device-1',
      linkedAt: '2026-08-20T10:00:00.000Z',
      token: 'device-secret',
      version: 1,
    })

    const empty = await runCli(['report'], {
      color: false,
      commandPrefix: 'trce',
      configFile,
      cwd: home,
      env: fixedEnv,
      homeDirectory: home,
      now: new Date('2026-08-20T11:05:00.000Z'),
      repositorySlugForCwd: async () => null,
    })

    expect(empty.exitCode).toBe(0)
    expect(empty.stdout).toContain(
      'No sessions in the last 30 days\n  ~/.claude/projects  0 sessions · no session files\n  ~/.codex/sessions   0 sessions · no session files\n',
    )
    expect(empty.stdout).toContain('Local only · Nothing was sent.')
    expect(empty.stdout).not.toContain(home)

    const context = await fixtureContext()
    const stale = await runCli(['report', '--since', '1d'], {
      ...context,
      color: false,
      now: new Date('2026-09-20T11:05:00.000Z'),
    })
    const staleJson = await runCli(['report', '--since', '1d', '--json'], {
      ...context,
      now: new Date('2026-09-20T11:05:00.000Z'),
    })

    expect(stale.stdout).toContain('No sessions in the last 1 day')
    expect(stale.stdout).toContain(context.claudeProjectsDirectory)
    expect(stale.stdout).toContain(context.codexSessionsDirectory)
    expect(stale.stdout.match(/0 sessions · 1 session file outside the window/g)).toHaveLength(2)
    expect(JSON.parse(staleJson.stdout)).not.toHaveProperty('historyRoots')
    expect(staleJson.stdout).not.toContain(context.claudeProjectsDirectory)
  })

  it('rejects invalid arguments clearly', async () => {
    const context = await fixtureContext()
    const sinceUsage = '--since takes a number of days like 30d (1d to 3650d)\n'
    await expect(runCli(['report', '--since', 'forever'], context)).resolves.toMatchObject({
      exitCode: 1,
      stderr: sinceUsage,
    })
    await expect(runCli(['report', '--since=0d'], context)).resolves.toMatchObject({
      exitCode: 1,
      stderr: sinceUsage,
    })
    await expect(runCli(['push', '--since', '4000d'], context)).resolves.toMatchObject({
      exitCode: 1,
      stderr: sinceUsage,
    })
    await expect(runCli(['diff'], context)).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Usage: trce diff <skill>\n',
    })
    await expect(runCli(['report', '--verbose'], context)).resolves.toEqual({
      exitCode: 1,
      stderr: 'Unknown report option: --verbose\nRun trce report --help for usage.\n',
      stdout: '',
    })
    await expect(
      runCli(['dedupe', '--json'], { ...context, commandPrefix: 'npx @trce/cli' }),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: 'Unknown dedupe option: --json\nRun npx @trce/cli dedupe --help for usage.\n',
      stdout: '',
    })
    await expect(
      runCli(['promote', 'x', '--pr', '--action', 'a', '--distribution', 'team-catalog'], context),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: '--distribution must be project or shared, not team-catalog\n',
    })
    await expect(
      runCli(['add', 'acme/skills:catalog/x', '--harness', 'both'], context),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: '--harness must be one of claude, codex, or all, not both\n',
    })
  })

  it('accepts --flag=value wherever --flag value works', async () => {
    const context = await fixtureContext()
    const spaced = await runCli(['report', '--since', '30d'], context)
    const joined = await runCli(['report', '--since=30d'], context)
    expect(joined).toEqual(spaced)
    const json = await runCli(['report', '--json', '--since=1d'], {
      ...context,
      now: new Date('2026-09-20T11:05:00.000Z'),
    })
    expect(JSON.parse(json.stdout)).toMatchObject({ version: 'local-report@1' })
  })

  it('prints per-command help for --help and -h and exits 0', async () => {
    const context = await fixtureContext()
    const help = await runCli(['report', '--help'], { ...context, color: false })
    const short = await runCli(['push', '-h'], { ...context, color: false })
    const later = await runCli(['add', 'acme/skills:x', '--help'], { ...context, color: false })

    expect(help).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: commandHelpText('report', { color: false, commandPrefix: 'trce' }),
    })
    expect(help.stdout).toContain('Usage\n  trce report [--since <Nd>] [--all] [--json]')
    expect(help.stdout).toContain('Offline. Reads skill directories and session history')
    expect(help.stdout).toContain('Exit codes\n  0  Success')
    expect(short.exitCode).toBe(0)
    expect(short.stdout).toContain('trce push [--dry-run] [--quiet] [--since <Nd>] [--url <url>]')
    expect(short.stdout).toContain('--quiet')
    expect(later.exitCode).toBe(0)
    expect(later.stdout).toContain('trce add <owner/repo:path>')
    // Help for an unlinked team command never touches the gate.
    const unlinked = await runCli(['push', '--help'], {
      ...(await unlinkedContext()),
      color: false,
    })
    expect(unlinked.exitCode).toBe(0)
    const unknown = await runCli(['wat', '--help'], context)
    expect(unknown).toMatchObject({
      exitCode: 1,
      stderr: 'Unknown command: wat\nRun trce --help for usage.\n',
    })
  })

  it('lists every duplicate pair with dedupe --all', async () => {
    const context = await fixtureContext()
    const summary = await runCli(['dedupe'], context)
    const complete = await runCli(['dedupe', '--all'], context)
    expect(summary.exitCode).toBe(0)
    expect(complete.exitCode).toBe(0)
    expect(complete.stdout).toContain('code-review ↔ pr-review')
    expect(complete.stdout).not.toContain('more not shown')
  })

  it.skipIf(!canDropReadPermission)('says how many session files could not be read', async () => {
    const context = await fixtureContext()
    const secret = join(context.claudeProjectsDirectory, 'secret.jsonl')
    await copyFile(join(fixtureRoot, 'parsers', 'claude-session.jsonl'), secret)
    await chmod(secret, 0o000)
    const report = await runCli(['report'], { ...context, color: false })
    expect(report.stdout).toContain('Recent activity · 3')
    expect(report.stdout).toContain('\n1 session file could not be read\n')

    const home = await mkdtemp(join(tmpdir(), 'trce-unreadable-home-'))
    const projects = join(home, '.claude', 'projects')
    await mkdir(projects, { recursive: true })
    await copyFile(join(fixtureRoot, 'parsers', 'claude-session.jsonl'), join(projects, 'a.jsonl'))
    await chmod(join(projects, 'a.jsonl'), 0o000)
    const empty = await runCli(['report'], {
      color: false,
      cwd: home,
      env: fixedEnv,
      homeDirectory: home,
      repositorySlugForCwd: async () => null,
    })
    expect(empty.stdout).toContain(
      'No sessions in the last 30 days\n  ~/.claude/projects  0 sessions · 1 session file could not be read\n  ~/.codex/sessions   0 sessions · no session files\n',
    )
  })

  it('says where the action id comes from when promote or unify lacks --action', async () => {
    const context = await fixtureContext()
    let fetchCalls = 0
    const fetch = (async () => {
      fetchCalls += 1
      throw new Error('a missing --action must not contact the server')
    }) as typeof globalThis.fetch
    const hint =
      'This command finishes an action started in Reviews. Choose Share with team, Add to repository, or Standardize, then copy the command from the Finish on your machine dialog.\n'

    await expect(
      runCli(['promote', 'release-notes', '--pr', '--repo', 'acme/skills'], { ...context, fetch }),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: `${hint}  Expected: trce promote <skill> --pr --repo <owner/repo> --action <id>\n`,
      stdout: '',
    })
    await expect(
      runCli(['unify', 'release-notes', '--pr'], {
        ...context,
        commandPrefix: 'npx @trce/cli',
        fetch,
      }),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: `${hint}  Expected: npx @trce/cli unify <skill> --pr --repo <owner/repo> --action <id>\n`,
      stdout: '',
    })
    expect(fetchCalls).toBe(0)
  })

  it('sends skill files only to the GitHub writer and reports only the PR number to trce', async () => {
    const fixture = await fixtureContext()
    const inventory = await scanInventory({
      homeDirectory: fixture.homeDirectory,
      projectDirectory: fixture.cwd,
      projectRepo: null,
    })
    const source = inventory.find((skill) => skill.name === 'release-notes')
    expect(source).toBeDefined()
    if (!source) return
    const dashboardBodies: string[] = []
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      dashboardBodies.push(body)
      const request = JSON.parse(body) as { kind: string }
      return Response.json(
        request.kind === 'claim'
          ? {
              action: {
                actionId: 'action-1',
                base: 'main',
                body: 'Reviewed.\n\n<!-- trce-action:action-1 -->',
                command: 'promote',
                head: 'trce/promote-release-notes-action-1',
                repository: 'acme/skills',
                skillFingerprint: source.fingerprint,
                skillName: 'release-notes',
                targets: [{ expectedSkillMdHash: null, path: '.agents/skills/release-notes' }],
                title: 'Add release-notes',
              },
              github: {
                apiUrl: 'https://api.github.com',
                expiresAt: '2026-08-28T10:00:00.000Z',
                token: 'installation-secret',
              },
              kind: 'ready',
            }
          : {
              kind: 'opened',
              number: 7,
              url: 'https://github.test/acme/skills/pull/7',
            },
      )
    }
    let uploaded = ''
    const result = await runCli(
      [
        'promote',
        'release-notes',
        '--pr',
        '--repo',
        'acme/skills',
        '--distribution',
        'shared',
        '--action',
        'action-1',
      ],
      {
        ...fixture,
        color: true,
        fetch,
        hyperlinks: true,
        openPullRequest: async (input) => {
          uploaded = Buffer.concat(input.files.map((file) => Buffer.from(file.contents))).toString(
            'utf8',
          )
          return { number: 7, url: 'https://github.test/acme/skills/pull/7' }
        },
      },
    )

    expect(result).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: `Uploading 1 file from ~/.agents/skills/release-notes to acme/skills\n  SKILL.md\nOpened pull request #7: ${terminalLink(
        'https://github.test/acme/skills/pull/7',
        { color: true, hyperlinks: true },
      )}\n`,
    })
    expect(uploaded).toContain('release-notes')
    expect(dashboardBodies).toEqual([
      JSON.stringify({ actionId: 'action-1', kind: 'claim' }),
      JSON.stringify({ actionId: 'action-1', kind: 'complete', pullRequestNumber: 7 }),
    ])
    expect(dashboardBodies.join('\n')).not.toContain('release-notes skill')
  })
})

describe('changes waiting for this machine', () => {
  const share = {
    command:
      'npx @trce/cli promote release-notes --pr --repo acme/skills --distribution shared --action action-1',
    id: 'action-1',
    kind: 'share' as const,
    skillName: 'release-notes',
    targetRepository: 'acme/skills',
  }
  const standardize = {
    command: 'npx @trce/cli unify pr-review --pr --repo acme/web --action action-2',
    id: 'action-2',
    kind: 'standardize' as const,
    skillName: 'pr-review',
    targetRepository: 'acme/web',
  }
  const notice = [
    '2 changes are waiting for this machine',
    '  Share release-notes with the team → run: trce promote release-notes --pr --repo acme/skills --distribution shared --action action-1',
    '  Standardize pr-review on this version → run: trce unify pr-review --pr --repo acme/web --action action-2',
    '',
  ].join('\n')

  it('prints the notice above report, dedupe, and diff, offline, and leaves --json alone', async () => {
    const context = await fixtureContext()
    await writePendingActions(
      pendingFile(context),
      [share, standardize],
      '2026-08-20T11:00:00.000Z',
    )
    const golden = await readFile(join(fixtureRoot, 'golden', 'report.txt'), 'utf8')
    const fetch = (async () => {
      throw new Error('the notice must not contact the server')
    }) as typeof globalThis.fetch

    const report = await runCli(['report', '--since', '30d'], { ...context, fetch })
    expect(report).toEqual({ exitCode: 0, stderr: '', stdout: `${notice}\n${golden}` })

    const dedupe = await runCli(['dedupe'], { ...context, fetch })
    expect(dedupe.stdout.startsWith(`${notice}\n`)).toBe(true)
    const diff = await runCli(['diff', 'pr-review'], { ...context, fetch })
    expect(diff.stdout.startsWith(`${notice}\n--- Claude Code · Personal`)).toBe(true)

    const json = await runCli(['report', '--json'], { ...context, fetch })
    expect(json.stdout.startsWith('{')).toBe(true)
    expect(json.stdout).not.toContain('waiting for this machine')
    expect(JSON.parse(json.stdout)).not.toHaveProperty('pendingActions')

    // A failed command keeps its error output as is.
    const missing = await runCli(['diff', 'no-such-skill'], { ...context, fetch })
    expect(missing).toEqual({ exitCode: 1, stderr: 'Skill not found: no-such-skill\n', stdout: '' })
  })

  it('reads the same notice under NO_COLOR and without a TTY', async () => {
    const context = await fixtureContext()
    await writePendingActions(pendingFile(context), [share], '2026-08-20T11:00:00.000Z')
    const colored = await runCli(['dedupe'], { ...context, color: true })
    const plain = await runCli(['dedupe'], { ...context, color: false })
    const line = '  Share release-notes with the team → run: trce promote release-notes'
    expect(colored.stdout.split('\n')[1]?.startsWith(line)).toBe(true)
    expect(plain.stdout.split('\n')[1]?.startsWith(line)).toBe(true)
    expect(colored.stdout.split('\n').slice(0, 2).join('\n')).toBe(
      plain.stdout.split('\n').slice(0, 2).join('\n'),
    )
  })

  it('forgets an action once promote opened its pull request', async () => {
    const fixture = await fixtureContext()
    await writePendingActions(
      pendingFile(fixture),
      [share, standardize],
      '2026-08-20T11:00:00.000Z',
    )
    const inventory = await scanInventory({
      homeDirectory: fixture.homeDirectory,
      projectDirectory: fixture.cwd,
      projectRepo: null,
    })
    const source = inventory.find((skill) => skill.name === 'release-notes')
    if (!source) throw new Error('fixture skill missing')
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { kind: string }
      return Response.json(
        request.kind === 'claim'
          ? {
              action: {
                actionId: 'action-1',
                base: 'main',
                body: 'Reviewed.\n\n<!-- trce-action:action-1 -->',
                command: 'promote',
                head: 'trce/promote-release-notes-action-1',
                repository: 'acme/skills',
                skillFingerprint: source.fingerprint,
                skillName: 'release-notes',
                targets: [{ expectedSkillMdHash: null, path: '.agents/skills/release-notes' }],
                title: 'Share release-notes',
              },
              github: {
                apiUrl: 'https://api.github.com',
                expiresAt: '2026-08-28T10:00:00.000Z',
                token: 'installation-secret',
              },
              kind: 'ready',
            }
          : { kind: 'opened', number: 7, url: 'https://github.test/acme/skills/pull/7' },
      )
    }

    const result = await runCli(
      ['promote', 'release-notes', '--pr', '--repo', 'acme/skills', '--action', 'action-1'],
      {
        ...fixture,
        fetch,
        openPullRequest: async () => ({ number: 7, url: 'https://github.test/acme/skills/pull/7' }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('waiting for this machine')
    expect(await readPendingActions(pendingFile(fixture))).toEqual([standardize])
    const report = await runCli(['report'], fixture)
    expect(report.stdout.split('\n')[0]).toBe('1 change is waiting for this machine')
    expect(report.stdout).not.toContain('action-1')
  })
})

function pendingFile(context: { configFile: string }) {
  return pendingActionsPath(context.configFile)
}

describe('team-link gate', () => {
  const refusal = { exitCode: 2, stderr: notLinkedMessage('trce', 'https://trce.sh'), stdout: '' }

  it('lets every public diagnostic run offline without a team link', async () => {
    const context = await unlinkedContext()
    let fetchCalls = 0
    const fetch = (async () => {
      fetchCalls += 1
      throw new Error('public diagnostics must stay offline')
    }) as typeof globalThis.fetch

    const report = await runCli(['report'], { ...context, fetch })
    const json = await runCli(['report', '--json'], { ...context, fetch })
    const dedupe = await runCli(['dedupe'], { ...context, fetch })
    const diff = await runCli(['diff', 'pr-review'], { ...context, fetch })

    expect(report.exitCode).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({ version: 'local-report@1' })
    expect(dedupe.exitCode).toBe(0)
    expect(diff.exitCode).toBe(0)
    expect(fetchCalls).toBe(0)
  })

  it('shows the early-access box only after an unlinked interactive report', async () => {
    const unlinked = await unlinkedContext()
    const linked = await fixtureContext()
    const interactive = {
      color: false,
      hyperlinks: false,
      interactive: true,
      terminalWidth: 80,
    }

    const visible = await runCli(['report'], { ...unlinked, ...interactive })
    const redirected = await runCli(['report'], { ...unlinked, interactive: false })
    const json = await runCli(['report', '--json'], { ...unlinked, ...interactive })
    const linkedReport = await runCli(['report'], { ...linked, ...interactive })
    const dedupe = await runCli(['dedupe'], { ...unlinked, ...interactive })

    expect(visible.stdout).toContain(
      '┌────────────────────────────────────────────────┐\n' +
        '│  Review skills across your team                │\n' +
        '│  Request early access  https://trce.sh         │\n' +
        '└────────────────────────────────────────────────┘\n',
    )
    expect(redirected.stdout).not.toContain('Request early access')
    expect(json.stdout).not.toContain('Request early access')
    expect(linkedReport.stdout).not.toContain('Request early access')
    expect(dedupe.stdout).not.toContain('Request early access')
  })

  it('prints the exact refusal for commands that need team scope or change files', async () => {
    const context = await unlinkedContext()
    let fetchCalls = 0
    const fetch = (async () => {
      fetchCalls += 1
      throw new Error('an unlinked laptop must not contact the server')
    }) as typeof globalThis.fetch
    const commands: string[][] = [
      ['push', '--dry-run'],
      ['push'],
      ['add', 'acme/skills:catalog/review-helper'],
      ['remove', 'review-helper'],
      ['update', 'review-helper'],
      ['promote', 'release-notes', '--pr', '--action', 'action-1'],
      ['unify', 'release-notes', '--pr', '--action', 'action-1'],
    ]

    for (const args of commands) {
      await expect(runCli(args, { ...context, fetch })).resolves.toEqual(refusal)
    }
    expect(fetchCalls).toBe(0)
    expect(refusal.stderr).toBe(
      'This machine is not linked to a team.\n  Run `trce init`. It prints a code to confirm at https://trce.sh/setup.\n  Nothing was scanned or sent.\n',
    )
    expect(refusal.stderr).not.toContain('\u001B')
  })

  it('names the command the user typed in the refusal', async () => {
    const context = await unlinkedContext()

    const viaNpx = await runCli(['push'], { ...context, commandPrefix: 'npx @trce/cli' })
    const viaBinary = await runCli(['push'], { ...context, commandPrefix: 'trce' })

    expect(viaNpx.stderr).toBe(
      'This machine is not linked to a team.\n  Run `npx @trce/cli init`. It prints a code to confirm at https://trce.sh/setup.\n  Nothing was scanned or sent.\n',
    )
    expect(viaBinary.stderr).toBe(
      'This machine is not linked to a team.\n  Run `trce init`. It prints a code to confirm at https://trce.sh/setup.\n  Nothing was scanned or sent.\n',
    )
  })

  it('keeps the refusal identical with color enabled or disabled', async () => {
    const context = await unlinkedContext()

    const colored = await runCli(['push'], { ...context, color: true })
    const plain = await runCli(['push'], { ...context, color: false })

    expect(colored).toEqual(refusal)
    expect(plain).toEqual(refusal)
  })

  it('leaves help, version, and unknown commands unaffected', async () => {
    const context = await unlinkedContext()

    const help = await runCli(['--help'], context)
    const version = await runCli(['--version'], context)
    const unknown = await runCli(['wat'], context)

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('report, dedupe, and diff run without a linked team')
    expect(version).toEqual({ exitCode: 0, stderr: '', stdout: '0.2.0-development\n' })
    for (const flag of ['-v', '-V', 'version']) {
      await expect(runCli([flag], context)).resolves.toEqual(version)
    }
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain('Unknown command: wat')
    // The legacy alias and flags are gone, not silently accepted.
    await expect(runCli(['try', 'acme/skills:x'], context)).resolves.toEqual({
      exitCode: 1,
      stderr: 'Unknown command: try\nRun trce --help for usage.\n',
      stdout: '',
    })
    await expect(
      runCli(['add', 'acme/skills:x', '--catalog'], await fixtureContext()),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: 'Unknown add option: --catalog\nRun trce add --help for usage.\n',
      stdout: '',
    })
  })

  it('lets init start the device flow on an unlinked laptop', async () => {
    const context = await unlinkedContext()
    const requests: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      requests.push(String(input))
      if (String(input).endsWith('/api/device/start')) {
        return Response.json(
          { code: 'ABCDEFG', deviceId: 'device-2', expiresAt: context.now.getTime() + 60_000 },
          { status: 201 },
        )
      }
      return Response.json({ status: 'expired' })
    }) as typeof globalThis.fetch

    const result = await runCli(['init', '--no-hooks', '--no-browser'], {
      ...context,
      fetch,
      sleep: async () => undefined,
    })

    expect(requests[0]).toBe('https://trce.sh/api/device/start')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe(
      'The code expired before it was confirmed.\n  Run `trce init` again for a new one.\n',
    )
  })

  it('explains when new machine links are temporarily limited', async () => {
    const context = await unlinkedContext()
    const fetch = (async () =>
      Response.json(
        { error: 'device_code_rate_limited', retryAfterSeconds: 42 },
        { status: 429 },
      )) as typeof globalThis.fetch

    const result = await runCli(['init', '--no-hooks', '--no-browser'], { ...context, fetch })

    expect(result).toEqual({
      exitCode: 1,
      stderr: 'Too many machines are being linked right now. Try again in 42 seconds.\n',
      stdout: '',
    })
  })

  it('tells an npx user to run npx again when the code expires', async () => {
    const context = await unlinkedContext()
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/device/start')) {
        return Response.json(
          { code: 'ABCDEFG', deviceId: 'device-2', expiresAt: context.now.getTime() + 60_000 },
          { status: 201 },
        )
      }
      return Response.json({ status: 'expired' })
    }) as typeof globalThis.fetch

    const result = await runCli(['init', '--no-hooks', '--no-browser'], {
      ...context,
      commandPrefix: 'npx @trce/cli',
      fetch,
      sleep: async () => undefined,
    })

    expect(result.stderr).toBe(
      'The code expired before it was confirmed.\n  Run `npx @trce/cli init` again for a new one.\n',
    )
  })

  it('points init at --url and TRCE_URL when the dashboard is unreachable', async () => {
    const context = await unlinkedContext()
    const fetch = (async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      })
    }) as typeof globalThis.fetch

    const result = await runCli(
      ['init', '--no-hooks', '--no-browser', '--url', 'http://localhost:3000'],
      { ...context, fetch },
    )

    expect(result).toEqual({
      exitCode: 1,
      stderr:
        'Could not reach http://localhost:3000 (connection refused).\n  Self-hosted or local? Pass --url <dashboard url> or set TRCE_URL.\n',
      stdout: '',
    })
    const viaEnv = await runCli(['init', '--no-hooks', '--no-browser'], {
      ...context,
      env: { ...fixedEnv, TRCE_URL: 'http://localhost:4000' },
      fetch,
    })
    expect(viaEnv.stderr).toContain('Could not reach http://localhost:4000 (connection refused).')
  })

  it('keeps the background hook silent on an unlinked laptop', async () => {
    const context = await unlinkedContext()

    await expect(runCli(['hook'], context)).resolves.toEqual({
      exitCode: 0,
      stderr: '',
      stdout: '',
    })
  })
})

async function unlinkedContext() {
  const context = await fixtureContext()
  return { ...context, configFile: join(context.temporary, 'missing.json') }
}

async function fixtureContext() {
  const temporary = await mkdtemp(join(tmpdir(), 'trce-cli-'))
  const claudeDirectory = join(temporary, 'claude')
  const codexDirectory = join(temporary, 'codex')
  const projectDirectory = join(temporary, 'project')
  await Promise.all([
    mkdir(claudeDirectory, { recursive: true }),
    mkdir(codexDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
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
  ])
  const configFile = join(temporary, 'config.json')
  await writeLinkedConfig(configFile, {
    baseUrl: 'http://dashboard.test',
    deviceId: 'device-1',
    linkedAt: '2026-08-20T10:00:00.000Z',
    token: 'device-secret',
    version: 1,
  })
  return {
    claudeProjectsDirectory: claudeDirectory,
    codexSessionsDirectory: codexDirectory,
    commandPrefix: 'trce',
    configFile,
    cwd: projectDirectory,
    env: fixedEnv,
    homeDirectory: join(fixtureRoot, 'home-synthetic'),
    now: new Date('2026-08-20T11:05:00.000Z'),
    temporary,
  }
}
