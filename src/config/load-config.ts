import {cosmiconfig} from 'cosmiconfig'
import dotenv from 'dotenv'
import {appConfigSchema, type AppConfig} from './schema.js'
import {getGlobalEnvPath} from './paths.js'

dotenv.config({path: getGlobalEnvPath()})
dotenv.config()

function nonEmpty(value?: string): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveIntFromEnv(name: string): number | undefined {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function booleanFromEnv(name: string): boolean | undefined {
  const raw = nonEmpty(process.env[name])?.toLowerCase()
  if (!raw) return undefined
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return undefined
}

export async function loadConfig(): Promise<AppConfig> {
  const explorer = cosmiconfig('myclaw')
  const result = await explorer.search()
  const base = (result?.config ?? {}) as Record<string, unknown>
  const baseRuntime = (base.runtime ?? {}) as Record<string, unknown>
  const baseChecks = (baseRuntime.checks ?? {}) as Record<string, unknown>
  const baseEslint = (baseChecks.eslint ?? {}) as Record<string, unknown>

  const merged: Record<string, unknown> = {
    ...base,
    provider: nonEmpty(process.env.MYCLAW_PROVIDER) ?? base.provider,
    model: nonEmpty(process.env.OPENAI_MODEL) ?? base.model,
    baseURL: nonEmpty(process.env.OPENAI_BASE_URL) ?? base.baseURL,
    runtime: {
      ...baseRuntime,
      ...(positiveIntFromEnv('MYCLAW_MODEL_TIMEOUT_MS')
        ? {modelTimeoutMs: positiveIntFromEnv('MYCLAW_MODEL_TIMEOUT_MS')}
        : {}),
      ...(positiveIntFromEnv('MYCLAW_MODEL_RETRY_COUNT')
        ? {modelRetryCount: positiveIntFromEnv('MYCLAW_MODEL_RETRY_COUNT')}
        : {}),
      ...(positiveIntFromEnv('MYCLAW_MAX_STEPS') ? {maxSteps: positiveIntFromEnv('MYCLAW_MAX_STEPS')} : {}),
      ...(positiveIntFromEnv('MYCLAW_CONTEXT_WINDOW_SIZE')
        ? {contextWindowSize: positiveIntFromEnv('MYCLAW_CONTEXT_WINDOW_SIZE')}
        : {}),
      checks: {
        ...baseChecks,
        eslint: {
          ...baseEslint,
          ...(booleanFromEnv('MYCLAW_ESLINT_CHECK_ENABLED') !== undefined
            ? {enabled: booleanFromEnv('MYCLAW_ESLINT_CHECK_ENABLED')}
            : {})
        }
      }
    }
  }

  return appConfigSchema.parse(merged)
}
