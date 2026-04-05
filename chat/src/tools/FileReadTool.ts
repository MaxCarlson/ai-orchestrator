import { readFileSync } from 'fs'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface FileReadInput {
  file_path: string
}

export class FileReadTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Read',
      description: 'Read the contents of a file from the filesystem.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        },
        required: ['file_path'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true
  }

  async execute(input: unknown, _ctx: ToolUseContext): Promise<string> {
    const { file_path } = input as FileReadInput
    try {
      return readFileSync(file_path, 'utf-8')
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`
    }
  }
}
