import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  formatPendingNotice,
  type PendingAction,
  parsePendingActions,
  pendingActionCommand,
  pendingActionsPath,
  readPendingActions,
  removePendingAction,
  writePendingActions,
} from './pending.js'

const share: PendingAction = {
  command:
    'npx @trce/cli promote test-triage --pr --repo acme/skills-library --distribution shared --action a1b2c3',
  id: 'a1b2c3',
  kind: 'share',
  skillName: 'test-triage',
  targetRepository: 'acme/skills-library',
}

const standardize: PendingAction = {
  command: 'npx @trce/cli unify pr-review --pr --repo acme/web --action d4e5f6',
  id: 'd4e5f6',
  kind: 'standardize',
  skillName: 'pr-review',
  targetRepository: 'acme/web',
}

const add: PendingAction = {
  command: 'npx @trce/cli promote release-notes --pr --repo acme/web --action g7h8i9',
  id: 'g7h8i9',
  kind: 'add',
  skillName: 'release-notes',
  targetRepository: 'acme/web',
}

describe('pending laptop actions', () => {
  it('accepts only the allowlisted shape whose command is the dashboard template', () => {
    expect(parsePendingActions([share, standardize, add])).toEqual([share, standardize, add])
    expect(parsePendingActions([])).toEqual([])
    expect(parsePendingActions(undefined)).toBeNull()
    expect(parsePendingActions([{ ...share, body: 'skill text' }])).toBeNull()
    expect(parsePendingActions([{ ...share, kind: 'retire' }])).toBeNull()
    expect(parsePendingActions([{ ...share, skillName: '../etc' }])).toBeNull()
    expect(parsePendingActions([{ ...share, targetRepository: '/tmp/x' }])).toBeNull()
    expect(parsePendingActions([{ ...share, command: `${share.command}; rm -rf ~` }])).toBeNull()
    expect(parsePendingActions([{ ...share, command: standardize.command }])).toBeNull()
    expect(parsePendingActions(Array.from({ length: 101 }, () => share))).toBeNull()
  })

  it('prints the command with the prefix the user typed', () => {
    expect(pendingActionCommand(share)).toBe(share.command)
    expect(pendingActionCommand(share, 'trce')).toBe(
      'trce promote test-triage --pr --repo acme/skills-library --distribution shared --action a1b2c3',
    )
  })

  it('renders one waiting change', () => {
    expect(formatPendingNotice([share], { commandPrefix: 'trce' })).toBe(
      [
        '1 change is waiting for this machine',
        '  Share test-triage with the team → run: trce promote test-triage --pr --repo acme/skills-library --distribution shared --action a1b2c3',
        '',
      ].join('\n'),
    )
  })

  it('renders several waiting changes in server order with glossary verbs, and nothing when empty', () => {
    expect(formatPendingNotice([share, standardize, add], { commandPrefix: 'npx @trce/cli' })).toBe(
      [
        '3 changes are waiting for this machine',
        '  Share test-triage with the team → run: npx @trce/cli promote test-triage --pr --repo acme/skills-library --distribution shared --action a1b2c3',
        '  Standardize pr-review on this version → run: npx @trce/cli unify pr-review --pr --repo acme/web --action d4e5f6',
        '  Add release-notes to acme/web → run: npx @trce/cli promote release-notes --pr --repo acme/web --action g7h8i9',
        '',
      ].join('\n'),
    )
    expect(formatPendingNotice([])).toBe('')
    // Plain text: no escape codes regardless of the terminal.
    expect(formatPendingNotice([share])).not.toContain(String.fromCharCode(0x1b))
  })

  it('writes an owner-only file next to skills.json, clears it on an empty list, and reads it back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trce-pending-'))
    const path = pendingActionsPath(join(directory, '.trce', 'skills.json'))
    expect(path).toBe(join(directory, '.trce', 'pending.json'))

    await writePendingActions(path, [share, standardize], '2026-08-30T10:00:00.000Z')
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, '.trce'))).mode & 0o777).toBe(0o700)
    }
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      actions: [share, standardize],
      fetchedAt: '2026-08-30T10:00:00.000Z',
      version: 1,
    })
    expect(await readPendingActions(path)).toEqual([share, standardize])

    await writePendingActions(path, [], '2026-08-30T10:05:00.000Z')
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readPendingActions(path)).toEqual([])
    // Clearing an already absent file is not an error.
    await expect(writePendingActions(path, [], '2026-08-30T10:06:00.000Z')).resolves.toBeUndefined()
  })

  it('reads a missing or malformed file as nothing waiting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trce-pending-bad-'))
    const path = join(directory, 'pending.json')
    expect(await readPendingActions(path)).toEqual([])
    await writeFile(path, '{not json')
    expect(await readPendingActions(path)).toEqual([])
    await writeFile(
      path,
      JSON.stringify({ actions: [{ ...share, body: 'x' }], fetchedAt: 'now', version: 1 }),
    )
    expect(await readPendingActions(path)).toEqual([])
  })

  it('removes one finished action and deletes the file when the last one goes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trce-pending-remove-'))
    const path = join(directory, 'pending.json')
    await writePendingActions(path, [share, standardize], '2026-08-30T10:00:00.000Z')

    await removePendingAction(path, share.id)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      actions: [standardize],
      fetchedAt: '2026-08-30T10:00:00.000Z',
      version: 1,
    })
    await removePendingAction(path, 'unknown-id')
    expect(await readPendingActions(path)).toEqual([standardize])

    await removePendingAction(path, standardize.id)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(removePendingAction(path, standardize.id)).resolves.toBeUndefined()
  })
})
