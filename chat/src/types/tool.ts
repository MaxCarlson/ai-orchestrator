export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, { type: string; description: string }>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: ToolInputSchema
}

export interface ToolUseContext {
  abortSignal: AbortSignal
  workingDir: string
}

export interface Tool {
  definition(): ToolDefinition
  isConcurrencySafe(input: unknown): boolean
  execute(input: unknown, ctx: ToolUseContext): Promise<string>
}

export interface ToolResult {
  tool_use_id: string
  content: string
  is_error: boolean
}
