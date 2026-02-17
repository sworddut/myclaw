export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
}

export type ProviderToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ProviderToolCall = {
  id?: string
  name: string
  input: Record<string, unknown>
}

export type ProviderResponse = {
  text: string
  toolCalls: ProviderToolCall[]
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], tools?: ProviderToolDefinition[]): Promise<ProviderResponse>
}
