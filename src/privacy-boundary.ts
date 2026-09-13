/** The standalone CLI keeps its own release-local copy of the payload path predicate. */
export function looksLikeAbsolutePath(value: string) {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('file://') ||
    /^[a-zA-Z]:[\\/]/u.test(value)
  )
}

/**
 * Detect common machine paths anywhere in prose, including Markdown punctuation and `path=`
 * assignments. A drive needs a word boundary so HTTPS is not mistaken for an `s:/` drive.
 * API route prose such as `/api` remains allowed; this is not a general secret detector.
 */
const localPathToken =
  /(?:~[\\/]|\/(?:Users|home|root|private|var|tmp|etc|opt|mnt|Volumes)\/|(?<![\w])[A-Za-z]:[\\/]|file:\/\/|\\\\[^\s\\]+\\)/iu

export function containsLocalPathToken(value: string) {
  return localPathToken.test(value)
}

/** True when a payload string starts with an absolute path or carries a local path anywhere. */
export function looksLikeLocalPath(value: string) {
  return looksLikeAbsolutePath(value) || containsLocalPathToken(value)
}
