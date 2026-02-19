import {appendFile, mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import type {AgentEvent} from '../agent.js'
import {getMetricsLogPath} from '../../config/paths.js'

type MetricsState = {
  sessionId: string
  startedAtMs: number
  lastEventAtMs: number
  toolCalls: number
  toolErrors: number
  turns: number
  oscillationAlerts: number
}

type MetricsRecord = {
  ts: string
  type: string
  [key: string]: unknown
}

export class MetricsSubscriber {
  private readonly states = new Map<string, MetricsState>()
  private readonly logPaths = new Map<string, string>()
  private readonly pendingBySession = new Map<string, Promise<void>>()

  async handle(event: AgentEvent): Promise<void> {
    const nowMs = Date.now()
    const ts = new Date(nowMs).toISOString()

    if (event.type === 'start') {
      this.logPaths.set(event.sessionId, getMetricsLogPath(event.sessionId))
      this.states.set(event.sessionId, {
        sessionId: event.sessionId,
        startedAtMs: nowMs,
        lastEventAtMs: nowMs,
        toolCalls: 0,
        toolErrors: 0,
        turns: 0,
        oscillationAlerts: 0
      })
      await this.append(event.sessionId, {
        ts,
        type: 'metrics_start',
        provider: event.provider,
        model: event.model,
        workspace: event.workspace
      })
      return
    }

    if ('sessionId' in event && typeof event.sessionId === 'string') {
      const state = this.states.get(event.sessionId)
      if (!state) return
      const deltaMs = nowMs - state.lastEventAtMs
      state.lastEventAtMs = nowMs

      switch (event.type) {
        case 'model_request_start':
          await this.append(event.sessionId, {
            ts,
            type: 'model_request_start_metric',
            step: event.step,
            deltaMs
          })
          break
        case 'tool_call':
          state.toolCalls += 1
          await this.append(event.sessionId, {
            ts,
            type: 'tool_call_metric',
            step: event.step,
            tool: event.tool,
            deltaMs
          })
          break
        case 'tool_result':
          if (!event.ok) state.toolErrors += 1
          await this.append(event.sessionId, {
            ts,
            type: 'tool_result_metric',
            step: event.step,
            tool: event.tool,
            ok: event.ok,
            deltaMs
          })
          break
        case 'model_response':
          state.turns += 1
          await this.append(event.sessionId, {
            ts,
            type: 'model_metric',
            step: event.step,
            deltaMs
          })
          break
        case 'oscillation_observe':
          if (event.possibleOscillation) state.oscillationAlerts += 1
          await this.append(event.sessionId, {
            ts,
            type: 'oscillation_metric',
            step: event.step,
            repeatRatio: event.repeatRatio,
            noveltyRatio: event.noveltyRatio,
            noMutationSteps: event.noMutationSteps,
            possibleOscillation: event.possibleOscillation,
            deltaMs
          })
          break
        case 'session_end':
          await this.append(event.sessionId, {
            ts,
            type: 'metrics_summary',
            totalMs: nowMs - state.startedAtMs,
            turns: state.turns,
            toolCalls: state.toolCalls,
            toolErrors: state.toolErrors,
            oscillationAlerts: state.oscillationAlerts
          })
          this.states.delete(event.sessionId)
          break
      }
    }
  }

  private async append(sessionId: string, record: MetricsRecord): Promise<void> {
    const logPath = this.logPaths.get(sessionId)
    if (!logPath) return
    const previous = this.pendingBySession.get(sessionId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await mkdir(dirname(logPath), {recursive: true})
          await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8')
        } catch {
          // Best effort only.
        }
      })
    this.pendingBySession.set(sessionId, next)
    await next
  }
}
