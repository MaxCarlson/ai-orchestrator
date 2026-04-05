import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { detectProject } from '../../src/project/detector.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'

const TMP = '/tmp/chat-project-detector-test'

beforeAll(() => {
  mkdirSync(`${TMP}/git-repo`, { recursive: true })
  spawnSync('git', ['init'], { cwd: `${TMP}/git-repo` })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: `${TMP}/git-repo` })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: `${TMP}/git-repo` })
  writeFileSync(`${TMP}/git-repo/CHAT.md`, '# My Project\nThis is my test project.\n', 'utf8')
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
})
