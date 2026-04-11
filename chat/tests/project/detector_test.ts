import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { detectProject } from '../../src/project/detector.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'

const TMP = '/tmp/chat-project-detector-test'

beforeAll(() => {
  mkdirSync(`${TMP}/git-repo/src/utils`, { recursive: true })
  mkdirSync(`${TMP}/git-repo/docs/guides`, { recursive: true })
  spawnSync('git', ['init'], { cwd: `${TMP}/git-repo` })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: `${TMP}/git-repo` })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: `${TMP}/git-repo` })
  writeFileSync(`${TMP}/git-repo/CHAT.md`, '# My Project\nThis is my test project.\n', 'utf8')
  writeFileSync(`${TMP}/git-repo/README.md`, '# Readme', 'utf8')
  writeFileSync(`${TMP}/git-repo/src/utils/helper.ts`, 'export {}', 'utf8')
  writeFileSync(`${TMP}/git-repo/docs/guides/intro.md`, '# Intro', 'utf8')
  spawnSync('git', ['add', '.'], { cwd: `${TMP}/git-repo` })
  spawnSync('git', ['commit', '-m', 'init'], { cwd: `${TMP}/git-repo` })
  mkdirSync(`${TMP}/plain-dir`, { recursive: true })
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('detectProject', () => {
  it('detects git root from a subdirectory', async () => {
    mkdirSync(`${TMP}/git-repo/sub`, { recursive: true })
    const info = await detectProject(`${TMP}/git-repo/sub`)
    expect(info).not.toBeNull()
    expect(info!.gitRoot).toBe(`${TMP}/git-repo`)
  })

  it('loads CHAT.md content when present', async () => {
    const info = await detectProject(`${TMP}/git-repo`)
    expect(info).not.toBeNull()
    expect(info!.chatMd).toContain('My Project')
  })

  it('returns null for non-git directory', async () => {
    const info = await detectProject(`${TMP}/plain-dir`)
    expect(info).toBeNull()
  })

  it('includes tracked directories in repoTree', async () => {
    const info = await detectProject(`${TMP}/git-repo`)
    expect(info).not.toBeNull()
    expect(info!.repoTree).toContain('src/')
    expect(info!.repoTree).toContain('docs/')
  })

  it('repoTree includes second-level entries', async () => {
    const info = await detectProject(`${TMP}/git-repo`)
    expect(info!.repoTree).toContain('src/utils/')
    expect(info!.repoTree).toContain('docs/guides/')
  })

  it('repoTree does not exceed 150 entries', async () => {
    const info = await detectProject(`${TMP}/git-repo`)
    const lines = info!.repoTree.split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(151)  // 150 + possible truncation line
  })
})
