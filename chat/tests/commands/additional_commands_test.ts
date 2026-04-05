import { describe, it, expect } from 'bun:test'
import { ModelCommand } from '../../src/commands/model.js'
import { ToolsCommand } from '../../src/commands/tools_cmd.js'
import { EmbeddingsCommand } from '../../src/commands/embeddings.js'
import { ProjectCommand } from '../../src/commands/project_cmd.js'
import { getConfig, setConfig } from '../../src/commands/config.js'
import { getProjectContext, setProjectContext } from '../../src/project/context.js'

const ctx = { clearMessages: () => {}, getMessages: () => [], workingDir: '/tmp' }

describe('ModelCommand', () => {
  it('shows current model with no args', async () => {
    const result = await new ModelCommand().execute('', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('model')
  })

  it('sets model when given a name', async () => {
    await new ModelCommand().execute('claude-haiku-4-5-20251001', ctx)
    expect(getConfig().model).toBe('claude-haiku-4-5-20251001')
    // Reset
    setConfig({ model: 'claude-sonnet-4-6' })
  })
})

describe('EmbeddingsCommand', () => {
  it('disables embeddings with off', async () => {
    setProjectContext({ embeddingsEnabled: true })
    await new EmbeddingsCommand().execute('off', ctx)
    expect(getProjectContext().embeddingsEnabled).toBe(false)
  })

  it('enables embeddings with on', async () => {
    setProjectContext({ embeddingsEnabled: false })
    await new EmbeddingsCommand().execute('on', ctx)
    expect(getProjectContext().embeddingsEnabled).toBe(true)
  })
})

describe('ProjectCommand', () => {
  it('disables project context with off', async () => {
    setProjectContext({ enabled: true })
    await new ProjectCommand().execute('off', ctx)
    expect(getProjectContext().enabled).toBe(false)
  })

  it('enables project context with on', async () => {
    setProjectContext({ enabled: false })
    await new ProjectCommand().execute('on', ctx)
    expect(getProjectContext().enabled).toBe(true)
  })
})

describe('ToolsCommand', () => {
  it('lists available tools', async () => {
    const result = await new ToolsCommand().execute('', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('Bash')
  })
})
