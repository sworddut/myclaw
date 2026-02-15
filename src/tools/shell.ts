import {execa} from 'execa'

export async function runShell(command: string, cwd = process.cwd()): Promise<string> {
  const {stdout, stderr, exitCode} = await execa('zsh', ['-lc', command], {cwd, reject: false})
  const header = `exit_code=${exitCode}`
  if (!stdout && !stderr) return '(no output)'
  return [header, stdout, stderr].filter(Boolean).join('\n')
}
