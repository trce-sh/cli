import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const codingAgentIds = ['claude-code', 'codex', 'cursor'] as const

export type CodingAgentId = (typeof codingAgentIds)[number]

/** Where each coding agent keeps its own configuration, skills, plugins, and session history. */
export type AgentHomes = {
  claude: string
  codex: string
  cursor: string
}

/**
 * Resolves the per-agent home directories. Claude Code honors `CLAUDE_CONFIG_DIR` and Codex
 * honors `CODEX_HOME`; Cursor has no relocation variable. Anything that reads or writes under
 * `~/.claude` or `~/.codex` must go through this so a relocated install is still found.
 */
export function agentHomes(env: NodeJS.ProcessEnv = process.env, home = homedir()): AgentHomes {
  return {
    claude: overrideDirectory(env.CLAUDE_CONFIG_DIR) ?? join(home, '.claude'),
    codex: overrideDirectory(env.CODEX_HOME) ?? join(home, '.codex'),
    cursor: join(home, '.cursor'),
  }
}

function overrideDirectory(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? resolve(trimmed) : null
}

/** A directory under one agent home, or under the user home for shared roots like `.agents`. */
export type AgentRoot = {
  base: keyof AgentHomes | 'home'
  path: readonly string[]
}

export function resolveAgentRoot(homes: AgentHomes, home: string, root: AgentRoot) {
  return join(root.base === 'home' ? home : homes[root.base], ...root.path)
}

type InventoryRootDefinition = AgentRoot & {
  mode: 'direct' | 'recursive'
  source: 'bundled' | 'plugin' | 'user'
}

type CodingAgentDefinition = {
  aliases: readonly string[]
  catalogObservationRule: string | null
  defaultInstallRoot: AgentRoot
  defaultProjectRoot: readonly string[]
  id: CodingAgentId
  installSupported: boolean
  inventoryRoots: readonly InventoryRootDefinition[]
  label: string
  projectRoots: readonly (readonly string[])[]
  shortLabel: string
  usageEvidence: 'verified' | 'inferred' | 'unavailable'
}

export const codingAgents = {
  'claude-code': {
    aliases: ['claude'],
    catalogObservationRule: null,
    defaultInstallRoot: { base: 'claude', path: ['skills'] },
    defaultProjectRoot: ['.claude', 'skills'],
    id: 'claude-code',
    installSupported: true,
    inventoryRoots: [
      { base: 'claude', mode: 'direct', path: ['skills'], source: 'user' },
      { base: 'claude', mode: 'recursive', path: ['plugins'], source: 'plugin' },
    ],
    label: 'Claude Code',
    projectRoots: [['.claude', 'skills']],
    shortLabel: 'claude',
    usageEvidence: 'verified',
  },
  codex: {
    aliases: ['codex-cli'],
    catalogObservationRule: 'codex-catalog@1',
    defaultInstallRoot: { base: 'home', path: ['.agents', 'skills'] },
    defaultProjectRoot: ['.agents', 'skills'],
    id: 'codex',
    installSupported: true,
    inventoryRoots: [
      { base: 'home', mode: 'direct', path: ['.agents', 'skills'], source: 'user' },
      { base: 'codex', mode: 'direct', path: ['skills', '.system'], source: 'bundled' },
      { base: 'codex', mode: 'recursive', path: ['plugins', 'cache'], source: 'plugin' },
    ],
    label: 'Codex',
    projectRoots: [
      ['.agents', 'skills'],
      ['.codex', 'skills'],
    ],
    shortLabel: 'codex',
    usageEvidence: 'inferred',
  },
  cursor: {
    aliases: ['cursor-agent'],
    catalogObservationRule: null,
    defaultInstallRoot: { base: 'cursor', path: ['skills'] },
    defaultProjectRoot: ['.agents', 'skills'],
    id: 'cursor',
    installSupported: false,
    inventoryRoots: [
      { base: 'cursor', mode: 'direct', path: ['skills'], source: 'user' },
      { base: 'home', mode: 'direct', path: ['.agents', 'skills'], source: 'user' },
      { base: 'claude', mode: 'direct', path: ['skills'], source: 'user' },
      { base: 'codex', mode: 'direct', path: ['skills'], source: 'user' },
    ],
    label: 'Cursor',
    projectRoots: [
      ['.cursor', 'skills'],
      ['.agents', 'skills'],
      ['.claude', 'skills'],
      ['.codex', 'skills'],
    ],
    shortLabel: 'cursor',
    usageEvidence: 'unavailable',
  },
} satisfies Record<CodingAgentId, CodingAgentDefinition>

export const codingAgentList: readonly CodingAgentDefinition[] = codingAgentIds.map(
  (id) => codingAgents[id],
)

export const installableCodingAgentIds = codingAgentIds.filter(
  (id) => codingAgents[id].installSupported,
)

export const installableCodingAgentList = installableCodingAgentIds.map((id) => codingAgents[id])

export function isCodingAgentId(value: string): value is CodingAgentId {
  return codingAgentIds.some((id) => id === value)
}

export function normalizeCodingAgentId(value: string): CodingAgentId | null {
  if (isCodingAgentId(value)) return value
  return codingAgentList.find((agent) => agent.aliases.some((alias) => alias === value))?.id ?? null
}

export function codingAgentLabel(agent: CodingAgentId) {
  return codingAgents[agent].label
}

export function codingAgentHasUsageEvidence(agent: CodingAgentId) {
  return codingAgents[agent].usageEvidence !== 'unavailable'
}

export function codingAgentInstallPath(
  homeDirectory: string,
  agent: CodingAgentId,
  skillName: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!codingAgents[agent].installSupported) {
    throw new Error(`${codingAgents[agent].label} installs are not available yet`)
  }
  const homes = agentHomes(env, homeDirectory)
  return join(
    resolveAgentRoot(homes, homeDirectory, codingAgents[agent].defaultInstallRoot),
    skillName,
  )
}
