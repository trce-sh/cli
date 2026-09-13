import { resolve } from 'node:path'
import { driftGroups, duplicateCandidates } from './analysis.js'
import { repositorySlug, scanHistory } from './history.js'
import { scanInventory } from './inventory.js'
import type { LocalReport } from './types.js'

export type GenerateReportOptions = {
  claudeProjectsDirectory?: string
  codexSessionsDirectory?: string
  /** Environment used to locate relocated agent homes. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  homeDirectory: string
  now?: Date
  projectDirectory?: string
  repositorySlugForCwd?: (cwd: string) => Promise<string | null>
  sinceDays?: number
}

export async function generateLocalReport(options: GenerateReportOptions): Promise<LocalReport> {
  const now = options.now ?? new Date()
  const sinceDays = options.sinceDays ?? 30
  const generatedAt = now.toISOString()
  const from = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
  const projectDirectory = options.projectDirectory ? resolve(options.projectDirectory) : undefined
  const resolveRepository = options.repositorySlugForCwd ?? repositorySlug
  const projectRepo = projectDirectory ? await resolveRepository(projectDirectory) : null
  const [skills, history] = await Promise.all([
    scanInventory({
      homeDirectory: options.homeDirectory,
      projectRepo,
      ...(options.env ? { env: options.env } : {}),
      ...(projectDirectory ? { projectDirectory } : {}),
    }),
    scanHistory({
      from,
      homeDirectory: options.homeDirectory,
      ...(options.env ? { env: options.env } : {}),
      repositorySlugForCwd: resolveRepository,
      ...(options.claudeProjectsDirectory
        ? { claudeProjectsDirectory: options.claudeProjectsDirectory }
        : {}),
      ...(options.codexSessionsDirectory
        ? { codexSessionsDirectory: options.codexSessionsDirectory }
        : {}),
    }),
  ])

  return {
    drift: driftGroups(skills),
    duplicateCandidates: duplicateCandidates(skills),
    generatedAt,
    historyRoots: history.roots,
    parserCoverage: history.parserCoverage,
    sessions: history.sessions,
    skills,
    window: { from, to: generatedAt },
  }
}

export const sinceUsage = '--since takes a number of days like 30d (1d to 3650d)'

export function parseSinceDays(value: string | undefined) {
  if (value === undefined) return 30
  const match = /^(\d+)d$/u.exec(value)
  const days = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new Error(sinceUsage)
  }
  return days
}
