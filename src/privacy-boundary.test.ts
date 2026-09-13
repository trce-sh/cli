import { describe, expect, it } from 'vitest'
import { looksLikeLocalPath } from './privacy-boundary.js'

describe('paths inside metadata prose', () => {
  it.each([
    'Read `/Users/example/private`.',
    'Read (/home/example/private).',
    'Use path=C:/Users/example/private.',
    'Use [notes](file:///tmp/private).',
    'Use "~/private".',
    'Read `/root/private`.',
    'Read \\\\server\\share\\private.',
    'Read C:\\Users\\example\\private.',
  ])('rejects %s', (value) => {
    expect(looksLikeLocalPath(value)).toBe(true)
  })

  it.each(['Review pull requests.', 'acme/app', 'https://github.com/acme/app', 'Testing & e2e'])(
    'allows %s',
    (value) => {
      expect(looksLikeLocalPath(value)).toBe(false)
    },
  )
})
