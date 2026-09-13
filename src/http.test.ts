import { describe, expect, it } from 'vitest'
import {
  describeFetchFailure,
  httpFailure,
  originOf,
  requestInit,
  sanitizeServerText,
} from './http.js'

const esc = String.fromCharCode(27)
const bell = String.fromCharCode(7)

describe('request defaults', () => {
  it('times out a hanging request and refuses redirects on token-bearing ones', async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof globalThis.fetch

    const started = Date.now()
    await expect(
      hanging('http://localhost:3000/api/ingest', requestInit({}, { bearer: true, timeoutMs: 20 })),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(Date.now() - started).toBeLessThan(5_000)

    const bearer = requestInit({ method: 'POST' }, { bearer: true })
    expect(bearer.redirect).toBe('error')
    expect(bearer.signal).toBeInstanceOf(AbortSignal)
    const plain = requestInit({ method: 'POST' })
    expect(plain.redirect).toBeUndefined()
    expect(plain.signal).toBeInstanceOf(AbortSignal)
  })

  it('names the failure class of a rejected fetch', () => {
    const withCause = (code: string, message = code) =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })
    expect(describeFetchFailure(withCause('ECONNREFUSED'))).toBe('connection refused')
    expect(describeFetchFailure(withCause('ENOTFOUND'))).toBe('host not found')
    expect(describeFetchFailure(withCause('UND_ERR_CONNECT_TIMEOUT'))).toBe('timed out')
    expect(describeFetchFailure(withCause('ECONNRESET'))).toBe('connection reset')
    expect(describeFetchFailure(withCause('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('TLS error')
    expect(
      describeFetchFailure(
        new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      ),
    ).toBe('redirect refused')
    expect(describeFetchFailure(new DOMException('aborted', 'TimeoutError'))).toBe('timed out')
    expect(describeFetchFailure(new TypeError('fetch failed'))).toBe('connection failed')
    expect(describeFetchFailure('nope')).toBe('connection failed')
  })

  it('strips control characters and escape sequences from server text', () => {
    expect(sanitizeServerText('invalid_device_token')).toBe('invalid_device_token')
    expect(sanitizeServerText(`${esc}[31mred${esc}[0m bell${bell}\r\n  x`)).toBe('red bell x')
    expect(sanitizeServerText(`${esc}]8;;http://evil${bell}link${esc}]8;;${bell}`)).toBe('link')
    expect(sanitizeServerText('')).toBeNull()
    expect(sanitizeServerText(42)).toBeNull()
    expect(sanitizeServerText(`${esc}[2J`)).toBeNull()
    expect(sanitizeServerText('a'.repeat(300))).toBe(`${'a'.repeat(200)}…`)
    expect(httpFailure(401, { error: 'badtoken' })).toBe('HTTP 401: badtoken')
    expect(httpFailure(502, null)).toBe('HTTP 502')
    expect(originOf('http://localhost:3000/api')).toBe('http://localhost:3000')
    expect(originOf('nope')).toBe('nope')
  })
})
