import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type InstallRequest,
  installCatalogSkill,
  loadGitHubSkillSourceWithCredential,
  removeCatalogSkill,
  updateCatalogSkill,
} from './catalog.js'
import { runCli } from './cli.js'
import { writeLinkedConfig } from './config.js'
import { fingerprintSkillFiles } from './hash.js'
import {
  clearInstallEvents,
  readInstallManifest,
  withInstallLock,
  writeInstallManifest,
} from './installs.js'
import { scanInventory } from './inventory.js'

const skillMd = `---
name: review-helper
description: Reviews a change without storing prompts or code.
---

Review the change.
`

function loader(body = skillMd, resolvedRef = 'abc123') {
  return async () => ({
    files: [
      {
        contents: Uint8Array.from(Buffer.from(body)),
        executable: false,
        path: 'SKILL.md',
      },
      {
        contents: Uint8Array.from(Buffer.from('#!/bin/sh\nexit 0\n')),
        executable: true,
        path: 'scripts/check.sh',
      },
    ],
    resolvedRef,
  })
}

const temporaryDirectories: string[] = []

async function temporaryHome(prefix: string) {
  const homeDirectory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(homeDirectory)
  return homeDirectory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

/** Managed installs need a linked team; write a fixture link into a fresh home. */
async function linkedHome(prefix: string) {
  const homeDirectory = await temporaryHome(prefix)
  await writeLinkedConfig(join(homeDirectory, '.trce', 'config.json'), {
    baseUrl: 'http://localhost:3000',
    deviceId: 'device-fixture',
    linkedAt: '2026-08-26T10:00:00.000Z',
    token: 'device-token',
    version: 1,
  })
  return homeDirectory
}

describe('managed skill installs', () => {
  it('refuses an unmanaged existing skill without changing either coding-agent directory', async () => {
    const homeDirectory = await linkedHome('trce-existing-add-')
    const existingSkill = join(homeDirectory, '.claude', 'skills', 'review-helper')
    await mkdir(existingSkill, { recursive: true })
    await writeFile(join(existingSkill, 'SKILL.md'), 'Existing personal copy.\n')

    const result = await runCli(['add', 'acme/skills:catalog/review-helper', '--dry-run'], {
      homeDirectory,
      loadSkillSource: loader(),
      now: new Date('2026-08-26T10:00:00Z'),
    })

    expect(result).toEqual({
      exitCode: 1,
      stderr: 'review-helper is already installed outside trce. Nothing changed.\n',
      stdout: '',
    })
    await expect(readFile(join(existingSkill, 'SKILL.md'), 'utf8')).resolves.toBe(
      'Existing personal copy.\n',
    )
    await expect(
      access(join(homeDirectory, '.agents', 'skills', 'review-helper')),
    ).rejects.toThrow()
    expect((await readInstallManifest(homeDirectory)).installs).toEqual([])
  })

  it('installs privately by default and removes to a recoverable local trash path', async () => {
    const homeDirectory = await linkedHome('trce-add-')
    const context = {
      homeDirectory,
      loadSkillSource: loader(),
      now: new Date('2026-08-26T10:00:00Z'),
    }

    const added = await runCli(['add', 'acme/skills:catalog/review-helper'], context)

    expect(added).toMatchObject({ exitCode: 0, stderr: '' })
    expect(added.stdout).toContain('Installed review-helper for Claude Code and Codex · Personal')
    await expect(
      readFile(join(homeDirectory, '.claude', 'skills', 'review-helper', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Reviews a change')
    await expect(
      readFile(join(homeDirectory, '.agents', 'skills', 'review-helper', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Reviews a change')
    const inventory = await scanInventory({ homeDirectory })
    expect(inventory).toHaveLength(3)
    expect(inventory.every((skill) => skill.provenance === null)).toBe(true)

    const removed = await runCli(['remove', 'review-helper'], context)

    expect(removed.stdout).toContain('Removed review-helper. Recovery copy: ~/.trce/')
    expect(removed.stdout).not.toContain(homeDirectory)
    await expect(
      access(join(homeDirectory, '.claude', 'skills', 'review-helper')),
    ).rejects.toThrow()
    expect((await readInstallManifest(homeDirectory)).installs).toEqual([])
    const trash = removed.stdout
      .trim()
      .replace('Removed review-helper. Recovery copy: ', '')
      .replace('~', homeDirectory)
    await expect(readFile(join(trash, 'claude-code', 'SKILL.md'), 'utf8')).resolves.toContain(
      'review-helper',
    )
  })

  it('refuses Cursor installs before the gate and before any network or source read', async () => {
    const homeDirectory = await linkedHome('trce-cursor-add-')
    const refusal = {
      exitCode: 1,
      stderr: 'Cursor installs are not available yet. Use --harness claude or --harness codex.\n',
      stdout: '',
    }
    let loads = 0
    let fetchCalls = 0
    const context = {
      fetch: (async () => {
        fetchCalls += 1
        throw new Error('Cursor refusal must not contact the server')
      }) as typeof globalThis.fetch,
      loadSkillSource: async () => {
        loads += 1
        return loader()()
      },
    }

    await expect(
      runCli(['add', 'acme/skills:catalog/review-helper', '--harness', 'cursor'], {
        ...context,
        homeDirectory,
      }),
    ).resolves.toEqual(refusal)
    await expect(
      runCli(
        ['add', 'acme/skills:catalog/review-helper', '--shared', '--harness', 'cursor-agent'],
        {
          ...context,
          homeDirectory,
        },
      ),
    ).resolves.toEqual(refusal)
    await expect(
      runCli(['add', 'acme/skills:catalog/review-helper', '--harness', 'cursor'], {
        ...context,
        homeDirectory: await temporaryHome('trce-cursor-unlinked-'),
      }),
    ).resolves.toEqual(refusal)
    expect(loads).toBe(0)
    expect(fetchCalls).toBe(0)
  })

  it('marks provenance only when the linked team declares a catalog repository', async () => {
    const homeDirectory = await linkedHome('trce-catalog-')
    const configFile = join(homeDirectory, '.trce', 'config.json')
    await mkdir(join(homeDirectory, '.trce'), { recursive: true })
    await writeFile(
      configFile,
      JSON.stringify({
        baseUrl: 'http://localhost:3000',
        deviceId: 'device-fixture',
        linkedAt: '2026-08-26T10:00:00.000Z',
        token: 'device-token',
        version: 1,
      }),
    )
    const fetch = (async (input: string | URL | Request) =>
      String(input).endsWith('/api/device/scope')
        ? Response.json({
            catalogRepositories: ['acme/skills'],
            repositories: ['acme/app', 'acme/skills'],
            version: 'team-repositories@1',
          })
        : Response.json({
            batchId: 'batch-1',
            invocations: 0,
            sessions: 0,
            skills: 1,
          })) as typeof globalThis.fetch

    const added = await runCli(
      ['add', 'acme/skills:catalog/review-helper', '--shared', '--harness', 'codex'],
      { configFile, fetch, homeDirectory, loadSkillSource: loader() },
    )

    expect(added.stdout).toContain('· Shared')
    expect((await readInstallManifest(homeDirectory)).pendingEvents).toEqual([
      expect.objectContaining({
        kind: 'installed',
        name: 'review-helper',
        sourceRepo: 'acme/skills',
      }),
    ])
    const [skill] = await scanInventory({ homeDirectory })
    expect(skill?.provenance).toEqual({
      kind: 'team_catalog',
      path: 'catalog/review-helper',
      ref: 'abc123',
      repository: 'acme/skills',
    })

    const pushed = await runCli(['push'], {
      configFile,
      fetch,
      homeDirectory,
      now: new Date('2026-08-26T10:05:00Z'),
    })
    expect(pushed).toMatchObject({ exitCode: 0 })
    expect((await readInstallManifest(homeDirectory)).pendingEvents).toEqual([])
  })

  it('uses linked-device GitHub access for Shared add and update without gh auth', async () => {
    const homeDirectory = await linkedHome('trce-linked-catalog-')
    let credentialRequests = 0
    const statuses: string[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.endsWith('/api/device/scope')) {
        return Response.json({
          catalogRepositories: ['acme/skills'],
          repositories: ['acme/skills'],
          version: 'team-repositories@1',
        })
      }
      if (request.url.endsWith('/api/device/catalog-access')) {
        credentialRequests += 1
        expect(request.headers.get('authorization')).toBe('Bearer device-token')
        expect(await request.json()).toEqual({ repository: 'acme/skills' })
        return Response.json({
          github: {
            apiUrl: 'https://api.github.com',
            expiresAt: '2026-09-02T11:00:00.000Z',
            token: 'installation-secret',
          },
          kind: 'ready',
          repository: 'acme/skills',
        })
      }
      expect(request.headers.get('authorization')).toBe('Bearer installation-secret')
      if (request.url.endsWith('/repos/acme/skills/commits/main')) {
        return Response.json({ commit: { tree: { sha: 'tree-one' } }, sha: 'commit-one' })
      }
      if (request.url.endsWith('/repos/acme/skills/git/trees/tree-one?recursive=1')) {
        return Response.json({
          tree: [
            {
              mode: '100644',
              path: 'catalog/review-helper/SKILL.md',
              sha: 'blob-one',
              size: Buffer.byteLength(skillMd),
              type: 'blob',
            },
          ],
          truncated: false,
        })
      }
      if (request.url.endsWith('/repos/acme/skills/git/blobs/blob-one')) {
        return Response.json({
          content: Buffer.from(skillMd).toString('base64'),
          encoding: 'base64',
        })
      }
      return new Response(null, { status: 404 })
    }) as typeof globalThis.fetch

    const added = await runCli(
      [
        'add',
        'acme/skills:catalog/review-helper',
        '--ref',
        'main',
        '--shared',
        '--harness',
        'codex',
      ],
      { fetch, homeDirectory, onStatus: (status) => statuses.push(String(status)) },
    )
    const updated = await runCli(['update', 'review-helper', '--dry-run'], {
      fetch,
      homeDirectory,
      onStatus: (status) => statuses.push(String(status)),
    })

    expect(added).toMatchObject({ exitCode: 0, stderr: '' })
    expect(added.stdout).toContain('Installed review-helper for Codex · Shared')
    expect(updated).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: 'review-helper is already current.\n',
    })
    expect(credentialRequests).toBe(2)
    expect(statuses).toEqual([
      'Checking team access…',
      'Getting repository access…',
      'Downloading skill…',
      'Getting repository access…',
      'Downloading skill…',
    ])
  })

  it('keeps dry runs non-mutating and refuses to overwrite local edits during update', async () => {
    const homeDirectory = await linkedHome('trce-update-')
    const baseContext = { homeDirectory, loadSkillSource: loader() }
    await runCli(['add', 'acme/skills:catalog/review-helper', '--harness', 'codex'], baseContext)
    const target = join(homeDirectory, '.agents', 'skills', 'review-helper', 'SKILL.md')
    await writeFile(target, `${skillMd}\nlocal edit\n`)

    const updated = await runCli(['update', 'review-helper'], {
      ...baseContext,
      loadSkillSource: loader(`${skillMd}\nupstream edit\n`),
    })
    expect(updated).toMatchObject({ exitCode: 1 })
    expect(updated.stderr).toContain('has local changes; update stopped')
    await expect(readFile(target, 'utf8')).resolves.toContain('local edit')

    const otherHome = await linkedHome('trce-dry-run-')
    const dryRun = await runCli(['add', 'acme/skills:catalog/review-helper', '--dry-run'], {
      homeDirectory: otherHome,
      loadSkillSource: loader(),
    })
    expect(dryRun.stdout).toContain('Would install')
    expect((await readInstallManifest(otherHome)).installs).toEqual([])
  })

  const updateCases = [false, true].flatMap((dryRun) =>
    [false, true].map((upstreamChanged) => ({ dryRun, upstreamChanged })),
  )

  it.each(updateCases)(
    'refuses edited targets with dryRun=$dryRun and upstreamChanged=$upstreamChanged',
    async ({ dryRun, upstreamChanged }) => {
      const homeDirectory = await linkedHome('trce-update-edited-')
      await runCli(['add', 'acme/skills:catalog/review-helper'], {
        homeDirectory,
        loadSkillSource: loader(),
      })
      const claude = join(homeDirectory, '.claude/skills/review-helper/SKILL.md')
      const codex = join(homeDirectory, '.agents/skills/review-helper/SKILL.md')
      // Edit the second target so an earlier target cannot be changed before validation finishes.
      await writeFile(codex, `${skillMd}\nLocal edit must survive.\n`)
      const manifestPath = join(homeDirectory, '.trce/installs.json')
      const before = await Promise.all([claude, codex, manifestPath].map((path) => readFile(path)))

      const result = await runCli(['update', 'review-helper', ...(dryRun ? ['--dry-run'] : [])], {
        homeDirectory,
        loadSkillSource: loader(upstreamChanged ? `${skillMd}\nUpstream change.\n` : skillMd),
      })

      expect(result).toEqual({
        exitCode: 1,
        stderr: 'review-helper has local changes; update stopped without changing files\n',
        stdout: '',
      })
      expect(
        await Promise.all([claude, codex, manifestPath].map((path) => readFile(path))),
      ).toEqual(before)
    },
  )

  it.each(updateCases)(
    'refuses missing targets with dryRun=$dryRun and upstreamChanged=$upstreamChanged',
    async ({ dryRun, upstreamChanged }) => {
      const homeDirectory = await linkedHome('trce-update-missing-')
      await runCli(['add', 'acme/skills:catalog/review-helper'], {
        homeDirectory,
        loadSkillSource: loader(),
      })
      const codexRoot = join(homeDirectory, '.agents/skills/review-helper')
      const backupRoot = `${codexRoot}.test-backup`
      await rename(codexRoot, backupRoot)
      const preserved = [
        join(homeDirectory, '.claude/skills/review-helper/SKILL.md'),
        join(backupRoot, 'SKILL.md'),
        join(homeDirectory, '.trce/installs.json'),
      ]
      const before = await Promise.all(preserved.map((path) => readFile(path)))

      const result = await runCli(['update', 'review-helper', ...(dryRun ? ['--dry-run'] : [])], {
        homeDirectory,
        loadSkillSource: loader(upstreamChanged ? `${skillMd}\nUpstream change.\n` : skillMd),
      })

      expect(result).toEqual({
        exitCode: 1,
        stderr: `${codexRoot} is missing; reinstall instead of updating\n`,
        stdout: '',
      })
      await expect(access(codexRoot)).rejects.toThrow()
      expect(await Promise.all(preserved.map((path) => readFile(path)))).toEqual(before)
    },
  )

  it('fails closed when the managed-install manifest is damaged', async () => {
    const homeDirectory = await linkedHome('trce-damaged-manifest-')
    await mkdir(join(homeDirectory, '.trce'), { recursive: true })
    await writeFile(join(homeDirectory, '.trce', 'installs.json'), '{not-json', 'utf8')

    const result = await runCli(['add', 'acme/skills:catalog/review-helper'], {
      homeDirectory,
      loadSkillSource: loader(),
    })

    expect(result).toMatchObject({ exitCode: 1 })
    expect(result.stderr).toMatch(/^Could not read .*installs\.json\. Nothing changed\.\n$/u)
    await expect(
      access(join(homeDirectory, '.claude', 'skills', 'review-helper')),
    ).rejects.toThrow()
  })

  it('keeps the requested ref for updates and records the exact resolved revision', async () => {
    const homeDirectory = await linkedHome('trce-ref-')
    const baseContext = {
      homeDirectory,
      loadSkillSource: loader(skillMd, 'commit-one'),
      now: new Date('2026-08-26T10:00:00Z'),
    }
    await runCli(
      ['add', 'acme/skills:catalog/review-helper', '--ref', 'main', '--harness', 'codex'],
      baseContext,
    )

    const before = (await readInstallManifest(homeDirectory)).installs[0]
    expect(before?.source).toMatchObject({ ref: 'main', resolvedRef: 'commit-one' })

    const updated = await runCli(['update', 'review-helper'], {
      ...baseContext,
      loadSkillSource: loader(`${skillMd}\nUpstream change.\n`, 'commit-two'),
      now: new Date('2026-08-26T11:00:00Z'),
    })

    expect(updated).toMatchObject({ exitCode: 0 })
    const after = (await readInstallManifest(homeDirectory)).installs[0]
    expect(after?.source).toMatchObject({ ref: 'main', resolvedRef: 'commit-two' })
    await expect(
      readFile(join(homeDirectory, '.agents', 'skills', 'review-helper', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Upstream change')
  })
})

describe('managed install safety', () => {
  async function request(name: string, homeDirectory: string): Promise<InstallRequest> {
    return {
      distribution: 'team_catalog',
      dryRun: false,
      harnesses: ['codex'],
      homeDirectory,
      loadSource: loader(skillMd.replace('review-helper', name)),
      now: new Date('2026-08-26T10:00:00Z'),
      source: { path: `skills/${name}`, ref: 'HEAD', repository: 'acme/skills' },
    }
  }

  it.skipIf(process.platform === 'win32')(
    'applies upstream mode-only updates and protects local chmod edits',
    async () => {
      const home = await temporaryHome('trce-install-modes-')
      const original = await request('review-helper', home)
      await installCatalogSkill(original)
      const source = await loader()()
      const noExecutable = {
        ...source,
        files: source.files.map((file) => ({ ...file, executable: false })),
      }
      const input = {
        dryRun: false,
        homeDirectory: home,
        loadSource: async () => noExecutable,
        name: 'review-helper',
        now: new Date('2026-08-26T11:00:00Z'),
      }
      const updated = await updateCatalogSkill(input)
      expect(updated.changed).toBe(true)
      const script = join(home, '.agents', 'skills', 'review-helper', 'scripts', 'check.sh')
      expect((await stat(script)).mode & 0o111).toBe(0)
      await chmod(script, 0o755)
      for (const dryRun of [true, false]) {
        await expect(updateCatalogSkill({ ...input, dryRun })).rejects.toThrow('local changes')
      }
      expect((await stat(script)).mode & 0o111).toBe(0o111)
    },
  )

  it('refuses overlapping installs and preserves both records after retry', async () => {
    const home = await temporaryHome('trce-install-race-')
    const first = await request('first', home)
    const second = await request('second', home)
    await installCatalogSkill({
      ...first,
      loadSource: async (source) => {
        // The first transaction is definitely still open, independent of filesystem timing.
        await expect(installCatalogSkill(second)).rejects.toThrow('locked')
        return first.loadSource(source)
      },
    })
    await installCatalogSkill(second)
    const manifest = await readInstallManifest(home)
    expect(manifest.installs.map((install) => install.name).sort()).toEqual(['first', 'second'])
    expect(manifest.pendingEvents).toHaveLength(2)
    await expect(access(join(home, '.trce', 'installs.lock'))).rejects.toThrow()
  })

  it('shares the lock with updates, removals, and background event acknowledgements', async () => {
    const home = await temporaryHome('trce-install-lock-')
    const install = await request('review-helper', home)
    await installCatalogSkill(install)
    const before = await readInstallManifest(home)
    const input = { dryRun: false, homeDirectory: home, name: 'review-helper', now: install.now }
    const eventIds = new Set(before.pendingEvents.map((event) => event.id))
    await withInstallLock(home, async () => {
      await expect(updateCatalogSkill({ ...input, loadSource: loader() })).rejects.toThrow('locked')
      await expect(removeCatalogSkill(input)).rejects.toThrow('locked')
      await expect(clearInstallEvents(home, eventIds)).rejects.toThrow('locked')
      expect(await readInstallManifest(home)).toEqual(before)
    })
    await clearInstallEvents(home, eventIds)
    expect((await readInstallManifest(home)).installs).toEqual(before.installs)
    expect((await readInstallManifest(home)).pendingEvents).toEqual([])
  })

  it('releases after a failure and keeps dry runs free of lock-file writes', async () => {
    const home = await temporaryHome('trce-install-lock-cleanup-')
    const input = await request('review-helper', home)
    await installCatalogSkill({ ...input, dryRun: true })
    await expect(access(join(home, '.trce'))).rejects.toThrow()
    await expect(
      installCatalogSkill({
        ...input,
        loadSource: async () => {
          throw new Error('fixture failure')
        },
      }),
    ).rejects.toThrow('fixture failure')
    await expect(access(join(home, '.trce', 'installs.lock'))).rejects.toThrow()
    await expect(installCatalogSkill(input)).resolves.toMatchObject({ name: 'review-helper' })
  })

  it('cleans the first staged copy when staging the second agent fails', async () => {
    const home = await temporaryHome('trce-install-staging-')
    const input = await request('review-helper', home)
    await writeFile(join(home, '.agents'), 'blocks the second install directory')
    await expect(
      installCatalogSkill({ ...input, harnesses: ['claude-code', 'codex'] }),
    ).rejects.toThrow()
    expect(await readdir(join(home, '.claude', 'skills'))).toEqual([])
    expect((await readInstallManifest(home)).installs).toEqual([])
    await expect(access(join(home, '.trce', 'installs.lock'))).rejects.toThrow()
  })

  it('keeps unverified install records removable but refuses to guess their original permissions', async () => {
    const home = await temporaryHome('trce-install-no-mode-record-')
    const input = await request('review-helper', home)
    await installCatalogSkill(input)
    const manifest = await readInstallManifest(home)
    for (const install of manifest.installs) delete install.modeFingerprint
    await writeInstallManifest(home, manifest)
    const operation = { dryRun: false, homeDirectory: home, name: 'review-helper', now: input.now }
    await expect(updateCatalogSkill({ ...operation, loadSource: loader() })).rejects.toThrow(
      'no executable-mode record',
    )
    await expect(removeCatalogSkill(operation)).resolves.toMatchObject({
      install: { name: 'review-helper' },
    })
  })
})

describe('catalog fingerprints', () => {
  const dryRun = async (files: Array<{ contents: string; executable: boolean; path: string }>) =>
    installCatalogSkill({
      distribution: 'private',
      dryRun: true,
      harnesses: ['codex'],
      homeDirectory: await temporaryHome('trce-fingerprint-'),
      loadSource: async () => ({
        files: files.map((file) => ({
          ...file,
          contents: Uint8Array.from(Buffer.from(file.contents)),
        })),
        resolvedRef: 'abc123',
      }),
      now: new Date('2026-08-26T10:00:00Z'),
      source: { path: 'catalog/review-helper', ref: 'HEAD', repository: 'acme/skills' },
    })
  const lfFiles = [
    { contents: skillMd, executable: false, path: 'SKILL.md' },
    { contents: '#!/bin/sh\nexit 0\n', executable: true, path: 'scripts/check.sh' },
    { contents: 'zed\n', executable: false, path: 'Zed.md' },
  ]

  it('matches the inventory fingerprint and ignores file order and CRLF', async () => {
    const crlfFiles = lfFiles.map((file) => ({
      ...file,
      contents: file.contents.replaceAll('\n', '\r\n'),
    }))

    const lf = await dryRun(lfFiles)
    const shuffled = await dryRun(lfFiles.toReversed())
    const crlf = await dryRun(crlfFiles)

    expect(lf.fingerprint).toBe(
      fingerprintSkillFiles(
        lfFiles.map((file) => ({ contents: Buffer.from(file.contents), path: file.path })),
      ),
    )
    expect(shuffled.fingerprint).toBe(lf.fingerprint)
    expect(crlf.fingerprint).toBe(lf.fingerprint)
  })
})

describe('GitHub App catalog loading', () => {
  it('downloads a Shared skill directly with an in-memory read credential', async () => {
    const requests: Request[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith('/repos/acme/skills/commits/main')) {
        return Response.json({ commit: { tree: { sha: 'tree-one' } }, sha: 'commit-one' })
      }
      if (request.url.endsWith('/repos/acme/skills/git/trees/tree-one?recursive=1')) {
        return Response.json({
          tree: [
            {
              mode: '100644',
              path: 'catalog/review-helper/SKILL.md',
              sha: 'blob-one',
              size: Buffer.byteLength(skillMd),
              type: 'blob',
            },
          ],
          truncated: false,
        })
      }
      if (request.url.endsWith('/repos/acme/skills/git/blobs/blob-one')) {
        return Response.json({
          content: Buffer.from(skillMd).toString('base64'),
          encoding: 'base64',
        })
      }
      return new Response(null, { status: 404 })
    }) as typeof globalThis.fetch

    const loaded = await loadGitHubSkillSourceWithCredential({
      credential: {
        apiUrl: 'https://api.github.com',
        expiresAt: '2026-09-02T11:00:00.000Z',
        token: 'installation-secret',
      },
      fetch,
      source: { path: 'catalog/review-helper', ref: 'main', repository: 'acme/skills' },
    })

    expect(loaded.resolvedRef).toBe('commit-one')
    expect(Buffer.from(loaded.files[0]?.contents ?? []).toString('utf8')).toBe(skillMd)
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBe('Bearer installation-secret')
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28')
    }
  })

  it('does not expose the read credential when GitHub refuses a request', async () => {
    const result = await loadGitHubSkillSourceWithCredential({
      credential: {
        apiUrl: 'https://api.github.com',
        expiresAt: '2026-09-02T11:00:00.000Z',
        token: 'installation-secret',
      },
      fetch: (async () => new Response('provider secret details', { status: 403 })) as typeof fetch,
      source: { path: 'catalog/review-helper', ref: 'main', repository: 'acme/skills' },
    }).catch((error: unknown) => String(error))

    expect(result).toContain('Could not read the Shared skill from GitHub')
    expect(result).not.toContain('installation-secret')
    expect(result).not.toContain('provider secret details')
  })
})
