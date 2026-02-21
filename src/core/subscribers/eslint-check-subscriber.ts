import {execa} from 'execa'
import {access} from 'node:fs/promises'
import {constants} from 'node:fs'
import {resolve} from 'node:path'
import type {AgentEvent} from '../agent.js'
import {checkGate} from '../check-gate.js'

type SessionRuntime = {
  workspace: string
}

function shouldCheck(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py)$/i.test(path)
}

function shouldSyntaxCheck(path: string): boolean {
  return /\.(mjs|cjs|js)$/i.test(path)
}

function shouldPythonSyntaxCheck(path: string): boolean {
  return /\.py$/i.test(path)
}

function shouldEslintCheck(path: string): boolean {
  return /\.(ts|tsx|js|jsx)$/i.test(path)
}

function shortOutput(stdout: string, stderr: string): string {
  const merged = `${stdout}\n${stderr}`.trim()
  return merged.length > 4000 ? `${merged.slice(0, 4000)}\n...[truncated]` : merged
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function hasEslintConfig(workspace: string): Promise<boolean> {
  const candidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs']
  for (const candidate of candidates) {
    if (await fileExists(resolve(workspace, candidate))) return true
  }
  return false
}

export class EslintCheckSubscriber {
  private readonly sessions = new Map<string, SessionRuntime>()
  private pending: Promise<void> = Promise.resolve()

  async handle(event: AgentEvent): Promise<void> {
    if (event.type === 'start') {
      this.sessions.set(event.sessionId, {workspace: event.workspace})
      return
    }

    if (event.type === 'session_end') {
      this.sessions.delete(event.sessionId)
      return
    }

    if (event.type !== 'write_completed') return
    if (!shouldCheck(event.path)) return

    const runtime = this.sessions.get(event.sessionId)
    if (!runtime) return

    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        try {
          if (shouldSyntaxCheck(event.path)) {
            const syntax = await execa('node', ['--check', event.path], {
              cwd: runtime.workspace,
              reject: false,
              timeout: 10_000
            })
            if (syntax.exitCode !== 0) {
              checkGate.pushFailure({
                sessionId: event.sessionId,
                checker: 'syntax',
                path: event.path,
                output: shortOutput(syntax.stdout ?? '', syntax.stderr ?? '') || 'node --check failed',
                createdAt: new Date().toISOString()
              })
              return
            }
          }

          if (shouldPythonSyntaxCheck(event.path)) {
            const pySyntax = await execa('python3', ['-m', 'py_compile', event.path], {
              cwd: runtime.workspace,
              reject: false,
              timeout: 10_000
            })
            if (pySyntax.exitCode !== 0) {
              const pyOut = shortOutput(pySyntax.stdout ?? '', pySyntax.stderr ?? '') || 'python -m py_compile failed'
              // If python runtime is unavailable, skip silently.
              if (!/not found|command not found|no such file or directory/i.test(pyOut)) {
                checkGate.pushFailure({
                  sessionId: event.sessionId,
                  checker: 'python_syntax',
                  path: event.path,
                  output: pyOut,
                  createdAt: new Date().toISOString()
                })
              }
              return
            }
          }

          if (!shouldEslintCheck(event.path)) return
          if (!(await hasEslintConfig(runtime.workspace))) return

          const result = await execa('npx', ['--no-install', 'eslint', '--format', 'unix', event.path], {
            cwd: runtime.workspace,
            reject: false,
            timeout: 15_000
          })

          if (result.exitCode === 0) return
          // If eslint is unavailable, skip silently in this minimal experiment.
          const out = shortOutput(result.stdout ?? '', result.stderr ?? '')
          if (/could not determine executable to run|not found|command not found/i.test(out)) return

          checkGate.pushFailure({
            sessionId: event.sessionId,
            checker: 'eslint',
            path: event.path,
            output: out || `eslint failed with exit code ${result.exitCode}`,
            createdAt: new Date().toISOString()
          })
        } catch {
          // Best effort only.
        }
      })
  }

  async flush(): Promise<void> {
    await this.pending.catch(() => undefined)
  }
}
