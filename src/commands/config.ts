import {Command} from '@oclif/core'
import {loadConfig} from '../config/load-config.js'

export default class Config extends Command {
  static override description = 'Print resolved config'

  public async run(): Promise<void> {
    const config = await loadConfig()
    this.log(JSON.stringify(config, null, 2))
  }
}
