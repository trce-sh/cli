import { readdir, readFile, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const documents = (
  await Promise.all(
    ['', 'docs/', '.github/'].map(async (directory) =>
      (
        await readdir(new URL(directory, root), { recursive: directory !== '' })
      )
        .filter((file) => file.endsWith('.md'))
        .map((file) => `${directory}${file.replaceAll('\\', '/')}`),
    ),
  )
).flat()

function prose(markdown: string) {
  return markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, '')
}

function localTargets(markdown: string) {
  const content = prose(markdown)
  const markdownLinks = [...content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)].map(
    (match) => match[1] ?? '',
  )
  const htmlLinks = [...content.matchAll(/\b(?:src|srcset|href)="([^"]+)"/gu)].map(
    (match) => match[1] ?? '',
  )
  return [...markdownLinks, ...htmlLinks].filter(
    (target) => target !== '' && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target),
  )
}

function headingAnchors(markdown: string) {
  const counts = new Map<string, number>()
  return [...prose(markdown).matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => {
    const slug = (match[1] ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/gu, '-')
    const count = counts.get(slug) ?? 0
    counts.set(slug, count + 1)
    return count === 0 ? slug : `${slug}-${count}`
  })
}

describe('repository documentation', () => {
  it('uses only static campaign fields in repository links to trce.sh', async () => {
    for (const document of documents) {
      const markdown = await readFile(new URL(document, root), 'utf8')
      for (const match of markdown.matchAll(/\]\((https:\/\/trce\.sh[^)]*)\)/gu)) {
        const url = new URL(match[1] ?? '')
        expect(url.hostname, document).toBe('trce.sh')
        expect(url.searchParams.get('utm_source'), document).toBe('github')
        expect(url.searchParams.get('utm_medium'), document).toBe('referral')
        expect(url.searchParams.get('utm_campaign'), document).toBe('cli')
        expect(url.searchParams.get('utm_content'), document).toMatch(/^[a-z_]+$/u)
        expect([...url.searchParams.keys()].sort()).toEqual([
          'utm_campaign',
          'utm_content',
          'utm_medium',
          'utm_source',
        ])
      }
    }
  })

  it.each(documents)('resolves local links and section anchors in %s', async (document) => {
    const source = new URL(document, root)
    for (const target of localTargets(await readFile(source, 'utf8'))) {
      const destination = new URL(target, source)
      const fragment = decodeURIComponent(destination.hash.slice(1))
      destination.hash = ''
      destination.search = ''
      await expect(stat(destination), `${document}: ${target}`).resolves.toBeDefined()
      if (fragment && destination.pathname.endsWith('.md')) {
        expect(
          headingAnchors(await readFile(destination, 'utf8')),
          `${document}: ${target}`,
        ).toContain(fragment)
      }
    }
  })

  it('checks nested badges and themed image sources without reading code examples', () => {
    expect(
      localTargets(
        '[![CI](https://example.test/badge)](README.md)\n' +
          '<source srcset="assets/dark.svg"><img src="assets/light.svg">\n' +
          '```md\n[example](does-not-exist.md)\n```\n',
      ),
    ).toEqual(['README.md', 'assets/dark.svg', 'assets/light.svg'])
    expect(
      headingAnchors('# Build and install\n## Build and install\n## `push` (preview)'),
    ).toEqual(['build-and-install', 'build-and-install-1', 'push-preview'])
  })

  it('uses the installed command in user guides and links the actual CI workflow', async () => {
    const readme = await readFile(new URL('README.md', root), 'utf8')
    const guide = await readFile(new URL('docs/USAGE.md', root), 'utf8')
    for (const document of [readme, guide]) {
      expect(document).not.toContain('node dist/bin.js')
      expect(document).not.toContain('npx @trce/cli')
      expect(document).not.toContain('blob/main/')
    }
    const manifest: unknown = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('repository' in manifest) ||
      typeof manifest.repository !== 'object' ||
      manifest.repository === null ||
      !('url' in manifest.repository) ||
      typeof manifest.repository.url !== 'string'
    ) {
      throw new Error('Package repository URL is missing')
    }
    const repository = manifest.repository.url.replace(/^git\+/u, '').replace(/\.git$/u, '')
    expect(readme).toContain(`${repository}/actions/workflows/ci.yml/badge.svg?branch=main`)
    await expect(stat(new URL('.github/workflows/ci.yml', root))).resolves.toBeDefined()
  })
})
