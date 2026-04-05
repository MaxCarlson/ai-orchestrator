import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import type { CommandRegistry } from './index.js'

export class HelpCommand implements SlashCommand {
  name = 'help'
  description = 'Show available slash commands'

  constructor(private readonly registry: CommandRegistry) {}

  async execute(_args: string, _ctx: CommandContext): Promise<CommandResult> {
    const lines = ['Available commands:', '']
    for (const cmd of this.registry.all()) {
      const aliases = cmd.aliases?.map(a => `/${a}`).join(', ') ?? ''
      lines.push(`  /${cmd.name}${aliases ? ` (${aliases})` : ''}  — ${cmd.description}`)
    }
    return { type: 'output', text: lines.join('\n') }
  }
}
