import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatDedupe, formatEarlyAccessCta, formatReport } from './output.js'
import type { DuplicateCandidate, LocalReport, LocalSession, LocalSkill } from './types.js'
import { displayWidth } from './value.js'

const esc = String.fromCharCode(27)
const osc8 = new RegExp(`${esc}\\]8;;.*?${esc}\\\\`, 'gu')
const ansiColor = new RegExp(`${esc}\\[[0-9;]*m`, 'gu')

function skill(name: string): LocalSkill {
  return {
    badges: [],
    category: 'other',
    definitionTokens: 0,
    description: null,
    descriptionTokens: 0,
    directory: `/fixture/${name}`,
    fingerprint: `fingerprint-${name}`,
    harness: 'claude-code',
    lint: [],
    name,
    provenance: null,
    realDirectory: `/fixture/${name}`,
    repo: null,
    skillMdFingerprint: `md-${name}`,
    skillMdText: '',
    source: 'user',
  }
}

function pair(left: string, right: string, similarity: number): DuplicateCandidate {
  return {
    left: skill(left),
    method: 'word-5-shingle-jaccard',
    methodVersion: '1',
    right: skill(right),
    similarity,
  }
}

function sessionCalling(skillName: string, calls: number): LocalSession {
  return {
    catalogSkillPaths: [],
    endedAt: null,
    harness: 'claude-code',
    harnessVersion: '1.0.0',
    invocations: Array.from({ length: calls }, (_, ordinal) => ({
      confidence: 'verified' as const,
      harness: 'claude-code' as const,
      model: null,
      nativeSkillPath: null,
      ordinal,
      outcome: 'success' as const,
      skillName,
      timestamp: null,
      tokenScope: 'unavailable' as const,
      tokenSegment: null,
      trigger: 'manual' as const,
    })),
    modelFallback: null,
    nativeCwd: null,
    nativeId: `session-${skillName}`,
    parserVersion: '1',
    repo: null,
    startedAt: null,
    status: 'success',
    tokenSegments: [],
  }
}

function reportWith(candidates: DuplicateCandidate[]): LocalReport {
  return {
    drift: [],
    duplicateCandidates: candidates,
    generatedAt: '2026-08-30T12:00:00.000Z',
    historyRoots: [],
    parserCoverage: [],
    sessions: [],
    skills: [],
    window: { from: '2026-07-31T12:00:00.000Z', to: '2026-08-30T12:00:00.000Z' },
  }
}

/** Ten calls on `called`, one call and a lint finding on `flagged`, nothing on `unused`. */
function mixedReport(): LocalReport {
  return {
    ...reportWith([]),
    sessions: [sessionCalling('called', 10), sessionCalling('flagged', 1)],
    skills: [
      skill('unused'),
      { ...skill('flagged'), lint: ['missing-description'] },
      skill('called'),
    ],
  }
}

beforeEach(() => {
  vi.stubEnv('LC_ALL', 'en_US.UTF-8')
  vi.stubEnv('COLORTERM', 'truecolor')
  vi.stubEnv('COLORFGBG', undefined)
})

afterEach(() => vi.unstubAllEnvs())

describe('duplicate pairs in the report overview', () => {
  it('keeps candidate counts out of the overview until every pair is trustworthy', () => {
    const output = formatReport(reportWith([pair('a', 'b', 0.92), pair('c', 'd', 0.42)]), {
      color: false,
    })
    expect(output).toContain('0 drifted skills')
    expect(output).not.toContain('duplicate')
  })
})

describe('report sections', () => {
  it('leads with recent activity, then needs attention, then no calls', () => {
    const output = formatReport(mixedReport(), { color: false })

    expect(output.indexOf('Recent activity · 1')).toBeLessThan(
      output.indexOf('Needs attention · 1'),
    )
    expect(output.indexOf('Needs attention · 1')).toBeLessThan(output.indexOf('No calls · 1'))
    expect(output).toContain('2 called · 1 no calls · 0 not measured')
  })

  it('caps the no-calls section and points at --all', () => {
    const skills = Array.from({ length: 12 }, (_, index) => skill(`unused-${index + 1}`))
    const output = formatReport({ ...reportWith([]), skills }, { color: false })

    expect(output).toContain('No calls · 12')
    expect(output.match(/^ {2}unused-/gmu)).toHaveLength(10)
    expect(output).toContain(
      '2 other installations hidden. Run trce report --all to list everything.',
    )
  })

  it('prints the status legend only when glyph rows were rendered', () => {
    const report = { ...reportWith([]), skills: [skill('unused')] }
    const table = formatReport(report, { color: false, terminalWidth: 88 })
    const list = formatReport(report, { color: false, terminalWidth: 56 })
    const complete = formatReport(report, { all: true, color: false, terminalWidth: 88 })
    const empty = formatReport(reportWith([]), { color: false })

    expect(table).toContain('  SKILL')
    expect(table).not.toContain('\nStatus\n')
    expect(list).toContain('○ unused · no calls')
    expect(list).toContain('\nStatus\n  ● called · ○ no calls · ? not measured')
    expect(complete).toContain('\nStatus\n')
    expect(empty).not.toContain('\nStatus\n')
    expect(empty.endsWith('Local only · Nothing was sent.\n')).toBe(true)
  })

  it('adapts report rows to the terminal width', () => {
    const report = { ...reportWith([]), skills: [skill('unused')] }
    const full = formatReport(report, { color: false, terminalWidth: 88 })
    const compact = formatReport(report, { color: false, terminalWidth: 72 })
    const narrow = formatReport(report, { color: false, terminalWidth: 56 })

    expect(full).toContain('SKILL')
    expect(full).toContain('AGENT')
    expect(full).toContain('SCOPE')
    expect(full).toContain('CATEGORY')
    expect(compact).toContain('SKILL')
    expect(compact).toContain('AGENT')
    expect(compact).toContain('SCOPE')
    expect(compact).not.toContain('CATEGORY')
    expect(narrow).toContain('○ unused · no calls')
    expect(narrow).not.toContain('SKILL')
    expect(narrow.split('\n').every((line) => line.length <= 56)).toBe(true)
  })

  it('clamps to 40 columns and keeps every line inside them', () => {
    const report: LocalReport = {
      ...mixedReport(),
      skills: [
        {
          ...skill('a-very-long-skill-name-that-needs-to-fit-somewhere'),
          lint: ['no-frontmatter'],
        },
        ...Array.from({ length: 12 }, (_, index) => skill(`unused-${index + 1}`)),
      ],
    }
    for (const terminalWidth of [20, 40]) {
      const output = formatReport(report, { color: false, terminalWidth })
      expect(output.split('\n').every((line) => displayWidth(line) <= 40)).toBe(true)
      expect(output).toContain('a-very-lo')
      expect(output).toContain('other installations hidden.')
    }
  })

  it('uses product vocabulary without changing machine-facing values', () => {
    const personal = skill('personal-skill')
    const shared = {
      ...skill('shared-skill'),
      category: 'docs-release' as const,
      provenance: {
        kind: 'team_catalog' as const,
        path: '.trce/skills/shared-skill',
        ref: 'main',
        repository: 'acme/skills',
      },
    }
    const output = formatReport(
      {
        ...reportWith([]),
        skills: [personal, shared],
      },
      { all: true, color: false },
    )

    expect(output).toContain('2 skills · 2 installations')
    expect(output).toContain('Claude Code · Personal · Other')
    expect(output).toContain('Claude Code · Shared · Docs & release')
    expect(output).not.toMatch(/verified|inferred/u)
  })

  it('keeps every report line readable in a narrow terminal', () => {
    const needsAttention: LocalSkill = {
      ...skill('a-very-long-skill-name-that-needs-to-fit'),
      badges: ['scripts', 'shell', 'network', 'install', 'env'],
      lint: ['name-directory-mismatch', 'missing-description'],
    }
    const output = formatReport(
      {
        ...reportWith([]),
        skills: [needsAttention],
      },
      { all: true, color: false, terminalWidth: 56 },
    )

    expect(output).toContain('No calls · 1')
    expect(output).toContain('Issues: name does not match folder, missing')
    expect(output).not.toContain('name-directory-mismatch')
    expect(output.split('\n').every((line) => line.length <= 56)).toBe(true)
  })

  it('uses the compact block wordmark and app semantic colors', () => {
    const report = { ...reportWith([]), skills: [skill('unused')] }
    const truecolor = formatReport(report, { all: true, color: true })

    expect(truecolor).toContain(`${esc}[1mReview system for your agent skills${esc}[0m`)
    expect(truecolor).toContain(`${esc}[38;2;157;152;255mtrce.sh${esc}[0m`)
    expect(truecolor).toContain(`${esc}[38;2;86;179;102m●${esc}[0m`)
    expect(truecolor).toContain(`${esc}[38;2;255;157;54m?${esc}[0m`)

    vi.stubEnv('COLORTERM', undefined)
    const indexed = formatReport(report, { all: true, color: true })
    expect(indexed).toContain(`${esc}[38;5;99mtrce.sh${esc}[0m`)
    expect(indexed).toContain(`${esc}[38;5;71m●${esc}[0m`)
    expect(indexed).not.toContain('38;2;')
  })
})

describe('numbers', () => {
  it('prints thousands separators in every count and keeps the calls column aligned', () => {
    const skills = [
      ...Array.from({ length: 1500 }, (_, index) => skill(`unused-${index + 1}`)),
      skill('busy'),
      skill('quiet'),
    ]
    const output = formatReport(
      {
        ...reportWith([]),
        sessions: [sessionCalling('busy', 1234), sessionCalling('quiet', 3)],
        skills,
      },
      { color: false, terminalWidth: 88 },
    )
    const rows = output.split('\n').filter((line) => /^ {2}(busy|quiet) /u.test(line))

    expect(output).toContain('1,502 skills · 1,502 installations')
    expect(output).toContain('1,237 calls')
    expect(output).toContain('No calls · 1,500')
    expect(output).toContain('1,490 other installations hidden')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('  1,234  Other')
    expect(rows[1]).toContain('      3  Other')
    expect(rows[0]?.indexOf('  Other')).toBe(rows[1]?.indexOf('  Other'))
  })

  it('formats list-layout counts too', () => {
    const output = formatReport(
      { ...reportWith([]), sessions: [sessionCalling('busy', 2500)], skills: [skill('busy')] },
      { all: true, color: false },
    )
    expect(output).toContain('● busy · 2,500 calls')
    expect(output).toContain('All installations · 1')
  })
})

describe('east asian width', () => {
  it('aligns table columns and truncates by display width', () => {
    const output = formatReport(
      { ...reportWith([]), skills: [skill('abc'), skill('日本語スキル')] },
      { color: false, terminalWidth: 88 },
    )
    const rows = output.split('\n').filter((line) => line.includes('Claude Code'))

    expect(rows).toHaveLength(2)
    const agentColumns = rows.map((row) => displayWidth(row.slice(0, row.indexOf('Claude Code'))))
    expect(agentColumns[0]).toBe(agentColumns[1])

    const narrow = formatReport(
      { ...reportWith([]), skills: [skill('日本語'.repeat(20))] },
      { color: false, terminalWidth: 40 },
    )
    expect(narrow.split('\n').every((line) => displayWidth(line) <= 40)).toBe(true)
    expect(narrow).toContain('…')
  })
})

describe('ascii mode', () => {
  it('draws the report with ASCII glyphs and separators', () => {
    const output = formatReport(mixedReport(), { all: true, ascii: true, color: false })

    expect(output).toContain('Local report - last 30 days')
    expect(output).toContain('* called - o no calls - ? not measured')
    expect(output).toContain('  * called - 10 calls')
    expect(output).toContain('  o unused - no calls')
    expect(output).toContain('Local only - Nothing was sent.')
    expect(output).not.toMatch(/[·●○…─]/u)
  })

  it('draws tables, the dedupe list, and the early-access box with ASCII', () => {
    const table = formatReport(
      {
        ...reportWith([]),
        skills: [skill('a-very-long-skill-name-that-does-not-fit-in-the-column-at-all')],
      },
      { ascii: true, color: false, terminalWidth: 60 },
    )
    expect(table).toMatch(/^ {2}-{40,}$/mu)
    expect(table).toContain('...')

    const dedupe = formatDedupe([pair('a', 'b', 0.92), pair('c', 'd', 0.42)], {
      ascii: true,
      color: false,
    })
    expect(dedupe).toContain('Likely - similarity >= 50% - 1')
    expect(dedupe).toContain('Possible - similarity 30%-50% - 1')
    expect(dedupe).toContain('  a <-> b  92.0%')

    const box = formatEarlyAccessCta({ ascii: true, color: false, hyperlinks: false })
    const lines = box.split('\n')
    expect(lines[0]).toBe(`+${'-'.repeat(48)}+`)
    expect(lines.at(-1)).toBe(`+${'-'.repeat(48)}+`)
    expect(lines[1]?.startsWith('|  ')).toBe(true)
  })
})

describe('early-access box', () => {
  it('keeps every styled border aligned at normal and narrow terminal widths', () => {
    for (const terminalWidth of [32, 40, 80]) {
      const output = formatEarlyAccessCta({
        color: true,
        hyperlinks: true,
        terminalWidth,
      })
      const visible = output.replace(osc8, '').replace(ansiColor, '')
      const expectedWidth = Math.min(50, Math.max(32, terminalWidth))

      expect(visible.split('\n').every((line) => line.length === expectedWidth)).toBe(true)
      expect(output).toContain(`${esc}]8;;https://trce.sh${esc}\\`)
    }
  })

  it('wraps the copy at word boundaries at every width', () => {
    const vocabulary = new Set(
      'Review skills across your team Request early access https://trce.sh'.split(' '),
    )
    for (let terminalWidth = 32; terminalWidth <= 50; terminalWidth += 1) {
      const output = formatEarlyAccessCta({ color: false, hyperlinks: false, terminalWidth })
      const lines = output.split('\n')
      const rows = lines.slice(1, -1)

      expect(lines.every((line) => line.length === terminalWidth)).toBe(true)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      for (const row of rows) {
        const content = row.slice(3, -3).trim()
        expect(content.length).toBeGreaterThan(0)
        for (const word of content.split(/\s+/u)) expect(vocabulary.has(word)).toBe(true)
      }
      expect(rows.map((row) => row.slice(3, -3).trim()).join(' ')).toContain(
        'Review skills across your team',
      )
    }
  })
})

describe('dedupe buckets', () => {
  it('keeps the full list, sorted, with a count per bucket', () => {
    const output = formatDedupe(
      [pair('a', 'b', 0.92), pair('c', 'd', 0.55), pair('e', 'f', 0.42)],
      { color: false },
    )
    expect(output).toContain('Duplicate candidates · 3')
    expect(output).toContain('Likely · similarity ≥ 50% · 2')
    expect(output).toContain('Possible · similarity 30%–50% · 1')
    expect(output.indexOf('a ↔ b')).toBeLessThan(output.indexOf('c ↔ d'))
    expect(output.indexOf('c ↔ d')).toBeLessThan(output.indexOf('e ↔ f'))
    expect(output).toContain('Local only · normalized 5-word shingle Jaccard, similarity > 30%.')
    expect(output).not.toContain('threshold')
  })

  it('says so when a bucket is empty', () => {
    const output = formatDedupe([pair('e', 'f', 0.42)], { color: false })
    expect(output).toContain('Likely · similarity ≥ 50% · 0')
    expect(output).toContain('None found.')
    expect(output).toContain('e ↔ f  42.0%')
  })

  it('caps each bucket at 20 pairs unless --all is set', () => {
    const likely = Array.from({ length: 25 }, (_, index) =>
      pair(`likely-${index}`, `twin-${index}`, 0.9 - index * 0.001),
    )
    const possible = [pair('p', 'q', 0.4)]
    const capped = formatDedupe([...likely, ...possible], { color: false, commandPrefix: 'trce' })
    const complete = formatDedupe([...likely, ...possible], { all: true, color: false })

    expect(capped).toContain('Likely · similarity ≥ 50% · 25')
    expect(capped.match(/^ {2}likely-\d+ ↔ /gmu)).toHaveLength(20)
    expect(capped).toContain('  5 more pairs hidden. Run trce dedupe --all to list everything.')
    expect(capped).toContain('  p ↔ q  40.0%')
    expect(complete.match(/^ {2}likely-\d+ ↔ /gmu)).toHaveLength(25)
    expect(complete).not.toContain('hidden')
  })
})
