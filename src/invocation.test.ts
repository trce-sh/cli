import { describe, expect, it } from 'vitest'
import { runCli } from './cli.js'
import { helpText } from './help.js'
import { binaryCommandPrefix, detectCommandPrefix, npxCommandPrefix } from './invocation.js'
import { notLinkedMessage } from './team-link.js'

describe('invoked command prefix', () => {
  it('detects npx from the npm exec environment', () => {
    expect(
      detectCommandPrefix({
        argv1: '/Users/dev/.npm/_npx/1a2b3c/node_modules/@trce/cli/dist/bin.js',
        env: {
          npm_command: 'exec',
          npm_config_user_agent: 'npm/10.9.0 node/v22.14.0 darwin arm64 workspaces/false',
          npm_lifecycle_event: 'npx',
        },
      }),
    ).toBe('npx @trce/cli')
    expect(detectCommandPrefix({ env: { npm_lifecycle_event: 'npx' } })).toBe(npxCommandPrefix)
    expect(
      detectCommandPrefix({
        argv1:
          'C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\@trce\\skills\\dist\\bin.js',
        env: { npm_config_user_agent: 'npm/10.9.0 node/v22.14.0 win32 x64' },
      }),
    ).toBe(npxCommandPrefix)
  })

  it('falls back to the installed binary name deterministically', () => {
    expect(detectCommandPrefix()).toBe('trce')
    expect(detectCommandPrefix({ argv1: '/usr/local/bin/trce', env: {} })).toBe(binaryCommandPrefix)
    expect(
      detectCommandPrefix({
        argv1: '/Users/dev/code/trce/cli/dist/bin.js',
        env: {
          npm_command: 'run-script',
          npm_config_user_agent: 'pnpm/10.34.5 npm/? node/v24.11.0 darwin arm64',
          npm_lifecycle_event: 'test',
        },
      }),
    ).toBe(binaryCommandPrefix)
    expect(
      detectCommandPrefix({
        argv1: '/Users/dev/.npm/_npx/1a2b3c/node_modules/@trce/cli/dist/bin.js',
        env: {},
      }),
    ).toBe(binaryCommandPrefix)
  })

  it('prints the refusal with the prefix the user typed', () => {
    expect(notLinkedMessage('npx @trce/cli')).toBe(
      'This machine is not linked to a team.\n  Run `npx @trce/cli init`. It prints a code to confirm at https://trce.sh/setup.\n  Nothing was scanned or sent.\n',
    )
    expect(notLinkedMessage('trce')).toBe(
      'This machine is not linked to a team.\n  Run `trce init`. It prints a code to confirm at https://trce.sh/setup.\n  Nothing was scanned or sent.\n',
    )
  })

  it('uses the prefix in help and in usage hints for both variants', async () => {
    for (const commandPrefix of ['npx @trce/cli', 'trce']) {
      const help = helpText({ color: false, commandPrefix })
      expect(help).toContain(`  ${commandPrefix} <command> [options]`)
      expect(help).toContain(`Not linked yet? Run ${commandPrefix} init.`)

      const unknown = await runCli(['wat'], { commandPrefix })
      expect(unknown.stderr).toBe(`Unknown command: wat\nRun ${commandPrefix} --help for usage.\n`)
    }
    const help = helpText({ color: false, commandPrefix: 'npx @trce/cli' })
    expect(help).toContain('npx @trce/cli <command>')
  })
})
