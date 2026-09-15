import { describe, expect, it } from 'vitest'
import { animateReport } from './animate.js'
import { buildReportScene, formatReport, renderReportScene } from './output.js'
import type { LocalReport, LocalSession, LocalSkill } from './types.js'

const esc = String.fromCharCode(27)
const escapes = new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, 'gu')
const cursorUp = new RegExp(`^${esc}\\[(\\d+)A`, 'u')
const cursorUpBoundary = new RegExp(`(?=${esc}\\[\\d+A)`, 'u')
const clearedLine = new RegExp(`^\\r${esc}\\[2K`, 'u')
const hideCursor = `${esc}[?25l`
const showCursor = `${esc}[?25h`

function skill(name: string): LocalSkill {
  return {
    badges: [],
    category: 'other',
    definitionTokens: 40,
    description: `${name} description`,
    descriptionTokens: 4,
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

function report(): LocalReport {
  return {
    drift: [],
    duplicateCandidates: [],
    generatedAt: '2026-09-15T10:00:00.000Z',
    historyRoots: [],
    parserCoverage: [],
    sessions: [sessionCalling('busy', 12), sessionCalling('quiet', 1)],
    skills: [skill('busy'), skill('quiet'), skill('unused')],
    window: { from: '2026-08-16T10:00:00.000Z', to: '2026-09-15T10:00:00.000Z' },
  }
}

describe('report scene', () => {
  it('renders at rest exactly like the static report', () => {
    const options = { color: true, hyperlinks: false, terminalWidth: 120 }
    expect(renderReportScene(buildReportScene(report(), options))).toBe(
      formatReport(report(), options),
    )
  })

  it('draws the trace and counts up with progress', () => {
    const scene = buildReportScene(report(), { color: true, hyperlinks: false, terminalWidth: 120 })
    const plain = (lines: string[]) => lines.join('\n').replace(escapes, '')

    expect(plain(scene.header(0))).not.toContain('╯')
    expect(plain(scene.header(1))).toContain('●──╯')
    expect(plain(scene.overview(0))).toContain('1 skill ')
    expect(plain(scene.overview(1))).toContain('3 skills')
    expect(scene.activity?.rows).toHaveLength(2)
    expect(plain([scene.activity?.rows[0]?.(0) ?? ''])).toMatch(/busy.* 1 {2}/u)
    expect(plain([scene.activity?.rows[0]?.(1) ?? ''])).toMatch(/busy.* 12 {2}/u)
  })
})

describe('animateReport', () => {
  it('ends on the static report and restores the cursor', async () => {
    const scene = buildReportScene(report(), { color: false, terminalWidth: 120 })
    const writes: string[] = []
    let frames = 0
    await animateReport(scene, (value) => writes.push(value), {
      sleep: async () => {
        frames += 1
      },
    })

    expect(writes[0]).toBe(hideCursor)
    expect(writes.at(-1)).toBe(showCursor)
    expect(frames).toBeGreaterThan(20)

    // Replay the writes on a small screen model: a cursor-up rewrites the lines above.
    const screen: string[] = []
    let cursor = 0
    for (const chunk of writes.slice(1, -1)) {
      for (const part of chunk.split(cursorUpBoundary)) {
        const up = cursorUp.exec(part)
        if (up) cursor -= Number(up[1])
        const lines = part.replace(cursorUp, '').split('\n').slice(0, -1)
        for (const line of lines) {
          screen[cursor] = line.replace(clearedLine, '')
          cursor += 1
        }
      }
    }
    expect(`${screen.join('\n')}\n`).toBe(renderReportScene(scene))
  })
})
