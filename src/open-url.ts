import { spawn } from 'node:child_process'

export function browserCommand(value: string, platform: string) {
  if (platform === 'darwin') return { args: [value], command: 'open' }
  if (platform === 'win32') {
    return {
      args: ['url.dll,FileProtocolHandler', value],
      command: 'rundll32.exe',
    }
  }
  return { args: [value], command: 'xdg-open' }
}

export async function openExternalUrl(
  value: string,
  platform = process.platform,
): Promise<boolean> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const target = url.toString()
  const { args, command } = browserCommand(target, platform)

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      resolvePromise(false)
      return
    }
    let settled = false
    const settle = (opened: boolean) => {
      if (settled) return
      settled = true
      resolvePromise(opened)
    }
    child.once('error', () => settle(false))
    child.once('spawn', () => {
      child.unref()
      settle(true)
    })
  })
}
