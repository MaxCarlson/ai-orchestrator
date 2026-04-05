import { spawnSync } from 'child_process'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
}

export class GrepTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Grep',
      description: 'Search file contents using ripgrep. Returns matching lines with file paths.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in' },
          glob: { type: 'string', description: 'File glob filter e.g. "*.ts"' },
        },
        required: ['pattern'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean { return true }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { pattern, path: searchPath, glob } = input as GrepInput
    // Build args array — never interpolate into shell string
    const args: string[] = ['-n', '--color=never', pattern]
    if (glob) args.push('--glob', glob)
    args.push(searchPath ?? ctx.workingDir)

    const result = spawnSync('rg', args, { encoding: 'utf8', cwd: ctx.workingDir })
    const output = (result.stdout ?? '').trim()
    if (!output) return 'No matches found.'
    return output
  }
}
