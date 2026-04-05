import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig, setConfig } from './config.js'

const ANTHROPIC_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

// Local model IDs — match paths shown in `lms ls` (run: /mnt/c/Users/<you>/.lmstudio/bin/lms.exe ls)
const LOCAL_MODELS = [
  'qwen/qwen3-coder-next',                    // Coding / agentic (80B)
  'openai/gpt-oss-20b',                       // General purpose (20B)
  'qwen3-30b-a3b-abliterated',                // General / reasoning (30B MoE)
  'deepseek/deepseek-r1-0528-qwen3-8b',       // Reasoning (8B)
  'mistralai/ministral-3-14b-reasoning',      // Reasoning (14B)
  'meta-llama-3.1-8b-instruct-abliterated',   // Fast general (8B)
  'qwen3-4b-abliterated',                     // Fast / router (4B)
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
