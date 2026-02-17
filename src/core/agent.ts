import {loadConfig} from '../config/load-config.js'
import {appendFile, mkdir, readdir, readFile} from 'node:fs/promises'
import {basename} from 'node:path'
import {MockProvider} from '../providers/mock-provider.js'
import {OpenAIProvider} from '../providers/openai-provider.js'
import type {ChatMessage, LLMProvider} from '../providers/types.js'
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

function providerFromConfig(name: string, model: string, baseURL?: string): LLMProvider {
  if (name === 'mock') return new MockProvider()
  if (name === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing. Set it in your environment or .env file.')
    }

    return new OpenAIProvider({
      apiKey,
      model,
      baseUrl: nonEmpty(baseURL) ?? nonEmpty(process.env.OPENAI_BASE_URL)
    })
  }

  throw new Error(`Provider '${name}' is not implemented yet.`)
}

type ToolName = 'read_file' | 'write_file' | 'apply_patch' | 'list_files' | 'search_workspace' | 'run_shell'

type ToolCall = {
  type: 'tool_call'
  tool: ToolName
  input: Record<string, unknown>
}

export type AgentEvent =
  | {type: 'start'; provider: string; model: string; workspace: string; sessionId: string}
  | {type: 'model_response'; step: number; content: string}
  | {type: 'tool_call'; step: number; tool: ToolName; input: Record<string, unknown>}
  | {type: 'tool_result'; step: number; tool: ToolName; ok: boolean; output: string}
  | {type: 'final'; step: number; content: string}
  | {type: 'max_steps'; step: number}

type AgentRunOptions = {
  onEvent?: (event: AgentEvent) => void
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

type SessionLogRecord = {
  ts: string
  type: string
  [key: string]: unknown
}

async function appendSessionLog(session: AgentSession, record: SessionLogRecord): Promise<void> {
  if (!session.logPath) return
  try {
    await appendFile(session.logPath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Best effort: logging must never break agent execution.
  }
}

function parseSessionIdFromPath(logPath: string): string {
  const fileName = basename(logPath)
  return fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : fileName
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

async function maybeCompressContext(session: AgentSession): Promise<void> {
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

    await appendSessionLog(session, {
      ts: summary.ts,
      type: 'summary',
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

function parseToolCalls(text: string): ToolCall[] {
  const block = extractJsonBlock(text)
  const candidates = block ? [block] : extractJsonObjects(text)
  const calls: ToolCall[] = []

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ToolCall>
      if (parsed.type !== 'tool_call') continue
      if (!parsed.tool || !parsed.input) continue
      calls.push(parsed as ToolCall)
    } catch {
      continue
    }
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
        const content = String(toolCall.input.content ?? '')
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
    'When you need to operate files or shell, respond with ONLY JSON:',
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
    'Use relative paths. Never wrap JSON with extra prose when calling tools.',
    'When finished, return a normal natural-language summary.'
  ].join('\n')
}

function buildContext(messages: ChatMessage[], windowSize: number): ChatMessage[] {
  const systemMessage = messages.find((message) => message.role === 'system')
  const nonSystem = messages.filter((message) => message.role !== 'system')
  const recent = nonSystem.slice(-windowSize)
  return systemMessage ? [systemMessage, ...recent] : recent
}

function buildContextFromSession(session: AgentSession, windowSize: number): ChatMessage[] {
  const systemMessage = session.messages.find((message) => message.role === 'system')
  const nonSystem = session.messages.filter((message) => message.role !== 'system')
  const start = Math.max(session.compressedCount, nonSystem.length - windowSize)
  const recent = nonSystem.slice(start)
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
  const provider = providerFromConfig(config.provider, resolvedModel, config.baseURL)
  return {config, resolvedModel, provider}
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
  const {config, resolvedModel, provider} = await resolveRuntime()
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
    readPaths: new Set<string>(),
    summaries: [],
    compressedCount: 0,
    messages: [{role: 'system', content: systemPrompt}]
  })
  created.logPath = getSessionLogPath(created.id, config.homeDir)

  await appendSessionLog(created, {
    ts: new Date().toISOString(),
    type: 'session_start',
    sessionId: created.id,
    workspace
  })
  await appendSessionLog(created, {
    ts: new Date().toISOString(),
    type: 'message',
    role: 'system',
    content: systemPrompt
  })

  options.onEvent?.({
    type: 'start',
    provider: config.provider,
    model: resolvedModel,
    workspace,
    sessionId: created.id
  })

  return created.id
}

export async function resumeAgentSession(sessionId: string, options: AgentRunOptions = {}): Promise<string> {
  if (sessionStore.has(sessionId)) return sessionId

  const {config, resolvedModel, provider} = await resolveRuntime()
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
      restoredMessages.push({role, content})
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
    readPaths: new Set<string>(),
    summaries: restoredSummaries,
    compressedCount,
    messages: restoredMessages
  })

  const resumed = sessionStore.get(sessionId)
  await appendSessionLog(resumed, {
    ts: new Date().toISOString(),
    type: 'session_resume',
    sessionId
  })

  options.onEvent?.({
    type: 'start',
    provider: config.provider,
    model: resolvedModel,
    workspace,
    sessionId
  })

  return sessionId
}

export async function runAgentTurn(
  sessionId: string,
  userMessage: string,
  options: AgentRunOptions = {}
): Promise<string> {
  const session = sessionStore.get(sessionId)
  const maxSteps = options.maxSteps ?? 8
  const contextWindowSize = options.contextWindowSize ?? CONTEXT_WINDOW_SIZE

  session.messages.push({role: 'user', content: userMessage})
  await appendSessionLog(session, {
    ts: new Date().toISOString(),
    type: 'message',
    role: 'user',
    content: userMessage
  })

  for (let step = 0; step < maxSteps; step += 1) {
    await maybeCompressContext(session)
    const context = buildContextFromSession(session, contextWindowSize)
    const assistantText = await session.provider.chat(context)
    options.onEvent?.({type: 'model_response', step, content: assistantText})
    session.messages.push({role: 'assistant', content: assistantText})
    await appendSessionLog(session, {
      ts: new Date().toISOString(),
      type: 'message',
      role: 'assistant',
      step,
      content: assistantText
    })

    const toolCalls = parseToolCalls(assistantText)
    if (toolCalls.length === 0) {
      options.onEvent?.({type: 'final', step, content: assistantText})
      return assistantText
    }

    if (mutationCount(toolCalls) > 1) {
      const output = 'Batch rejected: only one mutation tool (write_file/apply_patch) is allowed per step.'
      const mutationTool = toolCalls.find((call) => call.tool === 'write_file' || call.tool === 'apply_patch')
      options.onEvent?.({
        type: 'tool_result',
        step,
        tool: mutationTool?.tool ?? 'write_file',
        ok: false,
        output
      })
      session.messages.push({
        role: 'tool',
        content: `TOOL_RESULT ${JSON.stringify({tool: 'batch_validation', ok: false, output})}`
      })
      await appendSessionLog(session, {
        ts: new Date().toISOString(),
        type: 'message',
        role: 'tool',
        step,
        content: `TOOL_RESULT ${JSON.stringify({tool: 'batch_validation', ok: false, output})}`
      })
      continue
    }

    for (const toolCall of toolCalls) {
      options.onEvent?.({type: 'tool_call', step, tool: toolCall.tool, input: toolCall.input})
      const result = await executeTool(toolCall, session, options)
      options.onEvent?.({
        type: 'tool_result',
        step,
        tool: toolCall.tool,
        ok: result.ok,
        output: result.output
      })
      session.messages.push({
        role: 'tool',
        content: `TOOL_RESULT ${JSON.stringify({tool: toolCall.tool, ...result})}`
      })
      await appendSessionLog(session, {
        ts: new Date().toISOString(),
        type: 'message',
        role: 'tool',
        step,
        content: `TOOL_RESULT ${JSON.stringify({tool: toolCall.tool, ...result})}`
      })
    }
  }

  options.onEvent?.({type: 'max_steps', step: maxSteps})
  return 'Stopped after maximum tool steps. Please refine the task and retry.'
}

export function closeAgentSession(sessionId: string): void {
  const session = sessionStore.get(sessionId)
  void appendSessionLog(session, {
    ts: new Date().toISOString(),
    type: 'session_end',
    sessionId
  })
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
    closeAgentSession(sessionId)
  }
}
