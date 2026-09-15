import type { TerminalBackground } from './brand.js'

const esc = String.fromCharCode(27)
/** OSC 11 query: "what is your background colour?" */
const backgroundQuery = `${esc}]11;?${esc}\\`
const backgroundReply = new RegExp(
  `${esc}\\]11;rgb:([0-9a-f]{1,4})/([0-9a-f]{1,4})/([0-9a-f]{1,4})(?:${esc}\\\\|${String.fromCharCode(7)})`,
  'iu',
)

type TtyIn = {
  isRaw?: boolean | undefined
  isTTY?: boolean | undefined
  off: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  pause: () => unknown
  resume: () => unknown
  setRawMode?: ((mode: boolean) => unknown) | undefined
}

type TtyOut = { isTTY?: boolean | undefined; write: (value: string) => unknown }

/**
 * Asks the terminal for its background colour and waits briefly for a complete reply.
 * Unsupported terminals time out and use the environment hint or default palette.
 */
export function detectTerminalBackground({
  stdin = process.stdin,
  stdout = process.stdout,
  timeoutMs = 150,
}: {
  stdin?: TtyIn
  stdout?: TtyOut
  timeoutMs?: number
} = {}): Promise<TerminalBackground | null> {
  if (stdin.isTTY !== true || stdout.isTTY !== true || !stdin.setRawMode) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let buffer = ''
    let finished = false
    const wasRaw = stdin.isRaw === true
    const finish = (value: TerminalBackground | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stdin.off('data', onData)
      try {
        stdin.setRawMode?.(wasRaw)
      } catch {
        // The terminal went away; nothing to restore.
      }
      stdin.pause()
      resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const parsed = parseBackgroundReply(buffer)
      if (parsed) finish(parsed)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      stdin.setRawMode?.(true)
    } catch {
      finish(null)
      return
    }
    try {
      stdin.on('data', onData)
      stdin.resume()
      stdout.write(backgroundQuery)
    } catch {
      finish(null)
    }
  })
}

/** `rgb:1c1c/1b1b/2222` is dark, `rgb:ffff/ffff/ffff` is light; anything else is unknown. */
export function parseBackgroundReply(text: string): TerminalBackground | null {
  const match = backgroundReply.exec(text)
  if (!match) return null
  const [red, green, blue] = match.slice(1, 4).map((part) => {
    const value = Number.parseInt(part ?? '0', 16)
    const maximum = 16 ** (part?.length ?? 1) - 1
    return maximum > 0 ? value / maximum : 0
  })
  const luminance = 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
  return luminance > 0.5 ? 'light' : 'dark'
}
