import type {AgentEvent} from '../agent.js'
import {updateUserProfile, type UserProfileUpdate} from '../user-profile.js'

type SessionState = {
  workspace?: string
  recentUserMessages: string[]
  codingLanguages: Set<string>
  preferences: Set<string>
  preferredLanguage?: 'zh-CN' | 'en-US'
  environment: {
    os?: 'macOS' | 'Windows' | 'Linux'
    shell?: string
    packageManager?: 'npm' | 'pnpm' | 'yarn'
    nodeVersion?: string
  }
}

export class UserProfileSubscriber {
  private readonly sessions = new Map<string, SessionState>()
  private pending: Promise<void> = Promise.resolve()
  private readonly homeDir?: string

  constructor(options: {homeDir?: string} = {}) {
    this.homeDir = options.homeDir
  }

  async handle(event: AgentEvent): Promise<void> {
    if (event.type === 'start') {
      const state = this.sessions.get(event.sessionId) ?? {
        recentUserMessages: [],
        codingLanguages: new Set<string>(),
        preferences: new Set<string>(),
        environment: {}
      }
      state.workspace = event.workspace
      this.sessions.set(event.sessionId, state)
      return
    }

    if (event.type === 'message' && event.role === 'user') {
      const state = this.sessions.get(event.sessionId) ?? {
        recentUserMessages: [],
        codingLanguages: new Set<string>(),
        preferences: new Set<string>(),
        environment: {}
      }
      state.recentUserMessages.push(event.content)
      state.recentUserMessages = state.recentUserMessages.slice(-5)
      this.extractSignals(event.content, state)
      this.sessions.set(event.sessionId, state)
      return
    }

    if (event.type === 'summary') {
      const state = this.sessions.get(event.sessionId)
      if (!state) return
      this.extractSignals(event.content, state)
      this.enqueueUpdate({
        preferredLanguage: state.preferredLanguage,
        codingLanguages: [...state.codingLanguages],
        environment: state.environment,
        preferences: [...state.preferences],
        lastWorkspace: state.workspace
      })
      return
    }

    if (event.type === 'session_end') {
      const state = this.sessions.get(event.sessionId)
      if (!state) return
      const focus = this.buildRecentFocus(state.recentUserMessages)
      this.enqueueUpdate({
        preferredLanguage: state.preferredLanguage,
        codingLanguages: [...state.codingLanguages],
        environment: state.environment,
        preferences: [...state.preferences],
        recentFocus: focus,
        lastWorkspace: state.workspace
      })
      this.sessions.delete(event.sessionId)
    }
  }

  async flush(): Promise<void> {
    await this.pending.catch(() => undefined)
  }

  private enqueueUpdate(update: UserProfileUpdate): void {
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        const hasSignal =
          Boolean(update.preferredLanguage) ||
          Boolean(update.recentFocus) ||
          Boolean(update.lastWorkspace) ||
          Boolean(update.codingLanguages && update.codingLanguages.length > 0) ||
          Boolean(update.preferences && update.preferences.length > 0) ||
          Boolean(
            update.environment &&
              (update.environment.os ||
                update.environment.shell ||
                update.environment.packageManager ||
                update.environment.nodeVersion)
          )
        if (!hasSignal) return
        await updateUserProfile(update, this.homeDir)
      })
  }

  private buildRecentFocus(messages: string[]): string | undefined {
    const filtered = messages
      .map((item) => item.trim())
      .filter((item) => item.length >= 5 && !/^(hi|hello|你好|thanks|谢谢|ok)$/i.test(item))
    if (filtered.length === 0) return undefined
    return filtered.join(' | ').slice(0, 240)
  }

  private extractSignals(text: string, state: SessionState): void {
    const lower = text.toLowerCase()

    if (/[一-龥]/.test(text) || /中文|汉语/.test(text)) state.preferredLanguage = 'zh-CN'
    if (/\benglish\b|英文/.test(lower)) state.preferredLanguage = 'en-US'

    const langMap: Array<[RegExp, string]> = [
      [/\btypescript\b|\bts\b/, 'TypeScript'],
      [/\bjavascript\b|\bjs\b/, 'JavaScript'],
      [/\bpython\b|\bpy\b/, 'Python'],
      [/\bgo\b|\bgolang\b/, 'Go'],
      [/\bjava\b/, 'Java'],
      [/\brust\b/, 'Rust']
    ]
    for (const [pattern, name] of langMap) {
      if (pattern.test(lower)) state.codingLanguages.add(name)
    }

    if (/macos|mac\b|darwin/.test(lower)) state.environment.os = 'macOS'
    if (/windows|win32|\bwin\b/.test(lower)) state.environment.os = 'Windows'
    if (/linux|ubuntu|debian|centos/.test(lower)) state.environment.os = 'Linux'
    if (/\bzsh\b/.test(lower)) state.environment.shell = 'zsh'
    if (/\bbash\b/.test(lower)) state.environment.shell = 'bash'
    if (/\bfish\b/.test(lower)) state.environment.shell = 'fish'
    if (/\bpnpm\b/.test(lower)) state.environment.packageManager = 'pnpm'
    if (/\byarn\b/.test(lower)) state.environment.packageManager = 'yarn'
    if (/\bnpm\b/.test(lower)) state.environment.packageManager = 'npm'
    const nodeMatch = lower.match(/node(?:\.js)?\s*v?(\d+(?:\.\d+){0,2})/)
    if (nodeMatch?.[1]) state.environment.nodeVersion = nodeMatch[1]

    if (/先给结论|先说结论|结论先行/.test(text)) state.preferences.add('prefer conclusion first')
    if (/简洁|精简|简短/.test(text)) state.preferences.add('prefer concise response')
    if (/详细|展开|多讲/.test(text)) state.preferences.add('prefer detailed response')
    if (/先跑测试|先测一下/.test(text)) state.preferences.add('prefer running tests before summary')
    if (/只审查|不要改/.test(text)) state.preferences.add('review-only unless requested')
  }
}
