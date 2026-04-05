import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig, setConfig } from './config.js'

const KNOWN_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

export class ModelCommand implements SlashCommand {
  name = 'model'
  aliases = ['m']
  description = 'View or switch model: /model [name]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const name = args.trim()
    const cfg = getConfig()
    if (!name) {
      const list = KNOWN_MODELS.map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`)).join('\n')
      return { type: 'output', text: `Current model: ${cfg.model}\n\nKnown models:\n${list}\n\nUsage: /model <name>` }
    }
    setConfig({ model: name })
    return { type: 'output', text: `Model switched to: ${name}` }
  }
}
