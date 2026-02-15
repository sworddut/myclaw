import {Args, Command, Flags} from '@oclif/core'
import {createInterface} from 'node:readline/promises'
import {stdin as stdIn, stdout as stdOut} from 'node:process'
import {runAgentTask, type AgentEvent} from '../core/agent.js'

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

function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'start':
      return `[${now()}] START provider=${event.provider} model=${event.model} workspace=${event.workspace}`
    case 'model_response':
      return `[${now()}] MODEL_RESPONSE step=${event.step}\n${shorten(event.content)}`
    case 'tool_call':
      return `[${now()}] TOOL_CALL step=${event.step} tool=${event.tool} input=${JSON.stringify(event.input)}`
    case 'tool_result':
      return `[${now()}] TOOL_RESULT step=${event.step} tool=${event.tool} ok=${event.ok}\n${shorten(event.output)}`
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
    nonInteractive: Flags.boolean({description: 'disable interactive approval for sensitive commands'})
  }

  static override args = {
    task: Args.string({description: 'task prompt', required: true})
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(Run)
    const output = await runAgentTask(args.task, {
      onSensitiveAction: async ({tool, command}) => {
        if (flags.nonInteractive || !stdIn.isTTY) {
          this.log(
            red(`[${now()}] ⚠️ SENSITIVE_REQUEST tool=${tool} auto=deny (non-interactive) command=${command}`)
          )
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
      },
      onEvent: flags.quiet
        ? undefined
        : (event) => {
            if (event.type === 'model_response' && !flags.verboseModel) return
            if (event.type === 'final') return
            this.log(formatEvent(event))
          }
    })
    this.log(output)
  }
}
