import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface ProjectInfo {
  gitRoot: string
  projectName: string
  chatMd: string | null
  claudeMd: string | null
  repoTree: string   // top-2-level directory listing of git-tracked files
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

  const claudeMdPath = join(gitRoot, 'CLAUDE.md')
  const claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : null

  const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: gitRoot,
    encoding: 'utf8',
  })
  const remoteName = remoteResult.stdout?.trim()
  const dirName = gitRoot.split('/').pop() ?? 'unknown'
  const projectName = remoteName
    ? (remoteName.split('/').pop()?.replace(/\.git$/, '') ?? dirName)
    : dirName

  const repoTree = buildRepoTree(gitRoot)

  return { gitRoot, projectName, chatMd, claudeMd, repoTree }
}

/**
 * Build a compact 2-level repo tree using git ls-tree so only tracked files
 * appear (no node_modules, .git, build artifacts, etc).
 *
 * Output format mirrors `tree` output for readability:
 *   chat/
 *     src/
 *     tests/
 *   docker/
 *     ...
 */
function buildRepoTree(gitRoot: string): string {
  // Get all tracked paths (relative)
  const lsResult = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: gitRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (lsResult.status !== 0 || !lsResult.stdout) return ''

  const paths = lsResult.stdout.trim().split('\n').filter(Boolean)

  // Build a depth-2 set of unique entries: top-level files + dir/ + dir/subdir/
  const seen = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/')
    // Top-level file or dir
    seen.add(parts[0] + (parts.length > 1 ? '/' : ''))
    // Second level (if exists)
    if (parts.length > 1) {
      seen.add(parts[0] + '/' + parts[1] + (parts.length > 2 ? '/' : ''))
    }
  }

  // Sort: directories first, then files, alphabetically within each group
  const entries = [...seen].sort((a, b) => {
    const aDir = a.endsWith('/')
    const bDir = b.endsWith('/')
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.localeCompare(b)
  })

  // Format with indentation for second-level entries
  const lines: string[] = []
  for (const entry of entries) {
    const depth = entry.split('/').length - (entry.endsWith('/') ? 1 : 0)
    const indent = depth > 1 ? '  ' : ''
    lines.push(indent + entry)
  }

  // Cap at 150 lines to keep system prompt size reasonable
  const capped = lines.slice(0, 150)
  if (lines.length > 150) capped.push(`  … (${lines.length - 150} more entries)`)
  return capped.join('\n')
}
