export const packageFiles = [
  'dist',
  'assets/trce.svg',
  'assets/trce-dark.svg',
  'CHANGELOG.md',
  'LICENSE',
  'PRIVACY.md',
  'README.md',
]
const requiredPaths = [
  'package.json',
  'dist/bin.js',
  'dist/index.js',
  'dist/index.d.ts',
  ...packageFiles.filter((path) => path !== 'dist'),
]

export function assertPackagePolicy(manifest) {
  if (
    JSON.stringify([...(manifest.files ?? [])].sort()) !== JSON.stringify([...packageFiles].sort())
  ) {
    throw new Error('Package files must match the reviewed allowlist')
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (Object.keys(manifest[field] ?? {}).length)
      throw new Error('The CLI must have no runtime dependencies')
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[hook]) throw new Error(`Package must not run ${hook} on a user machine`)
  }
}

export function assertPackedFiles(files) {
  if (!Array.isArray(files)) throw new Error('npm pack did not return a file list')
  const paths = files.map((file) => file.path)
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      (!requiredPaths.includes(path) &&
        !/^dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.js|\.d\.ts)$/u.test(path))
    ) {
      throw new Error(`Unexpected package file: ${path}`)
    }
  }
  for (const path of requiredPaths) {
    if (!paths.includes(path)) throw new Error(`Missing package file: ${path}`)
  }
}
