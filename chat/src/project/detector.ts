import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface ProjectInfo {
  gitRoot: string
  projectName: string
  chatMd: string | null
}

/**
 * Detect project context from a working directory.
 * All subprocess calls use fixed string arrays — no shell interpolation, no injection risk.
 */
export async function detectProject(workingDir: string): Promise<ProjectInfo | null> {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workingDir,
    encoding: 'utf8',
  })

  if (result.status !== 0 || !result.stdout) return null

  const gitRoot = result.stdout.trim()

  const chatMdPath = join(gitRoot, 'CHAT.md')
  const chatMd = existsSync(chatMdPath) ? readFileSync(chatMdPath, 'utf-8') : null

  const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: gitRoot,
    encoding: 'utf8',
  })
  const remoteName = remoteResult.stdout?.trim()
  const dirName = gitRoot.split('/').pop() ?? 'unknown'
  const projectName = remoteName
    ? (remoteName.split('/').pop()?.replace(/\.git$/, '') ?? dirName)
    : dirName

  return { gitRoot, projectName, chatMd }
}
