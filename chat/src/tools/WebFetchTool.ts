import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface WebFetchInput {
  url: string
  max_length?: number
}

export class WebFetchTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'WebFetch',
      description: 'Fetch the text content of a URL. HTML tags are stripped.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          max_length: { type: 'number', description: 'Max characters to return (default 10000)' },
        },
        required: ['url'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean { return true }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { url, max_length = 10_000 } = input as WebFetchInput
    try {
      const res = await fetch(url, { signal: ctx.abortSignal })
      const text = await res.text()
      const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return stripped.slice(0, max_length)
    } catch (err) {
      return `Error fetching URL: ${(err as Error).message}`
    }
  }
}
