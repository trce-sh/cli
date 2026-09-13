import { readFile } from 'node:fs/promises'

const tag = process.argv[2]
if (!tag) throw new Error('Release tag is required')

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const version = String(manifest.version)

const developmentNote =
  'development versions are never published. Set a stable version in package.json (see RELEASING.md), then tag it.'
if (version.endsWith('-development')) {
  throw new Error(`Refusing to release package version ${version}: ${developmentNote}`)
}
if (tag.endsWith('-development')) {
  throw new Error(`Refusing to release tag ${tag}: ${developmentNote}`)
}

const expected = `v${version}`
if (tag !== expected) {
  throw new Error(
    `Release tag ${tag} does not match package version ${version} (expected ${expected})`,
  )
}

process.stdout.write(`Release tag matches ${version}.\n`)
