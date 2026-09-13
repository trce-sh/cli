import { describe, expect, it, vi } from 'vitest'
import { requestInit } from './http.js'
import { withTransientRetry } from './retry.js'

describe('transient retry', () => {
  it.each([
    { code: 'EAI_AGAIN', attempts: 2 },
    { code: 'ENOTFOUND', attempts: 1 },
  ])('retries DNS failure $code only when temporary', async ({ code, attempts }) => {
    const underlying = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code } })
    })
    await expect(
      withTransientRetry(underlying, async () => undefined)('https://example.test'),
    ).rejects.toThrow('fetch failed')
    expect(underlying).toHaveBeenCalledTimes(attempts)
  })

  it('renews the owned deadline and preserves the exact body, headers, and redirect policy', async () => {
    const original = requestInit(
      { body: '{"synthetic":true}', method: 'POST', headers: { authorization: 'Bearer fixture' } },
      { bearer: true, timeoutMs: 5 },
    )
    const seen: (RequestInit | undefined)[] = []
    const fetch = withTransientRetry(
      async (_input, init) => {
        seen.push(init)
        if (seen.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new DOMException('Deadline', 'TimeoutError')
        }
        expect(init?.signal?.aborted).toBe(false)
        return new Response('ok')
      },
      async () => undefined,
    )
    await fetch('https://example.test', original)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
      body: original.body,
      headers: original.headers,
      redirect: 'error',
    })
    expect(seen[1]?.signal).not.toBe(original.signal)
  })

  it.each(['unexpected redirect', 'certificate has expired', 'Failed to parse URL'])(
    'does not retry %s',
    async (message) => {
      const underlying = vi.fn(async () => {
        throw new TypeError(message)
      })
      const sleep = vi.fn(async () => undefined)
      await expect(withTransientRetry(underlying, sleep)('https://example.test')).rejects.toThrow(
        message,
      )
      expect(underlying).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    },
  )

  it('does not renew an explicit caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const underlying = vi.fn(async () => {
      throw new DOMException('Cancelled', 'AbortError')
    })
    await expect(
      withTransientRetry(underlying, async () => undefined)('https://example.test', {
        signal: controller.signal,
      }),
    ).rejects.toThrow('Cancelled')
    expect(underlying).toHaveBeenCalledTimes(1)
  })
})
