import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {getUserProfilePath} from '../config/paths.js'

export type StableUserProfile = {
  preferredLanguage?: 'zh-CN' | 'en-US'
  codingLanguages: string[]
  environment: {
    os?: 'macOS' | 'Windows' | 'Linux'
    shell?: string
    packageManager?: 'npm' | 'pnpm' | 'yarn'
    nodeVersion?: string
  }
  preferences: string[]
  recentFocus?: string
  lastWorkspace?: string
}

export type UserProfileUpdate = {
  preferredLanguage?: 'zh-CN' | 'en-US'
  codingLanguages?: string[]
  environment?: {
    os?: 'macOS' | 'Windows' | 'Linux'
    shell?: string
    packageManager?: 'npm' | 'pnpm' | 'yarn'
    nodeVersion?: string
  }
  preferences?: string[]
  recentFocus?: string
  lastWorkspace?: string
}

type UserProfileDoc = {
  version: 2
  updatedAt: string
  stableProfile: StableUserProfile
}

function emptyProfile(): UserProfileDoc {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    stableProfile: {
      codingLanguages: [],
      environment: {},
      preferences: []
    }
  }
}

export async function readUserProfile(homeDir?: string): Promise<UserProfileDoc> {
  const path = getUserProfilePath(homeDir)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()

    if (parsed.version === 2 && parsed.stableProfile && typeof parsed.stableProfile === 'object') {
      const sp = parsed.stableProfile as Record<string, unknown>
      return {
        version: 2,
        updatedAt,
        stableProfile: {
          preferredLanguage: sp.preferredLanguage === 'zh-CN' || sp.preferredLanguage === 'en-US' ? sp.preferredLanguage : undefined,
          codingLanguages: Array.isArray(sp.codingLanguages)
            ? sp.codingLanguages.filter((item): item is string => typeof item === 'string').slice(0, 20)
            : [],
          environment: sp.environment && typeof sp.environment === 'object'
            ? {
                os:
                  (sp.environment as Record<string, unknown>).os === 'macOS' ||
                  (sp.environment as Record<string, unknown>).os === 'Windows' ||
                  (sp.environment as Record<string, unknown>).os === 'Linux'
                    ? ((sp.environment as Record<string, unknown>).os as 'macOS' | 'Windows' | 'Linux')
                    : undefined,
                shell:
                  typeof (sp.environment as Record<string, unknown>).shell === 'string'
                    ? ((sp.environment as Record<string, unknown>).shell as string)
                    : undefined,
                packageManager:
                  (sp.environment as Record<string, unknown>).packageManager === 'npm' ||
                  (sp.environment as Record<string, unknown>).packageManager === 'pnpm' ||
                  (sp.environment as Record<string, unknown>).packageManager === 'yarn'
                    ? ((sp.environment as Record<string, unknown>).packageManager as 'npm' | 'pnpm' | 'yarn')
                    : undefined,
                nodeVersion:
                  typeof (sp.environment as Record<string, unknown>).nodeVersion === 'string'
                    ? ((sp.environment as Record<string, unknown>).nodeVersion as string)
                    : undefined
              }
            : {},
          preferences: Array.isArray(sp.preferences)
            ? sp.preferences.filter((item): item is string => typeof item === 'string').slice(0, 30)
            : [],
          recentFocus: typeof sp.recentFocus === 'string' ? sp.recentFocus : undefined,
          lastWorkspace: typeof sp.lastWorkspace === 'string' ? sp.lastWorkspace : undefined
        }
      }
    }

    // Legacy v1 migration: only keep a minimal high-value focus snapshot.
    if (Array.isArray(parsed.entries)) {
      const latestExit = [...parsed.entries]
        .reverse()
        .find(
          (item) =>
            item &&
            typeof item === 'object' &&
            (item as Record<string, unknown>).type === 'exit' &&
            typeof (item as Record<string, unknown>).content === 'string'
        ) as Record<string, unknown> | undefined
      const migrated = emptyProfile()
      if (latestExit?.content && typeof latestExit.content === 'string') {
        migrated.stableProfile.recentFocus = latestExit.content.replace(/^recent_user_focus:\s*/i, '').trim().slice(0, 240)
      }
      if (latestExit?.workspace && typeof latestExit.workspace === 'string') {
        migrated.stableProfile.lastWorkspace = latestExit.workspace
      }
      migrated.updatedAt = updatedAt
      return migrated
    }
    return emptyProfile()
  } catch {
    return emptyProfile()
  }
}

function uniqueLimit(values: string[], max: number): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, max)
}

export async function updateUserProfile(update: UserProfileUpdate, homeDir?: string): Promise<boolean> {
  const path = getUserProfilePath(homeDir)
  const profile = await readUserProfile(homeDir)
  const nextProfile: StableUserProfile = {
    ...profile.stableProfile,
    codingLanguages: [...profile.stableProfile.codingLanguages],
    environment: {...profile.stableProfile.environment},
    preferences: [...profile.stableProfile.preferences]
  }

  if (update.preferredLanguage) nextProfile.preferredLanguage = update.preferredLanguage
  if (update.codingLanguages && update.codingLanguages.length > 0) {
    nextProfile.codingLanguages = uniqueLimit([...nextProfile.codingLanguages, ...update.codingLanguages], 20)
  }
  if (update.environment) {
    nextProfile.environment = {
      ...nextProfile.environment,
      ...update.environment
    }
  }
  if (update.preferences && update.preferences.length > 0) {
    nextProfile.preferences = uniqueLimit([...nextProfile.preferences, ...update.preferences], 30)
  }
  if (update.recentFocus && update.recentFocus.trim()) {
    nextProfile.recentFocus = update.recentFocus.trim().slice(0, 240)
  }
  if (update.lastWorkspace) nextProfile.lastWorkspace = update.lastWorkspace

  const changed = JSON.stringify(nextProfile) !== JSON.stringify(profile.stableProfile)
  if (!changed) return false

  const next: UserProfileDoc = {
    version: 2,
    updatedAt: new Date().toISOString(),
    stableProfile: nextProfile
  }
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return true
}

export async function loadUserProfileBrief(homeDir?: string): Promise<string | undefined> {
  const profile = await readUserProfile(homeDir)
  const sp = profile.stableProfile
  const lines: string[] = []
  if (sp.preferredLanguage) lines.push(`- preferred_language: ${sp.preferredLanguage}`)
  if (sp.codingLanguages.length > 0) lines.push(`- coding_languages: ${sp.codingLanguages.join(', ')}`)
  if (sp.environment.os || sp.environment.shell || sp.environment.packageManager || sp.environment.nodeVersion) {
    lines.push(
      `- environment: os=${sp.environment.os ?? 'unknown'}, shell=${sp.environment.shell ?? 'unknown'}, package_manager=${sp.environment.packageManager ?? 'unknown'}, node=${sp.environment.nodeVersion ?? 'unknown'}`
    )
  }
  if (sp.preferences.length > 0) lines.push(`- preferences: ${sp.preferences.join(' | ')}`)
  if (sp.recentFocus) lines.push(`- recent_focus: ${sp.recentFocus}`)
  if (sp.lastWorkspace) lines.push(`- last_workspace: ${sp.lastWorkspace}`)
  if (lines.length === 0) return undefined
  return lines.join('\n')
}
