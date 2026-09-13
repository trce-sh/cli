/**
 * The command prefix the user actually typed. Printed hints must follow it: a machine running
 * `npx @trce/cli` may not have `trce` on PATH, while a local build, global install, or
 * pnpm link should not be told to fetch the package from npm.
 *
 * Detection is deterministic and offline. npm exec (which `npx` runs) sets `npm_command=exec`
 * and `npm_lifecycle_event=npx` on the child, and resolves the binary from an `_npx` cache
 * directory. Anything else falls back to the installed binary name.
 */

export const npxCommandPrefix = 'npx @trce/cli'
export const binaryCommandPrefix = 'trce'
export const defaultCommandPrefix = binaryCommandPrefix

export type InvocationInput = {
  argv1?: string | undefined
  env?: Readonly<Record<string, string | undefined>>
}

export function detectCommandPrefix(input: InvocationInput = {}): string {
  const env = input.env ?? {}
  if (env.npm_command === 'exec' || env.npm_lifecycle_event === 'npx') return npxCommandPrefix
  const userAgent = env.npm_config_user_agent ?? ''
  const argv1 = input.argv1 ?? ''
  if (userAgent.startsWith('npm/') && /[\\/]_npx[\\/]/u.test(argv1)) return npxCommandPrefix
  return binaryCommandPrefix
}
