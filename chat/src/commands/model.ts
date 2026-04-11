import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig, setConfig } from './config.js'

const ANTHROPIC_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

const GEMINI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
]

const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o1',
]

// Local model IDs — match paths shown in `lms ls`
const LOCAL_MODELS = [
  'qwen/qwen3-coder-next',
  'openai/gpt-oss-20b',
  'qwen3-30b-a3b-abliterated',
  'deepseek/deepseek-r1-0528-qwen3-8b',
  'mistralai/ministral-3-14b-reasoning',
  'meta-llama-3.1-8b-instruct-abliterated',
  'qwen3-4b-abliterated',
]

function getBackendLabel(model: string, localUrl: string): string {
  if (model.startsWith('gemini-')) return 'Google Generative AI (GEMINI_API_KEY)'
  if (model.startsWith('claude-')) return 'Anthropic API (ANTHROPIC_API_KEY)'
  if (/^(gpt-|o1-|o3-)/.test(model)) return 'OpenAI API (OPENAI_API_KEY)'
  return `local LM Studio (${localUrl})`
}

export class ModelCommand implements SlashCommand {
  name = 'model'
  aliases = ['m']
  description = 'View or switch model: /model [name]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const name = args.trim()
    const cfg = getConfig()
    const backend = getBackendLabel(cfg.model, cfg.localUrl)

    if (!name) {
      const fmt = (list: string[]) =>
        list.map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`)).join('\n')

      return {
        type: 'output',
        text: [
          `Current model: ${cfg.model}`,
          `Backend: ${backend}`,
          '',
          `Local models — LM Studio at ${cfg.localUrl}:`,
          fmt(LOCAL_MODELS),
          '',
          'Anthropic models (ANTHROPIC_API_KEY):',
          fmt(ANTHROPIC_MODELS),
          '',
          'Gemini models (GEMINI_API_KEY):',
          fmt(GEMINI_MODELS),
          '',
          'OpenAI models (OPENAI_API_KEY):',
          fmt(OPENAI_MODELS),
          '',
          'Usage: /model <name>',
          'Tip:   /config localUrl http://localhost:1234/v1  — change LM Studio address',
        ].join('\n'),
      }
    }

    setConfig({ model: name })
    const newBackend = getBackendLabel(name, cfg.localUrl)
    return { type: 'output', text: `Model switched to: ${name}\nBackend: ${newBackend}` }
  }
}
