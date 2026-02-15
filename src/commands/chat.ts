import {Command} from '@oclif/core'

export default class Chat extends Command {
  static override description = 'Interactive chat mode (scaffold only)'

  public async run(): Promise<void> {
    this.log('chat mode is scaffolded; interactive session will be implemented in next step.')
  }
}
