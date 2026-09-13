import { duplicateSimilarityFloor, likelyDuplicateSimilarity } from './analysis.js'
import {
  asciiMode,
  brand,
  type Glyphs,
  glyphs,
  supportsColor,
  supportsHyperlinks,
  terminalLink,
  terminalText,
} from './brand.js'
import { codingAgentHasUsageEvidence, codingAgentLabel } from './coding-agents.js'
import { defaultCommandPrefix } from './invocation.js'
import { publicDashboardUrl } from './service.js'
import type { DuplicateCandidate, HistoryRoot, LocalReport, LocalSkill } from './types.js'
import {
  displayWidth,
  homeRelativePath,
  padDisplayEnd,
  padDisplayStart,
  takeDisplayPrefix,
  takeDisplaySuffix,
} from './value.js'

type OutputOptions = {
  all?: boolean
  /** Plain ASCII glyphs and rules; defaults to `asciiMode()`. */
  ascii?: boolean
  color?: boolean
  commandPrefix?: string
  hyperlinks?: boolean
  /** Used to print scanned directories home-relative (`~/.claude/projects`). */
  homeDirectory?: string
  /** Terminal columns available for human-readable output. */
  terminalWidth?: number
}

type SkillSectionKind = 'activity' | 'attention' | 'no-calls' | 'other'
type SectionLayout = 'list' | 'table'

type SkillSection = {
  heading: string
  kind: SkillSectionKind
  skills: readonly LocalSkill[]
  total: number
}

type SkillOutputOptions = {
  color: boolean
  showCapabilities: boolean
  symbols: Glyphs
  width: number
}

type TableColumn = {
  align?: 'left' | 'right'
  header: string
  width: number
}

const defaultSectionLimit = 10
const dedupeSectionLimit = 20
const defaultTerminalWidth = 88
const minimumTerminalWidth = 40
const maximumTerminalWidth = 100
const earlyAccessWidth = 50
const minimumEarlyAccessWidth = 32
const numberFormat = new Intl.NumberFormat('en-US')

/** `1,234`: every count a person reads gets thousands separators. */
export function formatCount(value: number) {
  return numberFormat.format(value)
}

function counted(value: number, singular: string, plural = `${singular}s`) {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`
}

export function formatReport(report: LocalReport, options: OutputOptions = {}) {
  const color = options.color ?? supportsColor()
  const commandPrefix = options.commandPrefix ?? defaultCommandPrefix
  const symbols = glyphs(options.ascii ?? asciiMode())
  const dot = symbols.dot
  const width = reportWidth(options.terminalWidth)
  const countedInvocations = report.sessions
    .flatMap((session) => session.invocations)
    .filter((invocation) => invocation.confidence !== 'unknown')
  const usedKeys = new Set(
    countedInvocations.map((invocation) => `${invocation.harness}\u0000${invocation.skillName}`),
  )
  const usedSkills = report.skills.filter((skill) =>
    usedKeys.has(`${skill.harness}\u0000${skill.name}`),
  )
  const usageUnavailableSkills = report.skills.filter(
    (skill) => !codingAgentHasUsageEvidence(skill.harness),
  )
  const unusedSkills = report.skills.filter(
    (skill) =>
      codingAgentHasUsageEvidence(skill.harness) &&
      !usedKeys.has(`${skill.harness}\u0000${skill.name}`),
  )
  const invocationCounts = new Map<string, number>()
  for (const invocation of countedInvocations) {
    const key = `${invocation.harness}\u0000${invocation.skillName}`
    invocationCounts.set(key, (invocationCounts.get(key) ?? 0) + 1)
  }
  const skillNames = new Set(report.skills.map((skill) => skill.name))
  const sortedSkills = report.skills.toSorted((left, right) => {
    const leftCalls = invocationCounts.get(`${left.harness}\u0000${left.name}`) ?? 0
    const rightCalls = invocationCounts.get(`${right.harness}\u0000${right.name}`) ?? 0
    return (
      Number(right.lint.length > 0) - Number(left.lint.length > 0) ||
      rightCalls - leftCalls ||
      right.lint.length - left.lint.length ||
      left.name.localeCompare(right.name) ||
      left.harness.localeCompare(right.harness)
    )
  })
  const noCallSkills = unusedSkills.toSorted(
    (left, right) =>
      distributionPriority(left) - distributionPriority(right) ||
      left.name.localeCompare(right.name) ||
      left.harness.localeCompare(right.harness),
  )
  const attentionSkills = sortedSkills.filter((skill) => {
    return skill.lint.length > 0 && !unusedSkills.includes(skill)
  })
  const calledSkills = sortedSkills.filter((skill) => {
    const key = `${skill.harness}\u0000${skill.name}`
    return skill.lint.length === 0 && (invocationCounts.get(key) ?? 0) > 0
  })
  const otherSkills = sortedSkills.filter((skill) => {
    const key = `${skill.harness}\u0000${skill.name}`
    return (
      skill.lint.length === 0 &&
      (invocationCounts.get(key) ?? 0) === 0 &&
      !codingAgentHasUsageEvidence(skill.harness)
    )
  })
  const visibleNoCallSkills = options.all
    ? noCallSkills
    : noCallSkills.slice(0, defaultSectionLimit)
  const visibleAttentionSkills = options.all
    ? attentionSkills
    : attentionSkills.slice(0, defaultSectionLimit)
  const visibleCalledSkills = options.all
    ? calledSkills
    : calledSkills.slice(0, defaultSectionLimit)
  const visibleOtherSkills = options.all ? otherSkills : []
  const visibleSkillCount =
    visibleNoCallSkills.length +
    visibleAttentionSkills.length +
    visibleCalledSkills.length +
    visibleOtherSkills.length
  const hiddenSkillCount = report.skills.length - visibleSkillCount
  const lines = [
    brand({ color }),
    '',
    `Local report ${dot} last ${daysInWindow(report)} days`,
    '',
    'Overview',
  ]
  lines.push(
    ...wrapSegments(
      [counted(skillNames.size, 'skill'), counted(report.skills.length, 'installation')],
      width,
      dot,
    ),
    ...wrapSegments(
      [
        `Installations: ${metric(usedSkills.length, 'called')}`,
        metric(unusedSkills.length, 'no calls'),
        metric(usageUnavailableSkills.length, 'not measured'),
      ],
      width,
      dot,
    ),
    ...wrapSegments([counted(countedInvocations.length, 'call')], width, dot),
    ...wrapSegments([counted(report.drift.length, 'drifted skill')], width, dot),
  )
  if (report.sessions.length === 0) {
    lines.push('', ...scannedRootLines(report.historyRoots, daysInWindow(report), options))
  } else {
    // A report with sessions can still be short: say so instead of passing for complete.
    const unreadable = report.historyRoots.reduce((total, root) => total + root.unreadableFiles, 0)
    if (unreadable > 0) lines.push(unreadableFilesText(unreadable))
  }
  if (options.all) {
    lines.push('', `All installations ${dot} ${formatCount(report.skills.length)}`)
  }
  const skillOutputOptions: SkillOutputOptions = {
    color,
    showCapabilities: options.all === true,
    symbols,
    width,
  }
  const sections: SkillSection[] = [
    {
      heading: 'Recent activity',
      kind: 'activity',
      skills: visibleCalledSkills,
      total: calledSkills.length,
    },
    {
      heading: 'Needs attention',
      kind: 'attention',
      skills: visibleAttentionSkills,
      total: attentionSkills.length,
    },
    {
      heading: 'No calls',
      kind: 'no-calls',
      skills: visibleNoCallSkills,
      total: noCallSkills.length,
    },
    ...(options.all
      ? [
          {
            heading: 'Other installations',
            kind: 'other' as const,
            skills: visibleOtherSkills,
            total: otherSkills.length,
          },
        ]
      : []),
  ]
  let listRendered = false
  for (const section of sections) {
    const layout = appendSkillSection(lines, section, invocationCounts, skillOutputOptions)
    if (layout === 'list') listRendered = true
  }
  if (visibleSkillCount === 0) lines.push('', 'No calls or skill issues in this window.')
  if (!options.all && hiddenSkillCount > 0) {
    const hidden = `${counted(hiddenSkillCount, 'other installation')} hidden. Run ${commandPrefix} report --all to list everything.`
    lines.push('', ...wrapText(hidden, width).map((line) => terminalText(line, 'dim', { color })))
  }
  if (listRendered) {
    lines.push(
      '',
      'Status',
      ...wrapSegments(
        [
          `${terminalText(symbols.called, 'success', { color })} called`,
          `${terminalText(symbols.noCalls, 'dim', { color })} no calls`,
          `${terminalText(symbols.notMeasured, 'warning', { color })} not measured`,
        ],
        width,
        dot,
      ),
    )
  }
  lines.push('', terminalText(`Local only ${dot} Nothing was sent.`, 'dim', { color }))
  return `${lines.join('\n')}\n`
}

export function formatEarlyAccessCta(
  options: Pick<OutputOptions, 'ascii' | 'color' | 'hyperlinks' | 'terminalWidth'> = {},
) {
  const color = options.color ?? supportsColor()
  const hyperlinks = options.hyperlinks ?? supportsHyperlinks()
  const symbols = glyphs(options.ascii ?? asciiMode())
  const availableWidth = Math.floor(options.terminalWidth ?? earlyAccessWidth)
  const outerWidth = Math.min(earlyAccessWidth, Math.max(minimumEarlyAccessWidth, availableWidth))
  const innerWidth = outerWidth - 2
  const contentWidth = innerWidth - 4
  const border = (left: string, right: string) =>
    terminalText(`${left}${symbols.rule.repeat(innerWidth)}${right}`, 'dim', { color })
  const bar = terminalText(symbols.bar, 'dim', { color })
  const row = (plainText: string, renderedText = plainText) => {
    const rightPadding = ' '.repeat(Math.max(0, contentWidth - displayWidth(plainText)))
    return `${bar}  ${renderedText}${rightPadding}  ${bar}`
  }
  const title = 'Review skills across your team'
  const action = 'Request early access'
  const fullAction = `${action}  ${publicDashboardUrl}`
  const link = terminalLink(publicDashboardUrl, { color, hyperlinks })
  const rows = wrapText(title, contentWidth).map((line) => row(line))
  if (displayWidth(fullAction) <= contentWidth) {
    rows.push(row(fullAction, `${terminalText(action, 'dim', { color })}  ${link}`))
  } else {
    rows.push(
      ...wrapText(action, contentWidth).map((line) =>
        row(line, terminalText(line, 'dim', { color })),
      ),
      ...wrapText(publicDashboardUrl, contentWidth).map((line) =>
        row(line, line === publicDashboardUrl ? link : line),
      ),
    )
  }
  return [
    border(symbols.corners.topLeft, symbols.corners.topRight),
    ...rows,
    border(symbols.corners.bottomLeft, symbols.corners.bottomRight),
  ].join('\n')
}

/**
 * When the window holds no sessions, say which directories were read and what they held, so a
 * user can tell an empty laptop from a wrong directory or a wrong window.
 */
function scannedRootLines(
  roots: readonly HistoryRoot[],
  days: number,
  options: Pick<OutputOptions, 'ascii' | 'homeDirectory' | 'terminalWidth'>,
) {
  const dot = glyphs(options.ascii ?? asciiMode()).dot
  const outputWidth = reportWidth(options.terminalWidth)
  const labels = roots.map((root) => homeRelativePath(root.directory, options.homeDirectory))
  const labelWidth = Math.max(0, ...labels.map((label) => displayWidth(label)))
  return [
    `No sessions in the last ${days} ${days === 1 ? 'day' : 'days'}`,
    ...roots.flatMap((root, index) => {
      const label = labels[index] ?? ''
      const summary = rootSummary(root, dot)
      const singleLine = `  ${padDisplayEnd(label, labelWidth)}  ${summary}`
      if (displayWidth(singleLine) <= outputWidth) return [singleLine]
      return [
        ...wrapText(label, outputWidth - 2).map((line) => `  ${line}`),
        ...wrapText(summary, outputWidth - 4).map((line) => `    ${line}`),
      ]
    }),
  ]
}

/**
 * `0 sessions · 12 session files outside the window · 2 session files could not be read`: what
 * the scan found under one root, and what it could not read.
 */
function rootSummary(root: HistoryRoot, dot: string) {
  const parts = [counted(root.sessions, 'session')]
  const outside = Math.max(0, root.files - root.unreadableFiles)
  if (outside > 0) parts.push(`${counted(outside, 'session file')} outside the window`)
  else if (root.unreadableFiles === 0) parts.push('no session files')
  if (root.unreadableFiles > 0) parts.push(unreadableFilesText(root.unreadableFiles))
  return parts.join(` ${dot} `)
}

/** `2 session files could not be read`: printed wherever the scan admits it was incomplete. */
export function unreadableFilesText(count: number) {
  return `${counted(count, 'session file')} could not be read`
}

function truncateMiddle(value: string, width: number, ellipsis: string) {
  if (displayWidth(value) <= width) return value
  const ellipsisWidth = displayWidth(ellipsis)
  if (width < ellipsisWidth + 4) return takeDisplayPrefix(value, width)
  const side = Math.floor((width - ellipsisWidth) / 2)
  return `${takeDisplayPrefix(value, side)}${ellipsis}${takeDisplaySuffix(value, width - side - ellipsisWidth)}`
}

function appendSkillSection(
  lines: string[],
  section: SkillSection,
  invocationCounts: ReadonlyMap<string, number>,
  options: SkillOutputOptions,
): SectionLayout | null {
  if (section.skills.length === 0) return null
  lines.push('', `${section.heading} ${options.symbols.dot} ${formatCount(section.total)}`)
  if (!options.showCapabilities && options.width >= 60) {
    lines.push(
      ...skillTableLines(section.skills, invocationCounts, { ...options, kind: section.kind }),
    )
    return 'table'
  }
  for (const skill of section.skills) {
    lines.push(...skillLines(skill, invocationCounts, options))
  }
  return 'list'
}

function skillTableLines(
  skills: readonly LocalSkill[],
  invocationCounts: ReadonlyMap<string, number>,
  options: { color: boolean; kind: SkillSectionKind; symbols: Glyphs; width: number },
) {
  const rows = skills.map((skill) => {
    const calls = invocationCounts.get(`${skill.harness}\u0000${skill.name}`) ?? 0
    return {
      agent: codingAgentLabel(skill.harness),
      calls: formatCount(calls),
      category: categoryLabel(skill),
      issues: skill.lint.length > 0 ? skill.lint.map(lintLabel).join(', ') : '-',
      scope: distributionLabel(skill),
      skill: skill.name,
      state: calls > 0 ? counted(calls, 'call') : 'not measured',
    }
  })
  const full = options.width >= 80
  const hasIssues = skills.some((skill) => skill.lint.length > 0)
  const definitions = (() => {
    if (options.kind === 'activity') {
      return full
        ? [
            { header: 'SKILL' },
            { header: 'AGENT', width: 12 },
            { header: 'SCOPE', width: 10 },
            { align: 'right' as const, header: 'CALLS', width: 7 },
            { header: 'CATEGORY', width: 22 },
          ]
        : [
            { header: 'SKILL' },
            { header: 'AGENT', width: 12 },
            { align: 'right' as const, header: 'CALLS', width: 7 },
          ]
    }
    if (options.kind === 'attention') {
      return full
        ? [
            { header: 'SKILL' },
            { header: 'AGENT', width: 12 },
            { header: 'STATE', width: 12 },
            { header: 'ISSUES', width: 30 },
          ]
        : [{ header: 'SKILL' }, { header: 'STATE', width: 12 }, { header: 'ISSUES', width: 22 }]
    }
    if (hasIssues) {
      return full
        ? [
            { header: 'SKILL' },
            { header: 'AGENT', width: 12 },
            { header: 'SCOPE', width: 10 },
            { header: 'ISSUES', width: 28 },
          ]
        : [{ header: 'SKILL' }, { header: 'AGENT', width: 12 }, { header: 'ISSUES', width: 22 }]
    }
    return full
      ? [
          { header: 'SKILL' },
          { header: 'AGENT', width: 12 },
          { header: 'SCOPE', width: 10 },
          { header: 'CATEGORY', width: 22 },
        ]
      : [{ header: 'SKILL' }, { header: 'AGENT', width: 12 }, { header: 'SCOPE', width: 10 }]
  })()
  const columns = withFlexibleFirstColumn(definitions, options.width)
  const values = rows.map((row) => {
    if (options.kind === 'activity') {
      return full
        ? [row.skill, row.agent, row.scope, row.calls, row.category]
        : [row.skill, row.agent, row.calls]
    }
    if (options.kind === 'attention') {
      return full
        ? [row.skill, row.agent, row.state, row.issues]
        : [row.skill, row.state, row.issues]
    }
    if (hasIssues) {
      return full
        ? [row.skill, row.agent, row.scope, row.issues]
        : [row.skill, row.agent, row.issues]
    }
    return full
      ? [row.skill, row.agent, row.scope, row.category]
      : [row.skill, row.agent, row.scope]
  })
  return renderTable(columns, values, options.color, options.symbols)
}

function withFlexibleFirstColumn(
  definitions: readonly ({ header: string; width?: number } & Pick<TableColumn, 'align'>)[],
  width: number,
): TableColumn[] {
  const gapWidth = (definitions.length - 1) * 2
  const fixedWidth = definitions.slice(1).reduce((sum, column) => sum + (column.width ?? 0), 0)
  const firstWidth = width - 2 - gapWidth - fixedWidth
  return definitions.map((column, index) => ({
    ...column,
    width: index === 0 ? firstWidth : (column.width ?? 0),
  }))
}

function renderTable(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  color: boolean,
  symbols: Glyphs,
) {
  const tableWidth =
    columns.reduce((sum, column) => sum + column.width, 0) + (columns.length - 1) * 2
  const line = (values: readonly string[]) =>
    `  ${columns
      .map((column, index) => {
        const value = truncateCell(values[index] ?? '', column.width, symbols.ellipsis)
        return column.align === 'right'
          ? padDisplayStart(value, column.width)
          : padDisplayEnd(value, column.width)
      })
      .join('  ')}`.trimEnd()
  return [
    terminalText(line(columns.map((column) => column.header)), 'dim', { color }),
    terminalText(`  ${symbols.rule.repeat(tableWidth)}`, 'dim', { color }),
    ...rows.map(line),
  ]
}

function truncateCell(value: string, width: number, ellipsis: string) {
  if (displayWidth(value) <= width) return value
  const ellipsisWidth = displayWidth(ellipsis)
  if (width < ellipsisWidth + 1) return takeDisplayPrefix(value, width)
  return `${takeDisplayPrefix(value, width - ellipsisWidth)}${ellipsis}`
}

function distributionPriority(skill: LocalSkill) {
  if (skill.provenance?.kind === 'team_catalog') return 0
  const priorities = {
    project: 1,
    user: 2,
    plugin: 3,
    bundled: 4,
  } satisfies Record<LocalSkill['source'], number>
  return priorities[skill.source]
}

function skillLines(
  skill: LocalSkill,
  invocationCounts: ReadonlyMap<string, number>,
  { color, showCapabilities, symbols, width }: SkillOutputOptions,
) {
  const dot = symbols.dot
  const calls = invocationCounts.get(`${skill.harness}\u0000${skill.name}`) ?? 0
  const usageAvailable = codingAgentHasUsageEvidence(skill.harness)
  const status = calls > 0 ? counted(calls, 'call') : usageAvailable ? 'no calls' : 'not measured'
  const state =
    calls > 0
      ? terminalText(symbols.called, 'success', { color })
      : usageAvailable
        ? terminalText(symbols.noCalls, 'dim', { color })
        : terminalText(symbols.notMeasured, 'warning', { color })
  const headlineSuffix = ` ${dot} ${status}`
  const nameWidth = Math.max(5, width - 4 - displayWidth(headlineSuffix))
  const lines = [
    `  ${state} ${truncateMiddle(skill.name, nameWidth, symbols.ellipsis)}${headlineSuffix}`,
  ]
  lines.push(
    ...wrapText(
      [codingAgentLabel(skill.harness), distributionLabel(skill), categoryLabel(skill)].join(
        ` ${dot} `,
      ),
      width - 4,
    ).map((line) => `    ${line}`),
  )
  if (skill.lint.length > 0) {
    lines.push(
      ...wrapText(`Issues: ${skill.lint.map(lintLabel).join(', ')}`, width - 4).map(
        (line) => `    ${line}`,
      ),
    )
  }
  if (showCapabilities && skill.badges.length > 0) {
    lines.push(
      ...wrapText(`Capabilities: ${skill.badges.join(', ')}`, width - 4).map(
        (line) => `    ${line}`,
      ),
    )
  }
  return lines
}

const lintLabels = {
  'missing-description': 'missing description',
  'name-directory-mismatch': 'name does not match folder',
  'no-frontmatter': 'missing frontmatter',
  'oversized-skill-md': 'SKILL.md is over 100 KB',
} satisfies Record<LocalSkill['lint'][number], string>

function lintLabel(finding: LocalSkill['lint'][number]) {
  return lintLabels[finding]
}

function reportWidth(width: number | undefined) {
  if (!Number.isFinite(width)) return defaultTerminalWidth
  return Math.min(maximumTerminalWidth, Math.max(minimumTerminalWidth, Math.floor(width ?? 0)))
}

function wrapSegments(segments: readonly string[], width: number, dot: string, indent = 2) {
  if (segments.length === 0) return []
  const prefix = ' '.repeat(indent)
  const lines: string[] = []
  let current = prefix
  for (const segment of segments) {
    const separator = current === prefix ? '' : ` ${dot} `
    const candidate = `${current}${separator}${segment}`
    if (displayWidth(candidate) <= width || current === prefix) {
      current = candidate
      continue
    }
    lines.push(current)
    current = `${prefix}${segment}`
  }
  lines.push(current)
  return lines
}

/** Word-boundary wrapping by display width; only a single word wider than a line gets split. */
function wrapText(value: string, width: number) {
  const safeWidth = Math.max(1, width)
  const words = value.trim().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const chunks = chunkWord(word, safeWidth)
    for (const chunk of chunks) {
      const candidate = current ? `${current} ${chunk}` : chunk
      if (displayWidth(candidate) <= safeWidth) {
        current = candidate
        continue
      }
      if (current) lines.push(current)
      current = chunk
    }
  }
  if (current) lines.push(current)
  return lines
}

function chunkWord(word: string, width: number) {
  if (displayWidth(word) <= width) return [word]
  const chunks: string[] = []
  let rest = word
  while (displayWidth(rest) > width) {
    const chunk = takeDisplayPrefix(rest, width)
    if (!chunk) break
    chunks.push(chunk)
    rest = rest.slice(chunk.length)
  }
  if (rest) chunks.push(rest)
  return chunks
}

export function formatDedupe(
  candidates: readonly DuplicateCandidate[],
  options: OutputOptions = {},
) {
  const color = options.color ?? supportsColor()
  const commandPrefix = options.commandPrefix ?? defaultCommandPrefix
  const symbols = glyphs(options.ascii ?? asciiMode())
  const dot = symbols.dot
  if (candidates.length === 0) {
    return `Duplicate candidates\n  None found.\n`
  }
  const likely = candidates.filter((candidate) => candidate.similarity >= likelyDuplicateSimilarity)
  const possible = candidates.filter(
    (candidate) => candidate.similarity < likelyDuplicateSimilarity,
  )
  const lines = [`Duplicate candidates ${dot} ${formatCount(candidates.length)}`]
  const buckets = [
    {
      label: `Likely ${dot} similarity ${symbols.gte} ${percentLabel(likelyDuplicateSimilarity)}`,
      rows: likely,
    },
    {
      label: `Possible ${dot} similarity ${percentLabel(duplicateSimilarityFloor)}${symbols.range}${percentLabel(likelyDuplicateSimilarity)}`,
      rows: possible,
    },
  ]
  for (const bucket of buckets) {
    lines.push('', `${bucket.label} ${dot} ${formatCount(bucket.rows.length)}`)
    if (bucket.rows.length === 0) {
      lines.push('  None found.')
      continue
    }
    const visible = options.all ? bucket.rows : bucket.rows.slice(0, dedupeSectionLimit)
    for (const candidate of visible) {
      lines.push(
        `  ${candidate.left.name} ${symbols.both} ${candidate.right.name}  ${(candidate.similarity * 100).toFixed(1)}%`,
      )
    }
    const hidden = bucket.rows.length - visible.length
    if (hidden > 0) {
      lines.push(
        terminalText(
          `  ${counted(hidden, 'more pair')} hidden. Run ${commandPrefix} dedupe --all to list everything.`,
          'dim',
          { color },
        ),
      )
    }
  }
  lines.push(
    '',
    terminalText(
      `Local only ${dot} normalized 5-word shingle Jaccard, similarity > ${percentLabel(duplicateSimilarityFloor)}.`,
      'dim',
      { color },
    ),
  )
  return `${lines.join('\n')}\n`
}

function percentLabel(value: number) {
  return `${Math.round(value * 100)}%`
}

function metric(value: number, label: string) {
  return `${formatCount(value)} ${label}`
}

const categoryLabels = {
  'agent-workflows': 'Agent workflows',
  'code-quality': 'Code quality',
  'data-analytics': 'Data & analytics',
  databases: 'Databases',
  'devops-infra': 'DevOps & infrastructure',
  'docs-release': 'Docs & release',
  'frontend-design': 'Frontend & design',
  'marketing-content': 'Marketing & content',
  other: 'Other',
  personal: 'Personal',
  'product-planning': 'Product & planning',
  security: 'Security',
  'testing-e2e': 'Testing & e2e',
  writing: 'Writing',
} satisfies Record<LocalSkill['category'], string>

function categoryLabel(skill: LocalSkill) {
  return categoryLabels[skill.category]
}

function distributionLabel(skill: LocalSkill) {
  if (skill.provenance?.kind === 'team_catalog') return 'Shared'
  const labels = {
    bundled: 'Bundled',
    plugin: 'Plugin',
    project: 'Project',
    user: 'Personal',
  } satisfies Record<LocalSkill['source'], string>
  return labels[skill.source]
}

export function formatSkillDiff(
  name: string,
  copies: readonly LocalSkill[],
  options: Pick<OutputOptions, 'ascii'> = {},
) {
  if (copies.length === 0) return { error: `Skill not found: ${name}\n` }
  const unique = uniqueByFingerprint(copies)
  if (unique.length < 2) return { output: `${name} has one content fingerprint. No drift found.\n` }
  const [left, right] = unique
  if (!left || !right) return { output: `${name} has one content fingerprint. No drift found.\n` }
  const dot = glyphs(options.ascii ?? asciiMode()).dot
  const labels = [
    `${codingAgentLabel(left.harness)} ${dot} ${distributionLabel(left)}`,
    `${codingAgentLabel(right.harness)} ${dot} ${distributionLabel(right)}`,
  ]
  const lines = [
    `--- ${labels[0]}`,
    `+++ ${labels[1]}`,
    ...lineDiff(left.skillMdText, right.skillMdText),
  ]
  if (unique.length > 2) {
    const more = unique.length - 2
    lines.push('', `${counted(more, 'more version')} not shown.`)
  }
  return { output: `${lines.join('\n')}\n` }
}

function uniqueByFingerprint(skills: readonly LocalSkill[]) {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.fingerprint)) return false
    seen.add(skill.fingerprint)
    return true
  })
}

function lineDiff(leftText: string, rightText: string) {
  const left = leftText.replaceAll('\r\n', '\n').split('\n')
  const right = rightText.replaceAll('\r\n', '\n').split('\n')
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const row = table[leftIndex]
      const nextRow = table[leftIndex + 1]
      if (!row || !nextRow) continue
      row[rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? 1 + (nextRow[rightIndex + 1] ?? 0)
          : Math.max(nextRow[rightIndex] ?? 0, row[rightIndex + 1] ?? 0)
    }
  }
  const output: string[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      output.push(` ${left[leftIndex] ?? ''}`)
      leftIndex += 1
      rightIndex += 1
      continue
    }
    const removeScore = table[leftIndex + 1]?.[rightIndex] ?? 0
    const addScore = table[leftIndex]?.[rightIndex + 1] ?? 0
    if (rightIndex < right.length && (leftIndex >= left.length || addScore >= removeScore)) {
      output.push(`+${right[rightIndex] ?? ''}`)
      rightIndex += 1
    } else {
      output.push(`-${left[leftIndex] ?? ''}`)
      leftIndex += 1
    }
  }
  return output
}

function daysInWindow(report: LocalReport) {
  return Math.round(
    (Date.parse(report.window.to) - Date.parse(report.window.from)) / (24 * 60 * 60 * 1000),
  )
}
