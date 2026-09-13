import { describe, expect, it } from 'vitest'
import paths from '../fixtures/contracts/metadata-paths-v1.json' with { type: 'json' }
import fingerprints from '../fixtures/contracts/skill-fingerprints-v1.json' with { type: 'json' }
import { fingerprintSkillFiles, sha256, skillFingerprintHasher } from './hash.js'
import { looksLikeLocalPath } from './privacy-boundary.js'

describe('release-local app/CLI contracts', () => {
  it.each(['a\r\nb\r\n', '\r\r\n\r', '\r\n', 'a\rb', ''])(
    'streaming text matches the shared fingerprint: %j',
    async (contents) => {
      const bytes = Buffer.from(contents)
      const hasher = skillFingerprintHasher()
      async function* chunks() {
        for (const byte of bytes) {
          yield Uint8Array.of(byte)
          yield new Uint8Array()
        }
      }
      await hasher.addTextFile('large.md', chunks())
      expect(hasher.digest()).toBe(fingerprintSkillFiles([{ path: 'large.md', contents: bytes }]))
    },
  )

  it.each(fingerprints.cases)('fingerprint: $name', (fixture) => {
    const files = fixture.files.map(({ path, hex }) => ({
      path,
      contents: Buffer.from(hex, 'hex'),
    }))
    expect(fingerprintSkillFiles(files)).toBe(fixture.fingerprint)
    expect(fingerprintSkillFiles(files.toReversed())).toBe(fixture.fingerprint)
    const skillMd = files.find((file) => file.path === 'SKILL.md')
    if (!skillMd) throw new Error('Contract requires SKILL.md')
    expect(sha256(skillMd.contents)).toBe(fixture.skillMdFingerprint)
  })
  it.each(paths.cases)('metadata path: $value', ({ value, blocked }) => {
    expect(looksLikeLocalPath(value)).toBe(blocked)
  })
})
