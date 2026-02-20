import {loadConfig} from '../config/load-config.js'
import {mkdir, readdir, readFile} from 'node:fs/promises'
import {basename} from 'node:path'
import {MockProvider} from '../providers/mock-provider.js'
import {OpenAIProvider} from '../providers/openai-provider.js'
import type {
  ChatMessage,
  LLMProvider,
  ProviderToolCall,
  ProviderToolDefinition
} from '../providers/types.js'
import {getSessionLogPath, getSessionsDir} from '../config/paths.js'
import {
  applyTextPatch,
  fileExists,
  listFiles,
  readTextFile,
  resolveWorkspacePath,
  searchWorkspaceFiles,
  writeTextFile
} from '../tools/filesystem.js'
import {runShell} from '../tools/shell.js'
import {AgentSession, InMemorySessionStore, type SessionSummaryBlock} from './session-store.js'
import type {EventBus} from './event-bus.js'

const sessionStore = new InMemorySessionStore()
const CONTEXT_WINDOW_SIZE = 20
const COMPRESSION_TRIGGER_SIZE = 40
const COMPRESSION_CHUNK_SIZE = 20
const MAX_SUMMARY_BLOCKS_IN_CONTEXT = 3

function nonEmpty(value?: string): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function resolveModel(configModel?: string): string {
  return nonEmpty(configModel) ?? nonEmpty(process.env.OPENAI_MODEL) ?? 'gpt-4o-mini'
}

function providerFromConfig(
  name: string,
  model: string,
  baseURL: string | undefined,
  runtime: {modelTimeoutMs: number; modelRetryCount: number}
): LLMProvider {
  if (name === 'mock') return new MockProvider()
  if (name === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing. Set it in your environment or .env file.')
    }

    return new OpenAIProvider({
      apiKey,
      model,
      baseUrl: nonEmpty(baseURL) ?? nonEmpty(process.env.OPENAI_BASE_URL),
      timeoutMs: runtime.modelTimeoutMs,
      retryCount: runtime.modelRetryCount
    })
  }

  throw new Error(`Provider '${name}' is not implemented yet.`)
}

type ToolName = 'read_file' | 'write_file' | 'apply_patch' | 'list_files' | 'search_workspace' | 'run_shell'

type ToolCall = {
  tool: ToolName
  input: Record<string, unknown>
  id?: string
}

const TOOL_DEFINITIONS: ProviderToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from workspace by relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {type: 'string'}
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'write_file',
    description: 'Write or create a UTF-8 text file. Existing files must be read first in this session.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {type: 'string'},
        content: {type: 'string'},
        allowCreate: {type: 'boolean'}
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'apply_patch',
    description: 'Patch one file by replacing search text with replacement text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {type: 'string'},
        search: {type: 'string'},
        replace: {type: 'string'},
        replaceAll: {type: 'boolean'}
      },
      required: ['path', 'search', 'replace'],
      additionalProperties: false
    }
  },
  {
    name: 'list_files',
    description: 'List files in a relative directory path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {type: 'string'}
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_workspace',
    description: 'Find file paths containing a query under workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {type: 'string'},
        path: {type: 'string'}
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'run_shell',
    description: 'Run a shell command in workspace and return output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string'}
      },
      required: ['command'],
      additionalProperties: false
    }
  }
]

export type AgentEvent =
  | {
      type: 'start'
      provider: string
      model: string
      baseURL?: string
      workspace: string
      sessionId: string
      logPath: string
      systemPrompt: string
    }
  | {type: 'session_resume'; sessionId: string}
  | {type: 'session_end'; sessionId: string}
  | {
      type: 'message'
      sessionId: string
      role: ChatMessage['role']
      content: string
      step?: number
      toolCallId?: string
      toolName?: string
      toolCalls?: ProviderToolCall[]
    }
  | {type: 'summary'; sessionId: string; from: number; to: number; content: string}
  | {type: 'context_trim'; sessionId: string; droppedToolMessages: number; windowSize: number}
  | {type: 'model_request_start'; sessionId: string; step: number}
  | {type: 'model_response'; sessionId: string; step: number; content: string}
  | {type: 'tool_call'; sessionId: string; step: number; tool: ToolName; input: Record<string, unknown>}
  | {type: 'tool_result'; sessionId: string; step: number; tool: ToolName; ok: boolean; output: string}
  | {
      type: 'oscillation_observe'
      sessionId: string
      step: number
      window: number
      repeatRatio: number
      noveltyRatio: number
      noMutationSteps: number
      possibleOscillation: boolean
    }
  | {type: 'final'; sessionId: string; step: number; content: string}
  | {type: 'max_steps'; sessionId: string; step: number}

type AgentRunOptions = {
  onEvent?: (event: AgentEvent) => void
  bus?: EventBus<AgentEvent>
  maxSteps?: number
  contextWindowSize?: number
  onSensitiveAction?: (request: {tool: ToolName; command: string}) => Promise<boolean> | boolean
}

export type PersistedSessionSummary = {
  sessionId: string
  workspace?: string
  startedAt?: string
  lastUpdatedAt?: string
  messageCount: number
  logPath: string
}

function parseSessionIdFromPath(logPath: string): string {
  const fileName = basename(logPath)
  return fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : fileName
}

type SessionLogRecord = {
  ts?: string
  type?: string
  role?: string
  content?: string
  toolCallId?: string
  toolName?: string
  toolCalls?: ProviderToolCall[]
  from?: number
  to?: number
  workspace?: string
  [key: string]: unknown
}

function summarizeMessages(messages: ChatMessage[]): string {
  const userNotes: string[] = []
  const assistantNotes: string[] = []
  const toolNotes: string[] = []

  for (const message of messages) {
    const text = message.content.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const short = text.length > 180 ? `${text.slice(0, 180)}...` : text

    if (message.role === 'user') userNotes.push(short)
    if (message.role === 'assistant') assistantNotes.push(short)
    if (message.role === 'tool') toolNotes.push(short)
  }

  const lines: string[] = []
  if (userNotes.length) lines.push(`user_intents: ${userNotes.slice(-3).join(' | ')}`)
  if (assistantNotes.length) lines.push(`assistant_actions: ${assistantNotes.slice(-3).join(' | ')}`)
  if (toolNotes.length) lines.push(`tool_results: ${toolNotes.slice(-5).join(' | ')}`)
  if (lines.length === 0) return '(summary empty)'
  return lines.join('\n')
}

function maybeCompressContext(session: AgentSession, options: AgentRunOptions): void {
  const nonSystemMessages = session.messages.filter((message) => message.role !== 'system')
  while (nonSystemMessages.length - session.compressedCount > COMPRESSION_TRIGGER_SIZE) {
    const chunkStart = session.compressedCount
    const chunk = nonSystemMessages.slice(chunkStart, chunkStart + COMPRESSION_CHUNK_SIZE)
    if (chunk.length === 0) break

    const summaryContent = summarizeMessages(chunk)
    const summary: SessionSummaryBlock = {
      ts: new Date().toISOString(),
      from: chunkStart,
      to: chunkStart + chunk.length - 1,
      content: summaryContent
    }
    session.summaries.push(summary)
    session.compressedCount += chunk.length

    emitEvent(options, {
      type: 'summary',
      sessionId: session.id,
      from: summary.from,
      to: summary.to,
      content: summary.content
    })
  }
}

async function parseSessionSummary(logPath: string): Promise<PersistedSessionSummary> {
  const raw = await readFile(logPath, 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  let workspace: string | undefined
  let startedAt: string | undefined
  let lastUpdatedAt: string | undefined
  let messageCount = 0

  for (const line of lines) {
    let record: SessionLogRecord
    try {
      record = JSON.parse(line) as SessionLogRecord
    } catch {
      continue
    }

    if (record.type === 'session_start') {
      workspace = typeof record.workspace === 'string' ? record.workspace : workspace
      startedAt = typeof record.ts === 'string' ? record.ts : startedAt
    }
    if (record.type === 'message') {
      messageCount += 1
    }
    if (typeof record.ts === 'string') {
      lastUpdatedAt = record.ts
    }
  }

  return {
    sessionId: parseSessionIdFromPath(logPath),
    workspace,
    startedAt,
    lastUpdatedAt,
    messageCount,
    logPath
  }
}

function extractJsonBlock(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/i)
  if (fenceMatch?.[1]) return fenceMatch[1]

  return undefined
}

function extractJsonObjects(text: string): string[] {
  const blocks: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (ch === '\\') {
        escaped = true
        continue
      }

      if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }

    if (ch === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }

  return blocks
}

function isToolName(value: string): value is ToolName {
  return (
    value === 'read_file' ||
    value === 'write_file' ||
    value === 'apply_patch' ||
    value === 'list_files' ||
    value === 'search_workspace' ||
    value === 'run_shell'
  )
}

function parseToolCalls(text: string): ToolCall[] {
  const block = extractJsonBlock(text)
  const candidates = block ? [block] : extractJsonObjects(text)
  const calls: ToolCall[] = []

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        type?: string
        tool?: unknown
        input?: unknown
      }
      if (parsed.type && parsed.type !== 'tool_call') continue
      if (typeof parsed.tool !== 'string' || !isToolName(parsed.tool)) continue
      if (!parsed.input || typeof parsed.input !== 'object' || Array.isArray(parsed.input)) continue
      calls.push({
        tool: parsed.tool,
        input: parsed.input as Record<string, unknown>
      })
    } catch {
      continue
    }
  }

  return calls
}

function normalizeProviderToolCalls(toolCalls: ProviderToolCall[]): ToolCall[] {
  const calls: ToolCall[] = []
  for (const toolCall of toolCalls) {
    if (!isToolName(toolCall.name)) continue
    calls.push({
      id: toolCall.id,
      tool: toolCall.name,
      input: toolCall.input
    })
  }
  return calls
}

function mutationCount(calls: ToolCall[]): number {
  return calls.filter((call) => call.tool === 'write_file' || call.tool === 'apply_patch').length
}

function readBeforeWriteError(tool: ToolName, path: string): string {
  return `${tool} rejected: existing file '${path}' must be read_file first in this session.`
}

function createFileRejectedError(path: string): string {
  return `write_file rejected: '${path}' does not exist. Read related files first and use apply_patch, or set allowCreate=true only when explicit file creation is required.`
}

function shellDangerRejectedError(command: string): string {
  return `run_shell rejected: destructive command blocked. command=${command}`
}

function normalizeWriteContent(content: string): string {
  // Tool-call JSON may decode "\r" and some "\n" escapes into raw control chars.
  // Convert them back to escaped sequences to keep source files syntactically stable.
  const withEscapedCarriage = content.replace(/\r/g, '\\r')
  return withEscapedCarriage.replace(/(["'])\n(?=[^\n]*\1)/g, '$1\\n')
}

function looksDestructiveCommand(command: string): boolean {
  const text = command.toLowerCase().trim()
  const patterns = [
    /\brm\b/,
    /\brmdir\b/,
    /\bunlink\b/,
    /\bdel\b/,
    /\brd\b/,
    /\bmv\b.+\s\/dev\/null/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\b/
  ]
  return patterns.some((pattern) => pattern.test(text))
}

function isLikelyReadOnlyLsCommand(command: string): boolean {
  const text = command.trim().toLowerCase()
  return /^ls(\s|$)/.test(text) || text === 'pwd'
}

function isLowValueExplorationCall(toolCall: ToolCall): boolean {
  if (toolCall.tool === 'list_files' || toolCall.tool === 'search_workspace') return true
  if (toolCall.tool === 'run_shell') {
    const command = String(toolCall.input.command ?? '')
    return isLikelyReadOnlyLsCommand(command)
  }
  return false
}

function toolCallSignature(toolCall: ToolCall): string {
  return `${toolCall.tool}:${JSON.stringify(toolCall.input)}`
}

function normalizeOutputForNovelty(output: string): string {
  const oneLine = output.replace(/\s+/g, ' ').trim()
  return oneLine.length > 220 ? oneLine.slice(0, 220) : oneLine
}

function ratio(value: number): number {
  return Number(value.toFixed(3))
}

function emitEvent(options: AgentRunOptions, event: AgentEvent): void {
  options.onEvent?.(event)
  options.bus?.publish(event)
}

async function executeTool(
  toolCall: ToolCall,
  session: AgentSession,
  options: AgentRunOptions
): Promise<{ok: boolean; output: string}> {
  try {
    switch (toolCall.tool) {
      case 'read_file': {
        const path = String(toolCall.input.path ?? '')
        const content = await readTextFile(session.workspace, path)
        session.readPaths.add(resolveWorkspacePath(session.workspace, path))
        return {ok: true, output: content}
      }

      case 'write_file': {
        const path = String(toolCall.input.path ?? '')
        const content = normalizeWriteContent(String(toolCall.input.content ?? ''))
        const allowCreate = Boolean(toolCall.input.allowCreate ?? false)
        const existing = await fileExists(session.workspace, path)
        const canonicalPath = resolveWorkspacePath(session.workspace, path)
        if (!existing && !allowCreate) {
          return {ok: false, output: createFileRejectedError(path)}
        }
        if (existing && !session.readPaths.has(canonicalPath)) {
          return {ok: false, output: readBeforeWriteError('write_file', path)}
        }
        await writeTextFile(session.workspace, path, content)
        session.readPaths.add(canonicalPath)
        return {ok: true, output: `Wrote file: ${path}`}
      }

      case 'apply_patch': {
        const path = String(toolCall.input.path ?? '')
        const search = String(toolCall.input.search ?? '')
        const replace = String(toolCall.input.replace ?? '')
        const replaceAll = Boolean(toolCall.input.replaceAll ?? false)
        const existing = await fileExists(session.workspace, path)
        const canonicalPath = resolveWorkspacePath(session.workspace, path)
        if (!existing) {
          return {ok: false, output: `apply_patch rejected: '${path}' does not exist.`}
        }
        if (!session.readPaths.has(canonicalPath)) {
          return {ok: false, output: readBeforeWriteError('apply_patch', path)}
        }

        const output = await applyTextPatch(session.workspace, path, search, replace, replaceAll)
        session.readPaths.add(canonicalPath)
        return {ok: true, output}
      }

      case 'list_files': {
        const path = String(toolCall.input.path ?? '.')
        const files = await listFiles(session.workspace, path)
        return {ok: true, output: files.join('\n') || '(empty directory)'}
      }

      case 'search_workspace': {
        const query = String(toolCall.input.query ?? '')
        const path = String(toolCall.input.path ?? '.')
        const files = await searchWorkspaceFiles(session.workspace, query, path)
        return {ok: true, output: files.join('\n') || '(no matches)'}
      }

      case 'run_shell': {
        const command = String(toolCall.input.command ?? '')
        if (looksDestructiveCommand(command)) {
          const approved = (await options.onSensitiveAction?.({tool: 'run_shell', command})) ?? false
          if (!approved) {
            return {ok: false, output: shellDangerRejectedError(command)}
          }
        }
        const output = await runShell(command, session.workspace)
        return {ok: true, output}
      }

      default:
        return {ok: false, output: `Unknown tool: ${String(toolCall.tool)}`}
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {ok: false, output: message}
  }
}

function buildSystemPrompt(workspace: string): string {
  return [
    `You are a coding agent running in workspace: ${workspace}.`,
    'Use available tools for file/shell operations.',
    'If the model/tooling does not support native tool calling, fallback to JSON:',
    '{"type":"tool_call","tool":"read_file|write_file|apply_patch|list_files|search_workspace|run_shell","input":{...}}',
    'Available tools:',
    '- read_file: {"path":"relative/path"}',
    '- write_file: {"path":"relative/path","content":"...","allowCreate":false} (single-file full rewrite)',
    '- apply_patch: {"path":"relative/path","search":"old text","replace":"new text","replaceAll":false}',
    '- list_files: {"path":"relative/path optional"}',
    '- search_workspace: {"query":"keyword","path":"relative/path optional"}',
    '- run_shell: {"command":"..."}',
    'Rules:',
    '- Existing files MUST be read_file before write_file/apply_patch.',
    '- New file creation is blocked by default.',
    '- To create files, write_file input.allowCreate=true is required.',
    '- Destructive shell commands (e.g., rm/rmdir/unlink/del/git reset --hard/git clean) are sensitive and need approval.',
    '- You may call multiple read_file tools in one response.',
    '- At most one mutation tool (write_file or apply_patch) per response.',
    '- Avoid repeated or equivalent exploration on the same path without new evidence.',
    '- If two consecutive exploration steps add little new information, stop and switch strategy.',
    '- For greetings, casual chat, or meta questions, do NOT call tools; answer directly.',
    'Use relative paths. Never wrap JSON with extra prose when calling tools.',
    'When finished, return a concise task report only (what changed + key result).',
    'Do not paste full file contents or large code blocks unless the user explicitly asks.'
  ].join('\n')
}

function normalizeFinalAssistantText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === 'Model returned an empty response after tool execution. No further action required.') {
    return '任务已执行完成（模型在收尾阶段返回空响应）。如果你愿意，我可以继续帮你验证文件内容或运行结果。'
  }
  return text
}

function buildContext(messages: ChatMessage[], windowSize: number): ChatMessage[] {
  const systemMessage = messages.find((message) => message.role === 'system')
  const nonSystem = messages.filter((message) => message.role !== 'system')
  const recent = nonSystem.slice(-windowSize)
  return systemMessage ? [systemMessage, ...recent] : recent
}

function buildContextFromSession(session: AgentSession, windowSize: number, options?: AgentRunOptions): ChatMessage[] {
  const systemMessage = session.messages.find((message) => message.role === 'system')
  const nonSystem = session.messages.filter((message) => message.role !== 'system')
  const start = Math.max(session.compressedCount, nonSystem.length - windowSize)
  let recent = nonSystem.slice(start)

  // If the window starts with one or more `tool` messages, their preceding
  // `assistant` message (which carries `tool_calls`) was cut off.  Sending
  // orphaned tool-result messages to OpenAI triggers a 400 error:
  // "messages with role 'tool' must be a response to a preceeding message
  // with 'tool_calls'".  Drop them from the front of the window so the
  // context always begins with a valid message.
  let trimIdx = 0
  while (trimIdx < recent.length && recent[trimIdx].role === 'tool') {
    trimIdx += 1
  }
  if (trimIdx > 0) {
    recent = recent.slice(trimIdx)
    emitEvent(options ?? {}, {
      type: 'context_trim',
      sessionId: session.id,
      droppedToolMessages: trimIdx,
      windowSize
    })
  }

  const summaryBlocks = session.summaries.slice(-MAX_SUMMARY_BLOCKS_IN_CONTEXT)
  const summaryMessage =
    summaryBlocks.length > 0
      ? ({
          role: 'system' as const,
          content: `Compressed memory blocks:\n${summaryBlocks
            .map((item) => `[${item.from}-${item.to}] ${item.content}`)
            .join('\n\n')}`
        })
      : undefined

  const base = systemMessage ? [systemMessage] : []
  return summaryMessage ? [...base, summaryMessage, ...recent] : [...base, ...recent]
}

async function resolveRuntime() {
  const config = await loadConfig()
  const resolvedModel = resolveModel(config.model)
  const provider = providerFromConfig(config.provider, resolvedModel, config.baseURL, config.runtime)
  const resolvedBaseURL = nonEmpty(config.baseURL) ?? nonEmpty(process.env.OPENAI_BASE_URL)
  return {config, resolvedModel, resolvedBaseURL, provider}
}

export async function listPersistedSessionsForWorkspace(workspace?: string): Promise<PersistedSessionSummary[]> {
  const {config} = await resolveRuntime()
  const targetWorkspace = workspace ?? config.workspace
  const sessionsDir = getSessionsDir(config.homeDir)
  let files: string[] = []
  try {
    files = await readdir(sessionsDir)
  } catch {
    return []
  }

  const jsonlFiles = files.filter((file) => file.endsWith('.jsonl'))
  const summaries: PersistedSessionSummary[] = []
  for (const file of jsonlFiles) {
    const logPath = `${sessionsDir}/${file}`
    try {
      const summary = await parseSessionSummary(logPath)
      if (!summary.workspace || summary.workspace === targetWorkspace) {
        summaries.push(summary)
      }
    } catch {
      continue
    }
  }

  return summaries.sort((a, b) => {
    const aTs = Date.parse(a.lastUpdatedAt ?? a.startedAt ?? '')
    const bTs = Date.parse(b.lastUpdatedAt ?? b.startedAt ?? '')
    return bTs - aTs
  })
}

export async function createAgentSession(options: AgentRunOptions = {}): Promise<string> {
  const {config, resolvedModel, resolvedBaseURL, provider} = await resolveRuntime()
  const workspace = config.workspace
  const systemPrompt = buildSystemPrompt(workspace)

  const sessionsDir = getSessionsDir(config.homeDir)
  const placeholderLogPath = getSessionLogPath('pending', config.homeDir)
  try {
    await mkdir(sessionsDir, {recursive: true})
  } catch {
    // Best effort only.
  }

  const created = sessionStore.create({
    provider,
    workspace,
    logPath: placeholderLogPath,
    runtime: {
      maxSteps: config.runtime.maxSteps,
      contextWindowSize: config.runtime.contextWindowSize
    },
    readPaths: new Set<string>(),
    summaries: [],
    compressedCount: 0,
    messages: [{role: 'system', content: systemPrompt}]
  })
  created.logPath = getSessionLogPath(created.id, config.homeDir)

  emitEvent(options, {
    type: 'start',
    provider: config.provider,
    model: resolvedModel,
    baseURL: resolvedBaseURL,
    workspace,
    sessionId: created.id,
    logPath: created.logPath,
    systemPrompt
  })

  return created.id
}

export async function resumeAgentSession(sessionId: string, options: AgentRunOptions = {}): Promise<string> {
  if (sessionStore.has(sessionId)) return sessionId

  const {config, resolvedModel, resolvedBaseURL, provider} = await resolveRuntime()
  const workspace = config.workspace
  const logPath = getSessionLogPath(sessionId, config.homeDir)
  const raw = await readFile(logPath, 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  const restoredMessages: ChatMessage[] = []
  const restoredSummaries: SessionSummaryBlock[] = []
  let compressedCount = 0

  for (const line of lines) {
    let record: SessionLogRecord
    try {
      record = JSON.parse(line) as SessionLogRecord
    } catch {
      continue
    }
    if (record.type !== 'message') continue
    const role = record.role
    const content = record.content
    if (
      (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') &&
      typeof content === 'string'
    ) {
      const restored: ChatMessage = {role, content}
      if (typeof record.toolCallId === 'string') restored.toolCallId = record.toolCallId
      if (typeof record.toolName === 'string') restored.toolName = record.toolName
      if (Array.isArray(record.toolCalls)) {
        restored.toolCalls = record.toolCalls.filter((item): item is ProviderToolCall => {
          if (!item || typeof item !== 'object') return false
          const candidate = item as Record<string, unknown>
          return typeof candidate.name === 'string' && typeof candidate.input === 'object' && candidate.input !== null
        })
      }
      restoredMessages.push(restored)
    }
    continue
  }

  for (const line of lines) {
    let record: SessionLogRecord
    try {
      record = JSON.parse(line) as SessionLogRecord
    } catch {
      continue
    }
    if (record.type !== 'summary') continue
    const from = typeof record.from === 'number' ? record.from : undefined
    const to = typeof record.to === 'number' ? record.to : undefined
    const content = typeof record.content === 'string' ? record.content : undefined
    const ts = typeof record.ts === 'string' ? record.ts : new Date().toISOString()
    if (from === undefined || to === undefined || !content) continue
    restoredSummaries.push({ts, from, to, content})
    compressedCount = Math.max(compressedCount, to + 1)
  }

  if (!restoredMessages.some((message) => message.role === 'system')) {
    restoredMessages.unshift({role: 'system', content: buildSystemPrompt(workspace)})
  }

  sessionStore.restore({
    id: sessionId,
    provider,
    workspace,
    logPath,
    runtime: {
      maxSteps: config.runtime.maxSteps,
      contextWindowSize: config.runtime.contextWindowSize
    },
    readPaths: new Set<string>(),
    summaries: restoredSummaries,
    compressedCount,
    messages: restoredMessages
  })

  emitEvent(options, {type: 'session_resume', sessionId})

  emitEvent(options, {
    type: 'start',
    provider: config.provider,
    model: resolvedModel,
    baseURL: resolvedBaseURL,
    workspace,
    sessionId,
    logPath,
    systemPrompt: restoredMessages.find((message) => message.role === 'system')?.content ?? buildSystemPrompt(workspace)
  })

  return sessionId
}

export async function runAgentTurn(
  sessionId: string,
  userMessage: string,
  options: AgentRunOptions = {}
): Promise<string> {
  const session = sessionStore.get(sessionId)
  const maxSteps = options.maxSteps ?? session.runtime.maxSteps
  const contextWindowSize = options.contextWindowSize ?? session.runtime.contextWindowSize
  const explorationCounts = new Map<string, number>()
  let workspaceVersion = 0
  const metricsWindow = 6
  const recentCallSignatures: string[] = []
  const recentOutputFingerprints: string[] = []
  let noMutationSteps = 0

  session.messages.push({role: 'user', content: userMessage})
  emitEvent(options, {type: 'message', sessionId, role: 'user', content: userMessage})

  for (let step = 0; step < maxSteps; step += 1) {
    maybeCompressContext(session, options)
    const context = buildContextFromSession(session, contextWindowSize, options)
    emitEvent(options, {type: 'model_request_start', sessionId, step})
    const providerResponse = await session.provider.chat(context, TOOL_DEFINITIONS)
    const assistantText = normalizeFinalAssistantText(providerResponse.text)
    const nativeCalls = normalizeProviderToolCalls(providerResponse.toolCalls)
    emitEvent(options, {type: 'model_response', sessionId, step, content: assistantText})
    session.messages.push({
      role: 'assistant',
      content: assistantText,
      // Persist native tool_calls so the provider can replay them in subsequent
      // turns; without this, OpenAI rejects the following tool-result messages
      // with "messages with role 'tool' must be a response to a preceeding
      // message with 'tool_calls'".
      ...(providerResponse.toolCalls.length > 0 ? {toolCalls: providerResponse.toolCalls} : {})
    })
    emitEvent(options, {
      type: 'message',
      sessionId,
      role: 'assistant',
      step,
      content: assistantText,
      ...(providerResponse.toolCalls.length > 0 ? {toolCalls: providerResponse.toolCalls} : {})
    })
    const fallbackCalls = parseToolCalls(assistantText)
    const toolCalls: ToolCall[] = nativeCalls.length > 0 ? nativeCalls : fallbackCalls
    if (toolCalls.length === 0) {
      emitEvent(options, {type: 'final', sessionId, step, content: assistantText})
      return assistantText
    }

    if (mutationCount(toolCalls) > 1) {
      const output = 'Batch rejected: only one mutation tool (write_file/apply_patch) is allowed per step.'
      const mutationTool = toolCalls.find((call) => call.tool === 'write_file' || call.tool === 'apply_patch')
      emitEvent(options, {
        type: 'tool_result',
        sessionId,
        step,
        tool: mutationTool?.tool ?? 'write_file',
        ok: false,
        output
      })
      session.messages.push({
        role: 'tool',
        content: `TOOL_RESULT ${JSON.stringify({tool: 'batch_validation', ok: false, output})}`,
        toolName: 'batch_validation'
      })
      emitEvent(options, {
        type: 'message',
        sessionId,
        role: 'tool',
        step,
        content: `TOOL_RESULT ${JSON.stringify({tool: 'batch_validation', ok: false, output})}`,
        toolName: 'batch_validation'
      })
      continue
    }

    let stepHasSuccessfulMutation = false

    for (const toolCall of toolCalls) {
      const signature = `${workspaceVersion}:${toolCallSignature(toolCall)}`
      if (isLowValueExplorationCall(toolCall)) {
        const count = (explorationCounts.get(signature) ?? 0) + 1
        explorationCounts.set(signature, count)
        if (count > 1) {
          const output = `Duplicate low-value exploration blocked: ${toolCall.tool} ${JSON.stringify(toolCall.input)}. Use existing results and continue.`
          emitEvent(options, {
            type: 'tool_result',
            sessionId,
            step,
            tool: toolCall.tool,
            ok: false,
            output
          })
          session.messages.push({
            role: 'tool',
            content: `TOOL_RESULT ${JSON.stringify({tool: toolCall.tool, ok: false, output})}`,
            toolCallId: toolCall.id,
            toolName: toolCall.tool
          })
          emitEvent(options, {
            type: 'message',
            sessionId,
            role: 'tool',
            step,
            content: `TOOL_RESULT ${JSON.stringify({tool: toolCall.tool, ok: false, output})}`,
            toolCallId: toolCall.id,
            toolName: toolCall.tool
          })
          continue
        }
      }

      emitEvent(options, {type: 'tool_call', sessionId, step, tool: toolCall.tool, input: toolCall.input})
      const result = await executeTool(toolCall, session, options)
      recentCallSignatures.push(signature)
      if (recentCallSignatures.length > metricsWindow) recentCallSignatures.shift()
      recentOutputFingerprints.push(normalizeOutputForNovelty(result.output))
      if (recentOutputFingerprints.length > metricsWindow) recentOutputFingerprints.shift()

      emitEvent(options, {
        type: 'tool_result',
        sessionId,
        step,
        tool: toolCall.tool,
        ok: result.ok,
        output: result.output
      })
      session.messages.push({
        role: 'tool',
        content: `TOOL_RESULT ${JSON.stringify({tool: toolCall.tool, ...result})}`,
        toolCallId: toolCall.id,
        toolName: toolCall.tool
      })
      emitEvent(options, {
        type: 'message',
        sessionId,
        role: 'tool',
        step,
        content: `TOOL_RESULT ${JSON.stringify({tool: toolCall.tool, ...result})}`,
        toolCallId: toolCall.id,
        toolName: toolCall.tool
      })

      if (result.ok && (toolCall.tool === 'write_file' || toolCall.tool === 'apply_patch')) {
        stepHasSuccessfulMutation = true
        workspaceVersion += 1
        explorationCounts.clear()
      }
    }

    if (toolCalls.length > 0) {
      noMutationSteps = stepHasSuccessfulMutation ? 0 : noMutationSteps + 1
      const uniqueCalls = new Set(recentCallSignatures).size
      const uniqueOutputs = new Set(recentOutputFingerprints.filter(Boolean)).size
      const repeatRatio = recentCallSignatures.length
        ? ratio((recentCallSignatures.length - uniqueCalls) / recentCallSignatures.length)
        : 0
      const noveltyRatio = recentOutputFingerprints.length
        ? ratio(uniqueOutputs / recentOutputFingerprints.length)
        : 0
      const possibleOscillation = repeatRatio >= 0.5 && noveltyRatio <= 0.5 && noMutationSteps >= 2

      emitEvent(options, {
        type: 'oscillation_observe',
        sessionId,
        step,
        window: metricsWindow,
        repeatRatio,
        noveltyRatio,
        noMutationSteps,
        possibleOscillation
      })
    }
  }

  emitEvent(options, {type: 'max_steps', sessionId, step: maxSteps})
  return 'Stopped after maximum tool steps. Please refine the task and retry.'
}

export function closeAgentSession(sessionId: string, options: AgentRunOptions = {}): void {
  const session = sessionStore.get(sessionId)
  emitEvent(options, {type: 'session_end', sessionId})
  sessionStore.delete(sessionId)
}

export function getAgentSessionMessages(sessionId: string): ChatMessage[] {
  const session = sessionStore.get(sessionId)
  return session.messages.map((message) => ({...message}))
}

export function getAgentSessionSummaries(sessionId: string): SessionSummaryBlock[] {
  const session = sessionStore.get(sessionId)
  return session.summaries.map((summary) => ({...summary}))
}

export async function runAgentTask(task: string, options: AgentRunOptions = {}): Promise<string> {
  const sessionId = await createAgentSession(options)
  try {
    return await runAgentTurn(sessionId, task, options)
  } finally {
    closeAgentSession(sessionId, options)
  }
}
