import { readFileSync, writeFileSync } from 'fs'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface FileEditInput {
  file_path: string
  old_string: string
  new_string: string
}

export class FileEditTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Edit',
      description: 'Replace an exact string in a file. old_string must appear exactly once.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'Exact string to find and replace' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean { return false }

  async execute(input: unknown, _ctx: ToolUseContext): Promise<string> {
    const { file_path, old_string, new_string } = input as FileEditInput
    try {
      const content = readFileSync(file_path, 'utf-8')
      const count = content.split(old_string).length - 1
      if (count === 0) return `Error: old_string not found in file.`
      if (count > 1) return `Error: old_string found ${count} times — must be unique.`
      writeFileSync(file_path, content.replace(old_string, new_string), 'utf-8')
      return `File edited successfully.`
    } catch (err) {
      return `Error editing file: ${(err as Error).message}`
    }
  }
}
