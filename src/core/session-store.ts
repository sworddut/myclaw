import {randomUUID} from 'node:crypto'
import type {ChatMessage, LLMProvider} from '../providers/types.js'

export type SessionSummaryBlock = {
  ts: string
  from: number
  to: number
  content: string
}

export type AgentSession = {
  id: string
  provider: LLMProvider
  workspace: string
  logPath?: string
  runtime: {
    maxSteps: number
    contextWindowSize: number
  }
  messages: ChatMessage[]
  summaries: SessionSummaryBlock[]
  compressedCount: number
  readPaths: Set<string>
}

export class InMemorySessionStore {
  private readonly sessions = new Map<string, AgentSession>()

  create(session: Omit<AgentSession, 'id'>): AgentSession {
    const id = randomUUID()
    const created: AgentSession = {id, ...session}
    this.sessions.set(id, created)
    return created
  }

  get(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  restore(session: AgentSession): AgentSession {
    this.sessions.set(session.id, session)
    return session
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
