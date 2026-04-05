import { describe, it, expect } from 'bun:test'
import { queryLoop, dispatchTools } from '../src/query.js'
import type { Message } from '../src/types/message.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe('queryLoop', () => {
  it('exports dispatchTools helper', () => {
    expect(typeof dispatchTools).toBe('function')
  })

  it('emits text_delta events from a pure text response', async () => {
    if (!HAS_KEY) {
      console.log('  Skipping: ANTHROPIC_API_KEY not set')
      return
    }

    const messages: Message[] = [{ role: 'user', content: 'Reply with exactly the word "hello" and nothing else.' }]
    const events: string[] = []

    for await (const event of queryLoop(messages, [], {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 3,
      systemPrompt: 'You are a minimal test assistant. Follow instructions exactly.',
      abortSignal: new AbortController().signal,
      workingDir: '/tmp',
    })) {
      if (event.type === 'text_delta' && event.text) events.push(event.text)
    }

    expect(events.join('')).toMatch(/hello/i)
  })
})
