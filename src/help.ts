import { brand } from './brand.js'
import { installableCodingAgentList } from './coding-agents.js'
import { defaultCommandPrefix } from './invocation.js'
import { dashboardUrlEnvVar, publicDashboardUrl } from './service.js'

type HelpOptions = {
  color?: boolean
  commandPrefix?: string
  hyperlinks?: boolean
}

type OptionRow = readonly [flag: string, description: string]

type CommandHelp = {
  /** What the command reads and sends, printed under every command's help. */
  network: readonly string[]
  options: readonly OptionRow[]
  summary: string
  /** Usage lines without the command prefix, e.g. `init [--url <url>]`. */
  usage: readonly string[]
}

const installableAgents = installableCodingAgentList.map((agent) => agent.shortLabel)
const harnessValues = `${installableAgents.join('|')}|all`

const offline = [
  'Offline. Reads skill directories and session history on this machine; nothing is sent.',
]

/** Every command in workflow order; `hook` is listed last and marked internal. */
export const commandHelp: Readonly<Record<string, CommandHelp>> = {
  init: {
    network: [
      "Sends this machine's short hostname and platform to the dashboard, then stores the",
      'returned token in ~/.trce/config.json with owner-only permissions.',
    ],
    options: [
      ['--url <url>', `Dashboard origin (default: ${dashboardUrlEnvVar} or ${publicDashboardUrl})`],
      ['--no-browser', 'Link without opening the confirmation page'],
      ['--no-hooks', 'Link without changing Claude Code or Codex config'],
      ['--hooks-only', 'Install the background hooks on an already linked machine'],
      ['--remove', 'Remove only the hooks trce installed and keep the machine link'],
      ['--insecure-http', 'Allow a plain http:// origin that is not localhost'],
    ],
    summary: 'Link this machine and install background hooks',
    usage: [
      'init [--url <url>] [--no-browser] [--no-hooks] [--insecure-http]',
      'init --hooks-only',
      'init --remove',
    ],
  },
  report: {
    network: offline,
    options: [
      ['--since <Nd>', 'Scan this many days of local history, 1d to 3650d (default: 30d)'],
      ['--all', 'List every installation, including skills with no calls'],
      ['--json', 'Print the complete machine-readable local report'],
    ],
    summary: 'Show local skill activity and issues',
    usage: ['report [--since <Nd>] [--all] [--json]'],
  },
  dedupe: {
    network: offline,
    options: [['--all', 'List every pair instead of the first 20 per bucket']],
    summary: 'Find likely and possible duplicate pairs',
    usage: ['dedupe [--all]'],
  },
  diff: {
    network: offline,
    options: [],
    summary: 'Compare installed copies of one skill',
    usage: ['diff <skill>'],
  },
  push: {
    network: [
      "Fetches the team's connected repositories. Uploads only skill metadata to the linked",
      'dashboard; --dry-run prints the report body without uploading it.',
    ],
    options: [
      ['--dry-run', 'Print the exact report JSON without uploading it (still fetches scope)'],
      ['--quiet', 'Print nothing on success (what the background hook runs)'],
      ['--since <Nd>', 'Scan this many days of local history, 1d to 3650d (default: 30d)'],
      ['--url <url>', `Dashboard origin (default: ${dashboardUrlEnvVar} or the linked origin)`],
      ['--insecure-http', 'Allow a plain http:// origin that is not localhost'],
    ],
    summary: 'Send metadata for connected repositories (--dry-run prints it)',
    usage: ['push [--dry-run] [--quiet] [--since <Nd>] [--url <url>]'],
  },
  add: {
    network: [
      'Downloads skill files from GitHub. --shared first asks the dashboard for a short-lived',
      'credential for the Skills library.',
    ],
    options: [
      ['--shared', "Install from the team's Skills library and record where it came from"],
      [`--harness <${harnessValues}>`, 'Coding agent to install for (default: all)'],
      ['--ref <git ref>', 'Git ref to install (default: HEAD)'],
      ['--dry-run', 'Resolve and validate the source without changing files'],
    ],
    summary: 'Install a Personal or Shared skill on this machine',
    usage: [
      `add <owner/repo:path> [--harness <${harnessValues}>] [--ref <git ref>] [--dry-run]`,
      'add <owner/repo:path> --shared',
    ],
  },
  update: {
    network: [
      'Downloads the current skill files from GitHub; a Shared install first asks the dashboard',
      'for a credential.',
    ],
    options: [['--dry-run', 'Show whether an update is available without changing files']],
    summary: 'Update skills installed with add',
    usage: ['update <skill> [--dry-run]'],
  },
  remove: {
    network: ['Offline. Moves the skill to a local trash under ~/.trce; nothing is sent.'],
    options: [['--dry-run', 'Show what would be removed without changing files']],
    summary: 'Remove a skill installed with add (kept in a local trash)',
    usage: ['remove <skill> [--dry-run]'],
  },
  promote: {
    network: [
      'Uploads the skill files from this machine straight to GitHub. The dashboard receives',
      'the action id and the pull request number only.',
    ],
    options: [
      ['--repo <owner/repo>', 'Connected destination repository'],
      ['--action <id>', 'Action id copied from Reviews (required)'],
      [
        '--distribution <project|shared>',
        'project: loads for everyone in the repository. shared: the Skills library\nteammates opt in to',
      ],
    ],
    summary: 'Finish a Share with team or Add to repository review',
    usage: [
      'promote <skill> --pr --repo <owner/repo> --action <id> [--distribution <project|shared>]',
    ],
  },
  unify: {
    network: [
      'Uploads the skill files from this machine straight to GitHub. The dashboard receives',
      'the action id and the pull request number only.',
    ],
    options: [
      ['--repo <owner/repo>', 'Connected destination repository'],
      ['--action <id>', 'Action id copied from Reviews (required)'],
    ],
    summary: 'Finish a Standardize review',
    usage: ['unify <skill> --pr --repo <owner/repo> --action <id>'],
  },
  hook: {
    network: [
      'Internal. Started by the Claude Code and Codex hooks after a session; runs push --quiet in',
      'the background at most once a minute, ignores its arguments, and exits silently when the',
      'machine is not linked.',
    ],
    options: [],
    summary: 'Internal: run by the background hooks, not for interactive use',
    usage: ['hook'],
  },
}

export const commandNames = Object.keys(commandHelp)

const flagColumn = 22

function rows(entries: readonly OptionRow[], width = flagColumn) {
  return entries.map(([flag, description]) => {
    const indent = ' '.repeat(width + 2)
    const text = description.split('\n').join(`\n${indent}`)
    if (flag.length + 2 > width) return `  ${flag}\n${indent}${text}`
    return `  ${flag.padEnd(width)}${text}`
  })
}

/** The command table, shared with the usage guide. */
export function commandTable() {
  return rows(
    Object.entries(commandHelp).map(([name, help]) => [name, help.summary] as const),
    13,
  ).join('\n')
}

export function exitCodesText() {
  return [
    'Exit codes',
    '  0  Success',
    '  1  Error: a failed request, a refused install, an unknown command, or a usage error',
    '  2  Not linked: a team command ran before init. Nothing was scanned or sent.',
  ].join('\n')
}

export function helpText({
  color = true,
  commandPrefix = defaultCommandPrefix,
  hyperlinks = false,
}: HelpOptions = {}) {
  const agents = installableAgents.join(', ')
  return `${brand({ color, hyperlinks })}

Usage
  ${commandPrefix} <command> [options]
  ${commandPrefix} <command> --help

Commands
${commandTable()}

report, dedupe, and diff run without a linked team and never contact the server.
push, add, update, remove, promote, and unify require a linked team.

Report options
${rows(commandHelp.report?.options ?? []).join('\n')}

Global options
  -h, --help            Show help; after a command, show that command's help
  -v, -V, --version     Show the CLI version

Link options
${rows(commandHelp.init?.options ?? []).join('\n')}

Push options
${rows(commandHelp.push?.options ?? []).join('\n')}

Dedupe options
${rows(commandHelp.dedupe?.options ?? []).join('\n')}

Install options
  --shared              Install from the team's Skills library and record where it came from
  --harness <name>      Coding agent to install for: ${agents}, or all (default)
  --ref <git ref>       Git ref to install (default: HEAD)
  --dry-run             Resolve and validate the source without changing files

Pull-request options
${rows(commandHelp.promote?.options ?? []).join('\n')}

Options take values as --flag value or --flag=value.

${exitCodesText()}

Privacy
  Only skill metadata is sent to trce. Prompts, responses, source code, diffs,
  shell arguments, and unrelated local paths never enter trce. report, dedupe,
  and diff are offline. push resolves the team's connected repository scope.
  --dry-run prints the exact JSON that push sends. For reviewed promote and unify
  actions, skill files move directly from this machine to GitHub. trce receives
  the pull request number only.

Not linked yet? Run ${commandPrefix} init.
`
}

/** `trce <command> --help`: the usage lines, options, the network line, and the exit codes. */
export function commandHelpText(
  command: string,
  { color = true, commandPrefix = defaultCommandPrefix, hyperlinks = false }: HelpOptions = {},
) {
  const help = commandHelp[command]
  if (!help) return null
  const sections = [
    brand({ color, hyperlinks }),
    `${command}  ${help.summary}`,
    `Usage\n${help.usage.map((line) => `  ${commandPrefix} ${line}`).join('\n')}`,
  ]
  if (help.options.length > 0) sections.push(`Options\n${rows(help.options).join('\n')}`)
  sections.push(`Network\n${help.network.map((line) => `  ${line}`).join('\n')}`, exitCodesText())
  return `${sections.join('\n\n')}\n`
}
