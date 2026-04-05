import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { GlobTool } from '../../src/tools/GlobTool.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'

const TMP = '/tmp/chat-test-glob'
const ctx = { abortSignal: new AbortController().signal, workingDir: TMP }

beforeAll(() => {
  mkdirSync(`${TMP}/sub`, { recursive: true })
  writeFileSync(`${TMP}/a.ts`, '', 'utf8')
  writeFileSync(`${TMP}/b.ts`, '', 'utf8')
  writeFileSync(`${TMP}/sub/c.ts`, '', 'utf8')
  writeFileSync(`${TMP}/ignore.md`, '', 'utf8')
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('GlobTool', () => {
  it('finds files matching a pattern', async () => {
    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
    expect(result).toContain('c.ts')
    expect(result).not.toContain('ignore.md')
  })

  it('returns empty message when no matches', async () => {
    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '**/*.xyz' }, ctx)
    expect(result).toContain('No files found')
  })

  it('is concurrency safe', () => {
    expect(new GlobTool().isConcurrencySafe({})).toBe(true)
  })
})
