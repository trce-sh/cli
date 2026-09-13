export const publicDashboardUrl = 'https://trce.sh'

/** The env var that points the CLI at a self-hosted or local dashboard. */
export const dashboardUrlEnvVar = 'TRCE_URL'

export function publicDashboardPage(pathname: `/${string}`) {
  return `${publicDashboardUrl}${pathname}`
}

/**
 * The dashboard origin the CLI would use: `TRCE_URL` when set, otherwise the public origin.
 * Hints that tell the user where to link or connect repositories must name this, not the
 * hardcoded public origin, so a self-hosted install reads its own address.
 */
export function configuredDashboardUrl(env: NodeJS.ProcessEnv = process.env) {
  const value = env[dashboardUrlEnvVar]?.trim()
  return value ? value.replace(/\/+$/u, '') : publicDashboardUrl
}
