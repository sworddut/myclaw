import {afterEach, describe, expect, it, vi} from 'vitest'
import {unlink, writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {runAgentTask} from '../src/core/agent.js'

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
      const body = JSON.parse(String(init?.body)) as {model?: string}
      expect(body.model).toBe('gpt-test-model')
      return new Response(
        JSON.stringify({
          choices: [{message: {content: 'hello from openai'}}]
        }),
        {
          status: 200,
          headers: {'Content-Type': 'application/json'}
        }
      )
    })
    vi.stubGlobal(
      'fetch',
      fetchMock
    )

    const output = await runAgentTask('hello')
    expect(output).toContain('hello from openai')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('accepts choices[0].text style responses', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{text: 'hello from text field'}]
        }),
        {
          status: 200,
          headers: {'Content-Type': 'application/json'}
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

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
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"type":"tool_call","tool":"write_file","input":{"path":"tmp-rule-test.txt","content":"changed\\n"}}'
                }
              }
            ]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
      })
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{role: string; content: string}>
        }
        const toolResultMessage = body.messages.find((m) => m.role === 'user' && m.content.startsWith('TOOL_RESULT '))
        expect(toolResultMessage?.content).toContain('must be read_file first')
        return new Response(
          JSON.stringify({
            choices: [{message: {content: 'rule enforced'}}]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
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
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"type":"tool_call","tool":"write_file","input":{"path":"tmp-new-file.txt","content":"hello\\n"}}'
                }
              }
            ]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
      })
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{role: string; content: string}>
        }
        const toolResultMessage = body.messages.find((m) => m.role === 'user' && m.content.startsWith('TOOL_RESULT '))
        expect(toolResultMessage?.content).toContain('does not exist')
        return new Response(
          JSON.stringify({
            choices: [{message: {content: 'create blocked'}}]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
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
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"type":"tool_call","tool":"run_shell","input":{"command":"rm -rf task"}}'
                }
              }
            ]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
      })
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{role: string; content: string}>
        }
        const toolResultMessage = body.messages.find((m) => m.role === 'user' && m.content.startsWith('TOOL_RESULT '))
        expect(toolResultMessage?.content).toContain('destructive command blocked')
        return new Response(
          JSON.stringify({
            choices: [{message: {content: 'danger blocked'}}]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
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
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `{"type":"tool_call","tool":"run_shell","input":{"command":"rm -f ${target}"}}`
                }
              }
            ]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
      })
      .mockImplementationOnce(async () => {
        return new Response(
          JSON.stringify({
            choices: [{message: {content: 'approved'}}]
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        )
      })

    vi.stubGlobal('fetch', fetchMock)

    const output = await runAgentTask('run dangerous command with approval', {
      onSensitiveAction: async () => true
    })
    expect(output).toContain('approved')
    expect(existsSync(target)).toBe(false)
  })
})
