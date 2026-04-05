import { describe, it, expect } from 'bun:test'
import { BashTool } from '../../src/tools/BashTool.js'

const ctx = { abortSignal: new AbortController().signal, workingDir: '/tmp' }

describe('BashTool', () => {
  it('executes a simple command and returns stdout', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'echo hello' }, ctx)
    expect(result).toBe('hello\n')
  })

  it('captures stderr on failure', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'ls /nonexistent_path_xyz_abc' }, ctx)
    expect(result).toContain('No such file')
  })

  it('times out after configured ms', async () => {
    const tool = new BashTool({ timeoutMs: 50 })
    const result = await tool.execute({ command: 'sleep 10' }, ctx)
    expect(result).toContain('timed out')
  })

  it('is not concurrency safe for write commands', () => {
    const tool = new BashTool()
    expect(tool.isConcurrencySafe({ command: 'rm -rf /tmp/foo' })).toBe(false)
  })

  it('is concurrency safe for readonly commands', () => {
    const tool = new BashTool()
    expect(tool.isConcurrencySafe({ command: 'cat README.md' })).toBe(true)
  })
})
