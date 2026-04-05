import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export class ClearCommand implements SlashCommand {
  name = 'clear'
  description = 'Clear the conversation history'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    ctx.clearMessages()
    return { type: 'clear' }
  }
}
