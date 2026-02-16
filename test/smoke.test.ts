import {afterEach, describe, expect, it, vi} from 'vitest'
import {unlink, writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {runAgentTask} from '../src/core/agent.js'

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {'Content-Type': 'application/json'}
  })
}

describe('agent smoke test', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_BASE_URL
  })

  it('uses openai-compatible base url and model from env', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-test-model'
    process.env.OPENAI_BASE_URL = 'https://example-llm.com/v1/'
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      expect(url).toBe('https://example-llm.com/v1/chat/completions')
      const request = init?.body ? JSON.parse(String(init.body)) : null
      if (request?.model) expect(request.model).toBe('gpt-test-model')
      return jsonResponse({choices: [{message: {content: 'hello from openai'}}]})
    })
    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('hello')
    expect(output).toContain('hello from openai')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('accepts choices[0].text style responses', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({choices: [{text: 'hello from text field'}]})))

    const output = await runAgentTask('hello')
    expect(output).toContain('hello from text field')
  })

  it('rejects mutating an existing file before read_file', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const target = 'tmp-rule-test.txt'
    await writeFile(target, 'original\n', 'utf8')

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        return jsonResponse({
          choices: [
            {
              message: {
                content:
                  '{"type":"tool_call","tool":"write_file","input":{"path":"tmp-rule-test.txt","content":"changed\\n"}}'
              }
            }
          ]
        })
      })
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const request = init?.body ? JSON.parse(String(init.body)) : null
        const messages: Array<{role: string; content: string}> = request?.messages ?? []
        const toolResultMessage = messages.find((m) => m.role === 'user' && m.content.includes('TOOL_RESULT'))
        expect(toolResultMessage?.content).toContain('must be read_file first')
        return jsonResponse({choices: [{message: {content: 'rule enforced'}}]})
      })

    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('modify existing file')
    expect(output).toContain('rule enforced')
    await unlink(target)
  })

  it('rejects creating a new file without allowCreate', async () => {
    process.env.OPENAI_API_KEY = 'test-key'

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        return jsonResponse({
          choices: [
            {
              message: {
                content:
                  '{"type":"tool_call","tool":"write_file","input":{"path":"tmp-new-file.txt","content":"hello\\n"}}'
              }
            }
          ]
        })
      })
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const request = init?.body ? JSON.parse(String(init.body)) : null
        const messages: Array<{role: string; content: string}> = request?.messages ?? []
        const toolResultMessage = messages.find((m) => m.role === 'user' && m.content.includes('TOOL_RESULT'))
        expect(toolResultMessage?.content).toContain('does not exist')
        return jsonResponse({choices: [{message: {content: 'create blocked'}}]})
      })

    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('create file')
    expect(output).toContain('create blocked')
  })

  it('rejects destructive run_shell commands', async () => {
    process.env.OPENAI_API_KEY = 'test-key'

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        return jsonResponse({
          choices: [
            {
              message: {
                content: '{"type":"tool_call","tool":"run_shell","input":{"command":"rm -rf task"}}'
              }
            }
          ]
        })
      })
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const request = init?.body ? JSON.parse(String(init.body)) : null
        const messages: Array<{role: string; content: string}> = request?.messages ?? []
        const toolResultMessage = messages.find((m) => m.role === 'user' && m.content.includes('TOOL_RESULT'))
        expect(toolResultMessage?.content).toContain('destructive command blocked')
        return jsonResponse({choices: [{message: {content: 'danger blocked'}}]})
      })

    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('run dangerous command')
    expect(output).toContain('danger blocked')
  })

  it('allows destructive run_shell when user approves interactively', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const target = 'tmp-approved-delete.txt'
    await writeFile(target, 'x\n', 'utf8')

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        return jsonResponse({
          choices: [
            {
              message: {
                content: `{"type":"tool_call","tool":"run_shell","input":{"command":"rm -f ${target}"}}`
              }
            }
          ]
        })
      })
      .mockImplementation(async () => jsonResponse({choices: [{message: {content: 'approved'}}]}))

    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('run dangerous command with approval', {
      onSensitiveAction: async () => true
    })
    expect(output).toContain('approved')
    expect(existsSync(target)).toBe(false)
  })
})
