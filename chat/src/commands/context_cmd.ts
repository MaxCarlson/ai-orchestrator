import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig } from './config.js'
import { getProjectContext } from '../project/context.js'

export class ContextCommand implements SlashCommand {
  name = 'context'
  description = 'Show current session context, project, and settings'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    const cfg = getConfig()
    const proj = getProjectContext()
    const msgCount = (ctx.getMessages() as unknown[]).length

    const lines = [
      '=== Session Context ===',
      `  Model:       ${cfg.model}`,
      `  Max turns:   ${cfg.maxTurns}`,
      `  Messages:    ${msgCount}`,
      `  Working dir: ${ctx.workingDir}`,
      '',
      '=== Project Context ===',
      `  Enabled:     ${proj.enabled}`,
      `  Embeddings:  ${proj.embeddingsEnabled}`,
    ]
    if (proj.info) {
      lines.push(`  Project:     ${proj.info.projectName}`)
      lines.push(`  Git root:    ${proj.info.gitRoot}`)
      lines.push(`  CHAT.md:     ${proj.info.chatMd ? 'loaded' : 'not found'}`)
    } else {
      lines.push('  Project:     not detected')
    }
    lines.push(`\n  System prompt: ${cfg.systemPrompt.slice(0, 100)}...`)

    return { type: 'output', text: lines.join('\n') }
  }
}
