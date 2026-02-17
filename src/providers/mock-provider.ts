import type {ChatMessage, LLMProvider, ProviderResponse, ProviderToolDefinition} from './types.js'

export class MockProvider implements LLMProvider {
  readonly name = 'mock'

  async chat(messages: ChatMessage[], _tools?: ProviderToolDefinition[]): Promise<ProviderResponse> {
    const last = messages.at(-1)
    if (!last) return {text: 'No input provided.', toolCalls: []}
    return {text: `Mock response: ${last.content}`, toolCalls: []}
  }
}
