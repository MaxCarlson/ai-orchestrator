import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { SessionStore } from '../session/store.js'
import { homedir } from 'os'
import { join } from 'path'

export class SessionCommand implements SlashCommand {
  name = 'session'
  aliases = ['s']
  description = 'Manage sessions: /session list'
  private store: SessionStore

  constructor(sessionsDir?: string) {
    this.store = new SessionStore(sessionsDir ?? join(homedir(), '.ai-orchestrator', 'sessions'))
  }

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const sub = args.trim().split(/\s+/)[0] ?? 'list'

    if (sub === 'list') {
      const sessions = await this.store.list()
      if (sessions.length === 0) return { type: 'output', text: 'No saved sessions.' }
      const lines = sessions.map(s => {
        const date = new Date(s.updatedAt).toLocaleString()
        return `  ${s.id.slice(0, 8)}  ${date}  ${s.title}`
      })
      return { type: 'output', text: ['Sessions:', ...lines].join('\n') }
    }

    return { type: 'output', text: `Unknown session subcommand: ${sub}. Use: list` }
  }
}
