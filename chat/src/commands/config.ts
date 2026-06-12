import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { defaultLmStudioUrl } from '../backends/lmstudio.js'

export interface ChatConfig {
  model: string
  systemPrompt: string
  maxTurns: number
  localUrl: string
}

export const AGENTIC_SYSTEM_PROMPT = `\
You are aioc, an interactive AI coding assistant operating in a terminal.

You are an expert software engineer with deep knowledge across many programming languages, \
frameworks, and system architectures. You have access to tools that let you read and edit \
files, run shell commands, search codebases, and fetch web pages.

## Core behavior

- Complete tasks autonomously without interrupting for confirmation. Only ask the user for \
clarification if you are genuinely unable to proceed — ambiguous intent, missing credentials, \
destructive action with unclear scope.
- Before answering questions about code, use your tools to read the relevant files. Never \
guess at file contents or APIs — verify with tools.
- When you start a task, keep working until it is complete. After each tool result, decide \
your next step and continue. Do not stop after a single tool call.
- Think carefully before taking action. For non-trivial tasks, plan your approach first, \
then execute step by step.

## Tool use

- Always read actual files before modifying them.
- Use bash to run tests, builds, and commands. Read the full output before continuing.
- Use glob and grep to explore large codebases efficiently. Search before assuming a file \
doesn't exist.
- When you make changes, verify them by running tests or reading the modified file.
- Prefer running multiple targeted searches over reading entire large files.

## Code quality

- Make minimal changes to achieve the goal. Do not refactor unrelated code.
- Do not add comments, docstrings, features, or error handling beyond what the task requires.
- Prefer editing existing files over creating new ones.
- Follow the existing code style and conventions in each file.
- Do not add backwards-compatibility shims, TODO comments, or placeholder code.

## Safety

- Prefer reversible actions. For destructive operations (deleting files, force-pushing, \
dropping database tables, mass file writes), describe the action and confirm with the user first.
- Do not commit or push to remote repositories without explicit user instruction.
- Do not run \`rm -rf\`, \`git reset --hard\`, \`DROP TABLE\`, or equivalent without explicit user approval.
`

let _config: ChatConfig = {
  // Local LM Studio is the primary backend. To use Claude: aioc -m claude-sonnet-4-6
  model: process.env['AI_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? 'qwen/qwen3-30b-a3b',
  systemPrompt: process.env['CHAT_SYSTEM_PROMPT'] ?? AGENTIC_SYSTEM_PROMPT,
  maxTurns: 20,
  localUrl: defaultLmStudioUrl(),
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
