import type { LinkedConfig } from './config.js'
import { describeFetchFailure, originOf, requestInit } from './http.js'
import { asRecord, isoTimestamp, stringValue } from './value.js'

export type CatalogCredential = {
  apiUrl: 'https://api.github.com'
  expiresAt: string
  token: string
}

export async function fetchCatalogCredential(
  config: LinkedConfig,
  repository: string,
  fetch: typeof globalThis.fetch,
): Promise<CatalogCredential> {
  const origin = originOf(config.baseUrl)
  let response: Response
  try {
    response = await fetch(
      `${config.baseUrl}/api/device/catalog-access`,
      requestInit(
        {
          body: JSON.stringify({ repository }),
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
    throw new Error(`Could not reach ${origin} (${describeFetchFailure(error)}). Nothing changed.`)
  }

  const value = asRecord(await response.json().catch(() => null))
  if (!response.ok) {
    if (value?.error === 'catalog_repository_not_available') {
      throw new Error(
        `${repository} is not available as this team's Skills library. Nothing changed.`,
      )
    }
    throw new Error(
      `Could not get GitHub access for ${repository} from ${origin} (HTTP ${response.status}). Nothing changed.`,
    )
  }
  const github = asRecord(value?.github)
  const expiresAt = isoTimestamp(github?.expiresAt)
  const token = stringValue(github?.token)
  if (
    value?.kind !== 'ready' ||
    value?.repository !== repository ||
    github?.apiUrl !== 'https://api.github.com' ||
    !expiresAt ||
    !token
  ) {
    throw new Error('The dashboard returned invalid Shared install access. Nothing changed.')
  }
  return { apiUrl: 'https://api.github.com', expiresAt, token }
}
