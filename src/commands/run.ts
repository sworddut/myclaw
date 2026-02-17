import {Args, Command, Flags} from '@oclif/core'
import {createInterface} from 'node:readline/promises'
import {stdin as stdIn, stdout as stdOut} from 'node:process'
import {runAgentTask, type AgentEvent} from '../core/agent.js'
import {InMemoryEventBus} from '../core/event-bus.js'
import {SessionLogSubscriber} from '../core/subscribers/session-log-subscriber.js'
import {MetricsSubscriber} from '../core/subscribers/metrics-subscriber.js'

const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  bold: '\x1b[1m'
}

function red(text: string): string {
  return `${ANSI.red}${text}${ANSI.reset}`
}

function redBold(text: string): string {
  return `${ANSI.red}${ANSI.bold}${text}${ANSI.reset}`
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
    case 'model_response':
      return `[${now()}] MODEL_RESPONSE step=${event.step}\n${shorten(event.content)}`
    case 'tool_call':
      return `[${now()}] TOOL_CALL step=${event.step} tool=${event.tool} input=${JSON.stringify(event.input)}`
    case 'tool_result':
      return `[${now()}] TOOL_RESULT step=${event.step} tool=${event.tool} ok=${event.ok}\n${shorten(event.output)}`
    case 'oscillation_observe':
      return `[${now()}] OSCILLATION_OBSERVE step=${event.step} window=${event.window} repeat_ratio=${event.repeatRatio} novelty_ratio=${event.noveltyRatio} no_mutation_steps=${event.noMutationSteps} possible=${event.possibleOscillation}`
    case 'final':
      return `[${now()}] FINAL step=${event.step}\n${shorten(event.content)}`
    case 'max_steps':
      return `[${now()}] MAX_STEPS step=${event.step}`
  }
}

export default class Run extends Command {
  static override description = 'Run a one-shot coding task'

  static override flags = {
    quiet: Flags.boolean({description: 'hide execution logs and print only final output'}),
    verboseModel: Flags.boolean({description: 'show raw model responses for each step'}),
    nonInteractive: Flags.boolean({description: 'disable interactive approval for sensitive commands'}),
    debug: Flags.boolean({description: 'show timing debug info'})
  }

  static override args = {
    task: Args.string({description: 'task prompt', required: true})
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(Run)
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
      : bus.subscribe((event) => {
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

    let output = ''
    try {
      output = await runAgentTask(args.task, {
        bus,
        onSensitiveAction: async ({tool, command}) => {
          if (flags.nonInteractive || !stdIn.isTTY) {
            this.log(red(`[${now()}] ⚠️ SENSITIVE_REQUEST tool=${tool} auto=deny (non-interactive) command=${command}`))
            return false
          }

          this.log(redBold(`[${now()}] 🚨 WAITING FOR USER INPUT`))
          this.log(red(`[${now()}] ⚠️ SENSITIVE_REQUEST tool=${tool} command=${command}`))
          const rl = createInterface({input: stdIn, output: stdOut})
          try {
            const answer = (await rl.question(redBold('🛑 Allow this sensitive command? [y/N] ')))
              .trim()
              .toLowerCase()
            return answer === 'y' || answer === 'yes'
          } finally {
            rl.close()
          }
        }
      })
    } finally {
      unsubscribe()
      unsubscribeLog()
      unsubscribeMetrics()
    }

    this.log(output)
  }
}
