import { describe, expect, it } from 'vitest'
import { browserCommand, openExternalUrl } from './open-url.js'

describe('browser opener', () => {
  it('uses the native opener without a shell', () => {
    const url = 'http://localhost:3000/setup?code=ABCDEFG'

    expect(browserCommand(url, 'darwin')).toEqual({ args: [url], command: 'open' })
    expect(browserCommand(url, 'win32')).toEqual({
      args: ['url.dll,FileProtocolHandler', url],
      command: 'rundll32.exe',
    })
    expect(browserCommand(url, 'linux')).toEqual({ args: [url], command: 'xdg-open' })
  })

  it('rejects non-web URLs before launching a process', async () => {
    await expect(openExternalUrl('file:///tmp/private', 'darwin')).resolves.toBe(false)
    await expect(openExternalUrl('not-a-url', 'darwin')).resolves.toBe(false)
  })
})
