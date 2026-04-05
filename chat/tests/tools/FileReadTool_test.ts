import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { FileReadTool } from '../../src/tools/FileReadTool.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'

const TMP = '/tmp/chat-test-filereader'
const ctx = { abortSignal: new AbortController().signal, workingDir: TMP }

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(`${TMP}/hello.txt`, 'line1\nline2\nline3\n', 'utf8')
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('FileReadTool', () => {
  it('reads a file and returns its content', async () => {
    const tool = new FileReadTool()
    const result = await tool.execute({ file_path: `${TMP}/hello.txt` }, ctx)
    expect(result).toBe('line1\nline2\nline3\n')
  })

  it('returns error message for missing file', async () => {
    const tool = new FileReadTool()
    const result = await tool.execute({ file_path: `${TMP}/missing.txt` }, ctx)
    expect(result).toContain('Error')
  })

  it('is concurrency safe', () => {
    const tool = new FileReadTool()
    expect(tool.isConcurrencySafe({})).toBe(true)
  })
})
