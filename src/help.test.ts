import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.js'
import { commandHelpText, commandTable, helpText } from './help.js'

describe('CLI shell', () => {
  it('renders trce skills help without color when requested', () => {
    const help = helpText({ color: false })

    expect(help).toContain('trce')
    expect(help).toContain(
      'Only skill metadata is sent to trce. Prompts, responses, source code, diffs,',
    )
    expect(help).toContain('--dry-run prints the exact JSON that push sends')
    expect(help).toContain('and unrelated local paths never enter trce')
    expect(help).not.toContain('\u001B')
  })

  it('lists commands once each in workflow order with hook marked internal', () => {
    const help = helpText({ color: false })
    const commands = help
      .slice(help.indexOf('Commands\n'), help.indexOf('\n\n', help.indexOf('Commands\n')))
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/u)[0])

    expect(commands).toEqual([
      'init',
      'report',
      'dedupe',
      'diff',
      'push',
      'add',
      'update',
      'remove',
      'promote',
      'unify',
      'hook',
    ])
    expect(help).toContain(
      '  hook         Internal: run by the background hooks, not for interactive use',
    )
    expect(help).not.toContain('try ')
    expect(help).toContain('  -v, -V, --version     Show the CLI version')
    expect(help).toContain(
      '--all                 List every pair instead of the first 20 per bucket',
    )
    expect(help).toContain('--quiet               Print nothing on success')
    expect(help).toContain('  --repo <owner/repo>   Connected destination repository')
    expect(help.split('\n').every((line) => line.length <= 100)).toBe(true)
    expect(help).toContain('Exit codes\n  0  Success\n  1  Error')
    expect(help).toContain('2  Not linked')
    expect(help).toContain('TRCE_URL')
    expect(help).not.toContain('TRCE_SKILLS_URL')
    expect(help).toContain('push, add, update, remove, promote, and unify require a linked team')
  })

  it('uses the compact three-line brand lockup when color is enabled', () => {
    const help = helpText({ color: true, hyperlinks: false })

    expect(help).toContain('trce.sh')
    expect(help).toContain('Review system for your agent skills')
    expect(help).toContain('CLI · 0.2.0-development')
    expect(help).not.toContain('trce helps your team')
  })

  it('renders a compact section per command', () => {
    for (const command of [
      'init',
      'report',
      'dedupe',
      'diff',
      'push',
      'add',
      'update',
      'remove',
      'promote',
      'unify',
      'hook',
    ]) {
      const section = commandHelpText(command, { color: false, commandPrefix: 'npx @trce/cli' })
      expect(section).toContain(`Usage\n  npx @trce/cli ${command}`)
      expect(section).toContain('Network\n')
      expect(section).toContain('Exit codes')
      expect(section).not.toContain('\u001B')
    }
    expect(commandHelpText('wat')).toBeNull()
    expect(commandHelpText('init', { color: false })).toContain('--insecure-http')
    expect(commandHelpText('push', { color: false })).toContain('--url <url>')
    expect(commandHelpText('push', { color: false })).toContain('still fetches scope')
    expect(commandHelpText('push', { color: false })).toContain('without uploading it')
  })

  it('keeps the usage guide command table identical to the help text', async () => {
    const guide = await readFile(new URL('../docs/USAGE.md', import.meta.url), 'utf8')
    expect(guide).toContain(`\`\`\`text\n${commandTable()}\n\`\`\``)
    expect(guide).not.toContain('TRCE_SKILLS_URL')
  })

  it('returns an error for an unknown command', async () => {
    await expect(runCli(['wat'])).resolves.toEqual({
      exitCode: 1,
      stderr: 'Unknown command: wat\nRun trce --help for usage.\n',
      stdout: '',
    })
  })
})
