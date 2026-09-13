import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { driftGroups, duplicateCandidates } from './analysis.js'
import { agentHomes, codingAgentInstallPath } from './coding-agents.js'
import { compareCodePoints, fingerprintSkillFiles } from './hash.js'
import { nameMatchesDirectory, scanInventory } from './inventory.js'

const fixtureHome = fileURLToPath(new URL('../fixtures/home-synthetic/', import.meta.url))
const vendoredHome = fileURLToPath(new URL('../fixtures/home-vendored/', import.meta.url))
/** Scans in these tests must not pick up a relocated agent home from the developer's shell. */
const noEnv: NodeJS.ProcessEnv = {}
const nul = String.fromCharCode(0)

const temporaryDirectories: string[] = []

async function temporaryHome(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Git cannot track a nested `.git` directory and this repository ignores `node_modules`, so the
 * fixture stores them under placeholder names that the test restores in a temporary copy.
 */
const placeholderNames: Record<string, string> = {
  _git: '.git',
  _hidden: '.hidden',
  _node_modules: 'node_modules',
}

async function materializeHome(fixture: string, prefix: string) {
  const home = await temporaryHome(prefix)
  await cp(fixture, home, { recursive: true })
  await restorePlaceholderNames(home)
  return home
}

async function restorePlaceholderNames(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const restored = placeholderNames[entry.name]
    const path = join(directory, restored ?? entry.name)
    if (restored) await rename(join(directory, entry.name), path)
    await restorePlaceholderNames(path)
  }
}

async function writeSkill(directory: string, files: Record<string, string | Uint8Array>) {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('skill inventory', () => {
  it('fingerprints, lints, categorizes, and compares sanitized fixture skills', async () => {
    const skills = await scanInventory({ env: noEnv, homeDirectory: fixtureHome })

    expect(skills).toHaveLength(10)
    expect(skills.find((skill) => skill.name === 'legacy-helper')?.lint).toEqual([
      'no-frontmatter',
      'missing-description',
    ])
    expect(skills.find((skill) => skill.name === 'release-notes')?.category).toBe('docs-release')
    expect(
      skills.find((skill) => skill.name === 'pr-review' && skill.harness === 'claude-code')?.badges,
    ).toEqual(['scripts', 'shell', 'env'])
    expect(driftGroups(skills).map((group) => group.name)).toEqual(['pr-review'])
    expect(duplicateCandidates(skills)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          left: expect.objectContaining({ name: 'code-review' }),
          right: expect.objectContaining({ name: 'pr-review' }),
        }),
      ]),
    )
  })

  it('indexes Cursor native and compatible skill roots without inventing usage evidence', async () => {
    const home = await temporaryHome('trce-cursor-inventory-')
    const cursorSkill = join(home, '.cursor', 'skills', 'cursor-native')
    const sharedSkill = join(home, '.agents', 'skills', 'shared-agent-skill')
    await Promise.all([
      mkdir(cursorSkill, { recursive: true }),
      mkdir(sharedSkill, { recursive: true }),
    ])
    await Promise.all([
      writeFile(
        join(cursorSkill, 'SKILL.md'),
        '---\nname: cursor-native\ndescription: A sanitized Cursor fixture.\n---\n',
        'utf8',
      ),
      writeFile(
        join(sharedSkill, 'SKILL.md'),
        '---\nname: shared-agent-skill\ndescription: A sanitized shared fixture.\n---\n',
        'utf8',
      ),
    ])

    const skills = await scanInventory({ env: noEnv, homeDirectory: home })

    expect(skills.filter((skill) => skill.harness === 'cursor').map((skill) => skill.name)).toEqual(
      ['cursor-native', 'shared-agent-skill'],
    )
    expect(
      skills.some((skill) => skill.harness === 'codex' && skill.name === 'shared-agent-skill'),
    ).toBe(true)
  })

  it('canonicalizes symlinked skill roots and does not hash files outside the skill', async () => {
    const home = await temporaryHome('trce-inventory-')
    const canonical = join(home, 'canonical', 'safe-skill')
    const skillsRoot = join(home, '.claude', 'skills')
    await mkdir(canonical, { recursive: true })
    await mkdir(skillsRoot, { recursive: true })
    await writeFile(
      join(canonical, 'SKILL.md'),
      '---\nname: safe-skill\ndescription: A safe fixture.\n---\n',
      'utf8',
    )
    await writeFile(join(home, 'outside.txt'), 'must not be hashed', 'utf8')
    await symlink(canonical, join(skillsRoot, 'safe-skill'))
    await symlink(join(home, 'outside.txt'), join(canonical, 'outside-link.txt'))

    const [skill] = await scanInventory({ env: noEnv, homeDirectory: home })

    expect(skill?.realDirectory).toBe(await realpath(canonical))
    expect(skill?.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(skill?.directory).toBe(join(skillsRoot, 'safe-skill'))
  })

  it('does not classify same-name skills from different repositories as drift', async () => {
    const home = await temporaryHome('trce-project-lineage-')
    const firstProject = join(home, 'first')
    const secondProject = join(home, 'second')
    for (const [project, description] of [
      [firstProject, 'First project definition.'],
      [secondProject, 'Second project definition.'],
    ] as const) {
      const root = join(project, '.agents', 'skills', 'same-name')
      await mkdir(root, { recursive: true })
      await writeFile(
        join(root, 'SKILL.md'),
        `---\nname: same-name\ndescription: ${description}\n---\n`,
        'utf8',
      )
    }

    const first = await scanInventory({
      env: noEnv,
      homeDirectory: home,
      projectDirectory: firstProject,
      projectRepo: 'acme/first',
    })
    const second = await scanInventory({
      env: noEnv,
      homeDirectory: home,
      projectDirectory: secondProject,
      projectRepo: 'acme/second',
    })

    expect(driftGroups([...first, ...second])).toEqual([])
  })

  it('skips .git, node_modules, and dot directories inside skills and plugin trees', async () => {
    const home = await materializeHome(vendoredHome, 'trce-vendored-')
    const skillDirectory = join(home, '.claude', 'skills', 'vendored-skill')
    const cleanHome = await temporaryHome('trce-vendored-clean-')
    const cleanDirectory = join(cleanHome, '.claude', 'skills', 'vendored-skill')
    await writeSkill(cleanDirectory, {
      'SKILL.md': await readFile(join(skillDirectory, 'SKILL.md')),
      'scripts/check.sh': await readFile(join(skillDirectory, 'scripts', 'check.sh')),
    })

    const skills = await scanInventory({ env: noEnv, homeDirectory: home })
    const [clean] = await scanInventory({ env: noEnv, homeDirectory: cleanHome })
    const claude = skills.filter((skill) => skill.harness === 'claude-code')

    await expect(readFile(join(skillDirectory, '.git', 'HEAD'), 'utf8')).resolves.toContain('ref:')
    await expect(
      readFile(join(skillDirectory, 'node_modules', 'left-pad', 'package.json'), 'utf8'),
    ).resolves.toContain('left-pad')
    expect(claude.map((skill) => [skill.name, skill.source])).toEqual([
      ['plugin-skill', 'plugin'],
      ['vendored-skill', 'user'],
    ])
    expect(claude[1]?.fingerprint).toBe(clean?.fingerprint)
    expect(claude[1]?.badges).toEqual(clean?.badges)
  })

  it('treats a case-only name and directory difference as a match on darwin and win32', async () => {
    const home = await temporaryHome('trce-case-')
    await writeSkill(join(home, '.claude', 'skills', 'Review-Helper'), {
      'SKILL.md': '---\nname: review-helper\ndescription: Reviews.\n---\n',
    })

    const [onMac] = await scanInventory({ env: noEnv, homeDirectory: home, platform: 'darwin' })
    const [onLinux] = await scanInventory({ env: noEnv, homeDirectory: home, platform: 'linux' })

    expect(onMac?.lint).toEqual([])
    expect(onLinux?.lint).toEqual(['name-directory-mismatch'])
    expect(nameMatchesDirectory('review-helper', 'Review-Helper', 'win32')).toBe(true)
    expect(nameMatchesDirectory('review-helper', 'review_helper', 'win32')).toBe(false)
    expect(nameMatchesDirectory('review-helper', 'Review-Helper', 'linux')).toBe(false)
  })
})

describe('streaming inventory fingerprints', () => {
  it.each(['large.md', 'notes', 'binary-notes'])(
    'matches the shared hash for a file above the streaming threshold: %s',
    async (path) => {
      const home = await temporaryHome('trce-large-fingerprint-')
      const skill = Buffer.from(
        '---\nname: large-skill\ndescription: Synthetic hashing fixture.\n---\n',
      )
      const contents = Buffer.from(
        'x\r\n'.repeat(2_800_000) + (path === 'binary-notes' ? '\0' : ''),
      )
      expect(contents.length).toBeGreaterThan(8_000_000)
      await writeSkill(join(home, '.agents', 'skills', 'large-skill'), {
        'SKILL.md': skill,
        [path]: contents,
      })
      const skills = await scanInventory({ env: noEnv, homeDirectory: home })
      const found = skills.find((entry) => entry.name === 'large-skill')
      expect(found?.fingerprint).toBe(
        fingerprintSkillFiles([
          { path: 'SKILL.md', contents: skill },
          { path, contents },
        ]),
      )
    },
  )
})

describe('relocated agent homes', () => {
  it('honors CLAUDE_CONFIG_DIR and CODEX_HOME and falls back to the dot directories', () => {
    const env = { CLAUDE_CONFIG_DIR: '/opt/claude', CODEX_HOME: '/opt/codex' }

    expect(agentHomes(env, '/home/dev')).toEqual({
      claude: resolve('/opt/claude'),
      codex: resolve('/opt/codex'),
      cursor: join('/home/dev', '.cursor'),
    })
    expect(agentHomes({ CLAUDE_CONFIG_DIR: '  ', CODEX_HOME: '' }, '/home/dev')).toEqual({
      claude: join('/home/dev', '.claude'),
      codex: join('/home/dev', '.codex'),
      cursor: join('/home/dev', '.cursor'),
    })
    expect(codingAgentInstallPath('/home/dev', 'claude-code', 'review', env)).toBe(
      join(resolve('/opt/claude'), 'skills', 'review'),
    )
    expect(codingAgentInstallPath('/home/dev', 'codex', 'review', env)).toBe(
      join('/home/dev', '.agents', 'skills', 'review'),
    )
  })

  it('scans skills under relocated Claude Code and Codex homes', async () => {
    const home = await temporaryHome('trce-relocated-')
    const claudeHome = join(home, 'elsewhere', 'claude')
    const codexHome = join(home, 'elsewhere', 'codex')
    await writeSkill(join(claudeHome, 'skills', 'moved-claude'), {
      'SKILL.md': '---\nname: moved-claude\ndescription: Lives in CLAUDE_CONFIG_DIR.\n---\n',
    })
    await writeSkill(join(codexHome, 'skills', '.system', 'bundled-codex'), {
      'SKILL.md': '---\nname: bundled-codex\ndescription: Lives in CODEX_HOME.\n---\n',
    })
    const env = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }

    const relocated = await scanInventory({ env, homeDirectory: home })
    const standard = await scanInventory({ env: noEnv, homeDirectory: home })

    expect(relocated.map((skill) => [skill.name, skill.harness, skill.source])).toEqual([
      ['bundled-codex', 'codex', 'bundled'],
      ['moved-claude', 'claude-code', 'user'],
      ['moved-claude', 'cursor', 'user'],
    ])
    expect(standard).toEqual([])
  })
})

describe('skill fingerprints', () => {
  it('orders paths by code point instead of locale', () => {
    const paths = [
      'scripts/a.sh',
      'Zed.md',
      'SKILL.md',
      'z.md',
      'a-b',
      'a/b',
      '\u{1F600}.md',
      'é.md',
    ]

    expect(paths.toSorted(compareCodePoints)).toEqual([
      'SKILL.md',
      'Zed.md',
      'a-b',
      'a/b',
      'scripts/a.sh',
      'z.md',
      'é.md',
      '\u{1F600}.md',
    ])
    expect(compareCodePoints('abc', 'ab')).toBe(1)
    expect(compareCodePoints('ab', 'abc')).toBe(-1)
    expect(compareCodePoints('same', 'same')).toBe(0)
  })

  it('hashes files in code-point order with a length-framed path', async () => {
    const home = await temporaryHome('trce-fingerprint-order-')
    const files: Array<[string, string]> = [
      ['SKILL.md', '---\nname: ordered\ndescription: Ordered.\n---\n'],
      ['Zed.md', 'zed\n'],
      ['scripts/a.sh', '#!/bin/sh\n'],
    ]
    await writeSkill(join(home, '.claude', 'skills', 'ordered'), Object.fromEntries(files))
    const expected = createHash('sha256')
    for (const [path, contents] of files) {
      expected.update(`${Buffer.byteLength(path, 'utf8')}:${path}:${contents}${nul}`)
    }

    const [skill] = await scanInventory({ env: noEnv, homeDirectory: home })

    expect(skill?.fingerprint).toBe(expected.digest('hex'))
    expect(
      fingerprintSkillFiles(
        files.toReversed().map(([path, contents]) => ({ contents: Buffer.from(contents), path })),
      ),
    ).toBe(skill?.fingerprint)
  })

  it('normalizes CRLF in text files and keeps binary files byte-exact', async () => {
    const binary = Uint8Array.from([0x89, 0x50, 0x0d, 0x0a, 0x00, 0x0d, 0x0a])
    const lfFiles = {
      Makefile: 'all:\n\techo ok\n',
      'SKILL.md': '---\nname: eol\ndescription: Line endings.\n---\n\nBody.\n',
      'image.png': binary,
      'scripts/run.sh': '#!/bin/sh\necho ok\n',
    }
    const toCrlf = (text: string) => text.replaceAll('\n', '\r\n')
    const crlfFiles = {
      ...lfFiles,
      Makefile: toCrlf(lfFiles.Makefile),
      'SKILL.md': toCrlf(lfFiles['SKILL.md']),
      'scripts/run.sh': toCrlf(lfFiles['scripts/run.sh']),
    }
    const lfHome = await temporaryHome('trce-eol-lf-')
    const crlfHome = await temporaryHome('trce-eol-crlf-')
    const binaryHome = await temporaryHome('trce-eol-binary-')
    await writeSkill(join(lfHome, '.claude', 'skills', 'eol'), lfFiles)
    await writeSkill(join(crlfHome, '.claude', 'skills', 'eol'), crlfFiles)
    await writeSkill(join(binaryHome, '.claude', 'skills', 'eol'), {
      ...lfFiles,
      'image.png': Uint8Array.from([0x89, 0x50, 0x0a, 0x00, 0x0a]),
    })

    const [lf] = await scanInventory({ env: noEnv, homeDirectory: lfHome })
    const [crlf] = await scanInventory({ env: noEnv, homeDirectory: crlfHome })
    const [binaryChanged] = await scanInventory({ env: noEnv, homeDirectory: binaryHome })

    expect(crlf?.fingerprint).toBe(lf?.fingerprint)
    expect(binaryChanged?.fingerprint).not.toBe(lf?.fingerprint)
    expect(
      fingerprintSkillFiles([
        { contents: Buffer.from('a\r\nb'), path: 'notes' },
        { contents: Uint8Array.from([0x0d, 0x0a, 0x00]), path: 'blob' },
      ]),
    ).toBe(
      fingerprintSkillFiles([
        { contents: Buffer.from('a\nb'), path: 'notes' },
        { contents: Uint8Array.from([0x0d, 0x0a, 0x00]), path: 'blob' },
      ]),
    )
    expect(
      fingerprintSkillFiles([{ contents: Uint8Array.from([0x0d, 0x0a, 0x00]), path: 'blob' }]),
    ).not.toBe(fingerprintSkillFiles([{ contents: Uint8Array.from([0x0a, 0x00]), path: 'blob' }]))
  })
})
