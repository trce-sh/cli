import type { LinkedConfig } from './config.js'
import { normalizedBaseUrl } from './config.js'
import { describeFetchFailure, requestInit, sanitizeServerText } from './http.js'
import { defaultCommandPrefix } from './invocation.js'
import { dashboardUrlEnvVar } from './service.js'
import { asRecord, nonNegativeInteger, stringValue } from './value.js'

type DeviceLinkOptions = {
  baseUrl: string
  /** The command the user typed; printed when the code expires. */
  commandPrefix?: string
  fetch: typeof globalThis.fetch
  label: string
  now: () => number
  onCode: (input: {
    code: string
    label: string
    platform: string
    setupUrl: string
  }) => Promise<void> | void
  platform: string
  sleep: (milliseconds: number) => Promise<void>
}

export function defaultMachineLabel(hostname: string, platform: string) {
  const cleanedHostname = (hostname.trim().split('.', 1)[0] ?? '').slice(0, 120)
  if (cleanedHostname) return cleanedHostname
  if (platform === 'darwin') return 'macOS machine'
  if (platform === 'win32') return 'Windows machine'
  if (platform === 'linux') return 'Linux machine'
  return 'Linked machine'
}

export async function linkDevice(options: DeviceLinkOptions): Promise<LinkedConfig> {
  const baseUrl = normalizedBaseUrl(options.baseUrl)
  if (!baseUrl) throw new Error('The dashboard URL must use http or https')
  const started = await postJson(options.fetch, `${baseUrl}/api/device/start`, {
    label: options.label,
    platform: options.platform,
  })
  const code = stringValue(started.code)
  const deviceId = stringValue(started.deviceId)
  const expiresAt = nonNegativeInteger(started.expiresAt)
  if (!code || !/^[A-Z2-9]{7}$/u.test(code) || !deviceId || expiresAt === null) {
    throw new Error('The dashboard returned an invalid code')
  }
  const setupUrl = new URL('/setup', baseUrl)
  setupUrl.searchParams.set('code', code)
  await options.onCode({
    code,
    label: options.label,
    platform: options.platform,
    setupUrl: setupUrl.toString(),
  })

  while (options.now() < expiresAt) {
    await options.sleep(1500)
    const result = await postJson(options.fetch, `${baseUrl}/api/device/poll`, { code, deviceId })
    const status = stringValue(result.status)
    if (status === 'approved') {
      const token = stringValue(result.token)
      if (!token) throw new Error('The dashboard approved the machine without a token')
      return {
        baseUrl,
        deviceId,
        linkedAt: new Date(options.now()).toISOString(),
        token,
        version: 1,
      }
    }
    if (status === 'expired') break
    if (status !== 'pending') throw new Error('The dashboard returned an invalid link status')
  }
  throw new Error(expiredDeviceCodeMessage(options.commandPrefix ?? defaultCommandPrefix))
}

/** Printed when `init` cannot open a connection. Self-hosted and local dashboards need `--url`. */
export function unreachableDashboardMessage(origin: string, reason: string) {
  return `Could not reach ${origin} (${reason}).\n  Self-hosted or local? Pass --url <dashboard url> or set ${dashboardUrlEnvVar}.`
}

export function expiredDeviceCodeMessage(commandPrefix: string) {
  return `The code expired before it was confirmed.\n  Run \`${commandPrefix} init\` again for a new one.`
}

async function postJson(fetch: typeof globalThis.fetch, url: string, body: unknown) {
  let response: Response
  try {
    // Each poll is its own request with its own timeout; the loop above decides how long to keep
    // polling. The device flow carries no token yet, so redirects are left to the default.
    response = await fetch(
      url,
      requestInit({
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
  } catch (error) {
    throw new Error(unreachableDashboardMessage(new URL(url).origin, describeFetchFailure(error)))
  }
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    const record = asRecord(value)
    const error = sanitizeServerText(record?.error)
    const retryAfterSeconds = nonNegativeInteger(record?.retryAfterSeconds)
    if (error === 'device_code_rate_limited') {
      const retry = retryAfterSeconds === null ? 'in a moment' : `in ${retryAfterSeconds} seconds`
      throw new Error(`Too many machines are being linked right now. Try again ${retry}.`)
    }
    throw new Error(error ?? `Dashboard returned HTTP ${response.status}`)
  }
  const record = asRecord(value)
  if (!record) throw new Error('The dashboard returned invalid JSON')
  return record
}
