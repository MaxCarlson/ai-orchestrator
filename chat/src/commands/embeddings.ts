import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getProjectContext, setProjectContext } from '../project/context.js'

export class EmbeddingsCommand implements SlashCommand {
  name = 'embeddings'
  aliases = ['emb']
  description = 'Toggle semantic context injection: /embeddings [on|off|status]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const sub = args.trim().toLowerCase() || 'status'
    const projCtx = getProjectContext()
    if (sub === 'off') { setProjectContext({ embeddingsEnabled: false }); return { type: 'output', text: 'Embeddings disabled.' } }
    if (sub === 'on')  { setProjectContext({ embeddingsEnabled: true });  return { type: 'output', text: 'Embeddings enabled.' } }
    return { type: 'output', text: `Embeddings: ${projCtx.embeddingsEnabled ? 'enabled' : 'disabled'}\nUsage: /embeddings on|off` }
  }
}
