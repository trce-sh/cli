import { describeFetchFailure, ownsRequestDeadline, renewRequestDeadline } from './http.js'

/** How long to wait before the single retry of a transient connection failure. */
export const transientRetryDelayMs = 2_000

/**
 * Wraps fetch so one transient connection failure is retried once after a short pause. Only a
 * rejected fetch (the request never got an answer) is retried: an HTTP error response is an
 * answer and is returned as-is. A second failure surfaces exactly the error the first would
 * have, so `Could not reach …` and the scope messages stay unchanged.
 */
export function withTransientRetry(
  fetch: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  delayMs = transientRetryDelayMs,
): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      return await fetch(input, init)
    } catch (error) {
      if (init?.signal?.aborted && !ownsRequestDeadline(init.signal)) throw error
      const reason = describeFetchFailure(error)
      const transient =
        [
          'connection refused',
          'connection reset',
          'timed out',
          'temporary DNS failure',
          'UND_ERR_SOCKET',
        ].includes(reason) ||
        (error instanceof TypeError &&
          error.message === 'fetch failed' &&
          reason === 'connection failed')
      if (!transient) throw error
      await sleep(delayMs)
      if (init?.signal?.aborted && !ownsRequestDeadline(init.signal)) throw error
      return fetch(input, renewRequestDeadline(init))
    }
  }
}
