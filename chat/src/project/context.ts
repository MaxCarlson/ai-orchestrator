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

  if (info.repoTree) {
    lines.push('\n### Repository Structure (tracked files, 2 levels deep)\n')
    lines.push('```')
    lines.push(info.repoTree)
    lines.push('```')
    lines.push('\nUse the Read, Glob, or Grep tools to explore file contents. The structure above reflects the actual state of the repository — do not claim directories or files do not exist without first using a tool to verify.')
  }

  if (info.claudeMd) {
    lines.push('\n### Project Instructions (CLAUDE.md)\n')
    lines.push(info.claudeMd)
  }

  if (info.chatMd) {
    lines.push('\n### Project Memory (CHAT.md)\n')
    lines.push(info.chatMd)
  }

  return lines.join('\n')
}
