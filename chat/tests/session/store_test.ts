import { describe, it, expect, afterAll } from 'bun:test'
import { SessionStore } from '../../src/session/store.js'
import { rmSync } from 'fs'

const TMP = '/tmp/chat-sessions-test'

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('SessionStore', () => {
  it('saves and loads a session', async () => {
    const store = new SessionStore(TMP)
    const id = await store.create('test session')
    await store.appendMessages(id, [{ role: 'user', content: 'hello' }])
    const session = await store.load(id)
    expect(session).not.toBeNull()
    expect(session!.messages).toHaveLength(1)
    expect((session!.messages[0] as { content: string }).content).toBe('hello')
  })

  it('lists sessions sorted by most recent', async () => {
    const store = new SessionStore(TMP)
    const id1 = await store.create('first')
    await new Promise(r => setTimeout(r, 10))
    const id2 = await store.create('second')
    const list = await store.list()
    const ids = list.map(s => s.id)
    expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1))
  })

  it('returns null for missing session', async () => {
    const store = new SessionStore(TMP)
    const result = await store.load('nonexistent-id')
    expect(result).toBeNull()
  })
})
