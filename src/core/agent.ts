import {loadConfig} from '../config/load-config.js'
import {MockProvider} from '../providers/mock-provider.js'
import {OpenAIProvider} from '../providers/openai-provider.js'
import type {ChatMessage, LLMProvider} from '../providers/types.js'
import {
  applyTextPatch,
  fileExists,
  listFiles,
  readTextFile,
  resolveWorkspacePath,
  writeTextFile
} from '../tools/filesystem.js'
import {runShell} from '../tools/shell.js'

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

type ToolName = 'read_file' | 'write_file' | 'apply_patch' | 'list_files' | 'run_shell'

type ToolCall = {
  type: 'tool_call'
  tool: ToolName
  input: Record<string, unknown>
}

export type AgentEvent =
  | {type: 'start'; provider: string; model: string; workspace: string}
  | {type: 'model_response'; step: number; content: string}
  | {type: 'tool_call'; step: number; tool: ToolName; input: Record<string, unknown>}
  | {type: 'tool_result'; step: number; tool: ToolName; ok: boolean; output: string}
  | {type: 'final'; step: number; content: string}
  | {type: 'max_steps'; step: number}

type AgentRunOptions = {
  onEvent?: (event: AgentEvent) => void
  maxSteps?: number
  onSensitiveAction?: (request: {tool: ToolName; command: string}) => Promise<boolean> | boolean
}

type ExecutionState = {
  readPaths: Set<string>
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
  return `${tool} rejected: existing file '${path}' must be read_file first in this run.`
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
    /\brd\b/, // windows remove directory shorthand can appear in scripts
    /\bmv\b.+\s\/dev\/null/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\b/
  ]
  return patterns.some((pattern) => pattern.test(text))
}

async function executeTool(
  toolCall: ToolCall,
  workspace: string,
  state: ExecutionState,
  options: AgentRunOptions
): Promise<{ok: boolean; output: string}> {
  try {
    switch (toolCall.tool) {
      case 'read_file': {
        const path = String(toolCall.input.path ?? '')
        const content = await readTextFile(workspace, path)
        state.readPaths.add(resolveWorkspacePath(workspace, path))
        return {ok: true, output: content}
      }

      case 'write_file': {
        const path = String(toolCall.input.path ?? '')
        const content = String(toolCall.input.content ?? '')
        const allowCreate = Boolean(toolCall.input.allowCreate ?? false)
        const existing = await fileExists(workspace, path)
        const canonicalPath = resolveWorkspacePath(workspace, path)
        if (!existing && !allowCreate) {
          return {ok: false, output: createFileRejectedError(path)}
        }
        if (existing && !state.readPaths.has(canonicalPath)) {
          return {ok: false, output: readBeforeWriteError('write_file', path)}
        }
        await writeTextFile(workspace, path, content)
        state.readPaths.add(canonicalPath)
        return {ok: true, output: `Wrote file: ${path}`}
      }

      case 'apply_patch': {
        const path = String(toolCall.input.path ?? '')
        const search = String(toolCall.input.search ?? '')
        const replace = String(toolCall.input.replace ?? '')
        const replaceAll = Boolean(toolCall.input.replaceAll ?? false)
        const existing = await fileExists(workspace, path)
        const canonicalPath = resolveWorkspacePath(workspace, path)
        if (!existing) {
          return {ok: false, output: `apply_patch rejected: '${path}' does not exist.`}
        }
        if (existing && !state.readPaths.has(canonicalPath)) {
          return {ok: false, output: readBeforeWriteError('apply_patch', path)}
        }

        const output = await applyTextPatch(workspace, path, search, replace, replaceAll)
        state.readPaths.add(canonicalPath)
        return {ok: true, output}
      }

      case 'list_files': {
        const path = String(toolCall.input.path ?? '.')
        const files = await listFiles(workspace, path)
        return {ok: true, output: files.join('\n') || '(empty directory)'}
      }

      case 'run_shell': {
        const command = String(toolCall.input.command ?? '')
        if (looksDestructiveCommand(command)) {
          const approved = (await options.onSensitiveAction?.({tool: 'run_shell', command})) ?? false
          if (!approved) {
            return {ok: false, output: shellDangerRejectedError(command)}
          }
        }
        const output = await runShell(command, workspace)
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

export async function runAgentTask(task: string, options: AgentRunOptions = {}): Promise<string> {
  const config = await loadConfig()
  const resolvedModel = resolveModel(config.model)
  const provider = providerFromConfig(config.provider, resolvedModel, config.baseURL)
  const workspace = config.workspace
  const maxSteps = options.maxSteps ?? 8

  options.onEvent?.({
    type: 'start',
    provider: config.provider,
    model: resolvedModel,
    workspace
  })

  const messages: ChatMessage[] = [
    {
      role: 'system' as const,
      content: [
        `You are a coding agent running in workspace: ${workspace}.`,
        'When you need to operate files or shell, respond with ONLY JSON:',
        '{"type":"tool_call","tool":"read_file|write_file|apply_patch|list_files|run_shell","input":{...}}',
        'Available tools:',
        '- read_file: {"path":"relative/path"}',
        '- write_file: {"path":"relative/path","content":"...","allowCreate":false} (single-file full rewrite)',
        '- apply_patch: {"path":"relative/path","search":"old text","replace":"new text","replaceAll":false}',
        '- list_files: {"path":"relative/path optional"}',
        '- run_shell: {"command":"..."}',
        'Rules:',
        '- Existing files MUST be read_file before write_file/apply_patch.',
        '- New file creation is blocked by default.',
        '- To create files, write_file input.allowCreate=true is required.',
        '- Destructive shell commands (e.g., rm/rmdir/unlink/del/git reset --hard/git clean) are blocked.',
        '- You may call multiple read_file tools in one response.',
        '- At most one mutation tool (write_file or apply_patch) per response.',
        'Use relative paths. Never wrap JSON with extra prose when calling tools.',
        'When finished, return a normal natural-language summary.'
      ].join('\n')
    },
    {role: 'user' as const, content: task}
  ]
  const state: ExecutionState = {readPaths: new Set<string>()}

  for (let step = 0; step < maxSteps; step += 1) {
    const assistantText = await provider.chat(messages)
    options.onEvent?.({type: 'model_response', step, content: assistantText})
    const toolCalls = parseToolCalls(assistantText)

    if (toolCalls.length === 0) {
      options.onEvent?.({type: 'final', step, content: assistantText})
      return assistantText
    }

    messages.push({role: 'assistant', content: assistantText})
    if (mutationCount(toolCalls) > 1) {
      const output = 'Batch rejected: only one mutation tool (write_file/apply_patch) is allowed per step.'
      options.onEvent?.({
        type: 'tool_result',
        step,
        tool: toolCalls.find((call) => call.tool === 'write_file' || call.tool === 'apply_patch')?.tool ?? 'write_file',
        ok: false,
        output
      })
      messages.push({
        role: 'user',
        content: `TOOL_RESULT ${JSON.stringify({tool: 'batch_validation', ok: false, output})}`
      })
      continue
    }

    for (const toolCall of toolCalls) {
      options.onEvent?.({type: 'tool_call', step, tool: toolCall.tool, input: toolCall.input})
      const result = await executeTool(toolCall, workspace, state, options)
      options.onEvent?.({
        type: 'tool_result',
        step,
        tool: toolCall.tool,
        ok: result.ok,
        output: result.output
      })
      messages.push({
        role: 'user',
        content: `TOOL_RESULT ${JSON.stringify({tool: toolCall.tool, ...result})}`
      })
    }
  }

  options.onEvent?.({type: 'max_steps', step: maxSteps})
  return 'Stopped after maximum tool steps. Please refine the task and retry.'
}
