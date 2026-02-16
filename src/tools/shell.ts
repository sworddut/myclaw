import {execa} from 'execa'

function resolveShell(): string | true {
  if (process.env.SHELL?.trim()) return process.env.SHELL
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return true
}

export async function runShell(command: string, cwd = process.cwd()): Promise<string> {
  const {stdout, stderr, exitCode} = await execa(command, {
    cwd,
    reject: false,
    shell: resolveShell()
  })
  const header = `exit_code=${exitCode}`
  if (!stdout && !stderr) return `${header}\n(no output)`
  return [header, stdout, stderr].filter(Boolean).join('\n')
}
