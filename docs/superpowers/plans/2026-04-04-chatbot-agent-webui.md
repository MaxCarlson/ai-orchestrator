# Chatbot Agent Mode — Web UI + Multi-Provider Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Prerequisite:** Plan A (`2026-04-04-chatbot-agent-tui.md`) AND Plan C (`2026-04-04-chatbot-local-models.md`) must be merged before starting.

**Goal:** Add a browser chat panel to the existing web viewer with provider selection (local LM Studio, Claude, Gemini, OpenAI/Codex), bridged via a Bun WebSocket server. Gemini and OpenAI/Codex backends are added to the TypeScript agent so all providers share the same TUI and web UI.

**Architecture:** The TypeScript `chat/` package gains: (1) a Gemini backend (`backends/gemini_backend.ts`) using `@google/generative-ai`, (2) extended routing in `QueryEngine` for `gemini-*` and `gpt-*`/`o*` model names pointing to OpenAI's API, (3) a Bun WebSocket server (`server.ts`) wrapping `QueryEngine`. The Python FastAPI app proxies WebSocket connections transparently. The browser chat panel has a model/provider selector that sends `/model <name>` to switch providers. GitHub Copilot has no public streaming chat API and is omitted.

**Security note:** All DOM manipulation in `chat.js` uses `textContent` and `createElement`/`appendChild` — never `innerHTML` — to prevent XSS.

**Tech Stack:** Bun ≥1.1, TypeScript 5.7, @google/generative-ai ^0.21 (new), openai ^4 (from Plan C), FastAPI WebSocket proxy (existing `websockets` dep), vanilla JS + CSS

**Provider routing (after this plan):**

| Model prefix | Backend | Auth |
|---|---|---|
| `gemini-*` | Google Generative AI SDK | `GEMINI_API_KEY` |
| `claude-*` | Anthropic SDK | `ANTHROPIC_API_KEY` |
| `gpt-*`, `o1-*`, `o3-*` | OpenAI SDK → api.openai.com | `OPENAI_API_KEY` |
| anything else | OpenAI SDK → LM Studio local | none |

---

## File Map

```
chat/
├── package.json                         MODIFY  — add @google/generative-ai ^0.21
├── src/
│   ├── backends/
│   │   └── gemini_backend.ts            CREATE  — Gemini API streaming backend
│   ├── QueryEngine.ts                   MODIFY  — route gemini-* and gpt-*/o* prefixes
│   ├── commands/
│   │   └── model.ts                     MODIFY  — add Gemini + OpenAI model presets
│   └── server.ts                        CREATE  — Bun WebSocket server wrapping QueryEngine
└── tests/
    ├── backends/
    │   └── gemini_backend_test.ts       CREATE  — message converter unit tests
    └── server_test.ts                   CREATE  — WS server smoke test

orchestrator_web_viewer/orchestrator_web_viewer/
├── api/
│   └── chat.py                          CREATE  — FastAPI WS proxy endpoint
├── static/
│   ├── chat.js                          CREATE  — Browser chat panel (textContent only)
│   └── chat.css                         CREATE  — Chat panel styles
└── main.py                              MODIFY  — mount chat router + serve /chat page
```

---

## Task 1: Gemini Backend

**Files:**
- Modify: `chat/package.json`
- Create: `chat/src/backends/gemini_backend.ts`
- Create: `chat/tests/backends/gemini_backend_test.ts`

**Background:** The Gemini API uses `@google/generative-ai` (not OpenAI-compatible). Streaming works through `generateContentStream()`. Tool calling uses a different format — `functionDeclarations` instead of `tools`. The backend converts our `Message[]` to Gemini's `Content[]` format and yields the same `StreamEvent` union as other backends.

- [ ] **Step 1: Write failing tests**

```typescript
// chat/tests/backends/gemini_backend_test.ts
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
    // Tool results are not in history — they go into the current-turn parts
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
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test tests/backends/gemini_backend_test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Add `@google/generative-ai` dependency**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun add @google/generative-ai
```

Expected: `@google/generative-ai` appears in `chat/package.json`.

- [ ] **Step 4: Create `chat/src/backends/gemini_backend.ts`**

```typescript
import { GoogleGenerativeAI, type Content, type FunctionDeclaration, type Part } from '@google/generative-ai'
import { recordTokenUsage } from '../session/tokenTracker.js'
import { dispatchTools } from '../query.js'
import type { Message, StreamEvent } from '../types/message.js'
import type { Tool } from '../types/tool.js'
import type { QueryOptions } from '../query.js'

// ── Message conversion ────────────────────────────────────────────────────────

/**
 * Converts Message[] to Gemini Content[] history format.
 * ToolResultMessages are excluded — Gemini handles them as function_response
 * parts in the current turn, not as prior history. AssistantMessages with
 * tool_use blocks are converted to function_call parts.
 */
export function toGeminiHistory(messages: Message[]): Content[] {
  const result: Content[] = []

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      result.push({ role: 'user', parts: [{ text: msg.content }] })
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const parts: Part[] = []
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text })
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input as Record<string, unknown>,
            },
          })
        }
      }
      if (parts.length > 0) result.push({ role: 'model', parts })
      continue
    }

    // ToolResultMessages (role: 'user', content: ToolResultBlock[]) are skipped
    // here — they are spliced into the current-turn function_response parts below.
  }

  return result
}

// ── Tool definition conversion ────────────────────────────────────────────────

export function toGeminiFunctionDeclarations(tools: Tool[]): FunctionDeclaration[] {
  return tools.map(t => {
    const def = t.definition()
    return {
      name: def.name,
      description: def.description,
      parameters: def.input_schema as Record<string, unknown>,
    } as FunctionDeclaration
  })
}

// ── Extract pending tool results from message list ────────────────────────────

/**
 * Pulls the last ToolResultMessage from messages and converts it to Gemini
 * function_response parts (used when we're in a tool-call follow-up turn).
 */
function extractPendingToolResponseParts(messages: Message[]): Part[] {
  const parts: Part[] = []
  const last = messages.at(-1)
  if (!last || last.role !== 'user' || typeof last.content !== 'object' || !Array.isArray(last.content)) {
    return parts
  }
  for (const block of last.content) {
    if (block.type === 'tool_result') {
      parts.push({
        functionResponse: {
          name: block.tool_use_id, // Gemini matches by name; we use tool_use_id as proxy
          response: { output: block.content },
        },
      })
    }
  }
  return parts
}

// ── Query loop ────────────────────────────────────────────────────────────────

/**
 * Gemini API agent loop. Yields the same StreamEvent union as queryLoop.
 * Mutates `messages` in place — same contract as other backends.
 *
 * Model routing: called by QueryEngine when model name starts with 'gemini-'.
 * Requires GEMINI_API_KEY environment variable.
 */
export async function* queryLoopGemini(
  messages: Message[],
  tools: Tool[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { model, maxTurns, systemPrompt, abortSignal, workingDir } = options

  const apiKey = process.env['GEMINI_API_KEY']
  if (!apiKey) {
    yield { type: 'error', error: 'GEMINI_API_KEY environment variable is not set' }
    return
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const functionDeclarations = tools.length > 0 ? toGeminiFunctionDeclarations(tools) : undefined

  const geminiModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt || undefined,
    ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
  })

  let turns = 0

  while (turns < maxTurns) {
    turns++

    // Build history from messages (excluding the last message which is the current prompt)
    const allButLast = messages.slice(0, -1)
    const last = messages.at(-1)

    if (!last) break

    const history = toGeminiHistory(allButLast)

    // Current turn parts
    let currentParts: Part[]
    if (last.role === 'user' && typeof last.content === 'string') {
      currentParts = [{ text: last.content }]
    } else if (last.role === 'user' && Array.isArray(last.content)) {
      // Tool results from previous turn
      currentParts = extractPendingToolResponseParts(messages)
      if (currentParts.length === 0) break
    } else {
      break
    }

    const chat = geminiModel.startChat({ history })
    let streamResult: Awaited<ReturnType<typeof chat.sendMessageStream>>

    try {
      streamResult = await chat.sendMessageStream(currentParts)
    } catch (err) {
      yield { type: 'error', error: (err as Error).message }
      return
    }

    let responseText = ''
    const pendingToolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
    let toolCallId = 0

    for await (const chunk of streamResult.stream) {
      if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }

      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if ('text' in part && part.text) {
          responseText += part.text
          yield { type: 'text_delta', text: part.text }
        }

        if ('functionCall' in part && part.functionCall) {
          const id = `gemini_tc_${toolCallId++}`
          pendingToolCalls.push({ name: part.functionCall.name, args: part.functionCall.args as Record<string, unknown> })
          yield { type: 'tool_use_start', toolName: part.functionCall.name, toolUseId: id }
          yield { type: 'tool_use_end' }
        }
      }
    }

    // Token usage from aggregated response
    try {
      const finalResponse = await streamResult.response
      const usage = finalResponse.usageMetadata
      if (usage) {
        recordTokenUsage(usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0, 0)
      }
    } catch { /* usage not always available */ }

    yield { type: 'message_stop' }

    // Build assembled assistant message in Anthropic ContentBlock format
    const assistantContent: Message['content'] = []
    if (responseText) {
      (assistantContent as Array<{ type: 'text'; text: string }>).push({ type: 'text', text: responseText })
    }
    for (const [i, tc] of pendingToolCalls.entries()) {
      const id = `gemini_tc_${i}`
      ;(assistantContent as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>).push(
        { type: 'tool_use', id, name: tc.name, input: tc.args },
      )
    }
    messages.push({ role: 'assistant', content: assistantContent as import('@anthropic-ai/sdk/resources/messages.js').ContentBlock[] })

    if (pendingToolCalls.length === 0) break

    const pendingToolUse = pendingToolCalls.map((tc, i) => ({
      id: `gemini_tc_${i}`,
      name: tc.name,
      inputJson: JSON.stringify(tc.args),
    }))

    const toolResults = await dispatchTools(pendingToolUse, tools, { abortSignal, workingDir })

    messages.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error ? { is_error: true } : {}),
      })),
    })
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test
```

Expected: All prior tests + 3 new Gemini converter tests pass.

- [ ] **Step 6: Typecheck**

```bash
~/.bun/bin/bun run typecheck
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/package.json chat/bun.lock chat/src/backends/gemini_backend.ts chat/tests/backends/gemini_backend_test.ts
git commit -m "feat(chat): add Gemini API streaming backend"
```

---

## Task 2: Extended Routing — Gemini + OpenAI Cloud + Model Presets

**Files:**
- Modify: `chat/src/QueryEngine.ts`
- Modify: `chat/src/commands/model.ts`

**Background:** After this task, `QueryEngine` routes four ways:
- `gemini-*` → `queryLoopGemini`
- `claude-*` → `queryLoop` (Anthropic)
- `gpt-*`, `o1-*`, `o3-*` → `queryLoopOpenAI` pointing at `https://api.openai.com/v1`
- everything else → `queryLoopOpenAI` pointing at `localUrl` (LM Studio)

The OpenAI backend from Plan C can handle both LM Studio AND `api.openai.com` — they're the same protocol, different baseURL and API key.

- [ ] **Step 1: Update `chat/src/QueryEngine.ts` routing**

Read `QueryEngine.ts` and find the backend routing section added in Plan C:

```typescript
    const isLocalModel = !cfg.model.startsWith('claude-')
    const loopFn = isLocalModel ? queryLoopOpenAI : queryLoop
```

Replace with:

```typescript
    // Route by model name prefix:
    //   gemini-*        → Google Generative AI
    //   claude-*        → Anthropic
    //   gpt-* / o1-* / o3-*  → OpenAI API (api.openai.com)
    //   anything else   → LM Studio local (OpenAI-compat at localUrl)
    const isGemini = cfg.model.startsWith('gemini-')
    const isClaude = cfg.model.startsWith('claude-')
    const isOpenAICloud = /^(gpt-|o1-|o3-)/.test(cfg.model)

    let loopOptions = {
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      systemPrompt: cfg.systemPrompt + projectAddition,
      abortSignal,
      workingDir: this.workingDir,
      localUrl: isOpenAICloud ? 'https://api.openai.com/v1' : cfg.localUrl,
    }

    const loopFn = isGemini ? queryLoopGemini
      : isClaude ? queryLoop
      : queryLoopOpenAI  // handles both LM Studio and OpenAI cloud via localUrl
```

Also add the Gemini import at the top with the other backend imports:

```typescript
import { queryLoopGemini } from './backends/gemini_backend.js'
```

And change the for-loop to use `loopOptions`:

```typescript
    for await (const event of loopFn(this.messages, this.tools, loopOptions)) {
      yield event
    }
```

For the OpenAI cloud case, the `queryLoopOpenAI` function also needs to pick up the API key from `OPENAI_API_KEY`. Read `chat/src/backends/openai_compat.ts` and update the client construction:

```typescript
  const client = new OpenAI({
    baseURL: localUrl ?? 'http://localhost:1234/v1',
    // For api.openai.com, use OPENAI_API_KEY; for LM Studio, any non-empty string works
    apiKey: process.env['OPENAI_API_KEY'] ?? 'lm-studio',
  })
```

- [ ] **Step 2: Update `chat/src/commands/model.ts`** with Gemini + OpenAI presets

Replace `model.ts` entirely:

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig, setConfig } from './config.js'

const ANTHROPIC_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

const GEMINI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
]

const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o1',
]

// Local model IDs as they appear in LM Studio UI
const LOCAL_MODELS = [
  'gemma-4-27b-it',        // Deep research / planning — Gemma 4 31B-it
  'devstral-small-2',      // Agentic coding / repo editing — Devstral Small 2 24B
  'qwen3-32b',             // Reasoning + coding + thinking modes
  'gemma-4-4b-it',         // Summarization / memory — Gemma 4 E4B
  'gemma-4-2b-it',         // Router / classifier — Gemma 4 E2B
]

function getBackendLabel(model: string, localUrl: string): string {
  if (model.startsWith('gemini-')) return 'Google Generative AI (GEMINI_API_KEY)'
  if (model.startsWith('claude-')) return 'Anthropic API (ANTHROPIC_API_KEY)'
  if (/^(gpt-|o1-|o3-)/.test(model)) return 'OpenAI API (OPENAI_API_KEY)'
  return `local LM Studio (${localUrl})`
}

export class ModelCommand implements SlashCommand {
  name = 'model'
  aliases = ['m']
  description = 'View or switch model: /model [name]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const name = args.trim()
    const cfg = getConfig()
    const backend = getBackendLabel(cfg.model, cfg.localUrl)

    if (!name) {
      const fmt = (list: string[]) =>
        list.map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`)).join('\n')

      return {
        type: 'output',
        text: [
          `Current model: ${cfg.model}`,
          `Backend: ${backend}`,
          '',
          `Local models — LM Studio at ${cfg.localUrl}:`,
          fmt(LOCAL_MODELS),
          '',
          'Anthropic models (ANTHROPIC_API_KEY):',
          fmt(ANTHROPIC_MODELS),
          '',
          'Gemini models (GEMINI_API_KEY):',
          fmt(GEMINI_MODELS),
          '',
          'OpenAI models (OPENAI_API_KEY):',
          fmt(OPENAI_MODELS),
          '',
          'Usage: /model <name>',
          'Tip:   /config localUrl http://localhost:1234/v1  — change LM Studio address',
        ].join('\n'),
      }
    }

    setConfig({ model: name })
    const newBackend = getBackendLabel(name, cfg.localUrl)
    return { type: 'output', text: `Model switched to: ${name}\nBackend: ${newBackend}` }
  }
}
```

- [ ] **Step 3: Run tests**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test
```

Expected: All tests pass.

- [ ] **Step 4: Typecheck**

```bash
~/.bun/bin/bun run typecheck
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/QueryEngine.ts chat/src/backends/openai_compat.ts chat/src/commands/model.ts
git commit -m "feat(chat): route gemini-* to Google, gpt-*/o* to OpenAI cloud, local as default"
```

---

## Task 3: Bun WebSocket Server

**Files:**
- Create: `chat/src/server.ts`
- Create: `chat/tests/server_test.ts`
- Modify: `chat/package.json` (scripts)

**Protocol (client → server):**
```
{ "type": "message", "text": "user input" }
{ "type": "abort" }
```

**Protocol (server → client):**
```
{ "type": "text_delta", "text": "..." }
{ "type": "tool_use_start", "toolName": "...", "toolUseId": "..." }
{ "type": "tool_use_end" }
{ "type": "message_stop" }
{ "type": "command_output", "text": "..." }
{ "type": "command_clear" }
{ "type": "error", "error": "..." }
{ "type": "session_saved", "sessionId": "..." }
```

- [ ] **Step 1: Write failing smoke test**

```typescript
// chat/tests/server_test.ts
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
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test tests/server_test.ts
```

Expected: FAIL — server.ts not found.

- [ ] **Step 3: Create `chat/src/server.ts`**

```typescript
import { parseArgs } from 'util'
import { QueryEngine } from './QueryEngine.js'
import { setConfig } from './commands/config.js'
import { setProjectContext } from './project/context.js'

const { values } = parseArgs({
  options: {
    port:            { type: 'string',  short: 'p', default: '8765' },
    dir:             { type: 'string',  short: 'd', default: process.cwd() },
    'no-project':    { type: 'boolean', default: false },
    'no-embeddings': { type: 'boolean', default: false },
    model:           { type: 'string',  short: 'm' },
    help:            { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`
AI Orchestrator Chat WebSocket Server

Usage: bun run serve [options]

Options:
  -p, --port <port>      Listen port (default: 8765)
  -d, --dir <path>       Working directory for tools (default: cwd)
  -m, --model <name>     Default model (default: from config)
      --no-project       Disable project auto-detection
      --no-embeddings    Disable embeddings context
  -h, --help             Show help
  `)
  process.exit(0)
}

if (values.model)           setConfig({ model: values.model })
if (values['no-project'])   setProjectContext({ enabled: false })
if (values['no-embeddings'])setProjectContext({ embeddingsEnabled: false })

const PORT = parseInt(values.port ?? '8765', 10)
const WORKING_DIR = values.dir ?? process.cwd()

interface ClientMessage {
  type: 'message' | 'abort'
  text?: string
}

type ExtendedWS = {
  engine: QueryEngine
  abort: AbortController | null
}

Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return
    return new Response('AI Orchestrator Chat WebSocket server', { status: 200 })
  },
  websocket: {
    async open(ws) {
      const ext = ws as typeof ws & ExtendedWS
      ext.engine = new QueryEngine(WORKING_DIR)
      await ext.engine.initialize()
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

console.log(`[chat-server] listening on ws://localhost:${PORT}`)
```

- [ ] **Step 4: Add `serve` script to `chat/package.json`**

The `serve` script already exists (added in Plan A). Verify it reads:
```json
"serve": "bun run src/server.ts"
```

If it was previously a stub or pointed elsewhere, update it to the above.

- [ ] **Step 5: Run server test**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test tests/server_test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full test suite**

```bash
~/.bun/bin/bun test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/server.ts chat/tests/server_test.ts
git commit -m "feat(chat): add Bun WebSocket API server with per-connection QueryEngine"
```

---

## Task 4: FastAPI WebSocket Proxy

**Files:**
- Create: `orchestrator_web_viewer/orchestrator_web_viewer/api/chat.py`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/main.py`

- [ ] **Step 1: Install `websockets` if not present**

```bash
cd /home/mcarls/projects/ai-orchestrator/orchestrator_web_viewer
grep -q websockets pyproject.toml && echo "already installed" || uv add websockets
```

- [ ] **Step 2: Create `orchestrator_web_viewer/orchestrator_web_viewer/api/chat.py`**

```python
"""WebSocket proxy to the TypeScript chat agent server."""
import asyncio
import json
import logging

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ws", tags=["chat"])

CHAT_SERVER_URL = "ws://localhost:8765"


@router.websocket("/chat")
async def chat_proxy(client_ws: WebSocket) -> None:
    """Proxy WebSocket connections transparently to the TypeScript chat server."""
    await client_ws.accept()
    log.info("Chat WebSocket client connected")
    try:
        async with websockets.connect(CHAT_SERVER_URL) as server_ws:
            async def client_to_server() -> None:
                try:
                    while True:
                        data = await client_ws.receive_text()
                        await server_ws.send(data)
                except WebSocketDisconnect:
                    await server_ws.close()

            async def server_to_client() -> None:
                try:
                    async for message in server_ws:
                        await client_ws.send_text(str(message))
                except websockets.exceptions.ConnectionClosed:
                    pass

            await asyncio.gather(client_to_server(), server_to_client())
    except (OSError, websockets.exceptions.WebSocketException) as exc:
        log.error("Chat server not reachable: %s", exc)
        await client_ws.send_text(json.dumps({
            "type": "error",
            "error": "Chat agent server is not running. Start it with: cd chat && bun run serve",
        }))
        await client_ws.close()
    finally:
        log.info("Chat WebSocket client disconnected")
```

- [ ] **Step 3: Mount chat router in `main.py`**

Read `orchestrator_web_viewer/orchestrator_web_viewer/main.py`. Add with the other api imports at the top:
```python
from orchestrator_web_viewer.api.chat import router as chat_router
```

Add with the other `app.include_router` calls:
```python
app.include_router(chat_router)
```

- [ ] **Step 4: Verify endpoint exists**

```bash
cd /home/mcarls/projects/ai-orchestrator/orchestrator_web_viewer
uv run python -c "
from orchestrator_web_viewer.main import app
routes = [r.path for r in app.routes]
print('ws/chat found:', any('ws/chat' in r for r in routes))
"
```

Expected: `ws/chat found: True`

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add orchestrator_web_viewer/orchestrator_web_viewer/api/chat.py
git add orchestrator_web_viewer/orchestrator_web_viewer/main.py
git commit -m "feat(webui): add FastAPI WebSocket proxy to TypeScript chat server"
```

---

## Task 5: Browser Chat Panel — HTML, CSS, JavaScript

**Files:**
- Create: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.css`
- Create: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/main.py` (add `/chat` route)

**XSS safety contract:** Every piece of server-sourced text is assigned via `.textContent` only. No `innerHTML` assignments anywhere in `chat.js`. No `eval`. No `Function()`.

- [ ] **Step 1: Add `/chat` route and `_CHAT_PAGE_HTML` to `main.py`**

Add this near the other route definitions in `main.py`:

```python
from fastapi.responses import HTMLResponse

_CHAT_PAGE_HTML = (
    '<!DOCTYPE html><html lang="en"><head>'
    '<meta charset="UTF-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    '<title>AI Orchestrator - Chat Agent</title>'
    '<link rel="stylesheet" href="/static/chat.css"></head><body>'
    '<div id="app">'
    '<header class="chat-header">'
    '<h1>AI Orchestrator <span class="badge">Chat Agent</span></h1>'
    '<div class="header-actions">'
    '<select id="model-select">'
    '<optgroup label="Local (LM Studio)">'
    '<option value="gemma-4-27b-it">gemma-4-27b-it (research)</option>'
    '<option value="devstral-small-2">devstral-small-2 (coding)</option>'
    '<option value="qwen3-32b">qwen3-32b</option>'
    '<option value="gemma-4-4b-it">gemma-4-4b-it (fast)</option>'
    '</optgroup>'
    '<optgroup label="Anthropic">'
    '<option value="claude-sonnet-4-6">claude-sonnet-4-6</option>'
    '<option value="claude-opus-4-6">claude-opus-4-6</option>'
    '<option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>'
    '</optgroup>'
    '<optgroup label="Google">'
    '<option value="gemini-2.5-flash">gemini-2.5-flash</option>'
    '<option value="gemini-2.5-pro">gemini-2.5-pro</option>'
    '</optgroup>'
    '<optgroup label="OpenAI / Codex">'
    '<option value="gpt-4o">gpt-4o</option>'
    '<option value="gpt-4o-mini">gpt-4o-mini</option>'
    '<option value="o3">o3</option>'
    '</optgroup>'
    '</select>'
    '<button id="btn-clear">/clear</button>'
    '<button id="btn-cost">/cost</button>'
    '<span id="conn-status" class="status disconnected">disconnected</span>'
    '</div></header>'
    '<div id="message-list" aria-live="polite">'
    '<div class="message system"><span class="role">System</span>'
    '<p>Chat agent ready. Type /help for commands. Select a provider above.</p></div>'
    '</div>'
    '<div id="tool-progress"></div>'
    '<form id="input-form" autocomplete="off">'
    '<textarea id="chat-input" rows="2" '
    'placeholder="Type a message or /help for commands (Shift+Enter for newline)"></textarea>'
    '<button type="submit" id="btn-send">Send</button>'
    '</form></div>'
    '<script src="/static/chat.js"></script>'
    '</body></html>'
)

@app.get("/chat", response_class=HTMLResponse)
async def chat_page() -> HTMLResponse:
    return HTMLResponse(content=_CHAT_PAGE_HTML)
```

- [ ] **Step 2: Create `chat.css`**

```css
/* orchestrator_web_viewer/orchestrator_web_viewer/static/chat.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #c9d1d9; --text-muted: #6e7681;
  --accent: #58a6ff; --green: #3fb950; --yellow: #d29922; --red: #f85149;
}
body { background: var(--bg); color: var(--text); font-family: 'Cascadia Code', 'Fira Code', monospace; height: 100dvh; overflow: hidden; }
#app { display: flex; flex-direction: column; height: 100dvh; }
.chat-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex-wrap: wrap; gap: 8px; }
.chat-header h1 { font-size: 1rem; color: var(--accent); }
.badge { font-size: 0.7rem; background: var(--accent); color: #000; border-radius: 4px; padding: 1px 6px; margin-left: 8px; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.header-actions select { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 3px 8px; border-radius: 4px; font-family: inherit; font-size: 0.8rem; cursor: pointer; }
.header-actions select:focus { outline: none; border-color: var(--accent); }
.header-actions button { background: transparent; border: 1px solid var(--border); color: var(--text-muted); padding: 3px 8px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 0.8rem; }
.header-actions button:hover { border-color: var(--accent); color: var(--accent); }
.status { font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
.status.connected { background: #1a3028; color: var(--green); }
.status.disconnected { background: #2d1a1a; color: var(--red); }
.status.streaming { background: #1e2d1a; color: var(--yellow); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
#message-list { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; }
.message { padding: 10px 14px; border-radius: 8px; max-width: 90%; }
.message.user { background: #1c2128; border: 1px solid var(--border); align-self: flex-end; }
.message.assistant { background: var(--bg); border: 1px solid var(--border); align-self: flex-start; }
.message.system { background: transparent; border: 1px solid var(--border); color: var(--text-muted); align-self: center; font-size: 0.85rem; text-align: center; max-width: 100%; }
.message.command { background: #162032; border: 1px solid #1f3a5f; align-self: flex-start; font-size: 0.85rem; }
.message.error { background: #2d1a1a; border: 1px solid var(--red); color: var(--red); align-self: flex-start; }
.role { display: block; font-size: 0.7rem; font-weight: bold; margin-bottom: 4px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.message.user .role { color: var(--green); }
.message.assistant .role { color: var(--accent); }
.message p { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.streaming-cursor::after { content: '|'; animation: pulse 0.8s ease-in-out infinite; color: var(--accent); }
#tool-progress { padding: 0 16px; min-height: 0; }
.tool-item { display: flex; align-items: center; gap: 8px; color: var(--yellow); font-size: 0.85rem; padding: 4px 0; }
#input-form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--surface); }
#chat-input { flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 0.9rem; resize: none; outline: none; }
#chat-input:focus { border-color: var(--accent); }
#chat-input:disabled { opacity: 0.5; cursor: not-allowed; }
#btn-send { background: var(--accent); color: #000; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 0.9rem; font-weight: bold; }
#btn-send:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 3: Create `chat.js`**

```javascript
// orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js
// XSS safety: all server-sourced content is set via .textContent ONLY. Never innerHTML.
'use strict'

var WS_URL = 'ws://' + location.host + '/ws/chat'

var messageList = document.getElementById('message-list')
var inputEl = document.getElementById('chat-input')
var sendBtn = document.getElementById('btn-send')
var statusEl = document.getElementById('conn-status')
var toolProgress = document.getElementById('tool-progress')
var modelSelect = document.getElementById('model-select')

var ws = null
var streaming = false
var streamingMsgEl = null
var activeTools = new Map()

// ── Connection ───────────────────────────────────────────────────────────────

function connect() {
  ws = new WebSocket(WS_URL)
  ws.addEventListener('open', function() { setStatus('connected') })
  ws.addEventListener('close', function() { setStatus('disconnected'); setTimeout(connect, 2000) })
  ws.addEventListener('error', function() { setStatus('disconnected') })
  ws.addEventListener('message', function(e) {
    handleEvent(JSON.parse(e.data))
  })
}

function setStatus(state) {
  statusEl.className = 'status ' + state
  // Safe: hardcoded strings, not server data
  statusEl.textContent = state
}

// ── Provider / model selection ───────────────────────────────────────────────

modelSelect.addEventListener('change', function() {
  var model = modelSelect.value
  if (!model || streaming || !ws || ws.readyState !== 1) return
  // Use slash command to switch model — processed server-side without API call
  ws.send(JSON.stringify({ type: 'message', text: '/model ' + model }))
  setStreaming(true)
})

// ── Event handler ────────────────────────────────────────────────────────────

function handleEvent(event) {
  if (event.type === 'text_delta') {
    if (!streamingMsgEl) {
      streamingMsgEl = appendMessage('assistant', '')
      streamingMsgEl.querySelector('p').classList.add('streaming-cursor')
    }
    // Safe: .textContent only — server text never parsed as HTML
    streamingMsgEl.querySelector('p').textContent += event.text
    scrollBottom()
    setStatus('streaming')

  } else if (event.type === 'tool_use_start') {
    var toolEl = document.createElement('div')
    toolEl.className = 'tool-item'
    // Safe: .textContent
    toolEl.textContent = '\u2699\ufe0f ' + event.toolName + '\u2026'
    toolEl.dataset.toolId = event.toolUseId
    toolProgress.appendChild(toolEl)
    activeTools.set(event.toolUseId, toolEl)

  } else if (event.type === 'tool_use_end') {
    activeTools.forEach(function(el) { el.remove() })
    activeTools.clear()

  } else if (event.type === 'message_stop') {
    if (streamingMsgEl) {
      streamingMsgEl.querySelector('p').classList.remove('streaming-cursor')
      streamingMsgEl = null
    }
    setStreaming(false)
    setStatus('connected')

  } else if (event.type === 'command_output') {
    // Safe: .textContent
    appendMessage('command', event.text)
    setStreaming(false)
    setStatus('connected')

  } else if (event.type === 'command_clear') {
    messageList.textContent = ''
    appendMessage('system', 'Conversation cleared.')
    setStreaming(false)
    setStatus('connected')

  } else if (event.type === 'error') {
    // Safe: .textContent
    appendMessage('error', 'Error: ' + event.error)
    setStreaming(false)
    setStatus('connected')
  }
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

var ROLE_LABELS = { user: 'You', assistant: 'AI', command: 'Command', error: 'Error', system: 'System' }

function appendMessage(role, text) {
  var div = document.createElement('div')
  div.className = 'message ' + role

  var roleEl = document.createElement('span')
  roleEl.className = 'role'
  // Safe: ROLE_LABELS values are hardcoded strings
  roleEl.textContent = ROLE_LABELS[role] || role
  div.appendChild(roleEl)

  var p = document.createElement('p')
  // Safe: server text via .textContent only
  p.textContent = text
  div.appendChild(p)

  messageList.appendChild(div)
  scrollBottom()
  return div
}

function scrollBottom() {
  messageList.scrollTop = messageList.scrollHeight
}

function setStreaming(active) {
  streaming = active
  inputEl.disabled = active
  sendBtn.disabled = active
  modelSelect.disabled = active
  if (!active) inputEl.focus()
}

// ── Send ─────────────────────────────────────────────────────────────────────

document.getElementById('input-form').addEventListener('submit', function(e) {
  e.preventDefault()
  doSend()
})

inputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() }
})

function doSend() {
  var text = inputEl.value.trim()
  if (!text || streaming || !ws || ws.readyState !== 1) return
  appendMessage('user', text)
  inputEl.value = ''
  setStreaming(true)
  ws.send(JSON.stringify({ type: 'message', text: text }))
  scrollBottom()
}

// ── Header buttons ───────────────────────────────────────────────────────────

document.getElementById('btn-clear').addEventListener('click', function() {
  if (streaming || !ws || ws.readyState !== 1) return
  ws.send(JSON.stringify({ type: 'message', text: '/clear' }))
  setStreaming(true)
})

document.getElementById('btn-cost').addEventListener('click', function() {
  if (streaming || !ws || ws.readyState !== 1) return
  ws.send(JSON.stringify({ type: 'message', text: '/cost' }))
  setStreaming(true)
})

// ── Boot ─────────────────────────────────────────────────────────────────────
connect()
inputEl.focus()
```

- [ ] **Step 4: Add Chat Agent link to main navigation**

In `main.py`, find the root `GET /` handler that returns the main HTML page. Locate the navigation section and add a link using safe string concatenation (not innerHTML):

```python
# In the root HTML template nav section, add:
'<a href="/chat">Chat Agent</a>'
```

- [ ] **Step 5: Manual end-to-end test**

Terminal 1:
```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun run serve
```

Terminal 2:
```bash
cd /home/mcarls/projects/ai-orchestrator/orchestrator_web_viewer
uv run python -m orchestrator_web_viewer.main
```

Browser: `http://localhost:8000/chat`

Verify:
1. Status shows "connected" (green)
2. Provider dropdown is visible with Local/Anthropic/Google/OpenAI groups
3. Selecting "gemma-4-27b-it" and sending a message routes to LM Studio
4. `/clear` button works
5. `/cost` button shows token usage
6. Selecting `claude-sonnet-4-6` and sending a message routes to Anthropic (if `ANTHROPIC_API_KEY` set)
7. All text arrives via streaming cursor

- [ ] **Step 6: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add orchestrator_web_viewer/orchestrator_web_viewer/static/chat.css
git add orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js
git add orchestrator_web_viewer/orchestrator_web_viewer/main.py
git commit -m "feat(webui): add browser chat panel with provider selector (local/Claude/Gemini/OpenAI)"
```

---

## Task 6: Root Workspace Scripts + README

**Files:**
- Modify: `/home/mcarls/projects/ai-orchestrator/package.json`
- Modify: `README.md`

- [ ] **Step 1: Update root `package.json`**

Read `/home/mcarls/projects/ai-orchestrator/package.json` and update the scripts:

```json
{
  "name": "ai-orchestrator",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["chat"],
  "scripts": {
    "chat":       "cd chat && ~/.bun/bin/bun run src/cli.ts",
    "chat:serve": "cd chat && ~/.bun/bin/bun run src/server.ts",
    "chat:test":  "cd chat && ~/.bun/bin/bun test"
  }
}
```

- [ ] **Step 2: Update README provider table**

In `README.md`, find the **Local GPU Models** section added in Plan C and add a "Supported providers" subsection after the model stack table:

```markdown
### All Supported Providers

The `ai` TUI and web chat UI support these providers via the same interface:

| Provider | Models | Auth Required |
|----------|--------|---------------|
| Local (LM Studio) | `gemma-4-27b-it`, `devstral-small-2`, `qwen3-32b`, ... | None |
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-6`, ... | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` | `GEMINI_API_KEY` |
| OpenAI / Codex | `gpt-4o`, `gpt-4o-mini`, `o3`, `o1` | `OPENAI_API_KEY` |

Switch provider in TUI: `/model gemini-2.5-flash`
Switch provider in web UI: use the dropdown selector
```

Also add a quick-start entry to the Quick Reference section at the top:
```bash
# Start web chat UI (requires chat server running separately)
bun run chat:serve   # terminal 1: TypeScript WS server
uv run python -m orchestrator_web_viewer.main  # terminal 2: FastAPI
# Open http://localhost:8000/chat
```

- [ ] **Step 3: Final test run**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add package.json README.md
git commit -m "docs: document multi-provider chat support and web UI setup"
```

---

## Self-Review

### Spec Coverage

| Requirement | Covered by |
|-------------|------------|
| Local LM Studio (primary) | Plan C prerequisite + routing preserved |
| Claude in web UI | Task 2 routing + Task 5 model dropdown |
| Gemini in TUI + web UI | Task 1 backend + Task 2 routing + Task 5 dropdown |
| OpenAI/Codex in TUI + web UI | Task 2 routing (openai_compat.ts via api.openai.com) + Task 5 |
| GitHub Copilot | Omitted — no public streaming chat API |
| Provider selector in web UI | Task 5 — `<select id="model-select">` sends `/model` command |
| WebSocket server | Task 3 — `chat/src/server.ts` |
| FastAPI proxy | Task 4 |
| Browser chat panel | Task 5 |
| XSS safety | Task 5 — all server text via `.textContent` only |
| Streaming responses in browser | Task 5 — `text_delta` events update textContent live |
| Tool progress in browser | Task 5 — `tool_use_start/end` events |
| `/clear` and `/cost` buttons | Task 5 |
| `GEMINI_API_KEY` auth | Task 1 — runtime check with clear error |
| `OPENAI_API_KEY` auth | Task 2 — env var picked up by `openai_compat.ts` |

### Placeholder Scan

All code blocks are complete. No TBDs.

### Type Consistency

- `queryLoopGemini` signature: `(messages: Message[], tools: Tool[], options: QueryOptions)` — same as `queryLoop` and `queryLoopOpenAI`
- `toGeminiHistory` returns `Content[]` from `@google/generative-ai` — not mixed with other types
- `assistantContent` in `gemini_backend.ts` is cast to `ContentBlock[]` — same pattern as `openai_compat.ts`
- `loopFn` in `QueryEngine` is assigned one of three functions with identical signatures, then called with `loopOptions` — type-safe

### Known Omissions

- **GitHub Copilot**: `gh copilot suggest/explain` are non-streaming one-shot commands, not suitable for chat. If GitHub releases a Copilot streaming API, a `copilot_backend.ts` can be added without changing anything else.
- **Per-connection model state**: Global `setConfig()` module state means all WS connections share the same model. Fine for single-user; multi-user would require per-connection config (tracked as future work).
