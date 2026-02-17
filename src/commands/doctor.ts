import {Command, Flags} from '@oclif/core'
import {existsSync} from 'node:fs'
import process from 'node:process'
import {loadConfig} from '../config/load-config.js'
import {getGlobalEnvPath, getMemoryPath, getMyclawHome} from '../config/paths.js'

type DoctorReport = {
  cliVersion: string
  nodeVersion: string
  platform: string
  cwd: string
  myclawHome: string
  globalEnvPath: string
  globalEnvExists: boolean
  localEnvPath: string
  localEnvExists: boolean
  memoryPath: string
  memoryExists: boolean
  env: {
    hasOpenAIKey: boolean
    hasOpenAIModel: boolean
    hasOpenAIBaseURL: boolean
    hasAnthropicKey: boolean
  }
  config: unknown
}

export default class Doctor extends Command {
  static override description = 'Print runtime diagnostics for config and environment'

  static override flags = {
    json: Flags.boolean({description: 'print JSON output'})
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Doctor)

    const localEnvPath = `${process.cwd()}/.env`
    const report: DoctorReport = {
      cliVersion: this.config.pjson.version,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd(),
      myclawHome: getMyclawHome(),
      globalEnvPath: getGlobalEnvPath(),
      globalEnvExists: existsSync(getGlobalEnvPath()),
      localEnvPath,
      localEnvExists: existsSync(localEnvPath),
      memoryPath: getMemoryPath(),
      memoryExists: existsSync(getMemoryPath()),
      env: {
        hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
        hasOpenAIModel: Boolean(process.env.OPENAI_MODEL),
        hasOpenAIBaseURL: Boolean(process.env.OPENAI_BASE_URL),
        hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY)
      },
      config: await loadConfig()
    }

    if (flags.json) {
      this.log(JSON.stringify(report, null, 2))
      return
    }

    this.log(`myclaw version: ${report.cliVersion}`)
    this.log(`node: ${report.nodeVersion}`)
    this.log(`platform: ${report.platform}`)
    this.log(`cwd: ${report.cwd}`)
    this.log(`myclaw home: ${report.myclawHome}`)
    this.log(`global env: ${report.globalEnvPath} (exists=${report.globalEnvExists})`)
    this.log(`local env: ${report.localEnvPath} (exists=${report.localEnvExists})`)
    this.log(`memory file: ${report.memoryPath} (exists=${report.memoryExists})`)
    this.log(
      `env flags: OPENAI_API_KEY=${report.env.hasOpenAIKey} OPENAI_MODEL=${report.env.hasOpenAIModel} OPENAI_BASE_URL=${report.env.hasOpenAIBaseURL} ANTHROPIC_API_KEY=${report.env.hasAnthropicKey}`
    )
    this.log('resolved config:')
    this.log(JSON.stringify(report.config, null, 2))
  }
}
