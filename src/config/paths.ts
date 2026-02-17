import {homedir} from 'node:os'
import {resolve} from 'node:path'

export function getMyclawHome(): string {
  const custom = process.env.MYCLAW_HOME?.trim()
  if (custom) return resolve(custom)
  return resolve(homedir(), '.myclaw')
}

export function getGlobalEnvPath(): string {
  return resolve(getMyclawHome(), '.env')
}

export function getMemoryPath(): string {
  return resolve(getMyclawHome(), 'memory.md')
}

export function getSessionsDir(homeDir = getMyclawHome()): string {
  return resolve(homeDir, 'sessions')
}

export function getSessionLogPath(sessionId: string, homeDir = getMyclawHome()): string {
  return resolve(getSessionsDir(homeDir), `${sessionId}.jsonl`)
}
