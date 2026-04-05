import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig, setConfig } from './config.js'

const ANTHROPIC_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

// Local model IDs as loaded in LM Studio — match the filename/model name shown in LM Studio UI
const LOCAL_MODELS = [
  'gemma-4-27b-it',            // Deep research / planning / general agent (Gemma 4 31B-it)
  'devstral-small-2',          // Agentic coding / repo editing (Devstral Small 2 24B)
  'qwen3-32b',                 // Alternative: reasoning + coding + agentic
  'gemma-4-4b-it',             // Summarization / memory compression (Gemma 4 E4B)
  'gemma-4-2b-it',             // Router / classifier / minimal mode (Gemma 4 E2B)
]

export class ModelCommand implements SlashCommand {
  name = 'model'
  aliases = ['m']
  description = 'View or switch model: /model [name]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const name = args.trim()
    const cfg = getConfig()
    const isLocal = !cfg.model.startsWith('claude-')
    const backend = isLocal ? `local (${cfg.localUrl})` : 'Anthropic API'

    if (!name) {
      const anthropicList = ANTHROPIC_MODELS
        .map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`))
        .join('\n')
      const localList = LOCAL_MODELS
        .map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`))
        .join('\n')

      return {
        type: 'output',
        text: [
          `Current model: ${cfg.model}`,
          `Backend: ${backend}`,
          '',
          'Anthropic models (require ANTHROPIC_API_KEY):',
          anthropicList,
          '',
          `Local models (require LM Studio at ${cfg.localUrl}):`,
          localList,
          '',
          'Usage: /model <name>',
          'Tip:   /config localUrl http://localhost:1234/v1  — change LM Studio address',
        ].join('\n'),
      }
    }

    setConfig({ model: name })
    const newBackend = name.startsWith('claude-') ? 'Anthropic API' : `local (${cfg.localUrl})`
    return { type: 'output', text: `Model switched to: ${name}\nBackend: ${newBackend}` }
  }
}
