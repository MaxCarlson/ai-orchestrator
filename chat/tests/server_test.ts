import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

let testPort = 0

let serverProcess: ReturnType<typeof Bun.spawn> | null = null

function randomTestPort(): number {
  return 20_000 + Math.floor(Math.random() * 30_000)
}

async function waitForServer(url: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Server is not accepting connections yet.
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`server did not become ready: ${url}`)
}

beforeAll(async () => {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    testPort = randomTestPort()
    serverProcess = Bun.spawn(
      [process.execPath, 'run', 'src/server.ts', '--port', String(testPort)],
      { cwd: import.meta.dir + '/..', stderr: 'ignore', stdout: 'ignore' },
    )
    try {
      await waitForServer(`http://localhost:${testPort}/`)
      return
    } catch (err) {
      lastError = err
      serverProcess.kill()
      serverProcess = null
    }
  }
  throw lastError
}, 25_000)

afterAll(() => {
  serverProcess?.kill()
})

describe('chat WebSocket server', () => {
  it('responds to /help with command_output event', async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`)

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
