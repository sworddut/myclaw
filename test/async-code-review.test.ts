import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {unlink, writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'

vi.mock('../src/tools/code-review.js', () => ({
  runCodeReview: vi.fn(),
}))

import {runCodeReview} from '../src/tools/code-review.js'
import {runAgentTask} from '../src/core/agent.js'

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {'Content-Type': 'application/json'},
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('async code review integration', () => {
  const targetFile = 'tmp-async-review.ts'

  beforeEach(() => {
    vi.mocked(runCodeReview).mockReset()
    process.env.OPENAI_API_KEY = 'test-key'
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    delete process.env.OPENAI_API_KEY
    try {
      if (existsSync(targetFile)) await unlink(targetFile)
    } catch {
      /* ignore */
    }
  })

  it('injects LINT_FAIL into next turn when review resolves async', async () => {
    let receivedLintFail = false

    vi.mocked(runCodeReview).mockImplementation(async () => {
      await delay(30)
      return {file: targetFile, linter: 'eslint', output: 'error: no-unused-vars'}
    })

    const fetchMock = vi.fn().mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const messages: Array<{role: string; content: string}> = body?.messages ?? []
      const anyHasLintFail = messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('LINT_FAIL') && m.content.includes(targetFile),
      )
      if (anyHasLintFail) receivedLintFail = true

      if (anyHasLintFail) {
        return jsonResponse({choices: [{message: {content: 'Lint error received and acknowledged.'}}]})
      }

      const hasWriteResult = messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('Wrote file') && m.content.includes(targetFile),
      )
      if (!hasWriteResult) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: `{"type":"tool_call","tool":"write_file","input":{"path":"${targetFile}","content":"const x = 1\\\\n","allowCreate":true}}`,
              },
            },
          ],
        })
      }

      return jsonResponse({choices: [{message: {content: 'Task done.'}}]})
    })
    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('create a ts file')
    expect(output).toContain('Lint error received and acknowledged')
    expect(receivedLintFail).toBe(true)
  })

  it('no interrupt when review passes (returns null)', async () => {
    vi.mocked(runCodeReview).mockImplementation(async () => {
      await delay(10)
      return null
    })

    const fetchMock = vi.fn().mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const messages: Array<{role: string; content: string}> = body?.messages ?? []
      const hasLintFail = messages.some((m) => typeof m.content === 'string' && m.content.includes('LINT_FAIL'))
      if (hasLintFail) {
        return jsonResponse({choices: [{message: {content: 'Unexpected LINT_FAIL'}}]})
      }
      const hasWriteResult = messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('Wrote file'),
      )
      if (!hasWriteResult) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: `{"type":"tool_call","tool":"write_file","input":{"path":"${targetFile}","content":"x\\\\n","allowCreate":true}}`,
              },
            },
          ],
        })
      }
      return jsonResponse({choices: [{message: {content: 'Done.'}}]})
    })
    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('create file')
    expect(output).toContain('Done.')
    expect(output).not.toContain('Unexpected LINT_FAIL')
  })

  it('LINT_FAIL via drain when review resolves before model responds', async () => {
    vi.mocked(runCodeReview).mockImplementation(async () => {
      await delay(5)
      return {file: targetFile, linter: 'eslint', output: 'unused'}
    })

    let sawLintFail = false
    const fetchMock = vi.fn().mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const messages: Array<{role: string; content: string}> = body?.messages ?? []
      if (messages.some((m) => typeof m.content === 'string' && m.content.includes('LINT_FAIL'))) {
        sawLintFail = true
        return jsonResponse({choices: [{message: {content: 'Got lint via drain.'}}]})
      }
      const hasWrite = messages.some((m) => typeof m.content === 'string' && m.content.includes('Wrote file'))
      if (!hasWrite) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: `{"type":"tool_call","tool":"write_file","input":{"path":"${targetFile}","content":"y\\\\n","allowCreate":true}}`,
              },
            },
          ],
        })
      }
      return jsonResponse({choices: [{message: {content: 'Done.'}}]})
    })
    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('create file')
    expect(sawLintFail).toBe(true)
    expect(output).toContain('Got lint via drain.')
  })
})
