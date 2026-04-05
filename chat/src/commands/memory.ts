import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export class MemoryCommand implements SlashCommand {
  name = 'memory'
  description = 'Show conversation memory stats'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    const messages = ctx.getMessages() as Array<{ role: string }>
    const userCount = messages.filter(m => m.role === 'user').length
    const assistantCount = messages.filter(m => m.role === 'assistant').length
    return {
      type: 'output',
      text: [
        'Conversation memory:',
        `  User turns:      ${userCount}`,
        `  Assistant turns: ${assistantCount}`,
        `  Total messages:  ${messages.length}`,
      ].join('\n'),
    }
  }
}
