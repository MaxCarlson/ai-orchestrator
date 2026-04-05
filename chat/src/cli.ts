import { parseArgs } from 'util'
import { setConfig } from './commands/config.js'
import { setProjectContext } from './project/context.js'

const VERSION = '0.1.0'

const { values, positionals } = parseArgs({
  options: {
    model:           { type: 'string',  short: 'm' },
    'no-project':    { type: 'boolean', default: false },
    'no-embeddings': { type: 'boolean', default: false },
    dir:             { type: 'string',  short: 'd', default: process.cwd() },
    system:          { type: 'string',  short: 's' },
    'local-url':     { type: 'string',  short: 'u' },
    serve:           { type: 'boolean', default: false },
    port:            { type: 'string',  default: '8765' },
    help:            { type: 'boolean', short: 'h', default: false },
    version:         { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
})

if (values.version) {
  console.log(`aioc (ai-orchestrator) v${VERSION}`)
  process.exit(0)
}

if (values.help) {
  console.log(`
aioc — AI Orchestrator Chat Agent v${VERSION}

Usage: aioc [options] [initial message]

Options:
  -m, --model <name>      Model (default: gemma-4-27b-it for local, or AI_MODEL env)
      --no-project        Disable project auto-detection
      --no-embeddings     Disable semantic context injection
  -d, --dir <path>        Working directory (default: cwd)
  -s, --system <prompt>   Override system prompt
  -u, --local-url <url>   LM Studio base URL (default: http://localhost:1234/v1)
      --serve             Start WebSocket API server (for web UI)
      --port <port>       Port for --serve mode (default: 8765)
  -h, --help              Show this help
  -v, --version           Show version

Slash commands (in TUI):
  /help  /clear  /model  /config  /context  /cost
  /compact  /session  /memory  /project  /embeddings  /tools

Environment:
  ANTHROPIC_API_KEY       Required only for Anthropic (claude-*) models
  AI_MODEL                Override default model (takes highest precedence)
  ANTHROPIC_MODEL         Override default model (Anthropic models)
  CHAT_SYSTEM_PROMPT      Default system prompt
  LM_STUDIO_URL           Local model endpoint (default: http://localhost:1234/v1)
  `)
  process.exit(0)
}

// Apply flag overrides before loading Ink
if (values.model)            setConfig({ model: values.model })
if (values['local-url'])     setConfig({ localUrl: values['local-url'] })
if (values.system)           setConfig({ systemPrompt: values.system })
if (values['no-project'])    setProjectContext({ enabled: false })
if (values['no-embeddings']) setProjectContext({ embeddingsEnabled: false })

const workingDir = values.dir ?? process.cwd()
const initialMessage = positionals.length > 0 ? positionals.join(' ') : undefined

if (values.serve) {
  console.error('WebSocket server not yet implemented. Run without --serve for TUI mode.')
  process.exit(1)
} else {
  // TUI mode — dynamic imports to avoid loading Ink until needed
  const { default: React } = await import('react')
  const { render } = await import('ink')
  const { REPL } = await import('./screens/REPL.js')
  const { QueryEngine } = await import('./QueryEngine.js')

  const engine = new QueryEngine(workingDir)
  const initMessages: string[] = []
  for await (const event of engine.initialize()) {
    if (event.type === 'status') {
      process.stderr.write(event.text + '\n')
      initMessages.push(event.text)
    }
  }

  const replProps = initialMessage !== undefined
    ? { workingDir, engine, initialMessage, initMessages }
    : { workingDir, engine, initMessages }

  const { waitUntilExit } = render(
    React.createElement(REPL, replProps)
  )
  await waitUntilExit()
}
