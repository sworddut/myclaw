export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
  /** Native tool_calls returned by the model; stored on assistant messages so the
   *  provider can replay them verbatim when rebuilding the conversation context. */
  toolCalls?: ProviderToolCall[]
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
