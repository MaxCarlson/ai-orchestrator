import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export class CompactCommand implements SlashCommand {
  name = 'compact'
  description = 'Request conversation compaction before the next message'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    const messages = ctx.getMessages() as Array<{ role: string }>
    const turnCount = messages.filter(m => m.role === 'user').length
    if (turnCount < 4) return { type: 'output', text: 'Conversation is short — no compaction needed yet.' }
    ctx.requestCompact?.()
    return { type: 'output', text: `Compaction requested. ${turnCount} turns will be summarized before next message.` }
  }
}
