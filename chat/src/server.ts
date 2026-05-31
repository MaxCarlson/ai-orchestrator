import { parseArgs } from 'util'
import { QueryEngine } from './QueryEngine.js'
import { Logger } from './logger.js'
import { setConfig } from './commands/config.js'
import { setProjectContext } from './project/context.js'

export interface ChatServerOptions {
  port?: string | number
  dir?: string
  noProject?: boolean
  noEmbeddings?: boolean
  model?: string | undefined
  log?: string | null | undefined
}

function printHelp(): void {
  console.log(`
AI Orchestrator Chat WebSocket Server

Usage: bun run serve [options]

Options:
  -p, --port <port>      Listen port (default: 8765)
  -d, --dir <path>       Working directory for tools (default: cwd)
  -m, --model <name>     Default model (default: from config)
  -l, --log <path>       Write debug log to file
      --no-project       Disable project auto-detection
      --no-embeddings    Disable embeddings context
  -h, --help             Show help
  `)
}

interface ClientMessage {
  type: 'message' | 'abort' | 'set_workdir'
  text?: string
  dir?: string
}

type ExtendedWS = {
  engine: QueryEngine
  abort: AbortController | null
}

export function startChatServer(options: ChatServerOptions = {}): void {
  if (options.model)        setConfig({ model: options.model })
  if (options.noProject)    setProjectContext({ enabled: false })
  if (options.noEmbeddings) setProjectContext({ embeddingsEnabled: false })

  const port = typeof options.port === 'number' ? options.port : parseInt(options.port ?? '8765', 10)
  const workingDir = options.dir ?? process.cwd()
  const logPath = typeof options.log === 'string' ? options.log : null

  Bun.serve({
    port,
    fetch(req, server) {
      if (server.upgrade(req)) return
      return new Response('AI Orchestrator Chat WebSocket server', { status: 200 })
    },
    websocket: {
      async open(ws) {
        const ext = ws as typeof ws & ExtendedWS
        const logger = new Logger(logPath)
        ext.engine = new QueryEngine(workingDir, logger)
        for await (const event of ext.engine.initialize()) {
          if (event.type === 'status') ws.send(JSON.stringify(event))
        }
        ext.abort = null
        console.log('[chat-server] client connected')
      },

      async message(ws, rawMessage) {
        const ext = ws as typeof ws & ExtendedWS
        let parsed: ClientMessage
        try {
          parsed = JSON.parse(rawMessage as string) as ClientMessage
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }))
          return
        }

        if (parsed.type === 'abort') {
          ext.abort?.abort()
          ext.abort = null
          return
        }

        if (parsed.type === 'set_workdir' && parsed.dir) {
          const { existsSync } = await import('fs')
          if (existsSync(parsed.dir)) {
            ext.engine.workingDir = parsed.dir
            ws.send(JSON.stringify({ type: 'workdir_changed', dir: parsed.dir }))
          } else {
            ws.send(JSON.stringify({ type: 'error', error: `Directory not found: ${parsed.dir}` }))
          }
          return
        }

        if (parsed.type === 'message' && parsed.text) {
          const abort = new AbortController()
          ext.abort = abort
          try {
            for await (const event of ext.engine.submit(parsed.text, abort.signal)) {
              if (abort.signal.aborted) break
              ws.send(JSON.stringify(event))
            }
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', error: (err as Error).message }))
          } finally {
            ext.abort = null
          }
        }
      },

      close(ws) {
        const ext = ws as typeof ws & ExtendedWS
        ext.abort?.abort()
        console.log('[chat-server] client disconnected')
      },
    },
  })

  console.log(`[chat-server] listening on ws://localhost:${port}`)
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      port:            { type: 'string',  short: 'p', default: '8765' },
      dir:             { type: 'string',  short: 'd', default: process.cwd() },
      'no-project':    { type: 'boolean', default: false },
      'no-embeddings': { type: 'boolean', default: false },
      model:           { type: 'string',  short: 'm' },
      log:             { type: 'string',  short: 'l' },
      help:            { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  startChatServer({
    port: values.port,
    dir: values.dir,
    noProject: values['no-project'],
    noEmbeddings: values['no-embeddings'],
    model: values.model,
    log: values.log,
  })
}
