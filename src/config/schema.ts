import {z} from 'zod'

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
  workspace: z.string().default(process.cwd())
})

export type AppConfig = z.infer<typeof appConfigSchema>
