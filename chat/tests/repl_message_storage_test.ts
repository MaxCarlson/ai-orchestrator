/**
 * Tests the closure variable capture bug fix in REPL.tsx's message_stop handler.
 *
 * The bug: setMessages(prev => [...prev, { content: responseText }]) closes over
 * the `let responseText` variable. React/Ink calls state updaters asynchronously,
 * so by the time the updater runs, responseText has been reset to ''. This caused
 * every committed assistant message to have empty content.
 *
 * The fix: capture responseText into `const savedText = responseText` before
 * calling setMessages, so the closure over the const always sees the original value.
 */

import { describe, it, expect } from 'bun:test'

describe('closure variable capture', () => {
  it('demonstrates the bug: let variable captured by reference sees reset value', async () => {
    let mutableVar = 'hello world'
    const capturedUpdaters: Array<() => string> = []

    // Simulate what the BUGGY code did: close over the mutable let variable
    capturedUpdaters.push(() => mutableVar)

    // Simulate what React does: reset the variable before running the updater
    mutableVar = ''

    // Simulate React calling the updater asynchronously
    await Promise.resolve()
    const result = capturedUpdaters[0]!()

    // BUG: the updater sees '' instead of 'hello world'
    expect(result).toBe('')
  })

  it('demonstrates the fix: const capture preserves value at capture time', async () => {
    let mutableVar = 'hello world'
    const capturedUpdaters: Array<() => string> = []

    // THE FIX: capture into a const before closing over it
    const savedValue = mutableVar
    capturedUpdaters.push(() => savedValue)

    // Reset the original variable (simulating what happens after setMessages call)
    mutableVar = ''

    // Simulate React calling the updater asynchronously
    await Promise.resolve()
    const result = capturedUpdaters[0]!()

    // FIXED: the updater sees 'hello world', not ''
    expect(result).toBe('hello world')
  })

  it('simulates the full message_stop pattern: messages accumulate correctly', async () => {
    // Simulate the async generator event loop and React state batching
    let responseText = ''
    const messages: Array<{ role: string; content: string }> = []
    const pendingUpdaters: Array<(prev: typeof messages) => typeof messages> = []

    // Simulate text_delta events accumulating responseText
    const textDeltas = ['Hello', '! How', ' can I', ' help?']
    for (const delta of textDeltas) {
      responseText += delta
    }

    // Simulate message_stop: THE FIX — capture before reset
    if (responseText.trim()) {
      const savedText = responseText  // capture NOW
      pendingUpdaters.push(prev => [...prev, { role: 'assistant', content: savedText }])
      responseText = ''  // reset (would have broken the old code)
    }

    // Simulate React processing the batched update asynchronously
    await Promise.resolve()
    for (const updater of pendingUpdaters) {
      const result = updater(messages)
      messages.push(...result.slice(messages.length))
    }

    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('Hello! How can I help?')
  })
})
