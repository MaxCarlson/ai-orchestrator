# Chatbot Agent — Web UI & Feature Expansion Plan (Revised 2026-04-11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Prerequisite:** Plan A TUI is complete and merged.

---

## Status: What's Already Done

The following were completed during Plan A implementation (crossed off — do not redo):

- ~~Task A: Gemini API backend (`backends/gemini_backend.ts`)~~
- ~~Task B: Extended QueryEngine routing (gemini-*, claude-*, gpt-*, local)~~
- ~~Task C: Bun WebSocket server (`server.ts`)~~
- ~~Task D: FastAPI WebSocket proxy + `/api/chat/models` endpoint (`api/chat.py`)~~
- ~~Task E: Browser chat SPA view (chat.js, chat.css, index.html integration)~~
- ~~Task F: Dynamic model selector (populated from `/api/chat/models` at runtime)~~
- ~~Task G: Log viewer panel with thinking/tool-use/tool-result/model-output categories~~
- ~~Task H: Docker container for chat server (`docker/chat/Dockerfile`, docker-compose service)~~
- ~~Task I: `build/start.sh` and `build/build_all.sh` fixed (`--pull=missing`)~~

---

## Remaining Feature Map

```
chat/
├── src/
│   ├── backends/
│   │   ├── cli_claude.ts          CREATE  — @claude CLI subprocess backend
│   │   ├── cli_gemini.ts          CREATE  — @gemini CLI subprocess backend
│   │   ├── cli_codex.ts           CREATE  — @codex CLI subprocess backend
│   │   └── cli_copilot.ts         CREATE  — @copilot CLI subprocess backend
│   └── QueryEngine.ts             MODIFY  — route @-prefixed models to CLI backends
│
orchestrator_web_viewer/orchestrator_web_viewer/
├── api/
│   ├── chat.py                    MODIFY  — expose model search, HF model lookup
│   └── chat_memory.py             CREATE  — per-project + global memory CRUD + stats
├── static/
│   ├── chat.js                    MODIFY  — model filter, collapse, debug mode
│   ├── chat.css                   MODIFY  — collapse styles, debug panel
│   ├── memory.js                  MODIFY  — memory stats + shared-memory UI
│   └── index.html                 MODIFY  — Memory tab enhancements
└── templates/benchmark.html       CREATE  — benchmark runner page (future tab)

tests/
├── chat/tests/backends/
│   ├── cli_claude_test.ts         CREATE
│   └── cli_gemini_test.ts         CREATE
└── orchestrator_web_viewer/tests/
    └── chat_memory_test.py        CREATE
```

---

## Implementation Order

> Features ordered by dependency and user impact. TUI enhancements mixed in where they unblock or complement web features.

1. **Task 1** — CLI subprocess backends (`@claude`, `@gemini`, `@codex`, `@copilot`)
2. **Task 2** — TUI: collapsible messages + per-reply tool trace (debug mode)
3. **Task 3** — WebUI: log panel enhancements (tool timeline, expandable entries)
4. **Task 4** — WebUI: model dropdown search/filter
5. **Task 5** — Memory system infrastructure (API + DB schema)
6. **Task 6** — WebUI: Memory tab (stats, browse, save from chat)
7. **Task 7** — Chat ↔ Memory integration (save memories, load project context)
8. **Task 8** — Shared memory groups across projects
9. **Task 9** — HuggingFace model browser (search + LM Studio download link)
10. **Task 10** — Agent benchmark runner

---

## Task 1: CLI Subprocess Backends (`@claude`, `@gemini`, `@codex`, `@copilot`)

**Goal:** Route `@claude`, `@gemini`, `@codex`, `@copilot` model names to the actual CLIs
installed on the host machine, rather than API calls. The `@` prefix signals "use the CLI tool,
not the API." This is the primary use case the user wants — no API keys needed beyond what
the CLIs already manage.

**Protocol:** Each CLI backend spawns a child process, sends the conversation as a prompt,
and streams the response. The backend yields the same `StreamEvent` union as API backends.

**Files:**
- Create: `chat/src/backends/cli_claude.ts`
- Create: `chat/src/backends/cli_gemini.ts`
- Create: `chat/src/backends/cli_codex.ts`
- Create: `chat/src/backends/cli_copilot.ts`
- Modify: `chat/src/QueryEngine.ts` — add `@` prefix routing
- Create: `chat/tests/backends/cli_claude_test.ts`
- Create: `chat/tests/backends/cli_gemini_test.ts`

**Routing addition to `QueryEngine.ts`:**
```typescript
const isCLI = model.startsWith('@')
if (isCLI) {
  const cliName = model.slice(1)  // 'claude', 'gemini', 'codex', 'copilot'
  const { queryLoopCLI } = await import(`./backends/cli_${cliName}.js`)
  loop = queryLoopCLI(this.messages, this.tools, baseOptions)
}
```

**Model list addition in `api/chat.py`:**
`@claude`, `@gemini`, `@codex`, `@copilot` are already in `_CLI_MODELS` as the first group.
The QueryEngine just needs to route them. No Python changes required.

### Step 1: Write failing tests for CLI backends

```typescript
// chat/tests/backends/cli_claude_test.ts
import { describe, it, expect } from 'bun:test'
import { buildClaudeArgs } from '../../src/backends/cli_claude.js'
import type { Message } from '../../src/types/message.js'

describe('buildClaudeArgs', () => {
  it('returns print flag with conversation text', () => {
    const msgs: Message[] = [{ role: 'user', content: 'Hello world' }]
    const args = buildClaudeArgs(msgs, { systemPrompt: '' })
    expect(args).toContain('--print')
  })

  it('injects system prompt via --system-prompt flag', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const args = buildClaudeArgs(msgs, { systemPrompt: 'Be terse' })
    const idx = args.indexOf('--system-prompt')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('Be terse')
  })

  it('passes --no-tools when tools list is empty', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const args = buildClaudeArgs(msgs, { systemPrompt: '', noTools: true })
    expect(args).toContain('--no-tools')
  })
})
```

```typescript
// chat/tests/backends/cli_gemini_test.ts
import { describe, it, expect } from 'bun:test'
import { buildPromptText } from '../../src/backends/cli_gemini.js'
import type { Message } from '../../src/types/message.js'

describe('buildPromptText', () => {
  it('concatenates user/assistant turns', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: [{ type: 'text', text: '4' }] },
      { role: 'user', content: 'And 3+3?' },
    ]
    const text = buildPromptText(msgs)
    expect(text).toContain('What is 2+2?')
    expect(text).toContain('4')
    expect(text).toContain('And 3+3?')
  })
})
```

### Step 2: Run to confirm FAIL

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test tests/backends/cli_claude_test.ts tests/backends/cli_gemini_test.ts
```

Expected: FAIL — modules not found.

### Step 3: Create `chat/src/backends/cli_claude.ts`

The `claude` CLI (Claude Code) accepts `--print` for non-interactive output, reads from stdin
or `--message`, and streams markdown text. Tool use is handled by the claude CLI itself —
our job is just to pass the conversation and stream the response.

```typescript
import { spawn } from 'child_process'
import type { Message, StreamEvent } from '../types/message.js'
import type { QueryOptions } from '../query.js'

interface ClaudeArgOptions {
  systemPrompt: string
  noTools?: boolean
}

export function buildClaudeArgs(messages: Message[], opts: ClaudeArgOptions): string[] {
  const args: string[] = ['--print']
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt)
  }
  if (opts.noTools) {
    args.push('--no-tools')
  }
  // Last user message is the prompt; prior turns become conversation context
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (lastUserMsg && typeof lastUserMsg.content === 'string') {
    args.push('--message', lastUserMsg.content)
  }
  return args
}

/**
 * CLI backend for `@claude` — spawns the `claude` CLI and streams its output.
 * Yields StreamEvents compatible with the API backends.
 * NOTE: The claude CLI manages its own tool use; we stream text only.
 */
export async function* queryLoopCLI(
  messages: Message[],
  _tools: unknown[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { systemPrompt, abortSignal } = options
  const args = buildClaudeArgs(messages, { systemPrompt })

  const child = spawn('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  abortSignal.addEventListener('abort', () => { child.kill('SIGTERM') }, { once: true })

  let errorText = ''
  child.stderr?.on('data', (chunk: Buffer) => { errorText += chunk.toString() })

  for await (const chunk of child.stdout ?? []) {
    if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }
    yield { type: 'text_delta', text: (chunk as Buffer).toString() }
  }

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0 && !abortSignal.aborted) {
        reject(new Error(`claude CLI exited ${code}: ${errorText}`))
      } else {
        resolve()
      }
    })
  }).catch((err: Error) => {
    return { type: 'error' as const, error: err.message }
  })

  yield { type: 'message_stop' }
}
```

### Step 4: Create `chat/src/backends/cli_gemini.ts`

```typescript
import { spawn } from 'child_process'
import type { Message, StreamEvent } from '../types/message.js'
import type { QueryOptions } from '../query.js'

/**
 * Build a flat prompt string from message history for CLIs that don't
 * accept structured conversation (gemini, codex, copilot).
 */
export function buildPromptText(messages: Message[]): string {
  return messages.map(msg => {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return `User: ${msg.content}`
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('')
      return `Assistant: ${text}`
    }
    return ''
  }).filter(Boolean).join('\n\n')
}

export async function* queryLoopCLI(
  messages: Message[],
  _tools: unknown[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { abortSignal } = options
  const prompt = buildPromptText(messages)

  const child = spawn('gemini', ['--prompt', prompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  abortSignal.addEventListener('abort', () => { child.kill('SIGTERM') }, { once: true })

  let errorText = ''
  child.stderr?.on('data', (chunk: Buffer) => { errorText += chunk.toString() })

  for await (const chunk of child.stdout ?? []) {
    if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }
    yield { type: 'text_delta', text: (chunk as Buffer).toString() }
  }

  await new Promise<void>((resolve) => {
    child.on('close', () => resolve())
  })

  yield { type: 'message_stop' }
}
```

### Step 5: Create `chat/src/backends/cli_codex.ts`

Same `buildPromptText` pattern, spawns `codex`:

```typescript
import { spawn } from 'child_process'
import { buildPromptText } from './cli_gemini.js'
import type { Message, StreamEvent } from '../types/message.js'
import type { QueryOptions } from '../query.js'

export async function* queryLoopCLI(
  messages: Message[],
  _tools: unknown[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { abortSignal } = options
  const prompt = buildPromptText(messages)

  const child = spawn('codex', ['--quiet', prompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  abortSignal.addEventListener('abort', () => { child.kill('SIGTERM') }, { once: true })

  for await (const chunk of child.stdout ?? []) {
    if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }
    yield { type: 'text_delta', text: (chunk as Buffer).toString() }
  }

  await new Promise<void>(resolve => child.on('close', resolve))
  yield { type: 'message_stop' }
}
```

### Step 6: Create `chat/src/backends/cli_copilot.ts`

```typescript
import { spawn } from 'child_process'
import { buildPromptText } from './cli_gemini.js'
import type { Message, StreamEvent } from '../types/message.js'
import type { QueryOptions } from '../query.js'

export async function* queryLoopCLI(
  messages: Message[],
  _tools: unknown[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { abortSignal } = options
  const prompt = buildPromptText(messages)

  // GitHub Copilot CLI uses `gh copilot explain` or `gh copilot suggest`
  // For general chat, we use `gh copilot explain` with the prompt as the topic
  const child = spawn('gh', ['copilot', 'explain', prompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  abortSignal.addEventListener('abort', () => { child.kill('SIGTERM') }, { once: true })

  for await (const chunk of child.stdout ?? []) {
    if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }
    yield { type: 'text_delta', text: (chunk as Buffer).toString() }
  }

  await new Promise<void>(resolve => child.on('close', resolve))
  yield { type: 'message_stop' }
}
```

### Step 7: Update `chat/src/QueryEngine.ts` to route `@` prefixes

Find the routing block (around `const isGemini = ...`) and add before it:

```typescript
// CLI backends: @claude, @gemini, @codex, @copilot
if (cfg.model.startsWith('@')) {
  const cliName = cfg.model.slice(1)  // strip the @
  const validCLIs = ['claude', 'gemini', 'codex', 'copilot']
  if (!validCLIs.includes(cliName)) {
    yield { type: 'error', error: `Unknown CLI backend: @${cliName}. Valid: ${validCLIs.join(', ')}` }
    return
  }
  const { queryLoopCLI } = await import(`./backends/cli_${cliName}.js`)
  for await (const event of queryLoopCLI(this.messages, this.tools, baseOptions)) {
    yield event
  }
  return
}
```

### Step 8: Run all tests

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test
```

Expected: All tests pass. CLI backend unit tests pass (they only test arg-building, not actual CLI invocation).

### Step 9: Manual smoke test (requires CLIs on host)

```bash
# Test @claude routing (requires claude CLI on $PATH)
cd /home/mcarls/projects/ai-orchestrator/chat
echo '{ "type": "message", "text": "@claude say hi" }' | bun run src/server.ts &
# Or just: bun run tui --model @claude
```

### Step 10: Commit

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/backends/cli_*.ts chat/tests/backends/cli_*_test.ts chat/src/QueryEngine.ts
git commit -m "feat(chat): add CLI subprocess backends for @claude, @gemini, @codex, @copilot"
```

---

## Task 2: TUI — Collapsible Messages + Per-Reply Debug Mode

**Goal:** In the Ink TUI (`screens/REPL.tsx` + `screens/MessageList.tsx`):
1. Click/enter on a message to collapse/expand it (show first line + `[...]` when collapsed)
2. `Ctrl+D` toggles debug mode — each assistant reply shows a tool-use trace below it
3. In debug mode: tool name, input summary, output summary, timing, and what the model did next
4. New keyboard shortcuts: `c` = collapse all, `e` = expand all, `Enter` on focused message = toggle

**Files:**
- Modify: `chat/src/screens/MessageList.tsx` — collapsible state, focus, keyboard nav
- Modify: `chat/src/screens/REPL.tsx` — debug mode toggle, pass tool traces
- Modify: `chat/src/types/message.ts` — add `ToolTrace` type
- Create: `chat/tests/repl_collapse_test.ts`

**`ToolTrace` type addition to `types/message.ts`:**
```typescript
export interface ToolTrace {
  toolName: string
  toolUseId: string
  inputSummary: string   // first 200 chars of JSON input
  outputSummary: string  // first 200 chars of output
  durationMs: number
  isError: boolean
}

export interface AssistantTurnDebug {
  messageIndex: number   // index in ChatMessage[] this trace belongs to
  traces: ToolTrace[]
}
```

**MessageList collapse behavior:**
- Each message stores `collapsed: boolean` in local state map
- Collapsed: show role label + first ~80 chars + `[collapsed — click/Enter to expand]`
- Expanded: full text as before
- Arrow keys navigate focused message; Enter toggles collapse

**Debug mode in REPL:**
- `Ctrl+D` flips `debugMode: boolean` state
- When `debugMode` is true, after each assistant message insert a `ToolTrace[]` summary
- The `QueryEngine` already yields `tool_use_start/end` events; REPL accumulates them per turn
- Format per tool: `  ⚙ BashTool({"command":"ls /"}) → "bin dev etc home..." [42ms]`

### Step 1: Write failing tests

```typescript
// chat/tests/repl_collapse_test.ts
import { describe, it, expect } from 'bun:test'
import { truncateForCollapse, formatToolTrace } from '../src/screens/MessageList.js'

describe('truncateForCollapse', () => {
  it('returns full text when under 80 chars', () => {
    expect(truncateForCollapse('hello world', false)).toBe('hello world')
  })

  it('truncates and adds indicator when collapsed', () => {
    const long = 'a'.repeat(200)
    const result = truncateForCollapse(long, true)
    expect(result.length).toBeLessThan(100)
    expect(result).toContain('…')
  })
})

describe('formatToolTrace', () => {
  it('formats a tool trace entry', () => {
    const trace = {
      toolName: 'BashTool',
      toolUseId: 'tu_1',
      inputSummary: '{"command":"echo hi"}',
      outputSummary: 'hi\n',
      durationMs: 23,
      isError: false,
    }
    const line = formatToolTrace(trace)
    expect(line).toContain('BashTool')
    expect(line).toContain('23ms')
    expect(line).toContain('echo hi')
  })

  it('marks errors visually', () => {
    const trace = {
      toolName: 'BashTool',
      toolUseId: 'tu_2',
      inputSummary: '{"command":"rm -rf /"}',
      outputSummary: 'Permission denied',
      durationMs: 5,
      isError: true,
    }
    const line = formatToolTrace(trace)
    expect(line).toContain('✗')
  })
})
```

### Step 2: Run to confirm FAIL

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test tests/repl_collapse_test.ts
```

### Step 3: Add exported helpers to `MessageList.tsx`

Add these pure functions (no React import needed, just export from the file):

```typescript
export function truncateForCollapse(text: string, collapsed: boolean, limit = 80): string {
  if (!collapsed || text.length <= limit) return text
  return text.slice(0, limit) + '…'
}

export function formatToolTrace(trace: import('../types/message.js').ToolTrace): string {
  const icon = trace.isError ? '✗' : '⚙'
  const input = trace.inputSummary.slice(0, 60).replace(/\n/g, ' ')
  const output = trace.outputSummary.slice(0, 60).replace(/\n/g, ' ')
  return `  ${icon} ${trace.toolName}(${input}) → "${output}" [${trace.durationMs}ms]`
}
```

### Step 4: Update `MessageList.tsx` for collapse/focus

Add `collapsed` state map and keyboard navigation (see implementation notes):

Key changes:
- `const [collapsedSet, setCollapsedSet] = useState<Set<number>>(new Set())`
- `const [focusIdx, setFocusIdx] = useState(-1)` — -1 = no focus
- `useInput` block in the REPL passes key events down or MessageList handles them
- `c` key = collapse all, `e` = expand all (only when no input bar is active)
- `Enter` when `focusIdx >= 0` toggles that message

### Step 5: Update `REPL.tsx` for debug mode + tool traces

Key changes:
- `const [debugMode, setDebugMode] = useState(false)` — `Ctrl+D` toggles
- Accumulate `ToolTrace[]` per assistant turn during streaming:
  ```typescript
  const traceRef = useRef<ToolTrace[]>([])
  // in event handler:
  if (event.type === 'tool_use_start') {
    traceRef.current.push({ toolName: event.toolName, toolUseId: event.toolUseId,
      inputSummary: '', outputSummary: '', durationMs: 0, isError: false, _start: Date.now() })
  }
  if (event.type === 'tool_result') {
    // fill in output + timing for matching toolUseId
  }
  ```
- On `message_stop`: if `debugMode`, append a synthetic `command` message with the trace lines

### Step 6: Run tests

```bash
bun test tests/repl_collapse_test.ts
```

Expected: PASS.

### Step 7: Commit

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/screens/ chat/src/types/message.ts chat/tests/repl_collapse_test.ts
git commit -m "feat(tui): collapsible messages, debug mode tool trace, keyboard navigation"
```

---

## Task 3: WebUI Log Panel Enhancements

**Goal:** Upgrade the existing log panel (`chat.js`) to show:
1. Per-reply expandable tool trace sections (matching TUI debug mode)
2. Tool call timeline: show all tools used in a reply in order, each expandable
3. Tool input/output text in collapsible `<details>` elements per tool entry
4. "Copy" button on each log entry for sharing/debugging
5. Timestamps on all log entries

**Files:**
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.css`

**StreamEvent additions needed** in `server.ts` and `types/message.ts`:
```typescript
// Add to StreamEvent union:
| { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; durationMs: number }
```

The server already tracks tool results via `dispatchTools`; just needs to yield the result event
with timing so the browser can display it.

**Log entry structure (per tool call):**

```
[⚙ tool-use]  BashTool  →  [✓ 42ms]              [▶ expand]
  Input:  {"command": "ls /home/mcarls"}
  Output: ".bash_history\n.bashrc\nprojects\n..."
```

### Step 1: Add `tool_result` event to server.ts

In `chat/src/server.ts`, after `dispatchTools` returns, yield each result:

```typescript
for (const result of toolResults) {
  ws.send(JSON.stringify({
    type: 'tool_result',
    toolUseId: result.tool_use_id,
    content: result.content.slice(0, 2000),  // cap to avoid huge WS frames
    isError: result.is_error,
    durationMs: result.durationMs ?? 0,
  }))
}
```

Update `ToolResult` type to include `durationMs?: number`.

### Step 2: Update `chat.js` log handler

Current: `handleLogEvent()` only shows tool_use_start.
Updated: Track `currentToolEntry` per `toolUseId` and fill in the result on `tool_result` event.

Add `<details>/<summary>` elements for input/output using only DOM APIs (no innerHTML):

```javascript
function createToolLogEntry(toolName, toolUseId) {
  const entry = document.createElement('div')
  entry.className = 'log-entry tool-use'
  entry.dataset.toolUseId = toolUseId

  const summary = document.createElement('div')
  summary.className = 'log-entry-summary'

  const icon = document.createElement('span')
  icon.className = 'log-icon'
  icon.textContent = '⚙'
  summary.appendChild(icon)

  const name = document.createElement('span')
  name.className = 'log-tool-name'
  name.textContent = toolName
  summary.appendChild(name)

  const status = document.createElement('span')
  status.className = 'log-tool-status'
  status.textContent = '…'
  entry.appendChild(summary)
  entry.appendChild(status)

  // Details (expandable)
  const details = document.createElement('details')
  const inputPre = document.createElement('pre')
  inputPre.className = 'log-tool-input'
  const outputPre = document.createElement('pre')
  outputPre.className = 'log-tool-output'
  details.appendChild(inputPre)
  details.appendChild(outputPre)
  entry.appendChild(details)

  return { entry, status, inputPre, outputPre }
}
```

### Step 3: Add CSS for expandable tool entries

```css
.log-entry details { margin: 4px 0 0 20px; }
.log-entry summary { cursor: pointer; color: var(--color-muted); font-size: 0.8em; }
.log-tool-input, .log-tool-output {
  font-size: 0.75em;
  background: var(--color-surface-2);
  padding: 4px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}
```

### Step 4: Run full browser smoke test

Start the stack locally and manually verify:
- Tool entries in log expand on click
- Input/output shown with correct content
- Copy button copies entry text to clipboard

### Step 5: Commit

```bash
git add chat/src/server.ts orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js
git add orchestrator_web_viewer/orchestrator_web_viewer/static/chat.css
git commit -m "feat(webui): expandable tool trace in log panel with input/output details"
```

---

## Task 4: WebUI Model Dropdown — Search/Filter + Group Expand

**Goal:** The model selector is already populated dynamically. Now:
1. Add a text filter input above the dropdown that live-filters options by name
2. Group headers are collapsible (click to show/hide that group)
3. Show a `●` indicator on groups that have loaded LM Studio models
4. "Refresh" button already exists — ensure it re-populates correctly
5. (Optional/future) HuggingFace search deferred to Task 9

**Files:**
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.css`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/index.html`

**Implementation:**
Replace the `<select>` with a custom dropdown panel (div-based) to support:
- Text search box at top
- Collapsible group rows
- Click model name to select

**Key constraint:** Still XSS-safe — all model names/labels via `.textContent` only.

```html
<!-- Replace <select id="model-select"> with: -->
<div class="model-picker">
  <input type="text" id="model-filter" placeholder="Filter models…" autocomplete="off">
  <div id="model-dropdown" class="model-dropdown" hidden>
    <!-- populated by JS -->
  </div>
  <div id="model-selected" class="model-selected-display">
    <!-- shows current selection -->
  </div>
</div>
```

### Step 1: Update `populateModelSelect()` in chat.js

Current: builds `<option>` elements inside a `<select>`.
New: builds group sections with model rows inside `#model-dropdown`.

Groups come from the `group` field already in the `/api/chat/models` response.

### Step 2: Filter logic

```javascript
document.getElementById('model-filter').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase()
  for (const row of document.querySelectorAll('.model-option')) {
    const match = row.dataset.modelId.toLowerCase().includes(query)
      || row.dataset.modelLabel.toLowerCase().includes(query)
    row.hidden = !match
  }
})
```

### Step 3: Run tests / smoke test

```bash
# Python test: check models endpoint still returns correct shape
cd /home/mcarls/projects/ai-orchestrator/orchestrator_web_viewer
uv run pytest tests/ -v -k "chat_models"
```

### Step 4: Commit

```bash
git add orchestrator_web_viewer/orchestrator_web_viewer/static/
git commit -m "feat(webui): replace model <select> with filterable custom dropdown"
```

---

## Task 5: Memory System Infrastructure

**Goal:** Build the database schema and API layer for per-project and global memories.
The existing stack already has PostgreSQL with pgvector — we add a `chat_memories` table
and API endpoints to create, list, delete, and get stats.

**Design:**
- `chat_memories` table: `id`, `project_id` (nullable = global), `content`, `embedding` (vector),
  `source` (chat | manual | auto), `created_at`, `updated_at`
- `memory_groups` table: many-to-many `(group_id, memory_id)` for shared memory groups
- `memory_group_projects` table: which projects belong to each group

**Files:**
- Create: `docker/postgres/init-scripts/03_chat_memories.sql`
- Create: `orchestrator_web_viewer/orchestrator_web_viewer/api/chat_memory.py`
- Create: `orchestrator_web_viewer/orchestrator_web_viewer/tests/chat_memory_test.py`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/main.py` — mount router

### Step 1: Write failing tests

```python
# orchestrator_web_viewer/orchestrator_web_viewer/tests/chat_memory_test.py
import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch

# Test that the memory endpoints return expected shapes
def test_memory_list_returns_list(client):
    with patch('orchestrator_web_viewer.api.chat_memory.db_list_memories',
               new_callable=AsyncMock, return_value=[]):
        resp = client.get('/api/chat/memory')
        assert resp.status_code == 200
        assert isinstance(resp.json()['memories'], list)

def test_memory_stats_has_counts(client):
    mock_stats = {'global_count': 5, 'global_bytes': 1024,
                  'projects': [{'project_id': 'p1', 'count': 3, 'bytes': 512}]}
    with patch('orchestrator_web_viewer.api.chat_memory.db_memory_stats',
               new_callable=AsyncMock, return_value=mock_stats):
        resp = client.get('/api/chat/memory/stats')
        assert resp.status_code == 200
        data = resp.json()
        assert 'global_count' in data
        assert 'projects' in data
```

### Step 2: Create `docker/postgres/init-scripts/03_chat_memories.sql`

```sql
-- Chat memory storage with pgvector embeddings
CREATE TABLE IF NOT EXISTS chat_memories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  TEXT,                         -- NULL = global memory
    content     TEXT NOT NULL,
    embedding   vector(768),                  -- nomic-embed-text-v1.5 dimensions
    source      TEXT NOT NULL DEFAULT 'chat', -- 'chat' | 'manual' | 'auto'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_memories_project_idx ON chat_memories (project_id);
CREATE INDEX IF NOT EXISTS chat_memories_embedding_idx
    ON chat_memories USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Memory groups (shared across projects)
CREATE TABLE IF NOT EXISTS memory_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memory_group_members (
    group_id    UUID REFERENCES memory_groups(id) ON DELETE CASCADE,
    memory_id   UUID REFERENCES chat_memories(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, memory_id)
);

CREATE TABLE IF NOT EXISTS memory_group_projects (
    group_id    UUID REFERENCES memory_groups(id) ON DELETE CASCADE,
    project_id  TEXT NOT NULL,
    PRIMARY KEY (group_id, project_id)
);
```

### Step 3: Create `orchestrator_web_viewer/orchestrator_web_viewer/api/chat_memory.py`

```python
"""Chat memory CRUD and stats endpoints."""
from __future__ import annotations

import logging
import os
from typing import Any

import asyncpg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat/memory", tags=["chat-memory"])


class SaveMemoryRequest(BaseModel):
    content: str
    project_id: str | None = None  # None = global
    source: str = "chat"


async def _get_pool() -> asyncpg.Pool:
    """Return a fresh connection pool using KO_WEB env vars."""
    return await asyncpg.create_pool(
        host=os.getenv("KO_WEB_POSTGRES_HOST", "localhost"),
        port=int(os.getenv("KO_WEB_POSTGRES_PORT", "5432")),
        user=os.getenv("KO_WEB_POSTGRES_USER", "km_user"),
        password=os.getenv("KO_WEB_POSTGRES_PASSWORD", ""),
        database=os.getenv("KO_WEB_POSTGRES_DB", "knowledge_manager"),
        min_size=1,
        max_size=5,
    )


async def db_list_memories(project_id: str | None = None) -> list[dict[str, Any]]:
    pool = await _get_pool()
    async with pool.acquire() as conn:
        if project_id is None:
            rows = await conn.fetch(
                "SELECT id, project_id, content, source, created_at "
                "FROM chat_memories ORDER BY created_at DESC LIMIT 200"
            )
        else:
            rows = await conn.fetch(
                "SELECT id, project_id, content, source, created_at "
                "FROM chat_memories WHERE project_id = $1 OR project_id IS NULL "
                "ORDER BY created_at DESC LIMIT 200",
                project_id,
            )
    await pool.close()
    return [dict(r) for r in rows]


async def db_memory_stats() -> dict[str, Any]:
    pool = await _get_pool()
    async with pool.acquire() as conn:
        global_row = await conn.fetchrow(
            "SELECT COUNT(*) as cnt, COALESCE(SUM(octet_length(content)),0) as bytes "
            "FROM chat_memories WHERE project_id IS NULL"
        )
        project_rows = await conn.fetch(
            "SELECT project_id, COUNT(*) as cnt, "
            "COALESCE(SUM(octet_length(content)),0) as bytes "
            "FROM chat_memories WHERE project_id IS NOT NULL "
            "GROUP BY project_id ORDER BY cnt DESC"
        )
    await pool.close()
    return {
        "global_count": global_row["cnt"],
        "global_bytes": global_row["bytes"],
        "projects": [
            {"project_id": r["project_id"], "count": r["cnt"], "bytes": r["bytes"]}
            for r in project_rows
        ],
    }


@router.get("")
async def list_memories(project_id: str | None = None) -> dict[str, Any]:
    """List memories, optionally filtered by project."""
    try:
        memories = await db_list_memories(project_id)
        return {"memories": memories}
    except Exception as exc:
        log.error("list_memories failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/stats")
async def memory_stats() -> dict[str, Any]:
    """Return memory counts and storage bytes per project + global."""
    try:
        return await db_memory_stats()
    except Exception as exc:
        log.error("memory_stats failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("")
async def save_memory(req: SaveMemoryRequest) -> dict[str, Any]:
    """Save a new memory entry."""
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="content must not be empty")
    try:
        pool = await _get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO chat_memories (content, project_id, source) "
                "VALUES ($1, $2, $3) RETURNING id, created_at",
                req.content, req.project_id, req.source,
            )
        await pool.close()
        return {"id": str(row["id"]), "created_at": row["created_at"].isoformat()}
    except Exception as exc:
        log.error("save_memory failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.delete("/{memory_id}")
async def delete_memory(memory_id: str) -> dict[str, str]:
    """Delete a memory by ID."""
    try:
        pool = await _get_pool()
        async with pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM chat_memories WHERE id = $1", memory_id
            )
        await pool.close()
        if result == "DELETE 0":
            raise HTTPException(status_code=404, detail="Memory not found")
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
```

### Step 4: Mount router in `main.py`

```python
from orchestrator_web_viewer.api.chat_memory import router as chat_memory_router
app.include_router(chat_memory_router)
```

### Step 5: Add `asyncpg` to dependencies

```bash
cd /home/mcarls/projects/ai-orchestrator/orchestrator_web_viewer
uv add asyncpg
```

### Step 6: Run tests

```bash
uv run pytest orchestrator_web_viewer/tests/chat_memory_test.py -v
```

### Step 7: Commit

```bash
git add docker/postgres/init-scripts/03_chat_memories.sql
git add orchestrator_web_viewer/orchestrator_web_viewer/api/chat_memory.py
git add orchestrator_web_viewer/orchestrator_web_viewer/tests/chat_memory_test.py
git add orchestrator_web_viewer/orchestrator_web_viewer/main.py
git commit -m "feat(memory): add chat_memories table, CRUD API, and stats endpoint"
```

---

## Task 6: WebUI Memory Tab

**Goal:** The existing Memory tab (`memory.js`) shows orchestrator memories. Extend it with:
1. A "Chat Memories" section at the top showing global + per-project stats (count, KB/MB/GB)
2. A browsable list of memories (paginated, filterable by project)
3. Delete button per memory entry
4. "Save as global memory" / "Save to project" buttons (handy for manual entry too)
5. Visual indicator: storage bar showing global vs per-project proportions

**Files:**
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/memory.js`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/index.html`
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/style.css`

**Stats display format:**
```
Chat Memories
  Global:     42 entries  /  83 KB
  project-X:  17 entries  /  34 KB
  project-Y:   8 entries  /  12 KB
```

**Storage formatting helper:**
```javascript
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024*1024)).toFixed(1)} MB`
  return `${(bytes / (1024*1024*1024)).toFixed(2)} GB`
}
```

### Step 1: Add memory stats section to Memory tab in `index.html`

Add inside `<div id="memory-view" class="view">` near the top:

```html
<section id="chat-memory-stats" class="card">
  <h3>Chat Memories</h3>
  <div id="chat-memory-stats-body">Loading…</div>
  <div id="chat-memory-list-container">
    <input type="text" id="chat-memory-filter" placeholder="Filter by project or content…">
    <div id="chat-memory-list"></div>
  </div>
</section>
```

### Step 2: Load stats and entries in `memory.js`

```javascript
async function loadChatMemoryStats() {
  const resp = await fetch('/api/chat/memory/stats')
  if (!resp.ok) return
  const data = await resp.json()

  const body = document.getElementById('chat-memory-stats-body')
  clearChildren(body)

  const globalRow = document.createElement('div')
  globalRow.className = 'memory-stat-row'
  const globalLabel = document.createElement('span')
  globalLabel.textContent = 'Global:'
  const globalVal = document.createElement('span')
  globalVal.textContent = `${data.global_count} entries / ${formatBytes(data.global_bytes)}`
  globalRow.appendChild(globalLabel)
  globalRow.appendChild(globalVal)
  body.appendChild(globalRow)

  for (const proj of data.projects) {
    const row = document.createElement('div')
    row.className = 'memory-stat-row'
    const lbl = document.createElement('span')
    lbl.textContent = proj.project_id + ':'
    const val = document.createElement('span')
    val.textContent = `${proj.count} entries / ${formatBytes(proj.bytes)}`
    row.appendChild(lbl)
    row.appendChild(val)
    body.appendChild(row)
  }
}
```

### Step 3: Commit

```bash
git add orchestrator_web_viewer/orchestrator_web_viewer/static/
git commit -m "feat(webui): chat memory stats and browse panel in Memory tab"
```

---

## Task 7: Chat ↔ Memory Integration

**Goal:**
1. In the WebUI chat, after any message, user can right-click or use a button to "Save as memory"
2. A `/remember <text>` slash command in both TUI and WebUI saves text as global memory
3. A `/remember --project <id> <text>` saves to project
4. The chat can be told "remember that X" and the agent calls a `SaveMemoryTool`
5. When a chat session starts with a project context, relevant memories are retrieved and prepended to the system prompt

**Files:**
- Create: `chat/src/tools/SaveMemoryTool.ts`
- Create: `chat/src/commands/remember.ts`
- Modify: `chat/src/QueryEngine.ts` — register SaveMemoryTool, inject memories into system prompt
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js` — "Save" button on messages
- Create: `chat/tests/tools/SaveMemoryTool_test.ts`

**`SaveMemoryTool`:**
```typescript
// Calls the FastAPI /api/chat/memory endpoint via fetch
// Input: { content: string, project_id?: string }
// On success: returns "Memory saved."
// The tool is always available — the model decides when to use it based on "remember that X" intent
```

**`/remember` command:**
```typescript
// /remember <text> → saves as global
// /remember --project <id> <text> → saves to project
// Yields { type: 'command_output', text: 'Memory saved.' }
```

### Step 1: Write test for SaveMemoryTool

```typescript
// chat/tests/tools/SaveMemoryTool_test.ts
import { describe, it, expect, mock } from 'bun:test'
import { SaveMemoryTool } from '../../src/tools/SaveMemoryTool.js'

describe('SaveMemoryTool', () => {
  it('calls the memory API endpoint', async () => {
    const calls: unknown[] = []
    global.fetch = mock(async (url: string, opts: RequestInit) => {
      calls.push({ url, body: JSON.parse(opts.body as string) })
      return new Response(JSON.stringify({ id: 'abc', created_at: '2026-01-01' }), { status: 200 })
    }) as typeof fetch

    const tool = new SaveMemoryTool('http://localhost:3001')
    const ctx = { abortSignal: new AbortController().signal, workingDir: '/tmp' }
    const result = await tool.execute({ content: 'test memory', project_id: null }, ctx)
    expect(result).toBe('Memory saved.')
    expect(calls).toHaveLength(1)
  })

  it('returns error message on API failure', async () => {
    global.fetch = mock(async () =>
      new Response('{}', { status: 503 })
    ) as typeof fetch

    const tool = new SaveMemoryTool('http://localhost:3001')
    const ctx = { abortSignal: new AbortController().signal, workingDir: '/tmp' }
    const result = await tool.execute({ content: 'fail' }, ctx)
    expect(result).toContain('Error')
  })
})
```

### Step 2: Create `chat/src/tools/SaveMemoryTool.ts`

```typescript
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface SaveMemoryInput {
  content: string
  project_id?: string | null
}

export class SaveMemoryTool implements Tool {
  constructor(private readonly apiBase: string = 'http://localhost:3001') {}

  definition(): ToolDefinition {
    return {
      name: 'SaveMemory',
      description: 'Save a piece of information to long-term memory. Use when the user asks you to remember something.',
      input_schema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The information to remember' },
          project_id: { type: 'string', description: 'Project scope (omit for global memory)' },
        },
        required: ['content'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean { return true }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { content, project_id } = input as SaveMemoryInput
    try {
      const resp = await fetch(`${this.apiBase}/api/chat/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, project_id: project_id ?? null, source: 'chat' }),
        signal: ctx.abortSignal,
      })
      if (!resp.ok) return `Error saving memory: HTTP ${resp.status}`
      return 'Memory saved.'
    } catch (err) {
      return `Error saving memory: ${(err as Error).message}`
    }
  }
}
```

### Step 3: Register in QueryEngine and inject context

In `QueryEngine.ts` constructor, add `SaveMemoryTool` to `this.tools`.

In `submit()`, before building the query loop, if `this.projectId` is set:
1. Fetch recent memories for this project: `GET /api/chat/memory?project_id=X`
2. Prepend top N to system prompt: `\n\n## Relevant memories:\n- ${memory.content}\n...`

### Step 4: Run tests

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test tests/tools/SaveMemoryTool_test.ts
```

### Step 5: Commit

```bash
git add chat/src/tools/SaveMemoryTool.ts chat/src/commands/remember.ts
git add chat/tests/tools/SaveMemoryTool_test.ts
git commit -m "feat(memory): SaveMemoryTool + /remember command + project context injection"
```

---

## Task 8: Shared Memory Groups

**Goal:** Allow multiple projects to share a named memory group. Any memory saved to a
shared group is visible to all projects in that group.

**Files:**
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/api/chat_memory.py` — group endpoints
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/memory.js` — group management UI

**New endpoints:**
- `POST /api/chat/memory/groups` — create group `{ name, description }`
- `GET /api/chat/memory/groups` — list all groups with member projects
- `POST /api/chat/memory/groups/{id}/projects` — add project to group
- `DELETE /api/chat/memory/groups/{id}/projects/{project_id}` — remove project from group

**Memory retrieval update:** When loading memories for a project, also include memories from
any groups the project belongs to.

---

## Task 9: HuggingFace Model Browser

**Goal:** Add a "Download Model" panel within the model picker that lets users:
1. Search HuggingFace for GGUF models (filtered by `gguf` tag, sorted by downloads)
2. See model card info (size, downloads, last updated)
3. Click "Open in LM Studio" — constructs the LM Studio deep link or shows the HuggingFace URL to paste

**Why not auto-download?** LM Studio handles downloads itself. We just need to surface the
model so the user can copy the repo ID and paste it into LM Studio's search. Or if LM Studio
exposes a local download API, call it directly.

**Files:**
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/api/chat.py` — HF search proxy endpoint
- Modify: `orchestrator_web_viewer/orchestrator_web_viewer/static/chat.js` — model browser panel

**New endpoint: `GET /api/chat/hf-models?q=gemma&limit=10`**

```python
@router.get("/api/chat/hf-models")
async def search_hf_models(q: str = "", limit: int = 10) -> dict:
    """Proxy search to HuggingFace Hub API filtered to GGUF models."""
    url = "https://huggingface.co/api/models"
    params = {
        "search": q,
        "filter": "gguf",
        "sort": "downloads",
        "direction": -1,
        "limit": limit,
        "full": False,
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        models = resp.json()
    return {
        "models": [
            {
                "id": m.get("modelId", ""),
                "downloads": m.get("downloads", 0),
                "tags": m.get("tags", []),
                "last_modified": m.get("lastModified", ""),
            }
            for m in models
        ]
    }
```

**Browser UI:** A "🔍 Find models" button in the chat toolbar opens a search panel. Results
show model ID + downloads. Clicking a result: copies model ID + shows instructions to load
in LM Studio. If LM Studio's local API supports loading a model by repo ID, call it directly.

---

## Task 10: Agent Benchmark Runner

**Goal:** Provide infrastructure to run standardized AI benchmark tests against our agent
and compare scores across models.

**Design:**
- Benchmark tests are JSON files: `benchmarks/<suite-name>/<test-name>.json`
  - Format: `{ "prompt": "...", "expected_contains": [...], "expected_not_contains": [...],
    "max_turns": 3, "timeout_s": 60 }`
- A `RunBenchmark` slash command in the TUI: `/benchmark run <suite> --model <name>`
- A benchmark API endpoint: `POST /api/chat/benchmark` — runs a suite, returns scores
- A benchmark results tab in the WebUI showing pass/fail per test, per model, with timestamps
- Results stored in PostgreSQL: `benchmark_results` table

**Files:**
- Create: `benchmarks/` directory with example suites
- Create: `chat/src/commands/benchmark.ts`
- Create: `orchestrator_web_viewer/orchestrator_web_viewer/api/benchmark.py`
- Create: `docker/postgres/init-scripts/04_benchmark_results.sql`

**Suggested initial benchmark suites to download and adapt:**
- HumanEval (coding) — Python function completion
- MMLU (knowledge) — multiple-choice science/humanities
- HellaSwag (commonsense) — sentence completion
- Custom "agent loop" suite — tests that require tool use: bash commands, file reads, grep

**`benchmark_results` schema:**
```sql
CREATE TABLE IF NOT EXISTS benchmark_results (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    suite_name  TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    test_name   TEXT NOT NULL,
    passed      BOOLEAN NOT NULL,
    score       FLOAT,
    duration_ms INTEGER,
    response    TEXT,
    run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON benchmark_results (suite_name, model_id, run_at);
```

The benchmark tab in the WebUI shows a comparison table:
```
Suite: HumanEval          claude-sonnet  qwen3-32b  gemini-2.5  @claude
─────────────────────────────────────────────────────────────────────────
pass@1                        72%          68%          74%        71%
avg latency                  2.1s         0.8s         1.9s       3.4s
tool-call accuracy            94%          89%          91%        96%
```

---

## Provider Routing Summary (Current + New)

| Model prefix / name | Backend | Notes |
|---|---|---|
| `@claude` | `claude` CLI subprocess | No API key needed |
| `@gemini` | `gemini` CLI subprocess | No API key needed |
| `@codex` | `codex` CLI subprocess | No API key needed |
| `@copilot` | `gh copilot` subprocess | Requires `gh` auth |
| `gemini-*` | Google Generative AI SDK | `GEMINI_API_KEY` |
| `claude-*` | Anthropic SDK | `ANTHROPIC_API_KEY` |
| `gpt-*`, `o1-*`, `o3-*` | OpenAI SDK → api.openai.com | `OPENAI_API_KEY` |
| anything else | OpenAI-compat → LM Studio | No key, local only |

---

## Security Invariants (Carry Forward)

- All DOM manipulation in `chat.js` and `memory.js` uses `.textContent` and `createElement` — never `innerHTML`
- Server-sent model names, memory content, and tool output must never be assigned via innerHTML
- `SaveMemoryTool` input is validated server-side (non-empty content)
- Benchmark prompts from JSON files are not eval'd — they are strings passed to the agent
