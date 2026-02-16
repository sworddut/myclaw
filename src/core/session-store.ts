import {randomUUID} from 'node:crypto'
import type {ChatMessage, LLMProvider} from '../providers/types.js'

export type AgentSession = {
  id: string
  provider: LLMProvider
  workspace: string
  messages: ChatMessage[]
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

  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
