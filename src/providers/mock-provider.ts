import type {ChatMessage, LLMProvider} from './types.js'

export class MockProvider implements LLMProvider {
  readonly name = 'mock'

  async chat(messages: ChatMessage[]): Promise<string> {
    const last = messages.at(-1)
    if (!last) return 'No input provided.'
    return `Mock response: ${last.content}`
  }
}
