import { duplicateSimilarityFloor, likelyDuplicateSimilarity } from './analysis.js'
import {
  asciiMode,
  brand,
  type Glyphs,
  glyphs,
  supportsColor,
  supportsHyperlinks,
  type TerminalTone,
  terminalLink,
  terminalText,
} from './brand.js'
import { codingAgentHasUsageEvidence, codingAgentLabel, codingAgentList } from './coding-agents.js'
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
  /** End the report with a one-line pointer to the team workspace. */
  teamLine?: boolean
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
  /** Colour applied to the whole padded cell. */
  tone?: TerminalTone
  width: number
}

const defaultSectionLimit = 10
const dedupeSectionLimit = 20
/** Every report line starts this far from the left edge, matching the wordmark. */
const reportPadding = 2
/** Widest proportion bar under Overview. */
const overviewBarWidth = 60
/** Per-row call bars need this much room before the activity table shows them. */
const callBarMinimumWidth = 100 - reportPadding
const callBarWidth = 10
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

/**
 * The report split into the parts the reveal animates: the header draws its trace, the overview
 * counts up, activity rows land one by one with their bars, and everything else prints in order.
 * `renderReportScene` prints the same scene at rest, so both paths share one layout.
 */
export type ReportScene = {
  /** Header lines with the trace drawn to `progress` (0 to 1). */
  header: (progress: number) => string[]
  /** Lines between the header and the overview. */
  intro: string[]
  /** Overview lines with every count scaled to `progress` (0 to 1). */
  overview: (progress: number) => string[]
  /** Recent-activity table: heading and column lines, then one renderer per row. */
  activity: { head: string[]; rows: ((progress: number) => string)[] } | null
  /** Every remaining line, padded and ready to print. */
  rest: string[]
}

export function formatReport(report: LocalReport, options: OutputOptions = {}) {
  return renderReportScene(buildReportScene(report, options))
}

export function renderReportScene(scene: ReportScene) {
  const lines = [
    ...scene.header(1),
    ...scene.intro,
    ...scene.overview(1),
    ...(scene.activity
      ? [...scene.activity.head, ...scene.activity.rows.map((row) => row(1))]
      : []),
    ...scene.rest,
  ]
  return `${lines.join('\n')}\n`
}

/** Eased 0..1 progress applied to a count, so the reveal slows into the final number. */
function scaled(count: number, progress: number) {
  if (progress >= 1) return count
  const eased = 1 - (1 - Math.max(0, progress)) ** 3
  return count > 0 ? Math.max(1, Math.round(count * eased)) : 0
}

export function buildReportScene(report: LocalReport, options: OutputOptions = {}): ReportScene {
  const color = options.color ?? supportsColor()
  const commandPrefix = options.commandPrefix ?? defaultCommandPrefix
  const symbols = glyphs(options.ascii ?? asciiMode())
  const dot = symbols.dot
  const width = reportWidth(options.terminalWidth) - reportPadding
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
  const ascii = options.ascii ?? asciiMode()
  // A blank line above and below keeps the report clear of the prompt on both ends.
  const header = (progress: number) =>
    padLines(['', ...brand({ ascii, color, traceProgress: progress }).split('\n')], reportPadding)
  const intro = padLines(
    [
      '',
      terminalText(`Local report ${dot} last ${daysInWindow(report)} days`, 'dim', { color }),
      '',
    ],
    reportPadding,
  )
  const agents = codingAgentList
    .filter((agent) => report.skills.some((skill) => skill.harness === agent.id))
    .map((agent) => codingAgentLabel(agent.id))
  const overview = (progress: number) =>
    boxed(overviewLines(progress, width - 6), width, symbols, color)
  const overviewLines = (progress: number, width: number) => {
    const skills = scaled(skillNames.size, progress)
    const installations = scaled(report.skills.length, progress)
    const calls = scaled(countedInvocations.length, progress)
    const sessions = scaled(report.sessions.length, progress)
    const drift = scaled(report.drift.length, progress)
    return padLines(
      [
        terminalText('Overview', 'strong', { color }),
        ...wrapSegments(
          [
            `${terminalText(formatCount(skills), 'strong', { color })} ${skills === 1 ? 'skill' : 'skills'}`,
            `${terminalText(formatCount(installations), 'strong', { color })} ${installations === 1 ? 'installation' : 'installations'}`,
            ...(agents.length > 0 ? [terminalText(agents.join(', '), 'dim', { color })] : []),
          ],
          width,
          dot,
        ),
        ...proportionBarLines(
          [
            { count: scaled(usedSkills.length, progress), label: 'called', tone: 'success' },
            { count: scaled(unusedSkills.length, progress), label: 'no calls', tone: 'dim' },
            {
              count: scaled(usageUnavailableSkills.length, progress),
              label: 'not measured',
              tone: 'warning',
            },
          ],
          { color, symbols, width },
        ),
        ...wrapSegments(
          [
            `${terminalText(formatCount(calls), 'strong', { color })} ${calls === 1 ? 'call' : 'calls'}`,
            counted(sessions, 'session'),
            terminalText(counted(drift, 'drifted skill'), drift > 0 ? 'warning' : 'success', {
              color,
            }),
          ],
          width,
          dot,
        ),
      ],
      reportPadding,
    )
  }
  const lines: string[] = []
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
  let activity: ReportScene['activity'] = null
  for (const section of sections) {
    if (
      section.kind === 'activity' &&
      section.skills.length > 0 &&
      tableLayout(skillOutputOptions) &&
      lines.length === 0
    ) {
      const table = skillTable(section.skills, invocationCounts, {
        ...skillOutputOptions,
        kind: section.kind,
      })
      activity = {
        head: padLines(
          ['', sectionHeading(section, skillOutputOptions), ...table.head],
          reportPadding,
        ),
        rows: table.rows.map((row) => (progress: number) => padLine(row(progress), reportPadding)),
      }
      continue
    }
    const layout = appendSkillSection(lines, section, invocationCounts, skillOutputOptions)
    if (layout === 'list') listRendered = true
  }
  if (visibleSkillCount === 0) lines.push('', 'No calls or skill issues in this window.')
  lines.push(...neverCalledLines(report, unusedSkills, { color, commandPrefix, symbols, width }))
  if (!options.all && hiddenSkillCount > 0) {
    const hidden = `Showing ${formatCount(visibleSkillCount)} of ${counted(report.skills.length, 'installation')}. Run ${commandPrefix} report --all for the full list.`
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
  lines.push('', terminalText(`Local only ${dot} Nothing was sent.`, 'success', { color }))
  if (options.teamLine) {
    const hyperlinks = options.hyperlinks ?? supportsHyperlinks()
    const link = terminalLink(publicDashboardUrl, { color, hyperlinks, tone: 'accent' })
    const sentence = wrapText(
      'Want this report for your team? See who runs which skill, what drifted, what to standardize',
      width,
    )
    const last = sentence.at(-1) ?? ''
    const tail = ` ${dot} ${publicDashboardUrl}`
    const fits = displayWidth(last) + displayWidth(tail) <= width
    lines.push(
      '',
      ...sentence.slice(0, -1),
      ...(fits ? [`${last}${terminalText(` ${dot} `, 'dim', { color })}${link}`] : [last, link]),
    )
  }
  return { activity, header, intro, overview, rest: [...padLines(lines, reportPadding), ''] }
}

/** Wraps already-padded lines in a rule box that spans the content width. */
function boxed(lines: readonly string[], width: number, symbols: Glyphs, color: boolean) {
  const inner = width - 2
  const indent = ' '.repeat(reportPadding)
  const edge = (left: string, right: string) =>
    terminalText(`${left}${symbols.rule.repeat(inner)}${right}`, 'dim', { color })
  const bar = terminalText(symbols.bar, 'dim', { color })
  const body = lines.map((line) => {
    const content = line.slice(reportPadding)
    const padding = ' '.repeat(Math.max(0, inner - 2 - displayWidth(content)))
    return `${indent}${bar} ${content}${padding} ${bar}`
  })
  return [
    `${indent}${edge(symbols.corners.topLeft, symbols.corners.topRight)}`,
    ...body,
    `${indent}${edge(symbols.corners.bottomLeft, symbols.corners.bottomRight)}`,
  ]
}

function padLine(line: string, padding: number) {
  return line === '' ? line : `${' '.repeat(padding)}${line}`
}

function padLines(lines: readonly string[], padding: number) {
  const prefix = ' '.repeat(padding)
  return lines.map((line) => (line === '' ? line : `${prefix}${line}`))
}

type ProportionPart = { count: number; label: string; tone: TerminalTone }

/**
 * A bar of the three installation states, then the legend: every non-zero part gets at least one
 * cell so a small group stays visible, and the parts share the rest by proportion.
 */
function proportionBarLines(
  parts: readonly ProportionPart[],
  { color, symbols, width }: { color: boolean; symbols: Glyphs; width: number },
) {
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  if (total === 0) return []
  const barWidth = Math.max(10, Math.min(overviewBarWidth, width - 2))
  const nonZero = parts.filter((part) => part.count > 0)
  const cells = nonZero.map((part) => Math.max(1, Math.floor((barWidth * part.count) / total)))
  let spare = barWidth - cells.reduce((sum, count) => sum + count, 0)
  // Largest remainders take the leftover cells, so the bar always fills its width.
  const order = nonZero
    .map((part, index) => ({
      index,
      remainder: (barWidth * part.count) / total - (cells[index] ?? 0),
    }))
    .toSorted((left, right) => right.remainder - left.remainder)
  for (const { index } of order) {
    if (spare <= 0) break
    cells[index] = (cells[index] ?? 0) + 1
    spare -= 1
  }
  // Minimum-one-cell rounding can overfill the bar when one group dominates.
  for (const { index } of order.toReversed()) {
    if (spare >= 0) break
    const removable = Math.min(-spare, Math.max(0, (cells[index] ?? 0) - 1))
    cells[index] = (cells[index] ?? 0) - removable
    spare += removable
  }
  const bar = nonZero
    .map((part, index) => {
      const cell =
        part.label === 'not measured'
          ? symbols.shade
          : part.label === 'no calls'
            ? symbols.blockLight
            : symbols.block
      return terminalText(
        cell.repeat(cells[index] ?? 0),
        part.label === 'no calls' ? 'faint' : part.tone,
        { color },
      )
    })
    .join('')
  const legend = parts.map((part) =>
    terminalText(`${formatCount(part.count)} ${part.label}`, part.tone, { color }),
  )
  return [`  ${bar}`, ...wrapSegments(legend, width, ' ')]
}

/**
 * `Claude Code  58 of 73 skills never called · ~4.6k description tokens per session`:
 * per harness, because each agent only loads its own skills. Skips agents without call evidence.
 */
function neverCalledLines(
  report: LocalReport,
  unusedSkills: readonly LocalSkill[],
  {
    color,
    commandPrefix,
    symbols,
    width,
  }: { color: boolean; commandPrefix: string; symbols: Glyphs; width: number },
) {
  const lines: string[] = []
  const labelWidth = 13
  for (const agent of codingAgentList) {
    if (!codingAgentHasUsageEvidence(agent.id)) continue
    const installed = report.skills.filter((skill) => skill.harness === agent.id)
    const unused = unusedSkills.filter((skill) => skill.harness === agent.id)
    if (installed.length === 0 || unused.length === 0) continue
    const tokens = unused.reduce((sum, skill) => sum + skill.descriptionTokens, 0)
    const count = `${terminalText(`${formatCount(unused.length)} of ${formatCount(installed.length)}`, 'warning', { color })} ${installed.length === 1 ? 'skill' : 'skills'} never called`
    const cost = terminalText(
      `${approximateTokens(tokens)} description tokens per session`,
      'dim',
      {
        color,
      },
    )
    lines.push(
      ...labelledRow(codingAgentLabel(agent.id), [count, cost], labelWidth, width, symbols, color),
    )
  }
  const overlapping = report.duplicateCandidates.filter(
    (candidate) => candidate.similarity >= likelyDuplicateSimilarity,
  ).length
  if (overlapping > 0) {
    const count = `${terminalText(counted(overlapping, 'pair'), 'warning', { color })} of skills ${overlapping === 1 ? 'overlaps' : 'overlap'} ${symbols.gte} ${percentLabel(likelyDuplicateSimilarity)}`
    const hint = terminalText(`run ${commandPrefix} dedupe`, 'dim', { color })
    lines.push(...labelledRow('Overlap', [count, hint], labelWidth, width, symbols, color))
  }
  return lines.length > 0 ? ['', ...lines] : []
}

/**
 * `Claude Code  58 of 73 skills never called · ~4.6k description tokens per session`, with
 * continuation lines under the value. A narrow terminal drops the label column and lets the
 * label wrap like any other segment.
 */
function labelledRow(
  label: string,
  segments: readonly string[],
  labelWidth: number,
  width: number,
  symbols: Glyphs,
  color: boolean,
) {
  if (width < 60) {
    return wrapSegments([terminalText(label, 'dim', { color }), ...segments], width, symbols.dot)
  }
  const styledLabel = terminalText(padDisplayEnd(label, labelWidth), 'dim', { color })
  const [first = '', ...rest] = segments
  return wrapSegments([`${styledLabel}${first}`, ...rest], width, symbols.dot).map((line, index) =>
    index === 0 ? line : `${' '.repeat(labelWidth)}${line}`,
  )
}

/** `~4.6k`, `~820`: a rough count, because description tokens are estimated, not tokenized. */
function approximateTokens(tokens: number) {
  if (tokens < 1000) return `~${formatCount(tokens)}`
  return `~${(tokens / 1000).toFixed(1).replace(/\.0$/u, '')}k`
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

function sectionHeading(section: SkillSection, options: SkillOutputOptions) {
  return `${terminalText(section.heading, 'strong', { color: options.color })} ${terminalText(`${options.symbols.dot} ${formatCount(section.total)}`, 'dim', { color: options.color })}`
}

function tableLayout(options: SkillOutputOptions) {
  return !options.showCapabilities && options.width >= 60
}

function appendSkillSection(
  lines: string[],
  section: SkillSection,
  invocationCounts: ReadonlyMap<string, number>,
  options: SkillOutputOptions,
): SectionLayout | null {
  if (section.skills.length === 0) return null
  lines.push('', sectionHeading(section, options))
  if (tableLayout(options)) {
    const table = skillTable(section.skills, invocationCounts, { ...options, kind: section.kind })
    lines.push(...table.head, ...table.rows.map((row) => row(1)))
    return 'table'
  }
  for (const skill of section.skills) {
    lines.push(...skillLines(skill, invocationCounts, options))
  }
  return 'list'
}

/**
 * A section table as column lines plus one renderer per row. A row's `progress` (0 to 1) scales
 * its call count and bar, which only the activity table uses; every other table renders at 1.
 */
function skillTable(
  skills: readonly LocalSkill[],
  invocationCounts: ReadonlyMap<string, number>,
  options: { color: boolean; kind: SkillSectionKind; symbols: Glyphs; width: number },
) {
  const callBars = options.kind === 'activity' && options.width >= callBarMinimumWidth
  const mostCalls = Math.max(
    1,
    ...skills.map((skill) => invocationCounts.get(`${skill.harness}\u0000${skill.name}`) ?? 0),
  )
  const rowValues = (skill: LocalSkill, progress: number) => {
    const calls = scaled(invocationCounts.get(`${skill.harness}\u0000${skill.name}`) ?? 0, progress)
    return {
      agent: codingAgentLabel(skill.harness),
      bar: options.symbols.tick.repeat(
        Math.max(calls > 0 ? 1 : 0, Math.round((callBarWidth * calls) / mostCalls)),
      ),
      calls: formatCount(calls),
      category: categoryLabel(skill),
      issues: skill.lint.length > 0 ? skill.lint.map(lintLabel).join(', ') : '-',
      scope: distributionLabel(skill),
      skill: skill.name,
      state: calls > 0 ? counted(calls, 'call') : 'not measured',
    }
  }
  const full = options.width >= 80
  const hasIssues = skills.some((skill) => skill.lint.length > 0)
  const definitions = tableDefinitions(options.kind, { callBars, full, hasIssues })
  const columns = withFlexibleFirstColumn(definitions, options.width, skillColumnWidth(options))
  const values = (row: ReturnType<typeof rowValues>) => {
    if (options.kind === 'activity') {
      return full
        ? [row.skill, row.agent, row.scope, row.calls, ...(callBars ? [row.bar] : []), row.category]
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
  }
  const table = renderTable(columns, options.color, options.symbols)
  return {
    head: table.head,
    rows: skills.map(
      (skill) => (progress: number) => table.row(values(rowValues(skill, progress))),
    ),
  }
}

type TableDefinition = { header: string; width?: number } & Pick<TableColumn, 'align' | 'tone'>

/**
 * Columns per section. The skill name reads first, so it stays plain; agent, scope, and category
 * are context and print dim; the call count is the number a reader scans for, so it is bold; a
 * flagged skill name prints in the warning tone.
 */
function tableDefinitions(
  kind: SkillSectionKind,
  { callBars, full, hasIssues }: { callBars: boolean; full: boolean; hasIssues: boolean },
): TableDefinition[] {
  const agent = { header: 'AGENT', tone: 'dim' as const, width: 12 }
  const scope = { header: 'SCOPE', tone: 'dim' as const, width: callBars ? 9 : 10 }
  const calls = { align: 'right' as const, header: 'CALLS', tone: 'strong' as const, width: 7 }
  const category = { header: 'CATEGORY', tone: 'dim' as const, width: callBars ? 20 : 22 }
  if (kind === 'activity') {
    return full
      ? [
          { header: 'SKILL' },
          agent,
          scope,
          calls,
          ...(callBars ? [{ header: '', tone: 'accent' as const, width: callBarWidth }] : []),
          category,
        ]
      : [{ header: 'SKILL' }, agent, calls]
  }
  if (kind === 'attention') {
    const issues = { header: 'ISSUES', tone: 'dim' as const, width: full ? 30 : 22 }
    const state = { header: 'STATE', width: 12 }
    return full
      ? [{ header: 'SKILL', tone: 'warning' }, agent, state, issues]
      : [{ header: 'SKILL', tone: 'warning' }, state, issues]
  }
  if (hasIssues) {
    const issues = { header: 'ISSUES', tone: 'dim' as const, width: full ? 28 : 22 }
    return full ? [{ header: 'SKILL' }, agent, scope, issues] : [{ header: 'SKILL' }, agent, issues]
  }
  return full ? [{ header: 'SKILL' }, agent, scope, category] : [{ header: 'SKILL' }, agent, scope]
}

/**
 * One skill-column width for every section, the narrowest any section needs: agent and scope then
 * start at the same column in every table, and a long name truncates the same way everywhere.
 */
function skillColumnWidth(options: { kind: SkillSectionKind; width: number }) {
  const full = options.width >= 80
  const callBars = options.width >= callBarMinimumWidth
  const layouts: [SkillSectionKind, boolean][] = [
    ['activity', false],
    ['attention', false],
    ['no-calls', true],
    ['no-calls', false],
  ]
  const narrowest = Math.min(
    ...layouts.map(([kind, hasIssues]) =>
      naturalFirstWidth(tableDefinitions(kind, { callBars, full, hasIssues }), options.width),
    ),
  )
  return Math.max(12, narrowest)
}

function naturalFirstWidth(definitions: readonly TableDefinition[], width: number) {
  const gapWidth = (definitions.length - 1) * 2
  const fixedWidth = definitions.slice(1).reduce((sum, column) => sum + (column.width ?? 0), 0)
  return width - 2 - gapWidth - fixedWidth
}

/**
 * The first column takes the shared width; whatever that leaves goes to the last column, so
 * every table spans the same width and issue or category text gets the room.
 */
function withFlexibleFirstColumn(
  definitions: readonly TableDefinition[],
  width: number,
  sharedFirstWidth: number,
): TableColumn[] {
  const natural = naturalFirstWidth(definitions, width)
  const firstWidth = Math.min(natural, sharedFirstWidth)
  const spare = Math.max(0, natural - firstWidth)
  const last = definitions.length - 1
  return definitions.map((column, index) => ({
    ...column,
    width:
      index === 0 ? firstWidth : (column.width ?? 0) + (index === last && index > 0 ? spare : 0),
  }))
}

function renderTable(columns: readonly TableColumn[], color: boolean, symbols: Glyphs) {
  const tableWidth =
    columns.reduce((sum, column) => sum + column.width, 0) + (columns.length - 1) * 2
  const line = (values: readonly string[], toned = true) =>
    `  ${columns
      .map((column, index) => {
        const value = truncateCell(values[index] ?? '', column.width, symbols.ellipsis)
        const cell =
          column.align === 'right'
            ? padDisplayStart(value, column.width)
            : padDisplayEnd(value, column.width)
        return toned && column.tone ? terminalText(cell, column.tone, { color }) : cell
      })
      .join('  ')}`.trimEnd()
  return {
    head: [
      terminalText(
        line(
          columns.map((column) => column.header),
          false,
        ),
        'dim',
        { color },
      ),
      terminalText(`  ${symbols.rule.repeat(tableWidth)}`, 'dim', { color }),
    ],
    row: (values: readonly string[]) => line(values),
  }
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
