import {z} from 'zod'
import {getMemoryPath, getMyclawHome} from './paths.js'

const positiveInt = z.coerce.number().int().positive()

export const appConfigSchema = z.object({
  provider: z.enum(['mock', 'openai', 'anthropic']).default('openai'),
  model: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().optional()
  ),
  baseURL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().optional()
  ),
  workspace: z.string().default(process.cwd()),
  homeDir: z.string().default(getMyclawHome()),
  memoryFile: z.string().optional(),
  runtime: z
    .object({
      modelTimeoutMs: positiveInt.default(45_000),
      modelRetryCount: positiveInt.default(1),
      maxSteps: positiveInt.default(8),
      contextWindowSize: positiveInt.default(20),
      checks: z
        .object({
          eslint: z
            .object({
              enabled: z.boolean().default(true)
            })
            .default({})
        })
        .default({})
    })
    .default({}),
  review: z
    .object({
      enabled: z.boolean().default(true),
      tools: z.record(z.string(), z.string()).optional()
    })
    .default({})
}).transform((config) => ({
  ...config,
  memoryFile: config.memoryFile ?? getMemoryPath()
}))

export type AppConfig = z.infer<typeof appConfigSchema>
