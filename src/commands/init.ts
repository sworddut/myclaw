import {Command, Flags} from '@oclif/core'
import {mkdir, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'

export default class Init extends Command {
  static override description = 'Initialize myclaw config in current directory'

  static override flags = {
    force: Flags.boolean({char: 'f', description: 'overwrite existing config'})
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Init)
    const targetDir = process.cwd()
    const configPath = resolve(targetDir, '.myclawrc.json')
    const envPath = resolve(targetDir, '.env.example')

    await mkdir(targetDir, {recursive: true})
    await writeFile(
      configPath,
      JSON.stringify(
        {
          provider: 'openai',
          model: '',
          baseURL: '',
          workspace: targetDir
        },
        null,
        2
      ) + '\n',
      {flag: flags.force ? 'w' : 'wx'}
    )

    await writeFile(
      envPath,
      'OPENAI_API_KEY=\nOPENAI_MODEL=gpt-4o-mini\nOPENAI_BASE_URL=\nANTHROPIC_API_KEY=\n',
      {flag: flags.force ? 'w' : 'wx'}
    )

    this.log(`Created ${configPath}`)
    this.log(`Created ${envPath}`)
  }
}
