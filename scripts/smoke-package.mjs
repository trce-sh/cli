import { exec as execCommand, execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { assertPackagePolicy, assertPackedFiles } from './package-policy.mjs'

const exec = promisify(execFile)
const execShell = promisify(execCommand)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const prefix = await mkdtemp(join(tmpdir(), 'trce-package-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  const { stdout: packed } = await run(
    npm,
    [
      'pack',
      packageRoot,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      prefix,
      '--cache',
      join(prefix, '.npm-cache'),
    ],
    { cwd: packageRoot },
  )
  const packResult = JSON.parse(packed)
  assertPackedFiles(packResult[0]?.files)
  const filename = packResult[0]?.filename
  if (typeof filename !== 'string') throw new Error('npm pack did not return a tarball name')

  await writeFile(
    join(prefix, 'package.json'),
    `${JSON.stringify({ name: 'trce-smoke', private: true, version: '0.0.0' }, null, 2)}\n`,
  )
  await run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(prefix, filename),
      '--cache',
      join(prefix, '.npm-cache'),
    ],
    { cwd: prefix },
  )

  const executable = join(
    prefix,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'trce.cmd' : 'trce',
  )
  const { stdout } = await run(executable, ['--help'], { cwd: prefix })
  if (!stdout.includes('trce <command>') || !stdout.includes('--dry-run prints the exact JSON')) {
    throw new Error('Installed package help did not match the CLI contract')
  }

  const installedManifest = JSON.parse(
    await readFile(join(prefix, 'node_modules', '@trce', 'cli', 'package.json'), 'utf8'),
  )
  if (installedManifest.name !== '@trce/cli') {
    throw new Error('Installed package manifest has the wrong name')
  }
  assertPackagePolicy(installedManifest)
  const { stdout: version } = await run(executable, ['--version'], { cwd: prefix })
  if (version.trim() !== installedManifest.version) {
    throw new Error('Installed package version did not match its manifest')
  }

  process.stdout.write(`Installed package smoke passed in ${prefix}.\n`)
} finally {
  await rm(prefix, { force: true, recursive: true })
}

function run(command, args, options) {
  if (process.platform !== 'win32') return exec(command, args, options)
  if (/[\s"&|<>()^]/u.test(command)) {
    throw new Error('Windows smoke-test commands must not contain shell metacharacters')
  }
  const commandLine = [command, ...args.map(quoteWindowsArgument)].join(' ')
  return execShell(commandLine, {
    ...options,
    shell: process.env.ComSpec ?? 'cmd.exe',
  })
}

function quoteWindowsArgument(value) {
  if (value.includes('"') || /[\r\n]/u.test(value)) {
    throw new Error('Windows smoke-test arguments cannot contain quotes or newlines')
  }
  return `"${value}"`
}
