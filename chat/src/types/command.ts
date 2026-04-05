export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  execute(args: string, context: CommandContext): Promise<CommandResult>
}

export interface CommandContext {
  clearMessages: () => void
  getMessages: () => unknown[]
  workingDir: string
  requestCompact?: () => void
}

export type CommandResult =
  | { type: 'output'; text: string }
  | { type: 'clear' }
  | { type: 'noop' }
