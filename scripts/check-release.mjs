import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackagePolicy } from './package-policy.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
assertPackagePolicy(manifest)

assert(manifest.name === '@trce/cli', 'Package name must be @trce/cli')
assert(manifest.license === 'MIT', 'Package license must be MIT')
assert(manifest.author === 'Tair Asim', 'Package author must be Tair Asim')
const developmentBuild = manifest.version.endsWith('-development')
assert(
  developmentBuild
    ? /^\d+\.\d+\.\d+-development$/u.test(manifest.version)
    : /^\d+\.\d+\.\d+$/u.test(manifest.version),
  'Version must be a stable semver release or a private development version',
)
assert(
  developmentBuild ? manifest.private === true : manifest.private !== true,
  developmentBuild
    ? 'Development package must stay private until release approval'
    : 'Release package must not be private',
)
assert(manifest.homepage === 'https://trce.sh', 'Homepage must be the canonical public origin')
assert(
  manifest.bin?.trce === './dist/bin.js' && Object.keys(manifest.bin).length === 1,
  'Package must expose only the trce executable',
)
assert(manifest.publishConfig?.access === 'public', 'Future scoped release must be public')
assert(manifest.publishConfig?.provenance === true, 'Future release must request provenance')
assert(manifest.publishConfig?.tag === 'latest', 'Plain npx commands require the latest dist-tag')
const repository = ['trce-sh/cli']
assert(
  repository.some((name) => manifest.repository?.url === `git+https://github.com/${name}.git`) &&
    manifest.repository?.directory === undefined,
  'Repository URL must match the source repository',
)
assert(
  manifest.bugs?.url === manifest.repository.url.replace('git+', '').replace('.git', '/issues'),
  'Issue URL must match the source repository',
)

for (const file of [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'PRIVACY.md',
  'docs/ARCHITECTURE.md',
]) {
  await access(join(packageRoot, file))
}

process.stdout.write(
  developmentBuild
    ? 'CLI development metadata is ready; publishing remains blocked.\n'
    : `CLI release metadata is ready for ${manifest.version}.\n`,
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
