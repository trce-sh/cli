import { createRequire } from 'node:module'

const manifest = createRequire(import.meta.url)('../package.json') as { version: string }

/** The package version, printed verbatim by `--version` and the branded header. */
export const cliVersion = manifest.version
