import { describe, it, expect } from 'bun:test'
import { parseSlashCommand, CommandRegistry } from '../../src/commands/index.js'
import { HelpCommand } from '../../src/commands/help.js'
import { ClearCommand } from '../../src/commands/clear.js'

const ctx = { clearMessages: () => {}, getMessages: () => [], workingDir: '/tmp' }

describe('parseSlashCommand', () => {
  it('detects a slash command', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' })
  })

  it('extracts args', () => {
    expect(parseSlashCommand('/session list')).toEqual({ name: 'session', args: 'list' })
  })

  it('returns null for non-slash input', () => {
    expect(parseSlashCommand('just text')).toBeNull()
  })

  it('returns null for bare slash', () => {
    expect(parseSlashCommand('/')).toBeNull()
  })
})

describe('CommandRegistry', () => {
  it('dispatches /help', async () => {
    const registry = new CommandRegistry()
    registry.register(new HelpCommand(registry))
    const result = await registry.dispatch('help', '', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('/help')
  })

  it('dispatches /clear', async () => {
    const registry = new CommandRegistry()
    registry.register(new ClearCommand())
    const result = await registry.dispatch('clear', '', ctx)
    expect(result.type).toBe('clear')
  })

  it('returns output for unknown command', async () => {
    const registry = new CommandRegistry()
    const result = await registry.dispatch('unknown', '', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('Unknown')
  })
})
