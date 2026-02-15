export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[]): Promise<string>
}
