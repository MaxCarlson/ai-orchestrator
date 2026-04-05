import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

interface ChatConfig {
  model: string
  systemPrompt: string
  maxTurns: number
}

let _config: ChatConfig = {
  model: process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-6',
  systemPrompt: process.env['CHAT_SYSTEM_PROMPT'] ?? 'You are a helpful coding assistant.',
  maxTurns: 20,
}

export function getConfig(): ChatConfig { return { ..._config } }
export function setConfig(partial: Partial<ChatConfig>): void { _config = { ..._config, ...partial } }

export class ConfigCommand implements SlashCommand {
  name = 'config'
  description = 'View or set config: /config [key] [value]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/)
    const cfg = getConfig()

    if (!parts[0]) {
      return {
        type: 'output',
        text: [
          'Current config:',
          `  model        = ${cfg.model}`,
          `  maxTurns     = ${cfg.maxTurns}`,
          `  systemPrompt = ${cfg.systemPrompt}`,
        ].join('\n'),
      }
    }

    const [key, ...rest] = parts
    const value = rest.join(' ')
    if (key === 'model')       { setConfig({ model: value }); return { type: 'output', text: `model set to ${value}` } }
    if (key === 'maxTurns')    { setConfig({ maxTurns: parseInt(value, 10) }); return { type: 'output', text: `maxTurns set to ${value}` } }
    if (key === 'systemPrompt'){ setConfig({ systemPrompt: value }); return { type: 'output', text: 'systemPrompt updated' } }
    return { type: 'output', text: `Unknown config key: ${key}` }
  }
}
