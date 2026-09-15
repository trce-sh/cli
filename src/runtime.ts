import { animateReport } from './animate.js'
import { asciiMode, setTerminalBackground, supportsColor, supportsHyperlinks } from './brand.js'
import { type CliContext, type CliResult, runCli } from './cli.js'
import { detectCommandPrefix } from './invocation.js'
import type { ReportScene } from './output.js'
import { createTerminalStatusLine, type TerminalStatusLine } from './status-line.js'
import { detectTerminalBackground } from './terminal-background.js'
import { asRecord } from './value.js'

/** The parts of `process.stdout` / `process.stderr` the CLI touches. */
export type RuntimeStream = {
  columns?: number | undefined
  getWindowSize?: (() => number[]) | undefined
  isTTY?: boolean | undefined
  write: (value: string) => unknown
}

export type RuntimeProcess = {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  execPath: string
  platform: NodeJS.Platform
  stderr: RuntimeStream
  stdout: RuntimeStream
}

/**
 * Builds the `CliContext` for a real process. Progress lines (the device code, an upload's file
 * list) print immediately: to stdout in a terminal, to stderr when stdout is a pipe, so a
 * redirected `init` still shows the code the user must confirm.
 */
export function createRuntimeContext(
  runtime: RuntimeProcess,
  status: TerminalStatusLine = createTerminalStatusLine({
    ascii: asciiMode({ env: runtime.env, platform: runtime.platform }),
    color: supportsColor({ env: runtime.env, isTTY: runtime.stderr.isTTY === true }),
    ...(runtime.stderr === process.stderr ? {} : { stream: runtime.stderr }),
  }),
) {
  const stdoutIsTTY = runtime.stdout.isTTY === true
  const color = supportsColor({ env: runtime.env, isTTY: stdoutIsTTY })
  const progressStream = stdoutIsTTY ? runtime.stdout : runtime.stderr
  const readTerminalWidth = () =>
    runtime.stdout.getWindowSize?.()[0] ?? runtime.stdout.columns ?? undefined
  const terminalWidth = stdoutIsTTY ? readTerminalWidth() : undefined
  const context: CliContext = {
    color,
    commandPrefix: detectCommandPrefix({ argv1: runtime.argv[1], env: runtime.env }),
    env: runtime.env,
    executable: runtime.execPath,
    hyperlinks: supportsHyperlinks({ env: runtime.env, isTTY: stdoutIsTTY }),
    interactive: stdoutIsTTY,
    onProgress: (message: string) => {
      status.stop()
      progressStream.write(`${message}\n`)
    },
    onStatus: (message) => status.update(message),
    warn: (message: string) => {
      status.stop()
      runtime.stderr.write(`${message}\n`)
    },
    ...(stdoutIsTTY
      ? {
          animate: async (scene: ReportScene, notice: string | null) => {
            status.stop()
            if (notice) runtime.stdout.write(`${notice}\n`)
            await animateReport(scene, (value) => runtime.stdout.write(value))
          },
          readTerminalWidth,
        }
      : {}),
    ...(terminalWidth === undefined ? {} : { terminalWidth }),
    ...(runtime.argv[1] ? { scriptPath: runtime.argv[1] } : {}),
  }
  return {
    context,
    finish(result: CliResult) {
      status.stop()
      if (result.stdout) runtime.stdout.write(result.stdout)
      if (result.stderr) runtime.stderr.write(result.stderr)
    },
  }
}

/**
 * A reader that closes the pipe early (`trce report --json | head`) makes the next write fail
 * with EPIPE. That is not an error worth a stack trace: stop writing and exit cleanly.
 */
export function ignoreClosedPipes(
  streams: readonly NodeJS.EventEmitter[],
  exit: (code: number) => void = (code) => process.exit(code),
) {
  for (const stream of streams) {
    stream.on('error', (error: unknown) => {
      if (asRecord(error)?.code === 'EPIPE') {
        exit(0)
        return
      }
      throw error
    })
  }
}

/** Commands whose colour output is worth a background check before printing. */
const colourReportCommands = new Set(['report', 'dedupe', 'diff'])

export async function main(runtime: RuntimeProcess = process): Promise<number> {
  const args = runtime.argv.slice(2)
  const command = args[0]
  setTerminalBackground(null)
  if (
    command &&
    colourReportCommands.has(command) &&
    !args.some((arg) => ['--json', '--help', '-h'].includes(arg)) &&
    runtime.stdout.isTTY === true &&
    supportsColor({ env: runtime.env, isTTY: true })
  ) {
    setTerminalBackground(await detectTerminalBackground({ stdout: runtime.stdout }))
  }
  const { context, finish } = createRuntimeContext(runtime)
  const result = await runCli(runtime.argv.slice(2), context)
  finish(result)
  return result.exitCode
}
