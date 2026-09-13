import type { LinkedConfig } from './config.js'
import { describeFetchFailure, httpFailure, originOf, requestInit } from './http.js'
import { assertPayloadPrivacy } from './payload.js'
import { type PendingAction, parsePendingActions } from './pending.js'
import { asRecord, nonNegativeInteger, stringValue } from './value.js'

export type PushResult = {
  batchId: string
  invocations: number
  /** Laptop actions this device can finish; the only server-decided content a push brings back. */
  pendingActions: PendingAction[]
  sessions: number
  skills: number
}

/**
 * Sends the already-serialized report body. The caller serializes once and prints those exact
 * bytes for `--dry-run`, so parity between the two is structural, not a second serialization
 * that happens to agree.
 */
export async function sendPayload(
  config: LinkedConfig,
  body: string,
  fetch: typeof globalThis.fetch,
): Promise<PushResult> {
  assertPayloadPrivacy(body)
  const origin = originOf(config.baseUrl)
  let response: Response
  try {
    response = await fetch(
      `${config.baseUrl}/api/ingest`,
      requestInit(
        {
          body,
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        },
        { bearer: true },
      ),
    )
  } catch (error) {
    throw new Error(`Could not push the report to ${origin} (${describeFetchFailure(error)}).`)
  }
  const value = asRecord(await response.json().catch(() => null))
  if (!response.ok) {
    throw new Error(
      `Could not push the report to ${origin} (${httpFailure(response.status, value)}).`,
    )
  }
  const batchId = stringValue(value?.batchId)
  const skills = nonNegativeInteger(value?.skills)
  const sessions = nonNegativeInteger(value?.sessions)
  const invocations = nonNegativeInteger(value?.invocations)
  // A dashboard that predates the pending list answers without it; anything malformed is refused.
  const pendingActions =
    value?.pendingActions === undefined ? [] : parsePendingActions(value.pendingActions)
  if (
    !batchId ||
    skills === null ||
    sessions === null ||
    invocations === null ||
    pendingActions === null
  ) {
    throw new Error(`The dashboard at ${origin} returned an invalid ingest result.`)
  }
  return { batchId, invocations, pendingActions, sessions, skills }
}
