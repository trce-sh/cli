import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  claimLaptopAction,
  isUnderKnownSkillRoot,
  type LaptopActionPlan,
} from './device-actions.js'
import { openLaptopPullRequest } from './github-pull-request.js'
import type { LocalSkillFile } from './local-skill-source.js'

const files: LocalSkillFile[] = [
  {
    contents: Uint8Array.from(Buffer.from('---\nname: demo\n---\nDo the work.\n')),
    executable: false,
    path: 'SKILL.md',
  },
  {
    contents: Uint8Array.from(Buffer.from('#!/bin/sh\nexit 0\n')),
    executable: true,
    path: 'scripts/check.sh',
  },
]

function action(target: LaptopActionPlan['targets'][number]): LaptopActionPlan {
  return {
    actionId: 'action-1',
    base: 'main',
    body: 'Reviewed.\n\n<!-- trce-action:action-1 -->',
    command: 'promote',
    head: 'trce/promote-demo-action-1',
    repository: 'acme/app',
    skillFingerprint: 'a'.repeat(64),
    skillName: 'demo',
    targets: [target],
    title: 'Add demo',
  }
}

const github = {
  apiUrl: 'https://api.github.com' as const,
  expiresAt: '2099-01-01T00:00:00.000Z',
  token: 'installation-secret',
}

describe('direct GitHub pull request writer', () => {
  it.each(['scripts/check.sh', 'notes.txt'])(
    'refuses to replace or delete unreviewed auxiliary file %s before upload',
    async (relativePath) => {
      let writes = 0
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = String(input)
        if (init?.method === 'POST') writes += 1
        if (url.endsWith('/git/ref/heads/trce/promote-demo-action-1'))
          return new Response(null, { status: 404 })
        if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'base' } })
        if (url.endsWith('/git/commits/base'))
          return Response.json({ parents: [], tree: { sha: 'base-tree' } })
        if (url.endsWith('/git/trees/base-tree?recursive=1'))
          return Response.json({
            truncated: false,
            tree: [
              {
                mode: '100644',
                path: '.agents/skills/demo/SKILL.md',
                sha: 'skill-blob',
                type: 'blob',
              },
              {
                mode: '100644',
                path: `.agents/skills/demo/${relativePath}`,
                sha: 'changed-auxiliary-blob',
                type: 'blob',
              },
            ],
          })
        throw new Error(`Unexpected request: ${url}`)
      }
      await expect(
        openLaptopPullRequest({
          action: action({ expectedSkillMdHash: 'a'.repeat(64), path: '.agents/skills/demo' }),
          fetch,
          files,
          github,
        }),
      ).rejects.toThrow('full-directory review is required')
      expect(writes).toBe(0)
    },
  )
  it('uploads the full local directory directly to GitHub with file modes intact', async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = []
    let blob = 0
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null
      requests.push({ body, method, url })
      if (url.endsWith('/git/ref/heads/trce/promote-demo-action-1')) {
        return new Response(null, { status: 404 })
      }
      if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'base' } })
      if (url.endsWith('/git/commits/base')) {
        return Response.json({ parents: [], tree: { sha: 'base-tree' } })
      }
      if (url.endsWith('/git/trees/base-tree?recursive=1')) {
        return Response.json({ tree: [], truncated: false })
      }
      if (url.endsWith('/git/blobs')) {
        blob += 1
        return Response.json({ sha: `blob-${blob}` })
      }
      if (url.endsWith('/git/trees')) return Response.json({ sha: 'desired-tree' })
      if (url.endsWith('/git/commits')) return Response.json({ sha: 'head-sha' })
      if (url.endsWith('/git/refs')) return Response.json({ ref: 'created' })
      if (url.endsWith('/pulls')) {
        return Response.json({ html_url: 'https://github.test/acme/app/pull/7', number: 7 })
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url}`)
    }

    const result = await openLaptopPullRequest({
      action: action({ expectedSkillMdHash: null, path: '.agents/skills/demo' }),
      fetch,
      files,
      github,
    })

    expect(result).toEqual({ number: 7, url: 'https://github.test/acme/app/pull/7' })
    const treeRequest = requests.find((request) => request.url.endsWith('/git/trees'))
    expect(treeRequest?.body).toEqual({
      base_tree: 'base-tree',
      tree: [
        {
          mode: '100644',
          path: '.agents/skills/demo/SKILL.md',
          sha: 'blob-1',
          type: 'blob',
        },
        {
          mode: '100755',
          path: '.agents/skills/demo/scripts/check.sh',
          sha: 'blob-2',
          type: 'blob',
        },
      ],
    })
    const blobBodies = requests
      .filter((request) => request.url.endsWith('/git/blobs'))
      .map((request) => request.body)
    expect(blobBodies).toEqual([
      { content: Buffer.from(files[0]?.contents ?? []).toString('base64'), encoding: 'base64' },
      { content: Buffer.from(files[1]?.contents ?? []).toString('base64'), encoding: 'base64' },
    ])
  })

  it('refuses a destination outside the known skill roots before any request', async () => {
    let requests = 0
    const fetch = (async () => {
      requests += 1
      return Response.json({})
    }) as typeof globalThis.fetch
    for (const path of ['README.md', 'src/skills/demo', '.github/workflows/demo', 'skills']) {
      await expect(
        openLaptopPullRequest({
          action: action({ expectedSkillMdHash: null, path }),
          fetch,
          files,
          github,
        }),
      ).rejects.toThrow(
        `Refusing to write ${path}: reviewed actions only write under .claude/skills/, .agents/skills/, .codex/skills/, .trce/skills/, skills/. Nothing changed.`,
      )
    }
    expect(requests).toBe(0)
  })

  it('stops before writing when a reviewed repository version changed', async () => {
    const oldSkill = Buffer.from('old skill')
    let writes = 0
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') writes += 1
      if (url.endsWith('/git/ref/heads/trce/promote-demo-action-1')) {
        return new Response(null, { status: 404 })
      }
      if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'base' } })
      if (url.endsWith('/git/commits/base')) {
        return Response.json({ parents: [], tree: { sha: 'base-tree' } })
      }
      if (url.endsWith('/git/trees/base-tree?recursive=1')) {
        return Response.json({
          tree: [
            {
              mode: '100644',
              path: '.agents/skills/demo/SKILL.md',
              sha: 'old-blob',
              type: 'blob',
            },
          ],
          truncated: false,
        })
      }
      if (url.endsWith('/git/blobs/old-blob')) {
        return Response.json({ content: oldSkill.toString('base64'), encoding: 'base64' })
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    }

    await expect(
      openLaptopPullRequest({
        action: action({
          expectedSkillMdHash: createHash('sha256').update('different').digest('hex'),
          path: '.agents/skills/demo',
        }),
        fetch,
        files,
        github,
      }),
    ).rejects.toThrow('A reviewed repository copy changed')
    expect(writes).toBe(0)
  })

  it('recovers only the reviewed pull request when an action is retried', async () => {
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/git/ref/heads/trce/promote-demo-action-1')) {
        return Response.json({ object: { sha: 'existing-head' } })
      }
      if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'base' } })
      if (url.endsWith('/git/commits/base')) {
        return Response.json({ parents: [], tree: { sha: 'base-tree' } })
      }
      if (url.endsWith('/git/trees/base-tree?recursive=1')) {
        return Response.json({ tree: [], truncated: false })
      }
      if (url.endsWith('/git/blobs')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
        return Response.json({ sha: body?.content === 'LS0t' ? 'unexpected' : 'blob' })
      }
      if (url.endsWith('/git/trees')) return Response.json({ sha: 'desired-tree' })
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        return Response.json({ sha: 'unused-head' })
      }
      if (url.endsWith('/git/commits/existing-head')) {
        return Response.json({ parents: [{ sha: 'base' }], tree: { sha: 'desired-tree' } })
      }
      if (url.endsWith('/pulls') && init?.method === 'POST') {
        return Response.json({}, { status: 422 })
      }
      if (url.includes('/pulls?')) {
        return Response.json([
          {
            base: { ref: 'main' },
            body: 'unrelated',
            head: { ref: 'trce/promote-demo-action-1' },
            html_url: 'https://github.test/acme/app/pull/6',
            number: 6,
          },
          {
            base: { ref: 'main' },
            body: 'Reviewed.\n\n<!-- trce-action:action-1 -->',
            head: { ref: 'trce/promote-demo-action-1' },
            html_url: 'https://github.test/acme/app/pull/7',
            number: 7,
          },
        ])
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    }

    await expect(
      openLaptopPullRequest({
        action: action({ expectedSkillMdHash: null, path: '.agents/skills/demo' }),
        fetch,
        files,
        github,
      }),
    ).resolves.toEqual({ number: 7, url: 'https://github.test/acme/app/pull/7' })
  })
})

describe('reviewed action targets', () => {
  const config = {
    baseUrl: 'http://localhost:3000',
    deviceId: 'device-fixture',
    linkedAt: '2026-08-20T11:00:00.000Z',
    token: 'device-secret',
    version: 1 as const,
  }
  const plan = (path: string) => ({
    action: {
      actionId: 'action-1',
      base: 'main',
      body: 'Reviewed.',
      command: 'promote',
      head: 'trce/promote-demo-action-1',
      repository: 'acme/app',
      skillFingerprint: 'a'.repeat(64),
      skillName: 'demo',
      targets: [{ expectedSkillMdHash: null, path }],
      title: 'Add demo',
    },
    github,
    kind: 'ready',
  })

  it('accepts only destinations under a known skill root when claiming', async () => {
    const claimWith = (path: string) =>
      claimLaptopAction(config, 'action-1', (async () =>
        Response.json(plan(path))) as typeof globalThis.fetch)

    await expect(claimWith('.claude/skills/demo')).resolves.toMatchObject({ kind: 'ready' })
    await expect(claimWith('skills/demo')).resolves.toMatchObject({ kind: 'ready' })
    await expect(claimWith('docs/demo')).rejects.toThrow('Refusing to write docs/demo')
    await expect(claimWith('skills/')).rejects.toThrow('Dashboard returned an invalid action')
    expect(isUnderKnownSkillRoot('.trce/skills/x')).toBe(true)
    expect(isUnderKnownSkillRoot('.claude/skills/')).toBe(false)
    expect(isUnderKnownSkillRoot('my-skills/x')).toBe(false)
  })
})
