import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

const BUILTIN_TOOLS = [
  { name: 'Bash',     description: 'Execute bash commands (30s timeout)' },
  { name: 'Read',     description: 'Read file contents' },
  { name: 'Edit',     description: 'Search-and-replace edit files' },
  { name: 'Glob',     description: 'Find files by glob pattern' },
  { name: 'Grep',     description: 'Search file contents (ripgrep)' },
  { name: 'WebFetch', description: 'Fetch URL text content' },
]

export class ToolsCommand implements SlashCommand {
  name = 'tools'
  description = 'List available tools'

  async execute(_args: string, _ctx: CommandContext): Promise<CommandResult> {
    const lines = ['Available tools:', '']
    for (const tool of BUILTIN_TOOLS) {
      lines.push(`  ${tool.name.padEnd(12)} ${tool.description}`)
    }
    lines.push('')
    lines.push('Tools are invoked automatically by the model as needed.')
    return { type: 'output', text: lines.join('\n') }
  }
}
