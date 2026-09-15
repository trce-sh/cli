import type { ReportScene } from './output.js'

const hideCursor = '\u001B[?25l'
const showCursor = '\u001B[?25h'
const clearLine = '\r\u001B[2K'

type AnimateOptions = {
  /** Waits between frames; tests pass an instant one. */
  sleep?: (milliseconds: number) => Promise<void>
}

/**
 * Plays the report reveal: the trace draws, the overview counts up, activity rows land one at a
 * time with their bars, and the rest prints line by line. About two seconds in total, after the
 * scan. Every frame rewrites only the block it animates, so the output above stays put and the
 * final screen is exactly `renderReportScene`.
 */
export async function animateReport(
  scene: ReportScene,
  write: (value: string) => unknown,
  { sleep = defaultSleep }: AnimateOptions = {},
) {
  let shown = 0
  const block = (lines: readonly string[]) => {
    write(`${cursorUp(shown)}${lines.map((line) => `${clearLine}${line}\n`).join('')}`)
    // A block that shrank leaves stale lines below: clear them and come back up.
    if (lines.length < shown) {
      const stale = shown - lines.length
      write(`${`${clearLine}\n`.repeat(stale)}${cursorUp(stale)}`)
    }
    shown = lines.length
  }
  const settle = () => {
    shown = 0
  }
  write(hideCursor)
  try {
    const headerFrames = 8
    for (let frame = 0; frame <= headerFrames; frame += 1) {
      block(scene.header(frame / headerFrames))
      await sleep(45)
    }
    settle()
    block(scene.intro)
    settle()

    const overviewFrames = 14
    for (let frame = 0; frame <= overviewFrames; frame += 1) {
      block(scene.overview(frame / overviewFrames))
      await sleep(40)
    }
    settle()

    if (scene.activity) {
      block(scene.activity.head)
      settle()
      const rows = scene.activity.rows
      const rowSettle = 4
      const frames = rows.length + rowSettle
      for (let frame = 0; frame <= frames; frame += 1) {
        const visible = Math.min(rows.length, frame + 1)
        block(
          rows
            .slice(0, visible)
            .map((row, index) => row(Math.min(1, Math.max(0, (frame - index) / rowSettle)))),
        )
        await sleep(45)
      }
      settle()
    }

    for (const line of scene.rest) {
      block([line])
      settle()
      await sleep(12)
    }
  } finally {
    write(showCursor)
  }
}

function cursorUp(lines: number) {
  return lines > 0 ? `\u001B[${lines}A` : ''
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
