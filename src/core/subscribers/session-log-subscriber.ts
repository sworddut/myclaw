import {appendFile, mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import type {AgentEvent} from '../agent.js'

type SessionLogRecord = {
  ts: string
  type: string
  [key: string]: unknown
}

export class SessionLogSubscriber {
  private readonly logPaths = new Map<string, string>()
  private readonly pendingBySession = new Map<string, Promise<void>>()

  async handle(event: AgentEvent): Promise<void> {
    const ts = new Date().toISOString()

    if (event.type === 'start') {
      this.logPaths.set(event.sessionId, event.logPath)
      await this.append(event.sessionId, {
        ts,
        type: 'session_start',
        sessionId: event.sessionId,
        provider: event.provider,
        model: event.model,
        baseURL: event.baseURL,
        workspace: event.workspace
      })
      await this.append(event.sessionId, {
        ts,
        type: 'message',
        role: 'system',
        content: event.systemPrompt
      })
      return
    }

    if (event.type === 'session_resume') {
      await this.append(event.sessionId, {ts, type: 'session_resume', sessionId: event.sessionId})
      return
    }

    if (event.type === 'session_end') {
      await this.append(event.sessionId, {ts, type: 'session_end', sessionId: event.sessionId})
      this.logPaths.delete(event.sessionId)
      this.pendingBySession.delete(event.sessionId)
      return
    }

    if (event.type === 'message') {
      await this.append(event.sessionId, {
        ts,
        type: 'message',
        role: event.role,
        step: event.step,
        content: event.content,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolCalls: event.toolCalls
      })
      return
    }

    if (event.type === 'summary') {
      await this.append(event.sessionId, {
        ts,
        type: 'summary',
        from: event.from,
        to: event.to,
        content: event.content
      })
    }
  }

  private async append(sessionId: string, record: SessionLogRecord): Promise<void> {
    const logPath = this.logPaths.get(sessionId)
    if (!logPath) return
    const previous = this.pendingBySession.get(sessionId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await mkdir(dirname(logPath), {recursive: true})
          await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8')
        } catch {
          // Best effort: logging must not break runtime.
        }
      })
    this.pendingBySession.set(sessionId, next)
    await next
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pendingBySession.values()].map((pending) => pending.catch(() => undefined)))
  }
}
