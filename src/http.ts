import { asRecord, stringValue } from './value.js'

/** Every dashboard and GitHub request gives up after this long. Device polling retries later. */
export const requestTimeoutMs = 15_000
const requestTimeouts = new WeakMap<AbortSignal, number>()

/** Only trce-owned deadlines can be renewed; never replace a caller's cancellation signal. */
export function renewRequestDeadline(init: RequestInit | undefined) {
  const timeoutMs = init?.signal ? requestTimeouts.get(init.signal) : undefined
  return timeoutMs === undefined ? init : requestInit({ ...init }, { timeoutMs })
}

export function ownsRequestDeadline(signal: AbortSignal | null | undefined) {
  return signal ? requestTimeouts.has(signal) : false
}

type RequestDefaults = {
  /** Refuse redirects. Required for every request that carries a bearer token. */
  bearer?: boolean
  timeoutMs?: number
}

/**
 * The `RequestInit` every CLI request uses: a hard timeout, and for token-bearing requests a
 * refusal to follow redirects (a redirect would hand the token to whatever host answers).
 */
export function requestInit(init: RequestInit, defaults: RequestDefaults = {}): RequestInit {
  const timeoutMs = defaults.timeoutMs ?? requestTimeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  requestTimeouts.set(signal, timeoutMs)
  return {
    ...init,
    ...(defaults.bearer ? { redirect: 'error' as const } : {}),
    signal,
  }
}

/**
 * One short reason class for a rejected fetch: `connection refused`, `timed out`,
 * `host not found`, `redirect refused`, `TLS error`, or the failure code when nothing else fits.
 * Printed in parentheses after the origin so the user can tell a wrong URL from a down server.
 */
export function describeFetchFailure(error: unknown): string {
  const name = stringValue(property(error, 'name'))
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out'
  const cause = property(error, 'cause')
  const code = stringValue(property(cause, 'code')) ?? stringValue(property(error, 'code'))
  const message = `${stringValue(property(cause, 'message')) ?? ''} ${stringValue(property(error, 'message')) ?? ''}`
  if (code === 'ECONNREFUSED') return 'connection refused'
  if (code === 'ENOTFOUND') return 'host not found'
  if (code === 'EAI_AGAIN') return 'temporary DNS failure'
  if (code === 'ECONNRESET') return 'connection reset'
  if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return 'timed out'
  }
  if (/redirect/iu.test(message)) return 'redirect refused'
  if (code?.startsWith('ERR_TLS') || code?.startsWith('CERT_') || /certificate/iu.test(message)) {
    return 'TLS error'
  }
  if (code) return code
  return 'connection failed'
}

/**
 * Server-provided text is printed only after control characters and terminal escape sequences
 * are stripped, so a hostile or broken dashboard cannot repaint the terminal. Long values are
 * cut; an empty result means "nothing usable".
 */
export function sanitizeServerText(value: unknown, maxLength = 200) {
  const text = stringValue(value)
  if (!text) return null
  const cleaned = stripTerminalControl(text).replaceAll(/\s+/gu, ' ').trim()
  if (!cleaned) return null
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}

const escapeCode = 0x1b
const bell = 0x07
const backslash = 0x5c

/** Drops CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), other `ESC x`, and C0/C1 controls. */
function stripTerminalControl(text: string) {
  let result = ''
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === escapeCode) {
      index = skipEscapeSequence(text, index + 1)
      continue
    }
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f)
    if (!control || code === 0x09 || code === 0x0a || code === 0x0d) result += text[index]
    index += 1
  }
  return result
}

/** `index` points just past an ESC; returns the index just past the sequence it starts. */
function skipEscapeSequence(text: string, index: number) {
  const next = text.charCodeAt(index)
  if (next === 0x5b) {
    // CSI: parameter bytes 0x30–0x3f, intermediate 0x20–0x2f, one final byte 0x40–0x7e.
    let cursor = index + 1
    while (
      cursor < text.length &&
      text.charCodeAt(cursor) >= 0x20 &&
      text.charCodeAt(cursor) <= 0x3f
    ) {
      cursor += 1
    }
    return Math.min(text.length, cursor + 1)
  }
  if (next === 0x5d) {
    // OSC: runs until BEL or ESC \ (string terminator).
    let cursor = index + 1
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor)
      if (code === bell) return cursor + 1
      if (code === escapeCode && text.charCodeAt(cursor + 1) === backslash) return cursor + 2
      cursor += 1
    }
    return cursor
  }
  return Math.min(text.length, index + 1)
}

/** `HTTP 401: invalid_device_token`, or `HTTP 502` when the body carries no usable error. */
export function httpFailure(status: number, body: unknown) {
  const error = sanitizeServerText(asRecord(body)?.error)
  return error ? `HTTP ${status}: ${error}` : `HTTP ${status}`
}

/** Error fields (`message`, `cause`, `code`) are own but not enumerable; read them directly. */
function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

export function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}
