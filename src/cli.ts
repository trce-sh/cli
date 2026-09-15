import { homedir, hostname } from 'node:os'
import { resolve } from 'node:path'
import { duplicateCandidates } from './analysis.js'
import {
  asciiMode,
  brand,
  glyphs,
  supportsColor,
  supportsHyperlinks,
  terminalLink,
  terminalText,
} from './brand.js'
import {
  installCatalogSkill,
  loadGitHubSkillSource,
  loadGitHubSkillSourceWithCredential,
  parseCatalogSource,
  removeCatalogSkill,
  type SkillSourceLoader,
  updateCatalogSkill,
} from './catalog.js'
import { fetchCatalogCredential } from './catalog-access.js'
import {
  codingAgentLabel,
  codingAgentList,
  codingAgents,
  installableCodingAgentIds,
  installableCodingAgentList,
  normalizeCodingAgentId,
} from './coding-agents.js'
import {
  configPath,
  isLoopbackHost,
  type LinkedConfig,
  normalizedBaseUrl,
  writeLinkedConfig,
} from './config.js'
import { defaultMachineLabel, linkDevice } from './device.js'
import { claimLaptopAction, completeLaptopAction } from './device-actions.js'
import { openLaptopPullRequest } from './github-pull-request.js'
import { commandHelp, commandHelpText, helpText } from './help.js'
import { repositorySlug } from './history.js'
import { installHooks, removeHooks, spawnDetachedPush } from './hooks.js'
import { clearInstallEvents, readInstallManifest } from './installs.js'
import { scanInventory } from './inventory.js'
import { defaultCommandPrefix } from './invocation.js'
import { loadLocalSkillFiles, selectActionSkill } from './local-skill-source.js'
import { cliVersion } from './meta.js'
import { openExternalUrl } from './open-url.js'
import {
  buildReportScene,
  formatDedupe,
  formatEarlyAccessCta,
  formatSkillDiff,
  type ReportScene,
  renderReportScene,
} from './output.js'
import {
  assertPayloadPrivacy,
  buildLocalReportExport,
  buildPushPayload,
  serializePushPayload,
} from './payload.js'
import {
  formatPendingNotice,
  pendingActionsPath,
  readPendingActions,
  removePendingAction,
  writePendingActions,
} from './pending.js'
import { sendPayload } from './push.js'
import { generateLocalReport, parseSinceDays, type ScanProgress } from './report.js'
import { withTransientRetry } from './retry.js'
import { fetchTeamScope } from './scope.js'
import { configuredDashboardUrl } from './service.js'
import type { StatusItem } from './status-line.js'
import { linkedConfigPath, notLinkedMessage, notLinkedResult, readLinkedTeam } from './team-link.js'
import type { HarnessName } from './types.js'
import { homeRelativePath } from './value.js'

/** Printed after the hooks are installed. Keep this sentence aligned with hosted onboarding copy. */
const backgroundPushSentence =
  'After each session, the hook pushes in the background. Nothing to run by hand.'

export type CliResult = {
  exitCode: number
  /** Set when the command already printed the waiting-changes notice itself. */
  noticeShown?: boolean
  stderr: string
  stdout: string
}

export type CliContext = {
  claudeProjectsDirectory?: string
  codexSessionsDirectory?: string
  color?: boolean
  /** The command the user typed, `npx @trce/cli` or `trce`; printed in every hint. */
  commandPrefix?: string
  configFile?: string
  cwd?: string
  /** Environment for `TRCE_URL`, agent-home overrides, and locale; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  executable?: string
  fetch?: typeof globalThis.fetch
  homeDirectory?: string
  hyperlinks?: boolean
  interactive?: boolean
  loadSkillSource?: SkillSourceLoader
  machineName?: string
  now?: Date
  openUrl?: (url: string) => Promise<boolean>
  openPullRequest?: typeof openLaptopPullRequest
  /** Prints a line right away (stdout, or stderr when stdout is not a terminal). */
  onProgress?: (message: string) => void
  onStatus?: (message: string | readonly StatusItem[]) => void
  /**
   * Plays the report reveal in place of returning it as `stdout`; a terminal runtime provides
   * this, pipes and tests leave it unset. The notice, when any, prints first.
   */
  animate?: (scene: ReportScene, notice: string | null) => Promise<void>
  platform?: string
  /** Reads the live terminal width after slow scans, so a resize cannot leave stale columns. */
  readTerminalWidth?: () => number | undefined
  repositorySlugForCwd?: (cwd: string) => Promise<string | null>
  scriptPath?: string
  sleep?: (milliseconds: number) => Promise<void>
  terminalWidth?: number
  /** Receives one-line warnings that are not errors; defaults to stderr. */
  warn?: (message: string) => void
}

/**
 * Commands that use team scope, send metadata, or change files require a linked team key.
 * `report`, `dedupe`, and `diff` are public local diagnostics and never pass through this gate.
 * `init` creates the link. `hook` is the background entry installed by `init`; without a link it
 * exits silently so coding-agent hooks never print noise.
 */
const linkedCommands = new Set(['push', 'add', 'remove', 'update', 'promote', 'unify'])

/**
 * Commands that print the "changes waiting for this machine" notice above their output. The list
 * comes from `~/.trce/pending.json`, written by the last push; reading it is offline. Machine
 * contracts (`--json`, `push --dry-run`) and the silent hook push (`--quiet`) never carry it.
 */
const noticeCommands = new Set(['report', 'dedupe', 'diff', 'push'])

function machinePlatformLabel(platform: string) {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

export async function runCli(
  rawArgs: readonly string[],
  context: CliContext = {},
): Promise<CliResult> {
  const args = expandOptionValues(rawArgs)
  const [command] = args
  const helpOptions = {
    color: context.color ?? supportsColor(),
    commandPrefix: commandPrefixOf(context),
    hyperlinks: context.hyperlinks ?? supportsHyperlinks(),
  }
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: 0, stderr: '', stdout: helpText(helpOptions) }
  }
  if (isVersionFlag(command)) return { exitCode: 0, stderr: '', stdout: `${cliVersion}\n` }
  if (!Object.hasOwn(commandHelp, command)) return unknownCommand(command, context)
  if (args.slice(1).some((argument) => argument === '--help' || argument === '-h')) {
    const help = commandHelpText(command, helpOptions)
    if (help) return { exitCode: 0, stderr: '', stdout: help }
    return unknownCommand(command, context)
  }
  if (command === 'add') {
    const refusal = inventoryOnlyInstallRefusal(args.slice(1))
    if (refusal) return { exitCode: 1, stderr: `${refusal}\n`, stdout: '' }
  }
  try {
    if (linkedCommands.has(command) && !(await readLinkedTeam(context))) {
      return notLinkedResult({ commandPrefix: commandPrefixOf(context), env: envOf(context) })
    }
    if (command === 'hook' && !(await readLinkedTeam(context))) {
      return { exitCode: 0, stderr: '', stdout: '' }
    }
    const result = await runCommand(command, args.slice(1), context)
    return await withPendingNotice(command, args, context, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected CLI error'
    return { exitCode: 1, stderr: `${message}\n`, stdout: '' }
  }
}

function isVersionFlag(argument: string) {
  return (
    argument === '--version' || argument === '-v' || argument === '-V' || argument === 'version'
  )
}

/** `--flag=value` is accepted everywhere `--flag value` is. */
function expandOptionValues(args: readonly string[]) {
  return args.flatMap((argument) => {
    const match = /^(--[a-z][a-z-]*)=(.*)$/su.exec(argument)
    return match?.[1] !== undefined && match[2] !== undefined ? [match[1], match[2]] : [argument]
  })
}

function unknownCommand(command: string, context: CliContext): CliResult {
  return {
    exitCode: 1,
    stderr: `Unknown command: ${command}\nRun ${commandPrefixOf(context)} --help for usage.\n`,
    stdout: '',
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  context: CliContext,
): Promise<CliResult> {
  if (command === 'report') return reportCommand(args, context)
  if (command === 'dedupe') return dedupeCommand(args, context)
  if (command === 'diff') return diffCommand(args, context)
  if (command === 'init') return initCommand(args, context)
  if (command === 'push') return pushCommand(args, context)
  if (command === 'hook') return hookCommand(args, context)
  if (command === 'add') return addCommand(args, context)
  if (command === 'remove') return removeCommand(args, context)
  if (command === 'update') return updateCommand(args, context)
  if (command === 'promote' || command === 'unify') {
    return pullRequestCommand(command, args, context)
  }
  throw new Error(`Unknown command: ${command}`)
}

/** Prepends the waiting-changes notice to successful human-readable output; see `noticeCommands`. */
async function withPendingNotice(
  command: string,
  args: readonly string[],
  context: CliContext,
  result: CliResult,
): Promise<CliResult> {
  if (
    result.exitCode !== 0 ||
    result.noticeShown ||
    !noticeCommands.has(command) ||
    args.includes('--json') ||
    args.includes('--dry-run') ||
    args.includes('--quiet')
  ) {
    return result
  }
  const notice = await pendingNotice(context)
  return notice ? { ...result, stdout: `${notice}\n${result.stdout}` } : result
}

async function pendingNotice(context: CliContext) {
  return formatPendingNotice(await readPendingActions(pendingPathOf(context)), {
    commandPrefix: commandPrefixOf(context),
  })
}

/**
 * Lines that must reach the user before the command finishes (the device code, the file list of
 * an upload). With `onProgress` they print at once; without it they lead the final stdout.
 */
function progressLines(context: CliContext) {
  const deferred: string[] = []
  return {
    flush: () => deferred.map((message) => `${message}\n`).join(''),
    progress: (message: string) => {
      if (context.onProgress) context.onProgress(message)
      else deferred.push(message)
    },
  }
}

async function initCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const urlOption = optionValue(args, '--url')
  const allowed = new Set([
    '--hooks-only',
    '--insecure-http',
    '--no-browser',
    '--no-hooks',
    '--remove',
    '--url',
    urlOption ?? '',
  ])
  rejectUnknownOptions('init', args, allowed, context)
  const homeDirectory = context.homeDirectory ?? homedir()
  const env = envOf(context)
  if (args.includes('--remove')) {
    if (args.length > 1) throw new Error('init --remove cannot be combined with other options')
    const result = await removeHooks({ env, homeDirectory })
    return {
      exitCode: 0,
      stderr: '',
      stdout: `Hooks removed · Claude ${result.claude} · Codex ${result.codex}\nMachine link kept.\n`,
    }
  }
  if (args.includes('--hooks-only')) {
    if (args.length > 1) throw new Error('init --hooks-only cannot be combined with other options')
    if (!(await readLinkedTeam(context))) {
      return notLinkedResult({ commandPrefix: commandPrefixOf(context), env })
    }
    const color = context.color ?? supportsColor()
    const hooks = await installHooks({
      env,
      executable: context.executable ?? process.execPath,
      homeDirectory,
      scriptPath: context.scriptPath ?? process.argv[1] ?? 'trce',
    })
    return {
      exitCode: 0,
      stderr: '',
      stdout: `${terminalText(`✓ Hooks installed · Claude ${hooks.claude} · Codex ${hooks.codex}`, 'success', { color })}\n${backgroundPushSentence}\n`,
    }
  }

  const baseUrl = dashboardUrlFor(args, context, configuredDashboardUrl(env))
  const { flush, progress } = progressLines(context)
  const color = context.color ?? supportsColor()
  const hyperlinks = context.hyperlinks ?? supportsHyperlinks()
  const now = () => context.now?.getTime() ?? Date.now()
  const platform = context.platform ?? process.platform
  const machineLabel = defaultMachineLabel(context.machineName ?? hostname(), platform)
  const linked = await linkDevice({
    baseUrl,
    commandPrefix: commandPrefixOf(context),
    fetch: context.fetch ?? globalThis.fetch,
    label: machineLabel,
    now,
    onCode: async ({ code, label, platform: linkedPlatform, setupUrl }) => {
      progress(
        `${brand({ color, hyperlinks })}\n\nLink this machine\n  Machine  ${label} · ${machinePlatformLabel(linkedPlatform)}\n  Code     ${terminalText(code, 'accent', { color })}\n  Open     ${terminalLink(setupUrl, { color, hyperlinks })}\n  Sign in with GitHub, then confirm this machine in your browser.`,
      )
      if (!args.includes('--no-browser')) {
        const opened = await (context.openUrl ?? openExternalUrl)(setupUrl).catch(() => false)
        progress(
          opened
            ? terminalText('✓ Opened the confirmation page in your browser', 'success', { color })
            : terminalText('! Could not open a browser. Open the URL above.', 'warning', { color }),
        )
      }
      if (context.onStatus) context.onStatus(statusText(context, 'Waiting for confirmation'))
      else
        progress(
          terminalText(`  ${statusText(context, 'Waiting for confirmation')}`, 'dim', { color }),
        )
    },
    platform,
    sleep: context.sleep ?? wait,
  })
  await writeLinkedConfig(context.configFile ?? configPath(homeDirectory), linked)
  let hookMessage = terminalText(
    `Hooks skipped · Run \`${commandPrefixOf(context)} push\` to push by hand.`,
    'dim',
    { color },
  )
  if (!args.includes('--no-hooks')) {
    const hooks = await installHooks({
      env,
      executable: context.executable ?? process.execPath,
      homeDirectory,
      scriptPath: context.scriptPath ?? process.argv[1] ?? 'trce',
    })
    hookMessage = `Hooks installed · Claude ${hooks.claude} · Codex ${hooks.codex}\n${backgroundPushSentence}`
  }
  return {
    exitCode: 0,
    stderr: '',
    stdout: `${flush()}${terminalText('✓ Machine linked', 'success', { color })}\n${hookMessage}\n`,
  }
}

/**
 * The dashboard origin for `init` and `push`: `--url`, then `TRCE_URL`, then `fallback`. Plain
 * `http://` is fine for loopback hosts; anywhere else it needs `--insecure-http` and prints one
 * warning, because the machine token would travel unencrypted.
 */
function dashboardUrlFor(args: readonly string[], context: CliContext, fallback: string) {
  const urlOption = optionValue(args, '--url')
  const candidate = urlOption ?? envOf(context).TRCE_URL?.trim() ?? fallback
  const baseUrl = normalizedBaseUrl(candidate || fallback)
  if (!baseUrl) throw new Error('The dashboard URL must use http or https')
  const url = new URL(baseUrl)
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    if (!args.includes('--insecure-http')) {
      throw new Error(
        `${baseUrl} is plain http and not localhost, so the machine token would travel unencrypted. Use https, or pass --insecure-http to allow it.`,
      )
    }
    warnOf(context)(`! ${baseUrl} is plain http: the machine token travels unencrypted.`)
  }
  return baseUrl
}

async function pushCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const since = optionValue(args, '--since')
  const urlOption = optionValue(args, '--url')
  const allowed = new Set([
    '--dry-run',
    '--insecure-http',
    '--quiet',
    '--since',
    since ?? '',
    '--url',
    urlOption ?? '',
  ])
  rejectUnknownOptions('push', args, allowed, context)
  const sinceDays = parseSinceDays(since)
  const linked = await readLinkedTeam(context)
  if (!linked) throw new Error(notLinkedError(context))
  const config: LinkedConfig = {
    ...linked,
    baseUrl: dashboardUrlFor(args, context, linked.baseUrl),
  }
  const progress = args.includes('--quiet') ? undefined : context.onStatus
  // One transient connection failure is retried once after 2 s before the usual message prints.
  const fetch = withTransientRetry(context.fetch ?? globalThis.fetch, context.sleep ?? wait)
  progress?.(statusText(context, 'Loading team scope'))
  const scope = await fetchTeamScope(config, fetch)
  if (scope.repositories.length === 0) {
    throw new Error(
      `Nothing to push: this team has no connected repositories. Connect one at ${config.baseUrl}/repositories, then push again.`,
    )
  }
  const homeDirectory = context.homeDirectory ?? homedir()
  const manifest = await readInstallManifest(homeDirectory)
  progress?.(statusText(context, 'Scanning skills and local session history'))
  const report = await generateLocalReport(reportOptions(context, sinceDays))
  const payload = buildPushPayload(report, cliVersion, scope, manifest.pendingEvents)
  // Serialized once: these exact bytes are what --dry-run prints and what push sends.
  const serialized = serializePushPayload(payload)
  assertPayloadPrivacy(serialized)
  if (args.includes('--dry-run')) return { exitCode: 0, stderr: '', stdout: serialized }

  progress?.(statusText(context, 'Sending report'))
  const result = await sendPayload(config, serialized, fetch)
  await clearInstallEvents(
    homeDirectory,
    new Set(payload.distributionEvents.map((event) => event.id)),
  )
  // The only thing a push brings back: the changes waiting for this machine. Written on every
  // real push, including the silent hook push; an empty list removes the file.
  await writePendingActions(
    pendingPathOf(context),
    result.pendingActions,
    (context.now ?? new Date()).toISOString(),
  )
  return {
    exitCode: 0,
    stderr: '',
    stdout: args.includes('--quiet')
      ? ''
      : `${terminalText('✓ Report pushed', 'success', { color: context.color ?? supportsColor() })}\n  ${counted(result.skills, 'skill')} · ${counted(result.sessions, 'session')} · ${counted(result.invocations, 'call')}\n`,
  }
}

async function hookCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  // Codex appends one notification JSON argument. It is intentionally ignored and never parsed.
  void args
  await spawnDetachedPush(
    context.executable ?? process.execPath,
    context.scriptPath ?? process.argv[1] ?? 'trce',
    {
      env: envOf(context),
      homeDirectory: context.homeDirectory ?? homedir(),
      ...(context.now ? { now: context.now.getTime() } : {}),
    },
  )
  return { exitCode: 0, stderr: '', stdout: '' }
}

async function addCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const sourceValue = args[0]
  if (!sourceValue || sourceValue.startsWith('-')) {
    throw new Error(`Usage: ${commandPrefixOf(context)} add owner/repository:path/to/skill`)
  }
  const harnessOption = optionValue(args, '--harness')
  const ref = optionValue(args, '--ref')
  const allowed = new Set([
    sourceValue,
    '--shared',
    '--dry-run',
    '--harness',
    harnessOption ?? '',
    '--ref',
    ref ?? '',
  ])
  rejectUnknownOptions('add', args, allowed, context)
  const source = parseCatalogSource(sourceValue, ref)
  const distribution = args.includes('--shared') ? 'team_catalog' : 'private'
  const fetch = withTransientRetry(context.fetch ?? globalThis.fetch, context.sleep ?? wait)
  let sharedConfig: LinkedConfig | null = null
  if (distribution === 'team_catalog') {
    sharedConfig = await readLinkedTeam(context)
    if (!sharedConfig) throw new Error(notLinkedError(context))
    context.onStatus?.(statusText(context, 'Checking team access'))
    const scope = await fetchTeamScope(sharedConfig, fetch)
    if (!scope.catalogRepositories.includes(source.repository)) {
      throw new Error(
        `${source.repository} does not have the Skills library role. Set it on the Repositories page. Nothing changed.`,
      )
    }
  }
  const loadSource =
    context.loadSkillSource ??
    (sharedConfig
      ? sharedSkillSourceLoader(sharedConfig, fetch, context)
      : sourceLoaderWithStatus(loadGitHubSkillSource, context))
  const install = await installCatalogSkill({
    commandPrefix: commandPrefixOf(context),
    distribution,
    dryRun: args.includes('--dry-run'),
    harnesses: harnessesForOption(harnessOption),
    homeDirectory: context.homeDirectory ?? homedir(),
    loadSource,
    now: context.now ?? new Date(),
    source,
  })
  const action = args.includes('--dry-run') ? 'Would install' : 'Installed'
  const scope = distribution === 'team_catalog' ? 'Shared' : 'Personal'
  return {
    exitCode: 0,
    stderr: '',
    stdout: `${action} ${install.name} for ${install.targets.map((target) => harnessLabel(target.harness)).join(' and ')} · ${scope}\n`,
  }
}

async function removeCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const [name] = args
  if (!name || name.startsWith('-'))
    throw new Error(`Usage: ${commandPrefixOf(context)} remove <skill>`)
  rejectUnknownOptions('remove', args, new Set([name, '--dry-run']), context)
  const homeDirectory = context.homeDirectory ?? homedir()
  const result = await removeCatalogSkill({
    dryRun: args.includes('--dry-run'),
    homeDirectory,
    name,
    now: context.now ?? new Date(),
  })
  return {
    exitCode: 0,
    stderr: '',
    stdout: args.includes('--dry-run')
      ? `Would move ${name} to the local trce trash.\n`
      : `Removed ${name}. Recovery copy: ${homeRelativePath(result.trashRoot, homeDirectory)}\n`,
  }
}

async function updateCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const [name] = args
  if (!name || name.startsWith('-'))
    throw new Error(`Usage: ${commandPrefixOf(context)} update <skill>`)
  rejectUnknownOptions('update', args, new Set([name, '--dry-run']), context)
  const homeDirectory = context.homeDirectory ?? homedir()
  const manifest = await readInstallManifest(homeDirectory)
  const install = manifest.installs.find((candidate) => candidate.name === name)
  let loadSource = context.loadSkillSource ?? loadGitHubSkillSource
  if (!context.loadSkillSource && install?.distribution === 'team_catalog') {
    const config = await readLinkedTeam(context)
    if (!config) throw new Error(notLinkedError(context))
    loadSource = sharedSkillSourceLoader(
      config,
      withTransientRetry(context.fetch ?? globalThis.fetch, context.sleep ?? wait),
      context,
    )
  } else if (!context.loadSkillSource) {
    loadSource = sourceLoaderWithStatus(loadGitHubSkillSource, context)
  }
  const result = await updateCatalogSkill({
    dryRun: args.includes('--dry-run'),
    homeDirectory,
    loadSource,
    name,
    now: context.now ?? new Date(),
  })
  return {
    exitCode: 0,
    stderr: '',
    stdout: result.changed
      ? `${args.includes('--dry-run') ? 'Would update' : 'Updated'} ${name}.\n`
      : `${name} is already current.\n`,
  }
}

function sharedSkillSourceLoader(
  config: LinkedConfig,
  fetch: typeof globalThis.fetch,
  context: CliContext,
): SkillSourceLoader {
  return async (source) => {
    context.onStatus?.(statusText(context, 'Getting repository access'))
    const credential = await fetchCatalogCredential(config, source.repository, fetch)
    context.onStatus?.(statusText(context, 'Downloading skill'))
    return loadGitHubSkillSourceWithCredential({ credential, fetch, source })
  }
}

function sourceLoaderWithStatus(
  loadSource: SkillSourceLoader,
  context: CliContext,
): SkillSourceLoader {
  return async (source) => {
    context.onStatus?.(statusText(context, 'Downloading skill'))
    return loadSource(source)
  }
}

/** `Scanning…` with the terminal's ellipsis glyph (`...` on a non-UTF-8 locale). */
function statusText(context: CliContext, message: string) {
  return `${message}${glyphs(asciiMode({ env: envOf(context) })).ellipsis}`
}

/**
 * Per-agent status lines show completed file counts, followed by the skill inventory.
 */
function scanProgressStatus(context: CliContext) {
  const symbols = glyphs(asciiMode({ env: envOf(context) }))
  const counts = new Map<HarnessName, { filesRead: number; filesTotal: number }>()
  let skills: { done: boolean; installations: number } = { done: false, installations: 0 }
  return (progress: ScanProgress) => {
    if (progress.kind === 'skills') skills = progress
    else
      counts.set(progress.harness, {
        filesRead: progress.filesRead,
        filesTotal: progress.filesTotal,
      })
    const items: StatusItem[] = codingAgentList.flatMap((agent) => {
      const count = counts.get(agent.id)
      if (!count) return []
      const text = `${codingAgentLabel(agent.id)} sessions`
      if (count.filesTotal === 0) return [{ detail: `${symbols.dot} none`, done: true, text }]
      const done = count.filesRead >= count.filesTotal
      const progress = done ? `${count.filesTotal}` : `${count.filesRead}/${count.filesTotal}`
      return [{ detail: `${symbols.dot} ${progress}`, done, text }]
    })
    items.push(
      skills.done
        ? {
            detail: `${symbols.dot} ${skills.installations} installations`,
            done: true,
            text: 'Skills',
          }
        : { text: `Skills${symbols.ellipsis}` },
    )
    context.onStatus?.(items)
  }
}

async function pullRequestCommand(
  command: 'promote' | 'unify',
  args: readonly string[],
  context: CliContext,
): Promise<CliResult> {
  const [skill] = args
  if (!skill || !args.includes('--pr'))
    throw new Error(`Usage: ${commandPrefixOf(context)} ${command} <skill> --pr`)
  const repo = optionValue(args, '--repo')
  const action = optionValue(args, '--action')
  const distribution = optionValue(args, '--distribution')
  if (distribution && distribution !== 'project' && distribution !== 'shared') {
    throw new Error(`--distribution must be project or shared, not ${distribution}`)
  }
  if (command !== 'promote' && distribution) {
    throw new Error('--distribution is valid only for promote')
  }
  const allowed = new Set([
    skill,
    '--pr',
    '--repo',
    repo ?? '',
    '--action',
    action ?? '',
    '--distribution',
    distribution ?? '',
  ])
  rejectUnknownOptions(command, args, allowed, context)
  if (!action) {
    throw new Error(
      `This command finishes an action started in Reviews. Choose Share with team, Add to repository, or Standardize, then copy the command from the Finish on your machine dialog.\n  Expected: ${commandPrefixOf(context)} ${command} <skill> --pr --repo <owner/repo> --action <id>`,
    )
  }
  const config = await readLinkedTeam(context)
  if (!config) throw new Error(notLinkedError(context))
  const fetch = context.fetch ?? globalThis.fetch
  const claimed = await claimLaptopAction(config, action, fetch)
  const linkOptions = {
    color: context.color ?? supportsColor(),
    hyperlinks: context.hyperlinks ?? supportsHyperlinks(),
  }
  if (claimed.kind === 'opened') {
    await removePendingAction(pendingPathOf(context), action)
    return {
      exitCode: 0,
      stderr: '',
      stdout: `Pull request #${claimed.number} is already open: ${terminalLink(claimed.url, linkOptions)}\n`,
    }
  }
  if (
    claimed.action.command !== command ||
    claimed.action.skillName !== skill ||
    (repo !== undefined && claimed.action.repository !== repo)
  ) {
    throw new Error('The dashboard action does not match this command. Nothing changed.')
  }
  const inventory = await inventoryForContext(context)
  const selected = selectActionSkill(inventory, {
    fingerprint: claimed.action.skillFingerprint,
    name: claimed.action.skillName,
  })
  const files = await loadLocalSkillFiles(selected)
  // The exact files about to leave this machine, before any of them does.
  const { flush, progress } = progressLines(context)
  const homeDirectory = context.homeDirectory ?? homedir()
  progress(
    [
      `Uploading ${counted(files.length, 'file')} from ${homeRelativePath(selected.realDirectory, homeDirectory)} to ${claimed.action.repository}`,
      ...files.map((file) => `  ${file.path}`),
    ].join('\n'),
  )
  const pullRequest = await (context.openPullRequest ?? openLaptopPullRequest)({
    action: claimed.action,
    fetch,
    files,
    github: claimed.github,
  })
  const completed = await completeLaptopAction(config, action, pullRequest.number, fetch)
  await removePendingAction(pendingPathOf(context), action)
  return {
    exitCode: 0,
    stderr: '',
    stdout: `${flush()}Opened pull request #${completed.number}: ${terminalLink(completed.url, linkOptions)}\n`,
  }
}

async function reportCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const since = optionValue(args, '--since')
  rejectUnknownOptions(
    'report',
    args,
    new Set(['--all', '--json', '--since', '--static', since ?? '']),
    context,
  )
  const sinceDays = parseSinceDays(since)
  const quiet = args.includes('--json')
  if (!quiet) context.onStatus?.(statusText(context, 'Scanning skills and local session history'))
  const report = await generateLocalReport({
    ...reportOptions(context, sinceDays),
    ...(quiet || !context.onStatus ? {} : { onProgress: scanProgressStatus(context) }),
  })
  if (args.includes('--json')) {
    return {
      exitCode: 0,
      stderr: '',
      stdout: `${JSON.stringify(buildLocalReportExport(report), null, 2)}\n`,
    }
  }
  const terminalWidth = context.readTerminalWidth?.() ?? context.terminalWidth
  const outputOptions = {
    all: args.includes('--all'),
    ...outputStyle(context),
    homeDirectory: context.homeDirectory ?? homedir(),
    ...(terminalWidth === undefined ? {} : { terminalWidth }),
  }
  const showEarlyAccessCta = context.interactive === true && !(await readLinkedTeam(context))
  const scene = buildReportScene(report, { ...outputOptions, teamLine: !showEarlyAccessCta })
  const earlyAccessCta = showEarlyAccessCta
    ? `\n${formatEarlyAccessCta(outputOptions)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}\n`
    : ''
  if (context.animate && reportAnimates(args, context)) {
    await context.animate(scene, await pendingNotice(context))
    return { exitCode: 0, noticeShown: true, stderr: '', stdout: earlyAccessCta }
  }
  return {
    exitCode: 0,
    stderr: '',
    stdout: `${renderReportScene(scene)}${earlyAccessCta}`,
  }
}

/**
 * The reveal plays in an interactive colour terminal unless the user opts out with `--static`,
 * `TRCE_STATIC=1`, or `CI`. Pipes never animate: they get no `animate` hook at all.
 */
function reportAnimates(args: readonly string[], context: CliContext) {
  if (args.includes('--static')) return false
  const env = envOf(context)
  if (env.TRCE_STATIC === '1' || env.CI) return false
  return context.interactive === true && context.color !== false
}

async function dedupeCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  rejectUnknownOptions('dedupe', args, new Set(['--all']), context)
  const skills = await inventoryForContext(context)
  return {
    exitCode: 0,
    stderr: '',
    stdout: formatDedupe(duplicateCandidates(skills), {
      all: args.includes('--all'),
      ...outputStyle(context),
    }),
  }
}

async function diffCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const [name, ...extra] = args
  if (!name || extra.length > 0) throw new Error(`Usage: ${commandPrefixOf(context)} diff <skill>`)
  const skills = await inventoryForContext(context)
  const result = formatSkillDiff(
    name,
    skills.filter((skill) => skill.name === name),
  )
  return result.error
    ? { exitCode: 1, stderr: result.error, stdout: '' }
    : { exitCode: 0, stderr: '', stdout: result.output ?? '' }
}

/** Glyph, color, and link choices for human output, all derived from the context's env. */
function outputStyle(context: CliContext) {
  return {
    ascii: asciiMode({ env: envOf(context) }),
    commandPrefix: commandPrefixOf(context),
    ...(context.color === undefined ? {} : { color: context.color }),
    ...(context.hyperlinks === undefined ? {} : { hyperlinks: context.hyperlinks }),
  }
}

async function inventoryForContext(context: CliContext) {
  const projectDirectory = resolve(context.cwd ?? process.cwd())
  return scanInventory({
    env: envOf(context),
    homeDirectory: context.homeDirectory ?? homedir(),
    projectDirectory,
    projectRepo: await (context.repositorySlugForCwd ?? repositorySlug)(projectDirectory),
  })
}

function reportOptions(context: CliContext, sinceDays: number) {
  return {
    env: envOf(context),
    homeDirectory: context.homeDirectory ?? homedir(),
    projectDirectory: resolve(context.cwd ?? process.cwd()),
    ...(context.repositorySlugForCwd ? { repositorySlugForCwd: context.repositorySlugForCwd } : {}),
    sinceDays,
    ...(context.now ? { now: context.now } : {}),
    ...(context.claudeProjectsDirectory
      ? { claudeProjectsDirectory: context.claudeProjectsDirectory }
      : {}),
    ...(context.codexSessionsDirectory
      ? { codexSessionsDirectory: context.codexSessionsDirectory }
      : {}),
  }
}

function commandPrefixOf(context: CliContext) {
  return context.commandPrefix ?? defaultCommandPrefix
}

function envOf(context: CliContext) {
  return context.env ?? process.env
}

function warnOf(context: CliContext) {
  return context.warn ?? ((message: string) => process.stderr.write(`${message}\n`))
}

/** `~/.trce/pending.json`, next to the team link. */
function pendingPathOf(context: CliContext) {
  return pendingActionsPath(linkedConfigPath(context))
}

/** Defense in depth behind the `linkedCommands` gate; prints the same refusal, never a second text. */
function notLinkedError(context: CliContext) {
  return notLinkedMessage(
    commandPrefixOf(context),
    configuredDashboardUrl(envOf(context)),
  ).trimEnd()
}

function rejectUnknownOptions(
  command: string,
  args: readonly string[],
  allowed: ReadonlySet<string>,
  context: CliContext,
) {
  const unexpected = args.find((argument) => !allowed.has(argument))
  if (unexpected === undefined) return
  throw new Error(
    `Unknown ${command} option: ${unexpected}\nRun ${commandPrefixOf(context)} ${command} --help for usage.`,
  )
}

function optionValue(args: readonly string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`)
  return value
}

function harnessesForOption(value: string | undefined): HarnessName[] {
  if (value === undefined || value === 'all') return [...installableCodingAgentIds]
  const agent = normalizeCodingAgentId(value)
  if (agent && codingAgents[agent].installSupported) return [agent]
  if (agent) throw new Error(inventoryOnlyInstallMessage(agent))
  const options = installableCodingAgentList.map((entry) => entry.shortLabel).join(', ')
  throw new Error(`--harness must be one of ${options}, or all, not ${value}`)
}

/**
 * `add --harness cursor` is refused before the team-link gate and before any network call.
 * Cursor stays inventory-only (report, dedupe, diff); only installs are unavailable.
 */
function inventoryOnlyInstallRefusal(args: readonly string[]) {
  const index = args.indexOf('--harness')
  const value = index === -1 ? undefined : args[index + 1]
  if (!value || value.startsWith('-')) return null
  const agent = normalizeCodingAgentId(value)
  if (!agent || codingAgents[agent].installSupported) return null
  return inventoryOnlyInstallMessage(agent)
}

function inventoryOnlyInstallMessage(agent: HarnessName) {
  const choices = installableCodingAgentList.map((entry) => `--harness ${entry.shortLabel}`)
  return `${codingAgentLabel(agent)} installs are not available yet. Use ${choices.join(' or ')}.`
}

function harnessLabel(harness: HarnessName) {
  return codingAgentLabel(harness)
}

/** `1 session`, `2 sessions`: the pluralization every CLI count line uses. */
function counted(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

function wait(milliseconds: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
