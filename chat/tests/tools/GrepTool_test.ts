import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { GrepTool } from '../../src/tools/GrepTool.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'

const rgAvailable = spawnSync('which', ['rg']).status === 0

const TMP = '/tmp/chat-test-grep'
const ctx = { abortSignal: new AbortController().signal, workingDir: TMP }

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(`${TMP}/foo.ts`, 'export function hello() {}\nexport function world() {}', 'utf8')
  writeFileSync(`${TMP}/bar.ts`, 'const x = 1', 'utf8')
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('GrepTool', () => {
  it.skipIf(!rgAvailable)('finds lines matching pattern', async () => {
    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'function', path: TMP }, ctx)
    expect(result).toContain('hello')
    expect(result).toContain('world')
  })

  it.skipIf(!rgAvailable)('returns no matches message when pattern absent', async () => {
    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'ZZZNOTFOUND', path: TMP }, ctx)
    expect(result).toContain('No matches')
  })

  it('is concurrency safe', () => {
    expect(new GrepTool().isConcurrencySafe({})).toBe(true)
  })
})
