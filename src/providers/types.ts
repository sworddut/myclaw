export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[]): Promise<string>
}
