import {Command, Flags} from '@oclif/core'
import {createInterface} from 'node:readline/promises'
import {stdin as stdIn, stdout as stdOut} from 'node:process'
import {loadConfig} from '../config/load-config.js'
import {
  closeAgentSession,
  createAgentSession,
  getAgentSessionMessages,
  getAgentSessionSummaries,
  listPersistedSessionsForWorkspace,
  resumeAgentSession,
  runAgentTurn,
  type AgentEvent,
  type PersistedSessionSummary
} from '../core/agent.js'
import {InMemoryEventBus} from '../core/event-bus.js'
import {SessionLogSubscriber} from '../core/subscribers/session-log-subscriber.js'
import {MetricsSubscriber} from '../core/subscribers/metrics-subscriber.js'

const CHAT_COMMANDS = [
  '/help',
  '/exit',
  '/quit',
  '/clear',
  '/history',
  '/config',
  '/session',
  '/summary',
  '/sessions',
  '/use'
]

const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m'
}

function red(text: string): string {
  return `${ANSI.red}${text}${ANSI.reset}`
}

function redBold(text: string): string {
  return `${ANSI.red}${ANSI.bold}${text}${ANSI.reset}`
}

function cyan(text: string): string {
  return `${ANSI.cyan}${text}${ANSI.reset}`
}

function now(): string {
  return new Date().toISOString()
}

function shorten(text: string, max = 500): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...[truncated]`
}

function baseEventLine(event: AgentEvent): string {
  switch (event.type) {
    case 'start':
      return `[${now()}] START provider=${event.provider} model=${event.model} workspace=${event.workspace} session=${event.sessionId}`
    case 'session_resume':
      return `[${now()}] SESSION_RESUME session=${event.sessionId}`
    case 'session_end':
      return `[${now()}] SESSION_END session=${event.sessionId}`
    case 'message':
      return `[${now()}] MESSAGE session=${event.sessionId} role=${event.role} step=${event.step ?? '-'}`
    case 'summary':
      return `[${now()}] SUMMARY session=${event.sessionId} range=[${event.from}-${event.to}]`
    case 'context_trim':
      return `[${now()}] CONTEXT_TRIM session=${event.sessionId} dropped_tool_messages=${event.droppedToolMessages} window=${event.windowSize}`
    case 'model_request_start':
      return `[${now()}] MODEL_REQUEST_START step=${event.step}`
    case 'model_response':
      return `[${now()}] MODEL_RESPONSE step=${event.step}\n${shorten(event.content)}`
    case 'tool_call':
      return `[${now()}] TOOL_CALL step=${event.step} tool=${event.tool} input=${JSON.stringify(event.input)}`
    case 'tool_result':
      return `[${now()}] TOOL_RESULT step=${event.step} tool=${event.tool} ok=${event.ok}\n${shorten(event.output)}`
    case 'oscillation_observe':
      return `[${now()}] OSCILLATION_OBSERVE step=${event.step} window=${event.window} repeat_ratio=${event.repeatRatio} novelty_ratio=${event.noveltyRatio} no_mutation_steps=${event.noMutationSteps} possible=${event.possibleOscillation}`
    case 'review_start':
      return `[${now()}] REVIEW_START file=${event.file} linter=${event.linter}`
    case 'review_pass':
      return `[${now()}] REVIEW_PASS file=${event.file} linter=${event.linter}`
    case 'review_fail':
      return `[${now()}] REVIEW_FAIL file=${event.file} linter=${event.linter}\n${shorten(event.output)}`
    case 'final':
      return `[${now()}] FINAL step=${event.step}\n${shorten(event.content)}`
    case 'max_steps':
      return `[${now()}] MAX_STEPS step=${event.step}`
  }
}

function printHelp(log: (line: string) => void): void {
  log(cyan('chat commands:'))
  log(cyan('  /help                    show this help'))
  log(cyan('  /exit or /quit           exit chat'))
  log(cyan('  /clear                   clear current session history'))
  log(cyan('  /history [n]             show recent non-system messages (default 20)'))
  log(cyan('  /config                  print resolved config'))
  log(cyan('  /session                 show current session id and message count'))
  log(cyan('  /summary [n]             show recent summary blocks (default 3)'))
  log(cyan('  /sessions [n]            list recent sessions for current workspace'))
  log(cyan('  /use <id|index|latest>   switch to a persisted session'))
}

function createCompleter() {
  return (line: string): [string[], string] => {
    if (!line.startsWith('/')) return [[], line]
    const hits = CHAT_COMMANDS.filter((command) => command.startsWith(line))
    return [hits.length > 0 ? hits : CHAT_COMMANDS, line]
  }
}

function pickSession(
  summaries: PersistedSessionSummary[],
  specifier: string
): PersistedSessionSummary | undefined {
  if (specifier === 'latest') return summaries[0]
  const numeric = Number.parseInt(specifier, 10)
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= summaries.length) {
    return summaries[numeric - 1]
  }
  return summaries.find((item) => item.sessionId === specifier)
}

export default class Chat extends Command {
  static override description = 'Interactive chat mode with in-memory session loop'

  static override flags = {
    quiet: Flags.boolean({description: 'hide execution logs and show only assistant responses'}),
    verboseModel: Flags.boolean({description: 'show raw model responses for each step'}),
    nonInteractive: Flags.boolean({description: 'disable interactive approval for sensitive commands'}),
    debug: Flags.boolean({description: 'show timing debug info'}),
    resume: Flags.string({description: 'resume from session id or latest'})
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Chat)
    const rl = createInterface({input: stdIn, output: stdOut, completer: createCompleter()})
    let sessionId = ''
    const startedAt = Date.now()
    let lastEventAt = startedAt
    const bus = new InMemoryEventBus<AgentEvent>()
    const sessionLogSubscriber = new SessionLogSubscriber()
    const metricsSubscriber = new MetricsSubscriber()
    const unsubscribeLog = bus.subscribe((event) => {
      void sessionLogSubscriber.handle(event)
    })
    const unsubscribeMetrics = bus.subscribe((event) => {
      void metricsSubscriber.handle(event)
    })

    const unsubscribe = flags.quiet
      ? () => {}
      : bus.subscribe((event: AgentEvent) => {
          if (
            event.type === 'message' ||
            event.type === 'summary' ||
            event.type === 'session_resume' ||
            event.type === 'session_end'
          ) {
            return
          }
          if (event.type === 'model_response' && !flags.verboseModel) return
          if (event.type === 'final') return
          const base = baseEventLine(event)
          if (!flags.debug) {
            this.log(base)
            return
          }

          const nowAt = Date.now()
          const totalMs = nowAt - startedAt
          const deltaMs = nowAt - lastEventAt
          lastEventAt = nowAt
          this.log(`[debug +${deltaMs}ms total=${totalMs}ms] ${base}`)
        })

    try {
      if (flags.resume) {
        const workspace = (await loadConfig()).workspace
        const summaries = await listPersistedSessionsForWorkspace(workspace)
        const target = pickSession(summaries, flags.resume)
        if (!target) {
          this.log(red(`No session found for --resume ${flags.resume}`))
          sessionId = await createAgentSession({bus})
        } else {
          sessionId = await resumeAgentSession(target.sessionId, {bus})
          this.log(cyan(`resumed session: ${target.sessionId}`))
        }
      } else {
        sessionId = await createAgentSession({bus})
      }

      this.log(cyan('myclaw chat started. Type /help for commands.'))

      while (true) {
        let input = ''
        try {
          input = (await rl.question(cyan('you> '))).trim()
        } catch {
          this.log(cyan('\nInterrupted. Type /exit to quit.'))
          continue
        }

        if (!input) continue
        if (input === '/exit' || input === '/quit') break

        if (input === '/help') {
          printHelp((line) => this.log(line))
          continue
        }

        if (input === '/clear') {
          closeAgentSession(sessionId, {bus})
          sessionId = await createAgentSession({bus})
          this.log(cyan('session cleared'))
          continue
        }

        if (input.startsWith('/history')) {
          const maybeCount = Number.parseInt(input.split(/\s+/)[1] ?? '20', 10)
          const count = Number.isFinite(maybeCount) && maybeCount > 0 ? maybeCount : 20
          const messages = getAgentSessionMessages(sessionId)
            .filter((message) => message.role !== 'system')
            .slice(-count)
          if (messages.length === 0) {
            this.log(cyan('(history empty)'))
            continue
          }

          for (const message of messages) {
            this.log(`${message.role}> ${shorten(message.content, 300)}`)
          }
          continue
        }

        if (input === '/config') {
          const config = await loadConfig()
          this.log(JSON.stringify(config, null, 2))
          continue
        }

        if (input === '/session') {
          const messages = getAgentSessionMessages(sessionId)
          const nonSystem = messages.filter((message) => message.role !== 'system').length
          this.log(cyan(`session: ${sessionId} messages(non-system): ${nonSystem}`))
          continue
        }

        if (input.startsWith('/summary')) {
          const maybeCount = Number.parseInt(input.split(/\s+/)[1] ?? '3', 10)
          const count = Number.isFinite(maybeCount) && maybeCount > 0 ? maybeCount : 3
          const summaries = getAgentSessionSummaries(sessionId).slice(-count)
          if (summaries.length === 0) {
            this.log(cyan('(no summary blocks yet)'))
            continue
          }

          summaries.forEach((summary, index) => {
            this.log(cyan(`summary ${index + 1}: [${summary.from}-${summary.to}] ts=${summary.ts}`))
            this.log(summary.content)
          })
          continue
        }

        if (input.startsWith('/sessions')) {
          const maybeCount = Number.parseInt(input.split(/\s+/)[1] ?? '20', 10)
          const count = Number.isFinite(maybeCount) && maybeCount > 0 ? maybeCount : 20
          const workspace = (await loadConfig()).workspace
          const summaries = (await listPersistedSessionsForWorkspace(workspace)).slice(0, count)
          if (summaries.length === 0) {
            this.log(cyan('(no persisted sessions for current workspace)'))
            continue
          }

          summaries.forEach((summary, index) => {
            this.log(
              `${index + 1}. ${summary.sessionId} messages=${summary.messageCount} updated=${summary.lastUpdatedAt ?? summary.startedAt ?? 'unknown'}`
            )
          })
          continue
        }

        if (input.startsWith('/use ')) {
          const specifier = input.split(/\s+/)[1]
          if (!specifier) {
            this.log(red('usage: /use <id|index|latest>'))
            continue
          }

          const workspace = (await loadConfig()).workspace
          const summaries = await listPersistedSessionsForWorkspace(workspace)
          const target = pickSession(summaries, specifier)
          if (!target) {
            this.log(red(`no session found for '${specifier}'`))
            continue
          }

          if (sessionId !== target.sessionId) {
            closeAgentSession(sessionId, {bus})
            sessionId = await resumeAgentSession(target.sessionId, {bus})
          }
          this.log(cyan(`switched to session: ${target.sessionId}`))
          continue
        }

        if (input.startsWith('/')) {
          this.log(red(`unknown command: ${input}`))
          this.log(cyan('type /help to see supported commands'))
          continue
        }

        const output = await runAgentTurn(sessionId, input, {
          bus,
          onSensitiveAction: async ({tool, command}) => {
            if (flags.nonInteractive || !stdIn.isTTY) {
              this.log(red(`[${now()}] ⚠️ SENSITIVE_REQUEST tool=${tool} auto=deny (non-interactive) command=${command}`))
              return false
            }

            this.log(redBold(`[${now()}] 🚨 WAITING FOR USER INPUT`))
            this.log(red(`[${now()}] ⚠️ SENSITIVE_REQUEST tool=${tool} command=${command}`))
            const answer = (await rl.question(redBold('🛑 Allow this sensitive command? [y/N] ')))
              .trim()
              .toLowerCase()
            return answer === 'y' || answer === 'yes'
          }
        })

        this.log(cyan('assistant>'))
        this.log(output)
      }
    } finally {
      if (sessionId) closeAgentSession(sessionId, {bus})
      await Promise.all([sessionLogSubscriber.flush(), metricsSubscriber.flush()])
      unsubscribe()
      unsubscribeLog()
      unsubscribeMetrics()
      rl.close()
    }
  }
}
