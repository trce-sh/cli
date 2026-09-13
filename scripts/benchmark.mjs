import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

// Local, synthetic data only. Never scan the user's home or make a network request.
const agent = process.argv[2]
if (agent === 'claude' || agent === 'codex') {
  const { parseClaudeTranscriptLines } = await import('../dist/parsers/claude.js')
  const { parseCodexRolloutLines } = await import('../dist/parsers/codex.js')
  const records = 1500
  const text = 'Synthetic content. '.repeat(7000)
  const line = JSON.stringify(
    agent === 'claude'
      ? {
          type: 'assistant',
          sessionId: 'synthetic',
          message: { content: [{ type: 'text', text }] },
        }
      : {
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
        },
  )
  function* lines() {
    for (let index = 0; index < records; index += 1) yield line
  }
  const start = performance.now()
  const result = await (agent === 'claude' ? parseClaudeTranscriptLines : parseCodexRolloutLines)(
    lines(),
    'synthetic',
  )
  if (result.coverage.parseFailures || result.sessions.length !== 1)
    throw new Error('Synthetic parser failed')
  console.log(
    JSON.stringify({
      agent,
      records,
      inputMiB: Math.round((Buffer.byteLength(line) * records) / 1024 ** 2),
      elapsedMs: Math.round(performance.now() - start),
      maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    }),
  )
} else {
  const results = ['claude', 'codex'].map((name) => {
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=96', fileURLToPath(import.meta.url), name],
      { encoding: 'utf8', timeout: 30000 },
    )
    if (child.status !== 0)
      throw new Error(
        `${name} exceeded the 96 MiB heap / 30 s synthetic parser gate: ${child.stderr}`,
      )
    return JSON.parse(child.stdout)
  })
  console.log(
    JSON.stringify(
      {
        version: 'trce-synthetic-benchmark@1',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        results,
      },
      null,
      2,
    ),
  )
}
