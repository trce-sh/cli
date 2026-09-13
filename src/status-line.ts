import { asciiMode, glyphs, terminalText } from './brand.js'
import { displayWidth, takeDisplayPrefix } from './value.js'

const frameIntervalMs = 100
const clearLine = '\r\u001B[2K'

type StatusStream = {
  columns?: number | undefined
  isTTY?: boolean | undefined
  write: (value: string) => unknown
}

type TerminalStatusLineOptions = {
  /** Plain ASCII spinner frames; defaults to `asciiMode()`. */
  ascii?: boolean
  color: boolean
  now?: () => number
  /**
   * Defaults to stderr: the spinner is progress, not output, so it must never land in a pipe that
   * captures stdout. Without a stream the line is a no-op unless stderr is a TTY; an explicit
   * stream is trusted unless it says `isTTY: false`.
   */
  stream?: StatusStream
}

export type TerminalStatusLine = {
  stop: () => void
  update: (message: string) => void
}

const inactiveStatusLine: TerminalStatusLine = {
  stop() {},
  update() {},
}

export function createTerminalStatusLine({
  ascii = asciiMode(),
  color,
  now = Date.now,
  stream,
}: TerminalStatusLineOptions): TerminalStatusLine {
  const target = stream ?? process.stderr
  const enabled = stream ? stream.isTTY !== false : process.stderr.isTTY === true
  if (!enabled) return inactiveStatusLine
  const symbols = glyphs(ascii)
  const frames = symbols.spinner
  let frameIndex = 0
  let message = ''
  let startedAt = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function render() {
    if (!message) return
    const elapsedSeconds = Math.floor((now() - startedAt) / 1000)
    const elapsed = elapsedSeconds > 0 ? ` ${elapsedSeconds}s` : ''
    const width = Math.max(12, target.columns ?? 80)
    const available = Math.max(1, width - 3 - displayWidth(elapsed))
    const visibleMessage = truncate(message, available, symbols.ellipsis)
    const frame = frames[frameIndex % frames.length] ?? frames[0] ?? ''
    const elapsedText = elapsed ? terminalText(elapsed, 'dim', { color }) : ''
    target.write(
      `${clearLine}${terminalText(frame, 'accent', { color })} ${visibleMessage}${elapsedText}`,
    )
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    if (message) target.write(clearLine)
    message = ''
    frameIndex = 0
    startedAt = 0
  }

  function update(nextMessage: string) {
    const normalized = nextMessage.replaceAll(/\s+/gu, ' ').trim()
    if (!normalized) return
    if (!timer) {
      startedAt = now()
      timer = setInterval(() => {
        frameIndex += 1
        render()
      }, frameIntervalMs)
      timer.unref()
    }
    message = normalized
    render()
  }

  return { stop, update }
}

function truncate(value: string, width: number, ellipsis: string) {
  if (displayWidth(value) <= width) return value
  const ellipsisWidth = displayWidth(ellipsis)
  if (width <= ellipsisWidth)
    return takeDisplayPrefix(ellipsis, width) || takeDisplayPrefix(value, width)
  return `${takeDisplayPrefix(value, width - ellipsisWidth)}${ellipsis}`
}
