import { globSync } from 'glob'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface GlobInput {
  pattern: string
}

export class GlobTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Glob',
      description: 'Find files matching a glob pattern relative to the working directory.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern e.g. "**/*.ts"' },
        },
        required: ['pattern'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean { return true }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { pattern } = input as GlobInput
    try {
      const matches = globSync(pattern, { cwd: ctx.workingDir, dot: false })
      if (matches.length === 0) return 'No files found matching pattern.'
      return matches.join('\n')
    } catch (err) {
      return `Glob error: ${(err as Error).message}`
    }
  }
}
