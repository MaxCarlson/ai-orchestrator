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
    serve:           { type: 'boolean', default: false },
    port:            { type: 'string',  default: '8765' },
    help:            { type: 'boolean', short: 'h', default: false },
    version:         { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
})

if (values.version) {
  console.log(`ai-orchestrator chat v${VERSION}`)
  process.exit(0)
}

if (values.help) {
  console.log(`
ai — AI Orchestrator Chat Agent v${VERSION}

Usage: ai [options] [initial message]

Options:
  -m, --model <name>      Model (default: claude-sonnet-4-6)
      --no-project        Disable project auto-detection
      --no-embeddings     Disable semantic context injection
  -d, --dir <path>        Working directory (default: cwd)
  -s, --system <prompt>   Override system prompt
      --serve             Start WebSocket API server (for web UI)
      --port <port>       Port for --serve mode (default: 8765)
  -h, --help              Show this help
  -v, --version           Show version

Slash commands (in TUI):
  /help  /clear  /model  /config  /context  /cost
  /compact  /session  /memory  /project  /embeddings  /tools

Environment:
  ANTHROPIC_API_KEY       Required — your Anthropic API key
  ANTHROPIC_MODEL         Default model override
  CHAT_SYSTEM_PROMPT      Default system prompt
  `)
  process.exit(0)
}

// Apply flag overrides before loading Ink
if (values.model)            setConfig({ model: values.model })
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
  await engine.initialize()

  const replProps = initialMessage !== undefined
    ? { workingDir, engine, initialMessage }
    : { workingDir, engine }

  const { waitUntilExit } = render(
    React.createElement(REPL, replProps)
  )
  await waitUntilExit()
}
