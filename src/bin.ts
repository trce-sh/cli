#!/usr/bin/env node

// Runs before any module that uses newer runtime APIs loads: the CLI is imported dynamically.
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (nodeMajor < 22) {
  process.stderr.write(`trce needs Node 22 or newer (found ${process.versions.node}).\n`)
  process.exit(1)
}

const { ignoreClosedPipes, main } = await import('./runtime.js')
ignoreClosedPipes([process.stdout, process.stderr])
process.exitCode = await main(process)
