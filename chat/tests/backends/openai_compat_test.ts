import { describe, it, expect } from 'bun:test'
import { toOpenAIMessages, toOpenAITools } from '../../src/backends/openai_compat.js'
import type { Message } from '../../src/types/message.js'

describe('toOpenAIMessages', () => {
  it('prepends system prompt and converts user message', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }]
    const result = toOpenAIMessages('You are helpful.', msgs)
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(result[1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('converts tool result messages to role:tool', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run bash' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hello\n', is_error: false }],
      },
    ]
    const result = toOpenAIMessages('', msgs)
    expect(result[2]).toMatchObject({ role: 'tool', tool_call_id: 'tu_1', content: 'hello\n' })
  })

  it('converts assistant message with tool_use blocks to tool_calls', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
    ]
    const result = toOpenAIMessages('', msgs)
    expect(result[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'bash' } }],
    })
  })
})

describe('toOpenAITools', () => {
  it('converts tool definition to OpenAI function format', () => {
    const fakeTool = {
      definition: () => ({
        name: 'bash',
        description: 'Run a bash command',
        input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
      }),
      isConcurrencySafe: () => false,
      execute: async () => '',
    }
    const result = toOpenAITools([fakeTool])
    expect(result).toEqual([{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a bash command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    }])
  })
})
