import {Command, Flags} from '@oclif/core'
import {mkdir, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {getMemoryPath, getMyclawHome} from '../config/paths.js'

export default class Init extends Command {
  static override description = 'Initialize local project config and global myclaw home'

  static override flags = {
    force: Flags.boolean({char: 'f', description: 'overwrite existing config'})
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Init)
    const targetDir = process.cwd()
    const homeDir = getMyclawHome()
    const memoryPath = getMemoryPath()
    const configPath = resolve(targetDir, '.myclawrc.json')
    const globalEnvExamplePath = resolve(homeDir, '.env.example')

    await mkdir(targetDir, {recursive: true})
    await mkdir(homeDir, {recursive: true})
    await writeFile(
      configPath,
      JSON.stringify(
        {
          provider: 'openai',
          model: '',
          baseURL: '',
          workspace: targetDir,
          homeDir,
          memoryFile: memoryPath
        },
        null,
        2
      ) + '\n',
      {flag: flags.force ? 'w' : 'wx'}
    )

    await writeFile(
      globalEnvExamplePath,
      'OPENAI_API_KEY=\nOPENAI_MODEL=gpt-4o-mini\nOPENAI_BASE_URL=\nANTHROPIC_API_KEY=\n',
      {flag: flags.force ? 'w' : 'wx'}
    )
    await writeFile(
      memoryPath,
      '# myclaw memory\n\n- Add durable preferences and project notes here.\n',
      {flag: flags.force ? 'w' : 'wx'}
    )

    this.log(`Created ${configPath}`)
    this.log(`Created ${globalEnvExamplePath}`)
    this.log(`Created ${memoryPath}`)
  }
}
