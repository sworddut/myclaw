import OpenAI from 'openai'
import type {ChatMessage, LLMProvider} from './types.js'

type OpenAIProviderOptions = {
  apiKey: string
  model: string
  baseUrl?: string
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

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  private readonly client: OpenAI
  private readonly model: string

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model
    const rawBaseUrl = options.baseUrl ?? 'https://api.openai.com/v1'
    const baseURL = rawBaseUrl.replace(/\/+$/, '')
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL
    })
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages
    })
    const content = extractText(completion)

    if (!content) {
      throw new Error(`OpenAI API returned no readable text. Response snippet: ${safeJsonSnippet(completion)}`)
    }

    return content
  }
}
