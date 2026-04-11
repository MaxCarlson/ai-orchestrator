import { describe, it, expect } from 'bun:test'
import { toGeminiHistory, toGeminiFunctionDeclarations } from '../../src/backends/gemini_backend.js'
import type { Message } from '../../src/types/message.js'

describe('toGeminiHistory', () => {
  it('converts user message to Gemini user part', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }]
    const result = toGeminiHistory(msgs)
    expect(result).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
  })

  it('converts assistant text to Gemini model part', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
      },
    ]
    const result = toGeminiHistory(msgs)
    expect(result).toEqual([{ role: 'model', parts: [{ text: 'hi there' }] }])
  })

  it('skips ToolResultMessage (Gemini tool results handled separately)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run bash' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'output', is_error: false }],
      },
    ]
    const result = toGeminiHistory(msgs)
    // Tool results are not in history — they go into the current-turn function_response parts
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'run bash' }] })
  })
})

describe('toGeminiFunctionDeclarations', () => {
  it('converts a tool definition', () => {
    const fakeTool = {
      definition: () => ({
        name: 'bash',
        description: 'Run bash',
        input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
      }),
      isConcurrencySafe: () => false,
      execute: async () => '',
    }
    const result = toGeminiFunctionDeclarations([fakeTool])
    expect(result[0]).toMatchObject({ name: 'bash', description: 'Run bash' })
  })
})
