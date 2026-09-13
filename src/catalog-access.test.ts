import { describe, expect, it } from 'vitest'
import { fetchCatalogCredential } from './catalog-access.js'
import type { LinkedConfig } from './config.js'

const config: LinkedConfig = {
  baseUrl: 'http://localhost:3000',
  deviceId: 'device-fixture',
  linkedAt: '2026-09-02T10:00:00.000Z',
  token: 'device-secret',
  version: 1,
}

describe('Shared catalog access', () => {
  it('requests one repository-scoped credential with the linked device token', async () => {
    const requests: Array<{ body: string | null; headers: Headers; url: string }> = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push({ body: await request.text(), headers: request.headers, url: request.url })
      return Response.json({
        github: {
          apiUrl: 'https://api.github.com',
          expiresAt: '2026-09-02T11:00:00.000Z',
          token: 'installation-secret',
        },
        kind: 'ready',
        repository: 'acme/skills',
      })
    }) as typeof globalThis.fetch

    await expect(fetchCatalogCredential(config, 'acme/skills', fetch)).resolves.toEqual({
      apiUrl: 'https://api.github.com',
      expiresAt: '2026-09-02T11:00:00.000Z',
      token: 'installation-secret',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://localhost:3000/api/device/catalog-access')
    expect(requests[0]?.body).toBe('{"repository":"acme/skills"}')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer device-secret')
  })

  it('rejects malformed responses and never exposes credential material in errors', async () => {
    const invalid = await fetchCatalogCredential(config, 'acme/skills', (async () =>
      Response.json({
        github: {
          apiUrl: 'https://evil.example',
          expiresAt: '2026-09-02T11:00:00.000Z',
          token: 'installation-secret',
        },
        kind: 'ready',
        repository: 'acme/skills',
      })) as typeof globalThis.fetch).catch((error: unknown) => String(error))

    expect(invalid).toContain('invalid Shared install access')
    expect(invalid).not.toContain('installation-secret')
  })
})
