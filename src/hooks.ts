import { spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { agentHomes } from './coding-agents.js'
import { asRecord, homeRelativePath } from './value.js'

const hookDebounceMilliseconds = 60_000
/** Written into new hooks. */
export const hookMarker = 'trce-hook-v1'
/** The beta marker; still recognised so `init --remove` cleans up hooks from earlier builds. */
export const legacyHookMarker = 'trce-skills-hook-v1'
const hookMarkers = new Set([hookMarker, legacyHookMarker])
// Any command that runs one of trce's own scripts from ~/.trce is trce's hook, however it is quoted.
const trceScriptPattern = /\.trce[\\/]+(?:codex-notify|hook|skills-hook)\.mjs/u

type HookPaths = {
  claudeSettings: string
  codexConfig: string
  homeDirectory: string
  launcher: string
  /** The beta launcher name, removed by `init --remove` when present. */
  legacyLauncher: string
  lock: string
  state: string
  wrapper: string
}

type HookEnvironmentOptions = {
  /** Environment used to locate relocated agent homes. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  homeDirectory: string
}

type InstallHooksOptions = HookEnvironmentOptions & {
  executable: string
  platform?: NodeJS.Platform
  scriptPath: string
}

type HookState = {
  codexInstalledLine: string | null
  codexOriginalLine: string | null
  version: 1
}

export type HookInstallResult = {
  claude: 'installed' | 'already-installed'
  codex: 'installed' | 'already-installed'
}

export async function installHooks(options: InstallHooksOptions): Promise<HookInstallResult> {
  const paths = hookPaths(options)
  const trceCommand = [options.executable, paths.launcher]
  const command = shellCommand(trceCommand, options.platform ?? process.platform)
  // Validate both foreign configurations before creating a launcher or changing either agent.
  await installClaudeHook(paths, command, true)
  await installCodexHook(paths, trceCommand, true)
  await writeHookLauncher(paths.launcher, options.executable, options.scriptPath)
  if (await readText(paths.legacyLauncher)) {
    await writeHookLauncher(paths.legacyLauncher, options.executable, options.scriptPath)
  }
  const claude = await installClaudeHook(paths, command)
  const codex = await installCodexHook(paths, trceCommand)
  return { claude, codex }
}

export async function removeHooks(options: HookEnvironmentOptions) {
  const paths = hookPaths(options)
  await removeCodexHook(paths, true)
  const claude = await removeClaudeHook(paths)
  const codex = await removeCodexHook(paths)
  await Promise.all([
    rm(paths.launcher, { force: true }),
    rm(paths.legacyLauncher, { force: true }),
    rm(paths.wrapper, { force: true }),
    rm(paths.state, { force: true }),
    rm(paths.lock, { force: true }),
    ...[paths.launcher, paths.legacyLauncher, paths.wrapper, paths.lock].flatMap((path) => [
      rm(`${path}.timestamp`, { force: true }),
      rmdir(`${path}.admission`).catch((error: unknown) => {
        if (asRecord(error)?.code !== 'ENOENT') throw error
      }),
    ]),
  ])
  return { claude, codex }
}

export async function spawnDetachedPush(
  executable: string,
  scriptPath: string,
  options: HookEnvironmentOptions & { now?: number },
) {
  if (!(await claimHookWindow(options, options.now ?? Date.now()))) return false
  const child = spawn(executable, [scriptPath, 'push', '--quiet'], {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => undefined)
  child.unref()
  return true
}

/** Claude and Codex config paths honour `CLAUDE_CONFIG_DIR` and `CODEX_HOME` like every scan. */
function hookPaths({ env, homeDirectory }: HookEnvironmentOptions): HookPaths {
  const trceDirectory = join(homeDirectory, '.trce')
  const homes = agentHomes(env ?? process.env, homeDirectory)
  return {
    claudeSettings: join(homes.claude, 'settings.json'),
    codexConfig: join(homes.codex, 'config.toml'),
    homeDirectory,
    launcher: join(trceDirectory, 'hook.mjs'),
    legacyLauncher: join(trceDirectory, 'skills-hook.mjs'),
    lock: join(trceDirectory, 'hook-push.lock'),
    state: join(trceDirectory, 'hooks.json'),
    wrapper: join(trceDirectory, 'codex-notify.mjs'),
  }
}

async function claimHookWindow(options: HookEnvironmentOptions, now: number) {
  const path = hookPaths(options).lock
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  const admission = `${path}.admission`
  try {
    await mkdir(admission, { mode: 0o700 })
  } catch (error) {
    if (asRecord(error)?.code === 'EEXIST') return false
    throw error
  }
  try {
    const existing = Number.parseInt(await readText(path), 10)
    const elapsed = now - existing
    if (Number.isFinite(existing) && elapsed >= 0 && elapsed < hookDebounceMilliseconds) {
      return false
    }
    await writeFile(path, `${now}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } finally {
    await rmdir(admission)
  }
}

async function writeHookLauncher(path: string, executable: string, scriptPath: string) {
  // Background hooks must never install packages. A moved/deleted CLI fails closed until the
  // user reinstalls hooks from its new location. Admission happens before creating any child.
  const preferred = JSON.stringify([executable, scriptPath, 'hook'])
  const source = [
    "import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'",
    "import { spawn } from 'node:child_process'",
    '',
    "if (process.env.TRCE_HOOK_ACTIVE === '1') process.exit(0)",
    `const preferred = ${preferred}`,
    'if (!existsSync(preferred[0]) || !existsSync(preferred[1])) process.exit(0)',
    hookAdmissionSource(path, hookDebounceMilliseconds),
    'const claudeProjectDirectory = process.env.CLAUDE_PROJECT_DIR',
    'const cwd = claudeProjectDirectory && existsSync(claudeProjectDirectory) ? claudeProjectDirectory : process.cwd()',
    "const child = spawn(preferred[0], preferred.slice(1), { cwd, detached: true, env: { ...process.env, TRCE_HOOK_ACTIVE: '1' }, stdio: 'ignore' })",
    "child.on('error', () => undefined)",
    'child.unref()',
    '',
  ].join('\n')
  await writeOwnedTextAtomic(path, source)
}

async function installClaudeHook(paths: HookPaths, command: string, dryRun = false) {
  const path = paths.claudeSettings
  const settings = await readJsonObject(path, paths.homeDirectory)
  if (settings.hooks !== undefined && !asRecord(settings.hooks)) {
    throw new Error('Claude hooks have an unsupported shape; no hook was changed')
  }
  const hooks = asMutableRecord(settings.hooks)
  const sessionEnd = hooks.SessionEnd
  if (sessionEnd !== undefined && !Array.isArray(sessionEnd)) {
    throw new Error('Claude SessionEnd hooks have an unsupported shape; no hook was changed')
  }
  const entries = Array.isArray(sessionEnd) ? sessionEnd : []
  if (entries.some((entry) => containsTrceCommand(entry))) return 'already-installed' as const
  hooks.SessionEnd = [
    ...entries,
    {
      // `statusMessage` is the only free-form string Claude Code's hook schema allows besides the
      // command itself, so it carries the marker instead of a shell comment (which Windows lacks).
      hooks: [{ command, statusMessage: hookMarker, timeout: 5, type: 'command' }],
      matcher: '',
    },
  ]
  settings.hooks = hooks
  if (!dryRun) await writeForeignJsonAtomic(path, settings)
  return 'installed' as const
}

async function removeClaudeHook(paths: HookPaths) {
  const path = paths.claudeSettings
  const settings = await readJsonObject(path, paths.homeDirectory)
  const hooks = asMutableRecord(settings.hooks)
  if (!Array.isArray(hooks.SessionEnd)) return 'not-installed' as const
  let changed = false
  const retained: unknown[] = []
  for (const entry of hooks.SessionEnd) {
    const group = asRecord(entry)
    if (group && Array.isArray(group.hooks)) {
      // Only drop trce's inner entry; other commands in the same group stay where they are.
      const inner = group.hooks.filter((hook) => !containsTrceCommand(hook))
      if (inner.length === group.hooks.length) {
        retained.push(entry)
        continue
      }
      changed = true
      if (inner.length > 0) retained.push({ ...group, hooks: inner })
      continue
    }
    if (containsTrceCommand(entry)) {
      changed = true
      continue
    }
    retained.push(entry)
  }
  if (!changed) return 'not-installed' as const
  if (retained.length > 0) hooks.SessionEnd = retained
  else delete hooks.SessionEnd
  settings.hooks = hooks
  await writeForeignJsonAtomic(path, settings)
  return 'removed' as const
}

async function installCodexHook(paths: HookPaths, trceCommand: string[], dryRun = false) {
  const text = await readText(paths.codexConfig)
  const existing = topLevelNotify(text)
  const state = await readHookState(paths)
  if (state?.codexOriginalLine && referencesTrceHook(state.codexOriginalLine, paths)) {
    throw new Error(
      'Saved Codex notify points back to trce. Repair the recursive notification chain before installing hooks; no hook was changed',
    )
  }
  if (
    existing &&
    state?.codexInstalledLine &&
    (state.codexInstalledLine === existing.line.trim() ||
      restoreNestedNotify(existing.value, state, paths) !== null)
  ) {
    if (state.codexOriginalLine) {
      const original = topLevelNotify(state.codexOriginalLine)
      const command = original && parseTomlStringArray(original.value)
      if (!command)
        throw new Error('Saved Codex notify has an unsupported shape; no hook was changed')
      if (!dryRun) await writeCodexWrapper(paths.wrapper, command, trceCommand)
    }
    return 'already-installed' as const
  }
  // A notify that already reaches trce's scripts, even through another tool's wrapper, is
  // installed; wrapping it again would make the two wrappers call each other.
  if (existing && referencesTrceHook(existing.line, paths)) return 'already-installed' as const

  let installedLine: string
  if (existing) {
    const existingCommand = parseTomlStringArray(existing.value)
    if (!existingCommand) {
      throw new Error('Codex notify has an unsupported shape; no hook was changed')
    }
    if (!dryRun) await writeCodexWrapper(paths.wrapper, existingCommand, trceCommand)
    installedLine = `notify = ${tomlStringArray([trceCommand[0] ?? 'node', paths.wrapper])}`
  } else {
    installedLine = `notify = ${tomlStringArray(trceCommand)}`
  }
  if (dryRun) return 'installed' as const

  const next = existing
    ? `${text.slice(0, existing.start)}${installedLine}${text.slice(existing.end)}`
    : `${installedLine}\n${text}`
  await writeForeignTextAtomic(paths.codexConfig, next)
  await writeOwnedJsonAtomic(paths.state, {
    codexInstalledLine: installedLine,
    codexOriginalLine: existing?.line ?? null,
    version: 1,
  } satisfies HookState)
  return 'installed' as const
}

async function removeCodexHook(paths: HookPaths, dryRun = false) {
  const state = await readHookState(paths)
  if (!state?.codexInstalledLine) return 'not-installed' as const
  if (state.codexOriginalLine && referencesTrceHook(state.codexOriginalLine, paths)) {
    throw new Error(
      'Saved Codex notify points back to trce; refusing to restore a recursive notification chain',
    )
  }
  const text = await readText(paths.codexConfig)
  const existing = topLevelNotify(text)
  const replacement = existing
    ? existing.line.trim() === state.codexInstalledLine
      ? (state.codexOriginalLine ?? '')
      : restoreNestedNotify(existing.value, state, paths)
    : null
  if (!existing || replacement === null) {
    throw new Error('Codex notify changed after trce setup; it was left untouched')
  }
  if (dryRun) return 'removed' as const
  const next = `${text.slice(0, existing.start)}${replacement}${text.slice(existing.end)}`
  await writeForeignTextAtomic(paths.codexConfig, next.replace(/^\n/u, ''))
  await writeOwnedJsonAtomic(paths.state, {
    codexInstalledLine: null,
    codexOriginalLine: null,
    version: 1,
  } satisfies HookState)
  return 'removed' as const
}

/** Replace only an exact saved argv inside JSON-encoded command arguments, never shell text. */
function restoreNestedNotify(value: string, state: HookState, paths: HookPaths): string | null {
  const installed = state.codexInstalledLine && topLevelNotify(state.codexInstalledLine)
  const original = state.codexOriginalLine && topLevelNotify(state.codexOriginalLine)
  const installedCommand = installed && parseTomlStringArray(installed.value)
  const originalCommand = original && parseTomlStringArray(original.value)
  const current = parseTomlStringArray(value)
  // Without a previous command, we cannot assume how a foreign wrapper disables its callback.
  if (!installedCommand || !originalCommand || !current) return null
  if (!referencesTrceHook(tomlStringArray(installedCommand), paths)) return null
  const restored = replaceNestedCommand(current, installedCommand, originalCommand, 0)
  if (!restored) return null
  const line = `notify = ${tomlStringArray(restored)}`
  // Do not delete owned scripts while another, unrecognised callback still refers to them.
  return referencesTrceHook(line, paths) ? null : line
}

function replaceNestedCommand(
  current: string[],
  installed: string[],
  original: string[],
  depth: number,
): string[] | null {
  if (depth > 8) return null
  if (current.length === installed.length && current.every((arg, i) => arg === installed[i])) {
    return original
  }
  let changed = false
  const restored = current.map((arg, index) => {
    if (index === 0) return arg
    let nested: unknown
    try {
      nested = JSON.parse(arg)
    } catch {
      return arg
    }
    if (
      !Array.isArray(nested) ||
      !nested.every((item): item is string => typeof item === 'string')
    ) {
      return arg
    }
    const replacement = replaceNestedCommand(nested, installed, original, depth + 1)
    if (!replacement) return arg
    changed = true
    return JSON.stringify(replacement)
  })
  return changed ? restored : null
}

// Recognises the current and the beta `statusMessage` markers, the pre-release in-command marker
// (`... # trce-skills-hook-v1`), and either launcher file name, so `init --remove` cleans up
// hooks from any build.
export function containsTrceCommand(value: unknown): boolean {
  if (typeof value === 'string') {
    return (
      [...hookMarkers].some((marker) => value.includes(marker)) || trceScriptPattern.test(value)
    )
  }
  if (Array.isArray(value)) return value.some((child) => containsTrceCommand(child))
  const record = asRecord(value)
  if (!record) return false
  if (typeof record.statusMessage === 'string' && hookMarkers.has(record.statusMessage)) return true
  return Object.values(record).some((child) => containsTrceCommand(child))
}

export function referencesTrceHook(text: string, paths: Pick<HookPaths, 'launcher' | 'wrapper'>) {
  return (
    text.includes(paths.launcher) || text.includes(paths.wrapper) || trceScriptPattern.test(text)
  )
}

function topLevelNotify(text: string) {
  let offset = 0
  for (const lineWithNewline of text.match(/.*(?:\n|$)/gu) ?? []) {
    const line = lineWithNewline.replace(/\n$/u, '')
    if (/^\s*\[/u.test(line)) return null
    const match = /^\s*notify\s*=\s*(.+?)\s*$/u.exec(line)
    if (match?.[1]) {
      return {
        end: offset + line.length,
        line: line.trim(),
        start: offset,
        value: match[1],
      }
    }
    offset += lineWithNewline.length
  }
  return null
}

function parseTomlStringArray(value: string) {
  if (!/^\s*\[.*\]\s*$/u.test(value)) return null
  const strings: string[] = []
  const body = value.trim().slice(1, -1)
  let index = 0
  while (index < body.length) {
    while (/[\s,]/u.test(body[index] ?? '')) index += 1
    if (index >= body.length) break
    const quote = body[index]
    if (quote !== '"' && quote !== "'") return null
    const start = index
    index += 1
    let result = ''
    while (index < body.length && body[index] !== quote) {
      if (quote === '"' && body[index] === '\\' && index + 1 < body.length) {
        index += 1
        result += body[index]
      } else {
        result += body[index]
      }
      index += 1
    }
    if (body[index] !== quote) return null
    if (quote === '"') {
      // JSON string decoding preserves escaped controls, Unicode, quotes and backslashes.
      // Unsupported TOML escapes fail closed instead of silently changing notifier arguments.
      try {
        const decoded: unknown = JSON.parse(body.slice(start, index + 1))
        if (typeof decoded !== 'string') return null
        result = decoded
      } catch {
        return null
      }
    }
    strings.push(result)
    index += 1
  }
  return strings.length > 0 ? strings : null
}

function tomlStringArray(values: readonly string[]) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`
}

async function writeCodexWrapper(path: string, existing: string[], trce: string[]) {
  const source = `import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'

// A foreign notifier can call this wrapper again. Stop before spawning either child.
if (process.env.TRCE_NOTIFY_ACTIVE === '1') process.exit(0)
${hookAdmissionSource(path, 1_000)}
const env = { ...process.env, TRCE_NOTIFY_ACTIVE: '1' }
const eventArgs = process.argv.slice(2)
const commands = [
  { args: ${JSON.stringify(existing)}, forwardEvent: true },
  { args: ${JSON.stringify(trce)}, forwardEvent: false },
]
for (const command of commands) {
  const [file, ...args] = command.args
  if (!file) continue
  const child = spawn(file, [...args, ...(command.forwardEvent ? eventArgs : [])], { detached: true, env, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}
`
  await writeOwnedTextAtomic(path, source)
}

/** Cross-process admission before spawning, including when a foreign notifier drops our env. */
function hookAdmissionSource(path: string, milliseconds: number) {
  return `const admission = ${JSON.stringify(`${path}.admission`)}
const timestamp = ${JSON.stringify(`${path}.timestamp`)}
try { mkdirSync(admission, { mode: 0o700 }) } catch { process.exit(0) }
let admitted = false
try {
  const now = Date.now()
  let previous = 0
  try { previous = Number(readFileSync(timestamp, 'utf8')) } catch {}
  if (!Number.isFinite(previous) || now < previous || now - previous >= ${milliseconds}) {
    writeFileSync(timestamp, String(now), { mode: 0o600 })
    admitted = true
  }
} catch {} finally { try { rmdirSync(admission) } catch {} }
if (!admitted) process.exit(0)`
}

async function readHookState(paths: HookPaths): Promise<HookState | null> {
  const value = await readJsonObject(paths.state, paths.homeDirectory)
  if (value.version !== 1) return null
  const installed = value.codexInstalledLine
  const original = value.codexOriginalLine
  if (installed !== null && typeof installed !== 'string') return null
  if (original !== null && typeof original !== 'string') return null
  return { codexInstalledLine: installed, codexOriginalLine: original, version: 1 }
}

async function readJsonObject(path: string, homeDirectory: string) {
  const text = await readText(path)
  if (text.trim().length === 0) return {} as Record<string, unknown>
  try {
    const value = asRecord(JSON.parse(text) as unknown)
    if (!value) throw new Error('Expected a JSON object')
    return value
  } catch {
    throw new Error(`Could not read ${homeRelativePath(path, homeDirectory)}. No hook was changed.`)
  }
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {}
}

async function readText(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') return ''
    throw error
  }
}

function jsonText(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeOwnedJsonAtomic(path: string, value: unknown) {
  await writeOwnedTextAtomic(path, jsonText(value))
}

async function writeForeignJsonAtomic(path: string, value: unknown) {
  await writeForeignTextAtomic(path, jsonText(value))
}

// Files under ~/.trce belong to trce and stay owner-only.
async function writeOwnedTextAtomic(path: string, value: string) {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  await replaceFileAtomic(path, value, 0o600)
}

// Claude and Codex own their config files: write through any symlink (dotfiles checkouts) and
// keep whatever mode the file already has.
async function writeForeignTextAtomic(path: string, value: string) {
  const target = await resolveWriteTarget(path)
  const existing = await stat(target).catch((error: unknown) => {
    if (asRecord(error)?.code === 'ENOENT') return null
    throw error
  })
  await mkdir(dirname(target), { recursive: true })
  await replaceFileAtomic(target, value, existing ? existing.mode & 0o777 : 0o600)
}

async function resolveWriteTarget(path: string) {
  try {
    return await realpath(path)
  } catch (error) {
    if (asRecord(error)?.code !== 'ENOENT') throw error
  }
  // Missing file, or a symlink whose target does not exist yet: keep the link and create its target.
  const link = await readlink(path).catch(() => null)
  const target = link ? resolve(dirname(path), link) : path
  const parent = await realpath(dirname(target)).catch(() => dirname(target))
  return join(parent, basename(target))
}

async function replaceFileAtomic(path: string, value: string, mode: number) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporary, value, { encoding: 'utf8', mode })
  // writeFile's mode is subject to the umask; chmod restores the exact mode being preserved.
  await chmod(temporary, mode)
  await rename(temporary, path)
}

function shellCommand(values: readonly string[], platform: NodeJS.Platform) {
  if (platform === 'win32') {
    return values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(' ')
  }
  return values.map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(' ')
}
