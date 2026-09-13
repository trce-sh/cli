import { describe, expect, it } from 'vitest'
import { assertPackagePolicy, assertPackedFiles, packageFiles } from '../scripts/package-policy.mjs'

const packed = [
  'package.json',
  'dist/bin.js',
  'dist/index.js',
  'dist/index.d.ts',
  ...packageFiles.filter((path) => path !== 'dist'),
].map((path) => ({ path }))

describe('published package boundary', () => {
  it('accepts only the reviewed artifacts and compiled modules', () => {
    expect(() => assertPackedFiles([...packed, { path: 'dist/parsers/codex.js' }])).not.toThrow()
    expect(() =>
      assertPackagePolicy({ files: packageFiles, scripts: { prepack: 'pnpm run verify' } }),
    ).not.toThrow()
  })
  it.each([
    '.env',
    'src/cli.ts',
    'app/page.tsx',
    'convex/schema.ts',
    'dist/bin.js.map',
    'dist/../private.js',
    'out.txt',
  ])('rejects %s in the tarball', (path) => {
    expect(() => assertPackedFiles([...packed, { path }])).toThrow('Unexpected package file')
  })
  it('requires the executable and privacy documentation', () => {
    expect(() => assertPackedFiles(packed.filter(({ path }) => path !== 'PRIVACY.md'))).toThrow(
      'Missing package file: PRIVACY.md',
    )
  })
  it('rejects broad packaging, runtime dependencies, and install scripts', () => {
    expect(() => assertPackagePolicy({ files: ['.'] })).toThrow('allowlist')
    expect(() =>
      assertPackagePolicy({ files: packageFiles, dependencies: { example: '1' } }),
    ).toThrow('runtime dependencies')
    expect(() =>
      assertPackagePolicy({ files: packageFiles, scripts: { postinstall: 'node collect.js' } }),
    ).toThrow('postinstall')
  })
})
