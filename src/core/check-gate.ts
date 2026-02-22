export type CheckFailure = {
  sessionId: string
  checker: 'eslint' | 'syntax' | 'python_syntax'
  path: string
  output: string
  createdAt: string
}

class CheckGate {
  private readonly failuresBySession = new Map<string, CheckFailure[]>()

  pushFailure(failure: CheckFailure): void {
    const list = this.failuresBySession.get(failure.sessionId) ?? []
    list.push(failure)
    this.failuresBySession.set(failure.sessionId, list.slice(-20))
  }

  popFailures(sessionId: string): CheckFailure[] {
    const list = this.failuresBySession.get(sessionId) ?? []
    this.failuresBySession.delete(sessionId)
    return list
  }
}

export const checkGate = new CheckGate()
