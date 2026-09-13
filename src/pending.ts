import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { glyphs } from './brand.js'
import { defaultCommandPrefix, npxCommandPrefix } from './invocation.js'
import { asRecord, isoTimestamp, stringValue } from './value.js'

/**
 * Changes waiting for this machine. Sharing a Personal skill is two-party: the review happens in
 * the dashboard, but only a laptop that holds the exact version can open the pull request. The
 * push response lists the `awaiting_device` actions this laptop can finish; `push` stores them in
 * `~/.trce/pending.json` and every gated command prints them at the top. No extra request.
 */

export type PendingActionKind = 'add' | 'share' | 'standardize'

export type PendingAction = {
  /** The dashboard's command, verbatim (`npx @trce/cli promote … --action <id>`). */
  command: string
  id: string
  kind: PendingActionKind
  skillName: string
  targetRepository: string
}

export type PendingActionsFile = {
  actions: PendingAction[]
  fetchedAt: string
  version: 1
}

export const maximumPendingActions = 100

/** Next to `config.json`: `~/.trce/pending.json`. */
export function pendingActionsPath(configFile: string) {
  return join(dirname(configFile), 'pending.json')
}

/**
 * The command for one waiting action, in the dashboard's own template, printed with the prefix
 * the user typed. The hosted app verifies that its command builder stays in step with this one.
 */
export function pendingActionCommand(
  action: Pick<PendingAction, 'id' | 'kind' | 'skillName' | 'targetRepository'>,
  commandPrefix = npxCommandPrefix,
) {
  const verb = action.kind === 'standardize' ? 'unify' : 'promote'
  const distribution = action.kind === 'share' ? ' --distribution shared' : ''
  return `${commandPrefix} ${verb} ${action.skillName} --pr --repo ${action.targetRepository}${distribution} --action ${action.id}`
}

/**
 * Strict: every row must be exactly the allowlisted fields, and `command` must equal the template
 * for those fields. A response that carries anything else is treated as invalid, never printed.
 */
export function parsePendingActions(value: unknown): PendingAction[] | null {
  if (!Array.isArray(value) || value.length > maximumPendingActions) return null
  const actions = value.map(parsePendingAction)
  return actions.every((action): action is PendingAction => action !== null) ? actions : null
}

function parsePendingAction(value: unknown): PendingAction | null {
  const record = asRecord(value)
  if (!record) return null
  const keys = Object.keys(record).toSorted()
  if (keys.join(',') !== 'command,id,kind,skillName,targetRepository') return null
  const id = stringValue(record.id)
  const kind = pendingActionKind(record.kind)
  const skillName = stringValue(record.skillName)
  const targetRepository = stringValue(record.targetRepository)
  const command = stringValue(record.command)
  if (
    !id ||
    !/^[a-zA-Z0-9_-]+$/u.test(id) ||
    !kind ||
    !skillName ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(skillName) ||
    !targetRepository ||
    !/^[^/\s]+\/[^/\s]+$/u.test(targetRepository) ||
    !command
  ) {
    return null
  }
  const action = { command, id, kind, skillName, targetRepository }
  return command === pendingActionCommand(action) ? action : null
}

function pendingActionKind(value: unknown): PendingActionKind | null {
  return value === 'add' || value === 'share' || value === 'standardize' ? value : null
}

/** Missing, unreadable, or malformed files read as "nothing waiting"; the next push rewrites them. */
export async function readPendingActions(path: string): Promise<PendingAction[]> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return []
  }
  const record = asRecord(value)
  if (record?.version !== 1 || !isoTimestamp(record.fetchedAt)) return []
  return parsePendingActions(record.actions) ?? []
}

/** Owner-only like `config.json`. An empty list removes the file. */
export async function writePendingActions(
  path: string,
  actions: readonly PendingAction[],
  fetchedAt: string,
) {
  if (actions.length === 0) {
    await unlink(path).catch((error: unknown) => {
      if (asRecord(error)?.code !== 'ENOENT') throw error
    })
    return
  }
  const file: PendingActionsFile = { actions: [...actions], fetchedAt, version: 1 }
  const directory = dirname(path)
  const temporary = join(directory, `.pending.${process.pid}.${Date.now()}.tmp`)
  await mkdir(directory, { mode: 0o700, recursive: true })
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporary, path)
}

/** After `promote`/`unify` finishes an action, it is no longer waiting. */
export async function removePendingAction(path: string, actionId: string) {
  let fetchedAt = new Date(0).toISOString()
  try {
    fetchedAt =
      isoTimestamp(asRecord(JSON.parse(await readFile(path, 'utf8')) as unknown)?.fetchedAt) ??
      fetchedAt
  } catch {
    return
  }
  const actions = await readPendingActions(path)
  const remaining = actions.filter((action) => action.id !== actionId)
  if (remaining.length !== actions.length) await writePendingActions(path, remaining, fetchedAt)
}

/**
 * The notice printed above `report`, `dedupe`, `diff`, and `push` output. Plain text, no color,
 * one row per waiting change. User-facing verbs are Share with team, Add to repository, and
 * Standardize. Empty when nothing waits, so goldens do not change.
 */
export function formatPendingNotice(
  actions: readonly PendingAction[],
  options: { commandPrefix?: string } = {},
) {
  if (actions.length === 0) return ''
  const commandPrefix = options.commandPrefix ?? defaultCommandPrefix
  const arrow = glyphs().arrow
  const lines = [
    actions.length === 1
      ? '1 change is waiting for this machine'
      : `${actions.length} changes are waiting for this machine`,
    ...actions.map(
      (action) =>
        `  ${describePendingAction(action)} ${arrow} run: ${pendingActionCommand(action, commandPrefix)}`,
    ),
  ]
  return `${lines.join('\n')}\n`
}

function describePendingAction(action: PendingAction) {
  if (action.kind === 'share') return `Share ${action.skillName} with the team`
  if (action.kind === 'add') return `Add ${action.skillName} to ${action.targetRepository}`
  return `Standardize ${action.skillName} on this version`
}
