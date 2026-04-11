import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

const TEST_PORT = 8766

let serverProcess: ReturnType<typeof Bun.spawn> | null = null

beforeAll(async () => {
  serverProcess = Bun.spawn(
    [process.execPath, 'run', 'src/server.ts', '--port', String(TEST_PORT)],
    { cwd: import.meta.dir + '/..', stderr: 'ignore', stdout: 'ignore' },
  )
  await new Promise(r => setTimeout(r, 500))
})

afterAll(() => {
  serverProcess?.kill()
})

describe('chat WebSocket server', () => {
  it('responds to /help with command_output event', async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 4000)
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'message', text: '/help' }))
      })
      ws.addEventListener('error', reject)
      ws.addEventListener('message', (e) => {
        const data = JSON.parse(e.data as string) as { type: string }
        if (data.type === 'command_output') {
          clearTimeout(timer)
          ws.close()
          resolve()
        }
      })
    })
  })
})
