import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getProjectContext, setProjectContext } from '../project/context.js'
import { detectProject } from '../project/detector.js'

export class ProjectCommand implements SlashCommand {
  name = 'project'
  description = 'Manage project context: /project [on|off|reload|status]'

  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const sub = args.trim().toLowerCase() || 'status'
    const projCtx = getProjectContext()

    if (sub === 'off') { setProjectContext({ enabled: false }); return { type: 'output', text: 'Project context disabled.' } }
    if (sub === 'on')  { setProjectContext({ enabled: true });  return { type: 'output', text: 'Project context enabled.' } }

    if (sub === 'reload') {
      const info = await detectProject(ctx.workingDir)
      setProjectContext({ info: info ?? null })
      return info
        ? { type: 'output', text: `Project reloaded: ${info.projectName}` }
        : { type: 'output', text: 'No project detected in current directory.' }
    }

    const lines = [
      `Project context: ${projCtx.enabled ? 'enabled' : 'disabled'}`,
      `Embeddings:      ${projCtx.embeddingsEnabled ? 'enabled' : 'disabled'}`,
    ]
    if (projCtx.info) {
      lines.push(`Project:         ${projCtx.info.projectName}`)
      lines.push(`Root:            ${projCtx.info.gitRoot}`)
      lines.push(`CHAT.md:         ${projCtx.info.chatMd ? 'loaded' : 'not found'}`)
    } else {
      lines.push('No project detected.')
    }
    return { type: 'output', text: lines.join('\n') }
  }
}
