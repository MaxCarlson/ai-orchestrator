import type { ProjectInfo } from './detector.js'

export interface ProjectContext {
  enabled: boolean
  info: ProjectInfo | null
  embeddingsEnabled: boolean
}

let _ctx: ProjectContext = {
  enabled: true,
  info: null,
  embeddingsEnabled: true,
}

export function setProjectContext(ctx: Partial<ProjectContext>): void {
  _ctx = { ..._ctx, ...ctx }
}

export function getProjectContext(): ProjectContext {
  return { ..._ctx }
}

export function buildProjectSystemPromptAddition(): string {
  const { enabled, info } = _ctx
  if (!enabled || !info) return ''

  const lines = [
    `\n\n## Current Project: ${info.projectName}`,
    `Working directory root: ${info.gitRoot}`,
  ]

  if (info.chatMd) {
    lines.push('\n### Project Memory (CHAT.md)\n')
    lines.push(info.chatMd)
  }

  return lines.join('\n')
}
