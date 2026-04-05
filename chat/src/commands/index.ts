import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export function parseSlashCommand(input: string): { name: string; args: string } | null {
  if (!input.startsWith('/')) return null
  const trimmed = input.slice(1).trim()
  if (!trimmed) return null
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return { name: trimmed, args: '' }
  return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() }
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>()

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd)
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias, cmd)
    }
  }

  async dispatch(name: string, args: string, ctx: CommandContext): Promise<CommandResult> {
    const cmd = this.commands.get(name)
    if (!cmd) return { type: 'output', text: `Unknown command: /${name}. Type /help for available commands.` }
    return cmd.execute(args, ctx)
  }

  all(): SlashCommand[] {
    const seen = new Set<SlashCommand>()
    for (const cmd of this.commands.values()) seen.add(cmd)
    return [...seen]
  }
}
