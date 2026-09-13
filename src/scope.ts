import type { LinkedConfig } from './config.js'
import { describeFetchFailure, httpFailure, originOf, requestInit } from './http.js'
import type { TeamScope } from './types.js'
import { asRecord, stringValue } from './value.js'

/**
 * Every scope failure names the origin that was tried and why: the connection class when the
 * request never got an answer, the HTTP status (and the dashboard's error code) when it did,
 * and `unsupported`/`invalid` when the answer had the wrong shape. Nothing is sent after any of
 * them.
 */
export function scopeFailureMessage(origin: string, reason: string) {
  return `Could not load the team reporting scope from ${origin} (${reason}). Nothing was sent.`
}

export async function fetchTeamScope(
  config: LinkedConfig,
  fetch: typeof globalThis.fetch,
): Promise<TeamScope> {
  const origin = originOf(config.baseUrl)
  let response: Response
  try {
    response = await fetch(
      `${config.baseUrl}/api/device/scope`,
      requestInit(
        { headers: { authorization: `Bearer ${config.token}` }, method: 'GET' },
        { bearer: true },
      ),
    )
  } catch (error) {
    throw new Error(scopeFailureMessage(origin, describeFetchFailure(error)))
  }

  const value = asRecord(await response.json().catch(() => null))
  if (!response.ok) {
    throw new Error(scopeFailureMessage(origin, httpFailure(response.status, value)))
  }
  if (value?.version !== 'team-repositories@1') {
    throw new Error(
      `The dashboard at ${origin} returned an unsupported reporting scope. Nothing was sent.`,
    )
  }
  const repositories = stringArray(value.repositories)
  const catalogRepositories = stringArray(value.catalogRepositories)
  if (!repositories || !catalogRepositories) {
    throw new Error(
      `The dashboard at ${origin} returned an invalid reporting scope. Nothing was sent.`,
    )
  }
  const active = new Set(repositories)
  if (catalogRepositories.some((repository) => !active.has(repository))) {
    throw new Error(
      `The dashboard at ${origin} returned an invalid shared-library scope. Nothing was sent.`,
    )
  }
  return {
    catalogRepositories: [...new Set(catalogRepositories)].toSorted(),
    repositories: [...active].toSorted(),
    version: 'team-repositories@1',
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return null
  const strings = value.map(stringValue)
  return strings.every((item): item is string => item !== null) ? strings : null
}
