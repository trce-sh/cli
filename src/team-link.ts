import { homedir } from 'node:os'
import { configPath, type LinkedConfig, readLinkedConfig } from './config.js'
import { defaultCommandPrefix } from './invocation.js'
import { configuredDashboardUrl } from './service.js'

/**
 * Commands that use team scope, send metadata, or change files require a linked team key.
 * Public local diagnostics do not use this gate. Hosted team operations do.
 */

export const notLinkedExitCode = 2

/**
 * The refusal text. `commandPrefix` is what the user typed: `npx @trce/cli` or `trce`.
 * `init` is what prints the code; the user confirms it on the /setup page of the configured
 * dashboard (`TRCE_URL`, else trce.sh). Nothing hands out a code before `init` runs, so the
 * refusal must not send anyone to the site first.
 */
export function notLinkedMessage(
  commandPrefix = defaultCommandPrefix,
  dashboardUrl = configuredDashboardUrl(),
) {
  return `This machine is not linked to a team.
  Run \`${commandPrefix} init\`. It prints a code to confirm at ${dashboardUrl}/setup.
  Nothing was scanned or sent.
`
}

export type LinkedConfigContext = {
  configFile?: string
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  /** Receives the shared-permissions warning; defaults to stderr. */
  warn?: (message: string) => void
}

export function linkedConfigPath(context: LinkedConfigContext) {
  return context.configFile ?? configPath(context.homeDirectory ?? homedir())
}

export function readLinkedTeam(context: LinkedConfigContext): Promise<LinkedConfig | null> {
  return readLinkedConfig(linkedConfigPath(context), {
    homeDirectory: context.homeDirectory ?? homedir(),
    ...(context.warn ? { warn: context.warn } : {}),
  })
}

/** The refusal printed by every gated command. Plain text; no color, deterministic in CI. */
export function notLinkedResult({
  commandPrefix = defaultCommandPrefix,
  env = process.env,
}: {
  commandPrefix?: string
  env?: NodeJS.ProcessEnv
} = {}) {
  return {
    exitCode: notLinkedExitCode,
    stderr: notLinkedMessage(commandPrefix, configuredDashboardUrl(env)),
    stdout: '',
  }
}
