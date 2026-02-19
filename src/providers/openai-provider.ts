import OpenAI from 'openai'
import type {
  ChatMessage,
  LLMProvider,
  ProviderResponse,
  ProviderToolCall,
  ProviderToolDefinition
} from './types.js'
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'

type OpenAIProviderOptions = {
  apiKey: string
  model: string
  baseUrl?: string
  timeoutMs?: number
  retryCount?: number
}

function safeJsonSnippet(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500)
  } catch {
    return '[unserializable response]'
  }
}

function extractText(data: any): string | undefined {
  const messageContent = data?.choices?.[0]?.message?.content
  if (typeof messageContent === 'string' && messageContent.trim()) {
    return messageContent
  }

  if (Array.isArray(messageContent)) {
    const joined = messageContent
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .join('')
      .trim()
    if (joined) return joined
  }

  const textField = data?.choices?.[0]?.text
  if (typeof textField === 'string' && textField.trim()) {
    return textField
  }

  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text
  }

  return undefined
}

function parseToolCalls(data: any): ProviderToolCall[] {
  const rawCalls = data?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(rawCalls)) return []

  const parsed: ProviderToolCall[] = []
  for (const call of rawCalls) {
    if (call?.type !== 'function') continue
    const name = call?.function?.name
    const rawArguments = call?.function?.arguments
    if (typeof name !== 'string' || !name) continue

    let input: Record<string, unknown> = {}
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        const maybeObject = JSON.parse(rawArguments)
        if (maybeObject && typeof maybeObject === 'object' && !Array.isArray(maybeObject)) {
          input = maybeObject as Record<string, unknown>
        }
      } catch {
        input = {}
      }
    }

    parsed.push({
      id: typeof call?.id === 'string' ? call.id : undefined,
      name,
      input
    })
  }

  return parsed
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  private readonly client: OpenAI
  private readonly model: string
  private readonly timeoutMs: number
  private readonly retryCount: number

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? 45_000
    this.retryCount = options.retryCount ?? 1
    const rawBaseUrl = options.baseUrl ?? 'https://api.openai.com/v1'
    const baseURL = rawBaseUrl.replace(/\/+$/, '')
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL
    })
  }

  private async createWithTimeout(request: ChatCompletionCreateParamsNonStreaming) {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const id = setTimeout(() => {
        reject(new Error(`Model request timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      // Prevent timers from keeping process alive on some runtimes.
      id.unref?.()
    })

    return (await Promise.race([this.client.chat.completions.create(request), timeoutPromise])) as Awaited<
      ReturnType<OpenAI['chat']['completions']['create']>
    >
  }

  async chat(messages: ChatMessage[], tools: ProviderToolDefinition[] = []): Promise<ProviderResponse> {
    const mappedMessages: ChatCompletionMessageParam[] = messages.map((message) => {
      if (message.role === 'tool') {
        if (message.toolCallId) {
          return {
            role: 'tool',
            content: message.content,
            tool_call_id: message.toolCallId,
            // Some OpenAI-compatible backends (e.g. Gemini adapters) require function name on tool responses.
            ...(message.toolName ? {name: message.toolName} : {})
          } as ChatCompletionMessageParam
        }

        return {
          role: 'user',
          content: `[tool] ${message.content}`
        }
      }

      return {
        role: message.role,
        content: message.content
      }
    })

    const mappedTools: ChatCompletionTool[] = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }))

    const request: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: mappedMessages,
      ...(mappedTools.length > 0 ? {tools: mappedTools, tool_choice: 'auto' as const} : {})
    }

    let lastError: unknown
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        const completion = await this.createWithTimeout(request)
        const content = extractText(completion)
        const toolCalls = parseToolCalls(completion)
        if (!content && toolCalls.length === 0) {
          throw new Error(`Model returned empty completion payload. Response snippet: ${safeJsonSnippet(completion)}`)
        }

        return {
          text: content ?? '',
          toolCalls
        }
      } catch (error) {
        lastError = error
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError)
    return {
      text: `Model request failed after ${this.retryCount + 1} attempts: ${message}`,
      toolCalls: []
    }
  }

  async healthCheck(): Promise<{ok: boolean; message?: string}> {
    try {
      await this.chat([{role: 'user', content: 'ping'}])
      return {ok: true}
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
