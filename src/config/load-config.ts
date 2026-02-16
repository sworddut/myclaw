import {cosmiconfig} from 'cosmiconfig'
import dotenv from 'dotenv'
import {appConfigSchema, type AppConfig} from './schema.js'
import {getGlobalEnvPath} from './paths.js'

dotenv.config({path: getGlobalEnvPath()})
dotenv.config()

export async function loadConfig(): Promise<AppConfig> {
  const explorer = cosmiconfig('myclaw')
  const result = await explorer.search()
  return appConfigSchema.parse(result?.config ?? {})
}
