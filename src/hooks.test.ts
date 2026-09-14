import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { containsTrceCommand, installHooks, removeHooks, spawnDetachedPush } from './hooks.js'

const marker = 'trce-hook-v1'
const legacyMarker = 'trce-skills-hook-v1'

type ClaudeSettings = {
  hooks?: { SessionEnd?: { hooks: Record<string, unknown>[]; matcher?: string }[] }
  theme?: string
}

async function makeHome(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix))
  await Promise.all([
    mkdir(join(home, '.claude'), { recursive: true }),
    mkdir(join(home, '.codex'), { recursive: true }),
  ])
  return home
}

async function readClaudeSettings(home: string) {
  return JSON.parse(
    await readFile(join(home, '.claude', 'settings.json'), 'utf8'),
  ) as ClaudeSettings
}

function install(home: string, options: { executable?: string; platform?: NodeJS.Platform } = {}) {
  return installHooks({
    executable: options.executable ?? '/fixture/node',
    homeDirectory: home,
    ...(options.platform ? { platform: options.platform } : {}),
    scriptPath: '/fixture/trce/dist/bin.js',
  })
}

describe('additive hooks', () => {
  it('leaves both agents and the launcher untouched when Codex notify cannot be parsed', async () => {
    const home = await makeHome('trce-hooks-preflight-')
    const claude = '{"theme":"dark"}\n'
    const codex = 'notify = [\n  "existing-notify",\n]\n'
    await writeFile(join(home, '.claude', 'settings.json'), claude)
    await writeFile(join(home, '.codex', 'config.toml'), codex)
    await expect(install(home)).rejects.toThrow('no hook was changed')
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe(claude)
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(codex)
    await expect(stat(join(home, '.trce', 'hook.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves existing Claude and Codex hooks and restores Codex notify on removal', async () => {
    const home = await makeHome('trce-hooks-')
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ command: 'existing-claude-hook', type: 'command' }] }],
        },
        theme: 'dark',
      }),
      'utf8',
    )
    const originalCodex = 'notify = ["existing-notify", "--safe"]\nmodel = "fixture"\n'
    await writeFile(join(home, '.codex', 'config.toml'), originalCodex, 'utf8')

    const installed = await install(home, { platform: 'darwin' })
    const claude = await readClaudeSettings(home)
    const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
    const wrapper = await readFile(join(home, '.trce', 'codex-notify.mjs'), 'utf8')
    const launcher = await readFile(join(home, '.trce', 'hook.mjs'), 'utf8')

    expect(installed).toEqual({ claude: 'installed', codex: 'installed' })
    expect(claude.theme).toBe('dark')
    expect(claude.hooks?.SessionEnd).toHaveLength(2)
    expect(JSON.stringify(claude)).toContain('existing-claude-hook')
    expect(claude.hooks?.SessionEnd?.[1]).toEqual({
      hooks: [
        {
          command: `'/fixture/node' '${join(home, '.trce', 'hook.mjs')}'`,
          statusMessage: marker,
          timeout: 5,
          type: 'command',
        },
      ],
      matcher: '',
    })
    expect(codex).toContain(
      `notify = [${JSON.stringify('/fixture/node')}, ${JSON.stringify(join(home, '.trce', 'codex-notify.mjs'))}]`,
    )
    expect(codex).toContain('model = "fixture"')
    expect(wrapper).toContain('existing-notify')
    expect(wrapper).toContain('hook.mjs')
    expect(wrapper).not.toContain('skills-hook.mjs')
    expect(launcher).toContain('/fixture/trce/dist/bin.js')
    expect(launcher).not.toContain('npx')
    expect(launcher).toContain('process.env.CLAUDE_PROJECT_DIR')
    expect(launcher).toContain('spawn(preferred[0], preferred.slice(1), { cwd, detached: true')

    await writeFile(join(home, '.trce', 'codex-notify.mjs'), '// outdated wrapper\n')
    await expect(install(home, { platform: 'darwin' })).resolves.toEqual({
      claude: 'already-installed',
      codex: 'already-installed',
    })
    expect(await readFile(join(home, '.trce', 'codex-notify.mjs'), 'utf8')).toContain(
      'TRCE_NOTIFY_ACTIVE',
    )

    const removed = await removeHooks({ homeDirectory: home })
    expect(removed).toEqual({ claude: 'removed', codex: 'removed' })
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(originalCodex)
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toContain(
      'existing-claude-hook',
    )
    await expect(readFile(join(home, '.trce', 'hook.mjs'), 'utf8')).rejects.toThrow()
  })

  it('emits a double-quoted Claude command without a shell comment on Windows', async () => {
    const home = await makeHome('trce-hooks-win32-')
    const executable = 'C:\\Program Files\\nodejs\\node.exe'

    await install(home, { executable, platform: 'win32' })
    const hook = (await readClaudeSettings(home)).hooks?.SessionEnd?.[0]?.hooks[0]

    expect(hook?.command).toBe(`"${executable}" "${join(home, '.trce', 'hook.mjs')}"`)
    expect(hook?.command).not.toContain('#')
    expect(hook?.command).not.toContain(marker)
    expect(hook?.statusMessage).toBe(marker)
    expect(Object.keys(hook ?? {}).sort()).toEqual(['command', 'statusMessage', 'timeout', 'type'])
    await expect(install(home, { executable, platform: 'win32' })).resolves.toMatchObject({
      claude: 'already-installed',
    })
  })

  it('escapes embedded double quotes in Windows hook paths', async () => {
    const home = await makeHome('trce-hooks-win32-quote-')
    await install(home, { executable: 'C:\\odd "dir"\\node.exe', platform: 'win32' })
    const hook = (await readClaudeSettings(home)).hooks?.SessionEnd?.[0]?.hooks[0]
    expect(hook?.command).toMatch(/^"C:\\odd \\"dir\\"\\node\.exe" "/u)
  })

  it('still recognises and removes the pre-release in-command marker', async () => {
    const home = await makeHome('trce-hooks-legacy-')
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  command: `'/old/node' '${join(home, '.trce', 'skills-hook.mjs')}' # ${legacyMarker}`,
                  timeout: 5,
                  type: 'command',
                },
              ],
              matcher: '',
            },
          ],
        },
      }),
      'utf8',
    )

    await expect(install(home)).resolves.toMatchObject({ claude: 'already-installed' })
    await expect(removeHooks({ homeDirectory: home })).resolves.toMatchObject({ claude: 'removed' })
    expect((await readClaudeSettings(home)).hooks?.SessionEnd).toBeUndefined()
  })

  it('recognises beta hooks by the old marker and launcher name and removes the old launcher', async () => {
    const home = await makeHome('trce-hooks-beta-')
    const oldLauncher = join(home, '.trce', 'skills-hook.mjs')
    await mkdir(join(home, '.trce'), { recursive: true })
    await writeFile(oldLauncher, '// beta launcher\n', 'utf8')
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  command: `'/old/node' '${oldLauncher}'`,
                  statusMessage: legacyMarker,
                  timeout: 5,
                  type: 'command',
                },
              ],
              matcher: '',
            },
          ],
        },
      }),
      'utf8',
    )
    await writeFile(
      join(home, '.codex', 'config.toml'),
      `notify = ["/old/node", ${JSON.stringify(oldLauncher)}]\n`,
      'utf8',
    )

    await expect(install(home)).resolves.toEqual({
      claude: 'already-installed',
      codex: 'already-installed',
    })
    expect(await readFile(oldLauncher, 'utf8')).toContain('TRCE_HOOK_ACTIVE')
    expect(await readFile(oldLauncher, 'utf8')).not.toContain('npx')
    expect(containsTrceCommand({ statusMessage: legacyMarker })).toBe(true)
    expect(containsTrceCommand({ statusMessage: marker })).toBe(true)
    expect(containsTrceCommand(`node ${oldLauncher}`)).toBe(true)
    expect(containsTrceCommand('node /elsewhere/other-hook.mjs')).toBe(false)

    await expect(removeHooks({ homeDirectory: home })).resolves.toMatchObject({ claude: 'removed' })
    expect((await readClaudeSettings(home)).hooks?.SessionEnd).toBeUndefined()
    await expect(lstat(oldLauncher)).rejects.toThrow()
  })

  it('writes new hooks with the current marker and launcher name only', async () => {
    const home = await makeHome('trce-hooks-current-')
    await install(home)
    const settings = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
    expect(settings).toContain(marker)
    expect(settings).not.toContain(legacyMarker)
    expect(settings).toContain('hook.mjs')
    expect(settings).not.toContain('skills-hook.mjs')
    await expect(lstat(join(home, '.trce', 'hook.mjs'))).resolves.toBeDefined()
    await expect(lstat(join(home, '.trce', 'skills-hook.mjs'))).rejects.toThrow()
  })

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME when placing hooks', async () => {
    const home = await makeHome('trce-hooks-relocated-')
    const claudeHome = join(home, 'relocated-claude')
    const codexHome = join(home, 'relocated-codex')
    const env = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }

    await expect(
      installHooks({
        env,
        executable: '/fixture/node',
        homeDirectory: home,
        scriptPath: '/fixture/trce/dist/bin.js',
      }),
    ).resolves.toEqual({ claude: 'installed', codex: 'installed' })
    expect(await readFile(join(claudeHome, 'settings.json'), 'utf8')).toContain(marker)
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain('notify = ')
    await expect(lstat(join(home, '.claude', 'settings.json'))).rejects.toThrow()
    await expect(lstat(join(home, '.codex', 'config.toml'))).rejects.toThrow()
    // The launcher stays under ~/.trce regardless of where the agents keep their config.
    await expect(lstat(join(home, '.trce', 'hook.mjs'))).resolves.toBeDefined()

    await expect(removeHooks({ env, homeDirectory: home })).resolves.toEqual({
      claude: 'removed',
      codex: 'removed',
    })
    expect(await readFile(join(claudeHome, 'settings.json'), 'utf8')).not.toContain(marker)
  })

  it('removes only trce entry from a shared SessionEnd group', async () => {
    const home = await makeHome('trce-hooks-shared-group-')
    await install(home)
    const settings = await readClaudeSettings(home)
    const group = settings.hooks?.SessionEnd?.[0]
    if (!group) throw new Error('hook group missing')
    group.hooks.unshift({ command: 'user-added-hook', type: 'command' })
    settings.hooks = {
      SessionEnd: [group, { hooks: [{ command: 'other-group', type: 'command' }], matcher: '' }],
    }
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8')

    await expect(removeHooks({ homeDirectory: home })).resolves.toMatchObject({ claude: 'removed' })
    expect((await readClaudeSettings(home)).hooks?.SessionEnd).toEqual([
      { hooks: [{ command: 'user-added-hook', type: 'command' }], matcher: '' },
      { hooks: [{ command: 'other-group', type: 'command' }], matcher: '' },
    ])
    await expect(removeHooks({ homeDirectory: home })).resolves.toMatchObject({
      claude: 'not-installed',
    })
  })

  it('treats a foreign wrapper around trce Codex notify as already installed', async () => {
    const home = await makeHome('trce-hooks-foreign-wrapper-')
    const config =
      'notify = ["/Applications/Foo.app/Contents/MacOS/foo", "turn-ended", "--previous-notify", "[\\"/usr/local/bin/node\\",\\"/home/dev/.trce/codex-notify.mjs\\"]"]\nmodel = "fixture"\n'
    await writeFile(join(home, '.codex', 'config.toml'), config, 'utf8')

    await expect(install(home)).resolves.toMatchObject({ codex: 'already-installed' })
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(config)
    await expect(lstat(join(home, '.trce', 'codex-notify.mjs'))).rejects.toThrow()
    await expect(lstat(join(home, '.trce', 'hooks.json'))).rejects.toThrow()
  })

  it('treats a Windows-style wrapper path around the launcher as already installed', async () => {
    const home = await makeHome('trce-hooks-foreign-wrapper-win-')
    const config =
      'notify = ["C:\\\\Tools\\\\foo.exe", "--previous-notify", "[\\"C:\\\\\\\\node.exe\\",\\"C:\\\\\\\\Users\\\\\\\\dev\\\\\\\\.trce\\\\\\\\skills-hook.mjs\\"]"]\n'
    await writeFile(join(home, '.codex', 'config.toml'), config, 'utf8')
    await expect(install(home)).resolves.toMatchObject({ codex: 'already-installed' })
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(config)
  })

  it.each([false, true])(
    'removes a JSON-wrapped notifier without losing the outer command (escaped slashes: %s)',
    async (escapeSlashes) => {
      const home = await makeHome('trce-hooks-nested-remove-')
      const original = ['C:\\Program Files\\Notifier\\notify.exe', '--label', 'line\nbreak', '雪']
      const configPath = join(home, '.codex', 'config.toml')
      await writeFile(configPath, `notify = ${JSON.stringify(original).replace('雪', '\\u96ea')}\n`)
      await install(home)
      const installed: unknown = JSON.parse(
        (await readFile(configPath, 'utf8')).trim().replace(/^notify = /u, ''),
      )
      const encoded = JSON.stringify(installed)
      const outer = [
        '/Applications/Notifier App/notifier',
        'turn-ended',
        '--previous-notify',
        escapeSlashes ? encoded.replaceAll('/', '\\/') : encoded,
      ]
      const suffix = '\nmodel = "fixture"\n[projects.fixture]\ntrust_level = "trusted"\n'
      await writeFile(configPath, `notify = ${JSON.stringify(outer)}${suffix}`)
      // Reinstall must refresh the owned wrapper even after another tool wraps it.
      await writeFile(join(home, '.trce', 'codex-notify.mjs'), '// outdated wrapper\n')
      await expect(install(home)).resolves.toMatchObject({ codex: 'already-installed' })
      expect(await readFile(join(home, '.trce', 'codex-notify.mjs'), 'utf8')).toContain(
        'TRCE_NOTIFY_ACTIVE',
      )

      await expect(removeHooks({ homeDirectory: home })).resolves.toEqual({
        claude: 'removed',
        codex: 'removed',
      })
      const removed = await readFile(configPath, 'utf8')
      // Compare argv values rather than incidental TOML spacing.
      expect(JSON.parse(removed.split('\n')[0]?.replace(/^notify = /u, '') ?? '')).toEqual([
        ...outer.slice(0, -1),
        JSON.stringify(original),
      ])
      expect(removed.slice(removed.indexOf('\n'))).toBe(suffix)
      await expect(lstat(join(home, '.trce', 'codex-notify.mjs'))).rejects.toThrow()
      await expect(removeHooks({ homeDirectory: home })).resolves.toEqual({
        claude: 'not-installed',
        codex: 'not-installed',
      })
      await install(home)
      await removeHooks({ homeDirectory: home })
      expect(await readFile(configPath, 'utf8')).toBe(removed)
    },
  )

  it('leaves unknown changed notification formats and both hooks untouched', async () => {
    const home = await makeHome('trce-hooks-nested-unknown-')
    const configPath = join(home, '.codex', 'config.toml')
    await writeFile(configPath, 'notify = ["original-notifier"]\n')
    await install(home)
    const claude = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
    const wrapper = await readFile(join(home, '.trce', 'codex-notify.mjs'), 'utf8')
    const unknown = `notify = ${JSON.stringify(['new-notifier', '--shell-command', `node ${join(home, '.trce', 'codex-notify.mjs')}`])}\n`
    await writeFile(configPath, unknown)
    await expect(removeHooks({ homeDirectory: home })).rejects.toThrow('left untouched')
    expect(await readFile(configPath, 'utf8')).toBe(unknown)
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe(claude)
    expect(await readFile(join(home, '.trce', 'codex-notify.mjs'), 'utf8')).toBe(wrapper)
  })

  it('keeps notifications working and stops reporting after removing a nested hook', async () => {
    const home = await makeHome('trce-hooks-nested-runtime-')
    const configPath = join(home, '.codex', 'config.toml')
    const notifier = join(home, 'notifier.mjs')
    const outer = join(home, 'outer.mjs')
    const reporter = join(home, 'reporter.mjs')
    const events = join(home, 'events.txt')
    const reports = join(home, 'reports.txt')
    await writeFile(
      notifier,
      `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(events)}, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
    )
    await writeFile(
      reporter,
      `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(reports)}, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
    )
    await writeFile(
      outer,
      `import { spawnSync } from 'node:child_process'
const [file, ...args] = JSON.parse(process.argv[2])
const result = spawnSync(file, [...args, ...process.argv.slice(3)], { timeout: 2000 })
process.exit(result.status ?? 1)
`,
    )
    await writeFile(
      configPath,
      `notify = ${JSON.stringify([process.execPath, notifier, '--safe'])}\n`,
    )
    await installHooks({ executable: process.execPath, homeDirectory: home, scriptPath: reporter })
    const installed = (await readFile(configPath, 'utf8')).trim().replace(/^notify = /u, '')
    await writeFile(
      configPath,
      `notify = ${JSON.stringify([process.execPath, outer, installed])}\n`,
    )
    const event = '{"type":"agent-turn-complete","last-assistant-message":"synthetic-private-text"}'
    await promisify(execFile)(process.execPath, [outer, installed, event], { timeout: 3000 })
    await expect.poll(() => readFile(events, 'utf8')).toBe(`${JSON.stringify(['--safe', event])}\n`)
    await expect.poll(() => readFile(reports, 'utf8')).toBe('["hook"]\n')

    await removeHooks({ homeDirectory: home })
    const command: unknown = JSON.parse(
      (await readFile(configPath, 'utf8')).trim().replace(/^notify = /u, ''),
    )
    if (
      !Array.isArray(command) ||
      !command.every((arg): arg is string => typeof arg === 'string')
    ) {
      throw new Error('Expected a notification command')
    }
    const [executable, ...args] = command
    if (!executable) throw new Error('Expected a notification executable')
    await promisify(execFile)(executable, [...args, event], { timeout: 3000 })
    expect(await readFile(events, 'utf8')).toBe(`${JSON.stringify(['--safe', event])}\n`.repeat(2))
    expect(await readFile(reports, 'utf8')).toBe('["hook"]\n')
  })

  it.each(['different-argv', 'remaining-reference', 'no-original', 'too-deep'])(
    'refuses ambiguous nested cleanup: %s',
    async (scenario) => {
      const home = await makeHome('trce-hooks-nested-ambiguous-')
      const configPath = join(home, '.codex', 'config.toml')
      if (scenario !== 'no-original')
        await writeFile(configPath, 'notify = ["original-notifier"]\n')
      await install(home)
      const installed = (await readFile(configPath, 'utf8')).trim().replace(/^notify = /u, '')
      let nested = installed
      if (scenario === 'different-argv') nested = installed.replace(']', ', "--extra"]')
      for (let i = 0; i < (scenario === 'too-deep' ? 10 : 1); i += 1) {
        nested = JSON.stringify(['outer-notifier', '--previous-notify', nested])
      }
      if (scenario === 'remaining-reference') {
        nested = JSON.stringify(['outer-notifier', nested, join(home, '.trce', 'hook.mjs')])
      }
      const changed = `notify = ${nested}\n`
      await writeFile(configPath, changed)
      await expect(removeHooks({ homeDirectory: home })).rejects.toThrow('left untouched')
      expect(await readFile(configPath, 'utf8')).toBe(changed)
      expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toContain(marker)
      await expect(stat(join(home, '.trce', 'hook.mjs'))).resolves.toBeDefined()
    },
  )

  it('writes through symlinked foreign configs and preserves their mode', async () => {
    const home = await makeHome('trce-hooks-symlink-')
    const dotfiles = join(home, 'dotfiles')
    await mkdir(dotfiles, { recursive: true })
    const claudeTarget = join(dotfiles, 'claude-settings.json')
    const codexTarget = join(dotfiles, 'codex-config.toml')
    await writeFile(claudeTarget, '{"theme":"light"}\n', { encoding: 'utf8', mode: 0o644 })
    await writeFile(codexTarget, 'model = "fixture"\n', { encoding: 'utf8', mode: 0o640 })
    await chmod(claudeTarget, 0o644)
    await chmod(codexTarget, 0o640)
    await symlink(claudeTarget, join(home, '.claude', 'settings.json'))
    await symlink(codexTarget, join(home, '.codex', 'config.toml'))

    await expect(install(home)).resolves.toEqual({ claude: 'installed', codex: 'installed' })

    expect((await lstat(join(home, '.claude', 'settings.json'))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(home, '.codex', 'config.toml'))).isSymbolicLink()).toBe(true)
    expect(await readFile(claudeTarget, 'utf8')).toContain(marker)
    expect(await readFile(codexTarget, 'utf8')).toContain('notify = ')
    if (process.platform !== 'win32') {
      expect((await stat(claudeTarget)).mode & 0o777).toBe(0o644)
      expect((await stat(codexTarget)).mode & 0o777).toBe(0o640)
      expect((await stat(join(home, '.trce', 'hook.mjs'))).mode & 0o777).toBe(0o600)
    }
    expect((await readdir(dotfiles)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    await expect(removeHooks({ homeDirectory: home })).resolves.toEqual({
      claude: 'removed',
      codex: 'removed',
    })
    expect((await lstat(join(home, '.claude', 'settings.json'))).isSymbolicLink()).toBe(true)
    expect(await readFile(codexTarget, 'utf8')).toBe('model = "fixture"\n')
    if (process.platform !== 'win32') expect((await stat(codexTarget)).mode & 0o777).toBe(0o640)
  })

  it('creates the target of a dangling settings symlink instead of replacing the link', async () => {
    const home = await makeHome('trce-hooks-dangling-')
    const target = join(home, 'dotfiles', 'claude-settings.json')
    await mkdir(join(home, 'dotfiles'), { recursive: true })
    await symlink(target, join(home, '.claude', 'settings.json'))

    await install(home)
    expect((await lstat(join(home, '.claude', 'settings.json'))).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toContain(marker)
  })

  it('removes the push lock together with the launcher and wrapper', async () => {
    const home = await makeHome('trce-hooks-lock-')
    await install(home)
    await spawnDetachedPush('/fixture/node', '/fixture/trce/dist/bin.js', {
      homeDirectory: home,
      now: 1_000,
    })
    await expect(readFile(join(home, '.trce', 'hook-push.lock'), 'utf8')).resolves.toBe('1000\n')

    await removeHooks({ homeDirectory: home })
    await expect(lstat(join(home, '.trce', 'hook-push.lock'))).rejects.toThrow()
    await expect(lstat(join(home, '.trce', 'hooks.json'))).rejects.toThrow()
  })

  it('generates a guarded local launcher with no package-manager fallback', async () => {
    const home = await makeHome('trce-hooks-launcher-source-')
    await install(home)
    const launcher = await readFile(join(home, '.trce', 'hook.mjs'), 'utf8')

    expect(launcher).toContain('!existsSync(preferred[0]) || !existsSync(preferred[1])')
    expect(launcher).toContain('TRCE_HOOK_ACTIVE')
    expect(launcher).toContain('mkdirSync(admission')
    expect(launcher).not.toContain('npx')
    expect(launcher).not.toContain('@trce/cli')
    expect(launcher).toContain('child.unref()')
  })

  it('runs the preferred checkout from the generated launcher', async () => {
    const home = await makeHome('trce-hooks-launcher-run-')
    const recorder = join(home, 'record.mjs')
    const record = join(home, 'record.json')
    await writeFile(
      recorder,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n`,
      'utf8',
    )
    await installHooks({ executable: process.execPath, homeDirectory: home, scriptPath: recorder })

    await promisify(execFile)(process.execPath, [join(home, '.trce', 'hook.mjs')], {
      cwd: home,
      env: { ...process.env, CLAUDE_PROJECT_DIR: join(home, 'dotfiles-missing') },
    })
    const recorded = await waitForJson(record)

    expect(recorded).toMatchObject({ args: ['hook'] })
    if (typeof recorded !== 'object' || recorded === null || !('cwd' in recorded)) {
      throw new Error('Launcher did not record its working directory')
    }
    const cwd = recorded.cwd
    expect(typeof cwd).toBe('string')
    if (typeof cwd !== 'string') throw new Error('Launcher did not record its working directory')
    expect(await realpath(cwd)).toBe(await realpath(home))
  })

  it('rejects saved recursive notification chains before changing either agent or removing hooks', async () => {
    const home = await makeHome('trce-hooks-saved-cycle-')
    await writeFile(join(home, '.codex', 'config.toml'), 'notify = ["existing-notify"]\n')
    await install(home)
    const claude = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
    const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
    const launcher = await readFile(join(home, '.trce', 'hook.mjs'), 'utf8')
    const previous = JSON.stringify([
      '/fixture/node',
      join(home, '.trce', 'codex-notify.mjs'),
    ]).replaceAll('/', '\\/')
    await writeFile(
      join(home, '.trce', 'hooks.json'),
      JSON.stringify({
        version: 1,
        codexInstalledLine: codex.trim(),
        codexOriginalLine: `notify = ${JSON.stringify(['foreign-notifier', '--previous-notify', previous])}`,
      }),
    )
    await expect(install(home)).rejects.toThrow('recursive notification chain')
    await expect(removeHooks({ homeDirectory: home })).rejects.toThrow(
      'recursive notification chain',
    )
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe(claude)
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(codex)
    expect(await readFile(join(home, '.trce', 'hook.mjs'), 'utf8')).toBe(launcher)
  })

  it.each([false, true])(
    'stops notifier reentry (guard stripped: %s) without forwarding events to trce',
    async (stripGuard) => {
      const home = await makeHome('trce-hooks-runtime-cycle-')
      const wrapper = join(home, '.trce', 'codex-notify.mjs')
      const notifier = join(home, 'notifier.mjs')
      const recorder = join(home, 'recorder.mjs')
      const calls = join(home, 'calls.json')
      const done = join(home, 'done.json')
      const report = join(home, 'report.json')
      // Fixture fuse: even a broken guard can create at most four callback invocations.
      await writeFile(
        notifier,
        `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const path = ${JSON.stringify(calls)}
const calls = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
calls.push(process.argv.slice(2))
writeFileSync(path, JSON.stringify(calls))
const env = { ...process.env }
if (${stripGuard}) delete env.TRCE_NOTIFY_ACTIVE
if (calls.length < 4) spawnSync(process.execPath, [${JSON.stringify(wrapper)}, ...process.argv.slice(2)], { env, timeout: 2000 })
writeFileSync(${JSON.stringify(done)}, '{}')
`,
      )
      await writeFile(
        recorder,
        `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.argv.slice(2)))
`,
      )
      await writeFile(
        join(home, '.codex', 'config.toml'),
        `notify = ${JSON.stringify([process.execPath, notifier])}\n`,
      )
      await installHooks({
        executable: process.execPath,
        homeDirectory: home,
        scriptPath: recorder,
      })
      const event =
        '{"type":"agent-turn-complete","last-assistant-message":"synthetic-private-text"}'
      await promisify(execFile)(process.execPath, [wrapper, event], { timeout: 2000 })
      await waitForJson(done)
      expect(await waitForJson(calls)).toEqual([[event]])
      expect(await waitForJson(report)).toEqual(['hook'])
    },
  )

  it('admits only one child from concurrent generated launcher invocations', async () => {
    const home = await makeHome('trce-hooks-runtime-burst-')
    const recorder = join(home, 'recorder.mjs')
    const calls = join(home, 'calls.txt')
    await writeFile(
      recorder,
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(calls)}, 'call\\n')\n`,
    )
    await installHooks({ executable: process.execPath, homeDirectory: home, scriptPath: recorder })
    const launcher = join(home, '.trce', 'hook.mjs')
    await Promise.all(
      Array.from({ length: 6 }, () =>
        promisify(execFile)(process.execPath, [launcher], { timeout: 2000 }),
      ),
    )
    await expect.poll(async () => readFile(calls, 'utf8')).toBe('call\n')
    await promisify(execFile)(process.execPath, [launcher], { timeout: 2000 })
    expect(await readFile(calls, 'utf8')).toBe('call\n')
    await removeHooks({ homeDirectory: home })
    await expect(stat(`${launcher}.timestamp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not spawn or invoke npm when the installed CLI disappears', async () => {
    const home = await makeHome('trce-hooks-missing-install-')
    await install(home)
    const probe = join(home, 'probe.mjs')
    const spawned = join(home, 'spawned.json')
    // Intercept spawning before importing the generated script: regressions cannot reach npm.
    await writeFile(
      probe,
      `import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileSync } from 'node:fs'
childProcess.spawn = (...args) => { writeFileSync(${JSON.stringify(spawned)}, JSON.stringify(args)); return { on() {}, unref() {} } }
syncBuiltinESMExports()
`,
    )
    await promisify(execFile)(
      process.execPath,
      ['--import', pathToFileURL(probe).href, join(home, '.trce', 'hook.mjs')],
      { timeout: 2000 },
    )
    await expect(stat(spawned)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('debounces background pushes without reading hook arguments', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trce-hook-debounce-'))

    await expect(
      spawnDetachedPush('/fixture/node', '/fixture/trce/dist/bin.js', {
        homeDirectory: home,
        now: 1_000,
      }),
    ).resolves.toBe(true)
    await expect(
      spawnDetachedPush('/fixture/node', '/fixture/trce/dist/bin.js', {
        homeDirectory: home,
        now: 2_000,
      }),
    ).resolves.toBe(false)
    await expect(
      spawnDetachedPush('/fixture/node', '/fixture/trce/dist/bin.js', {
        homeDirectory: home,
        now: 62_000,
      }),
    ).resolves.toBe(true)
  })

  it('admits only one concurrent push when the previous window expires', async () => {
    const home = await makeHome('trce-hook-push-burst-')
    await install(home)
    await writeFile(join(home, '.trce', 'hook-push.lock'), '1000\n')
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        spawnDetachedPush('/fixture/node', '/fixture/trce/dist/bin.js', {
          homeDirectory: home,
          now: 62_000,
        }),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    await expect(stat(join(home, '.trce', 'hook-push.lock.admission'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

async function waitForJson(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`launcher never wrote ${path}`)
}
