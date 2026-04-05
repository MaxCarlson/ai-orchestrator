import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export interface ChatConfig {
  model: string
  systemPrompt: string
  maxTurns: number
  localUrl: string
}

let _config: ChatConfig = {
  // Local LM Studio is the primary backend. To use Claude: ai -m claude-sonnet-4-6
  model: process.env['AI_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? 'qwen3-30b-a3b-abliterated',
  systemPrompt: process.env['CHAT_SYSTEM_PROMPT'] ?? 'You are a helpful coding assistant.',
  maxTurns: 20,
  localUrl: process.env['LM_STUDIO_URL'] ?? 'http://localhost:1234/v1',
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
          `  localUrl     = ${cfg.localUrl}`,
          `  systemPrompt = ${cfg.systemPrompt.slice(0, 60)}${cfg.systemPrompt.length > 60 ? '...' : ''}`,
          '',
          'Usage: /config <key> <value>',
          'Keys: model, maxTurns, localUrl, systemPrompt',
        ].join('\n'),
      }
    }

    const key = parts[0] as keyof ChatConfig
    const value = parts.slice(1).join(' ')

    if (!value) {
      return { type: 'output', text: `${key} = ${String(cfg[key])}` }
    }

    if (key === 'maxTurns') {
      const n = parseInt(value, 10)
      if (isNaN(n) || n < 1) return { type: 'output', text: 'maxTurns must be a positive integer' }
      setConfig({ maxTurns: n })
    } else if (key === 'model' || key === 'systemPrompt' || key === 'localUrl') {
      setConfig({ [key]: value })
    } else {
      return { type: 'output', text: `Unknown config key: ${key}` }
    }

    return { type: 'output', text: `Set ${key} = ${value}` }
  }
}
