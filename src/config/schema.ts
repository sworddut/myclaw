import {z} from 'zod'
import {getMemoryPath, getMyclawHome} from './paths.js'

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
  memoryFile: z.string().optional()
}).transform((config) => ({
  ...config,
  memoryFile: config.memoryFile ?? getMemoryPath()
}))

export type AppConfig = z.infer<typeof appConfigSchema>
