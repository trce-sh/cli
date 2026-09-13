import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanInventory } from './inventory.js'
import { loadLocalSkillFiles, selectActionSkill } from './local-skill-source.js'
import type { LocalSkill } from './types.js'

async function skillHome(files: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), 'trce-upload-'))
  const directory = join(home, '.claude', 'skills', 'demo')
  await mkdir(directory, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(directory, name, '..'), { recursive: true })
    await writeFile(join(directory, name), contents, 'utf8')
  }
  const [skill] = await scanInventory({ env: {}, homeDirectory: home })
  if (!skill) throw new Error('fixture skill missing')
  return skill
}

function skill(overrides: Partial<LocalSkill>): LocalSkill {
  return {
    badges: [],
    category: 'other',
    definitionTokens: 10,
    description: null,
    descriptionTokens: 0,
    directory: '/home/dev/.claude/skills/pr-review',
    fingerprint: 'a'.repeat(64),
    harness: 'claude-code',
    lint: [],
    name: 'pr-review',
    provenance: null,
    realDirectory: '/home/dev/.claude/skills/pr-review',
    repo: null,
    skillMdFingerprint: 'b'.repeat(64),
    skillMdText: '# pr-review',
    source: 'user',
    ...overrides,
  }
}

/**
 * `promote` and `unify` write the directory whose fingerprint the dashboard recorded (the version
 * the reviewer chose), never whatever happens to carry the name on this laptop.
 */
describe('loadLocalSkillFiles', () => {
  it('skips OS litter, keeps the inventory fingerprint on CRLF trees, and lists relative paths', async () => {
    const skill = await skillHome({
      '.DS_Store': 'litter',
      'SKILL.md': '---\r\nname: demo\r\n---\r\nDo the work.\r\n',
      'Thumbs.db': 'litter',
      'scripts/check.sh': '#!/bin/sh\r\nexit 0\r\n',
    })

    const files = await loadLocalSkillFiles(skill)

    expect(files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/check.sh'])
    expect(
      files.every((file) => !file.path.includes('/Users/') && !file.path.startsWith('/')),
    ).toBe(true)
  })

  it('refuses to upload a skill that carries an env file, naming it', async () => {
    const skill = await skillHome({
      '.env': 'TOKEN=secret',
      'SKILL.md': '---\nname: demo\n---\nDo the work.\n',
    })
    await expect(loadLocalSkillFiles(skill)).rejects.toThrow(
      'The skill contains .env, which may hold secrets. Remove it before sharing. Nothing changed.',
    )

    const nested = await skillHome({
      'SKILL.md': '---\nname: demo\n---\nDo the work.\n',
      'config/.env.local': 'TOKEN=secret',
    })
    await expect(loadLocalSkillFiles(nested)).rejects.toThrow('config/.env.local')
  })
})

describe('selectActionSkill', () => {
  it('picks the local copy whose fingerprint matches the recorded version', () => {
    const chosen = skill({
      fingerprint: 'c'.repeat(64),
      realDirectory: '/home/dev/.agents/skills/pr-review',
    })
    const selected = selectActionSkill([skill({}), chosen], {
      fingerprint: 'c'.repeat(64),
      name: 'pr-review',
    })
    expect(selected).toBe(chosen)
  })

  it('refuses when this laptop holds the skill at another version', () => {
    expect(() =>
      selectActionSkill([skill({})], { fingerprint: 'c'.repeat(64), name: 'pr-review' }),
    ).toThrow('This machine does not have the selected version of pr-review. Nothing changed.')
    expect(() =>
      selectActionSkill([skill({ name: 'other' })], {
        fingerprint: 'a'.repeat(64),
        name: 'pr-review',
      }),
    ).toThrow('does not have the selected version')
  })
})
