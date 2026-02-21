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

export function getUserProfilePath(homeDir = getMyclawHome()): string {
  return resolve(homeDir, 'user-profile.json')
}

export function getSessionsDir(homeDir = getMyclawHome()): string {
  return resolve(homeDir, 'sessions')
}

export function getSessionLogPath(sessionId: string, homeDir = getMyclawHome()): string {
  return resolve(getSessionsDir(homeDir), `${sessionId}.jsonl`)
}

export function getMetricsDir(homeDir = getMyclawHome()): string {
  return resolve(homeDir, 'metrics')
}

export function getMetricsLogPath(sessionId: string, homeDir = getMyclawHome()): string {
  return resolve(getMetricsDir(homeDir), `${sessionId}.jsonl`)
}
