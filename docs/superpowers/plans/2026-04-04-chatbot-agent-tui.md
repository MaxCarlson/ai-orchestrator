# Chatbot Agent Mode — Core + TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full-featured TypeScript chatbot agent with an Ink-based TUI — a claude-code–style REPL backed by the Anthropic SDK, with slash commands, session persistence, and tool dispatch — living at `chat/` inside the ai-orchestrator repo.

**Architecture:** A standalone Bun package (`chat/`) exposes two entry points: (1) `bun run tui` launches the Ink REPL for interactive use, (2) `bun run serve` starts a WebSocket API server that the Python web viewer connects to (implemented in Plan B). The agent loop is an async generator that streams API responses, dispatches tools concurrently where safe, and feeds results back until the model stops calling tools.

**Tech Stack:** Bun ≥1.1, TypeScript 5.7, @anthropic-ai/sdk ^0.39.0, ink ^5.1, React 19, vitest ^2, chalk ^5

---

## File Map

```
chat/
├── package.json                         CREATE  — Bun package manifest + scripts
├── tsconfig.json                        CREATE  — TypeScript config
├── src/
│   ├── index.ts                         CREATE  — TUI entry point (bun run tui)
│   ├── query.ts                         CREATE  — Core agent loop (async generator)
│   ├── QueryEngine.ts                   CREATE  — Session orchestrator wrapping query.ts
│   ├── types/
│   │   ├── message.ts                   CREATE  — Message, AssistantMessage, ToolResult types
│   │   ├── tool.ts                      CREATE  — Tool interface + ToolUseContext
│   │   └── command.ts                   CREATE  — SlashCommand type
│   ├── tools/
│   │   ├── registry.ts                  CREATE  — Tool registry (register + findByName)
│   │   ├── BashTool.ts                  CREATE  — Bash execution tool
│   │   ├── FileReadTool.ts              CREATE  — File read tool
│   │   ├── FileEditTool.ts              CREATE  — File edit (search-replace) tool
│   │   ├── GlobTool.ts                  CREATE  — Glob pattern file finder
│   │   ├── GrepTool.ts                  CREATE  — Ripgrep content search
│   │   └── WebFetchTool.ts              CREATE  — HTTP fetch (text/HTML) tool
│   ├── commands/
│   │   ├── index.ts                     CREATE  — Command registry + dispatcher
│   │   ├── help.ts                      CREATE  — /help command
│   │   ├── clear.ts                     CREATE  — /clear command
│   │   ├── config.ts                    CREATE  — /config command
│   │   ├── session.ts                   CREATE  — /session command (list/resume)
│   │   └── memory.ts                    CREATE  — /memory command (show/clear)
│   ├── session/
│   │   └── store.ts                     CREATE  — Disk-based session persistence
│   └── screens/
│       ├── REPL.tsx                     CREATE  — Main Ink REPL component
│       ├── MessageList.tsx              CREATE  — Scrollable message history
│       ├── InputBar.tsx                 CREATE  — Text input with slash-command hint
│       └── ToolProgress.tsx             CREATE  — Tool execution spinner/output
└── tests/
    ├── query_test.ts                    CREATE  — Agent loop unit tests
    ├── tools/
    │   ├── BashTool_test.ts             CREATE
    │   ├── FileReadTool_test.ts         CREATE
    │   ├── GlobTool_test.ts             CREATE
    │   └── GrepTool_test.ts             CREATE
    ├── commands/
    │   └── commands_test.ts             CREATE  — Slash command parsing + dispatch
    └── session/
        └── store_test.ts               CREATE  — Session read/write
```

---

## Task 1: Package Scaffold

**Files:**
- Create: `chat/package.json`
- Create: `chat/tsconfig.json`

- [ ] **Step 1: Create `chat/package.json`**

```json
{
  "name": "ai-orchestrator-chat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "tui": "bun run src/index.ts",
    "serve": "bun run src/server.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "chalk": "^5.3.0",
    "ink": "^5.1.0",
    "react": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `chat/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "rootDir": "src",
    "paths": {}
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Install dependencies**

Run from `chat/`:
```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun install
```

Expected: `node_modules/` created, `bun.lock` written.

- [ ] **Step 4: Verify Bun resolves TypeScript**

Create `chat/src/index.ts` with:
```typescript
console.log('chat agent ok')
```

Run:
```bash
bun run src/index.ts
```

Expected output: `chat agent ok`

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/
git commit -m "feat(chat): scaffold TypeScript Bun package"
```

---

## Task 2: Core Types

**Files:**
- Create: `chat/src/types/message.ts`
- Create: `chat/src/types/tool.ts`
- Create: `chat/src/types/command.ts`

- [ ] **Step 1: Write `chat/src/types/message.ts`**

```typescript
import type { MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources/messages.js'

export type Role = 'user' | 'assistant'

export interface UserMessage {
  role: 'user'
  content: string
}

export interface AssistantMessage {
  role: 'assistant'
  content: ContentBlock[]
}

export interface ToolResultMessage {
  role: 'user'
  content: Array<{
    type: 'tool_result'
    tool_use_id: string
    content: string
    is_error?: boolean
  }>
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// Convert our Message type to what the SDK expects
export function toApiMessage(msg: Message): MessageParam {
  if (msg.role === 'user' && 'content' in msg && typeof msg.content === 'string') {
    return { role: 'user', content: msg.content }
  }
  return msg as MessageParam
}

export interface StreamEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_end' | 'message_stop' | 'error'
  text?: string
  toolName?: string
  toolUseId?: string
  toolInput?: string
  error?: string
}
```

- [ ] **Step 2: Write `chat/src/types/tool.ts`**

```typescript
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, { type: string; description: string }>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: ToolInputSchema
}

export interface ToolUseContext {
  abortSignal: AbortSignal
  workingDir: string
}

export interface Tool {
  definition(): ToolDefinition
  isConcurrencySafe(input: unknown): boolean
  execute(input: unknown, ctx: ToolUseContext): Promise<string>
}

export interface ToolResult {
  tool_use_id: string
  content: string
  is_error: boolean
}
```

- [ ] **Step 3: Write `chat/src/types/command.ts`**

```typescript
export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  execute(args: string, context: CommandContext): Promise<CommandResult>
}

export interface CommandContext {
  clearMessages: () => void
  getMessages: () => unknown[]
  workingDir: string
}

export type CommandResult =
  | { type: 'output'; text: string }
  | { type: 'clear' }
  | { type: 'noop' }
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun run typecheck
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/types/
git commit -m "feat(chat): add core type definitions"
```

---

## Task 3: Tool Registry + BashTool + FileReadTool

**Files:**
- Create: `chat/src/tools/registry.ts`
- Create: `chat/src/tools/BashTool.ts`
- Create: `chat/src/tools/FileReadTool.ts`
- Create: `chat/tests/tools/BashTool_test.ts`
- Create: `chat/tests/tools/FileReadTool_test.ts`

- [ ] **Step 1: Write failing tests for BashTool**

```typescript
// chat/tests/tools/BashTool_test.ts
import { describe, it, expect } from 'bun:test'
import { BashTool } from '../../src/tools/BashTool.js'

const ctx = { abortSignal: new AbortController().signal, workingDir: '/tmp' }

describe('BashTool', () => {
  it('executes a simple command and returns stdout', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'echo hello' }, ctx)
    expect(result).toBe('hello\n')
  })

  it('returns stderr on failure with is_error indication in output', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'ls /nonexistent_path_xyz' }, ctx)
    expect(result).toContain('No such file')
  })

  it('times out after 30 seconds (mocked)', async () => {
    const tool = new BashTool({ timeoutMs: 50 })
    const result = await tool.execute({ command: 'sleep 10' }, ctx)
    expect(result).toContain('timed out')
  })

  it('is not concurrency safe by default', () => {
    const tool = new BashTool()
    expect(tool.isConcurrencySafe({})).toBe(false)
  })

  it('is concurrency safe for readonly commands', () => {
    const tool = new BashTool()
    expect(tool.isConcurrencySafe({ command: 'cat README.md' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test tests/tools/BashTool_test.ts
```

Expected: FAIL — `BashTool` module not found.

- [ ] **Step 3: Write `chat/src/tools/BashTool.ts`**

```typescript
import { spawn } from 'child_process'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface BashInput {
  command: string
}

interface BashToolOptions {
  timeoutMs?: number
}

const READONLY_PREFIXES = ['cat ', 'ls ', 'echo ', 'grep ', 'find ', 'head ', 'tail ', 'wc ', 'pwd', 'which ']

export class BashTool implements Tool {
  private readonly timeoutMs: number

  constructor(opts: BashToolOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  definition(): ToolDefinition {
    return {
      name: 'Bash',
      description: 'Execute a bash command and return the combined stdout/stderr output. Use for running scripts, git commands, build tools, etc.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
        },
        required: ['command'],
      },
    }
  }

  isConcurrencySafe(input: unknown): boolean {
    const { command } = input as BashInput
    return READONLY_PREFIXES.some(p => command.startsWith(p))
  }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { command } = input as BashInput

    return new Promise((resolve) => {
      let output = ''
      let timedOut = false

      const child = spawn('bash', ['-c', command], {
        cwd: ctx.workingDir,
        env: process.env,
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        resolve(`Command timed out after ${this.timeoutMs}ms`)
      }, this.timeoutMs)

      child.stdout.on('data', (d: Buffer) => { output += d.toString() })
      child.stderr.on('data', (d: Buffer) => { output += d.toString() })

      child.on('close', () => {
        if (!timedOut) {
          clearTimeout(timer)
          resolve(output || '(no output)')
        }
      })

      ctx.abortSignal.addEventListener('abort', () => {
        timedOut = true
        child.kill('SIGTERM')
        resolve('Command aborted')
      })
    })
  }
}
```

- [ ] **Step 4: Run BashTool tests — expect PASS**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test tests/tools/BashTool_test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Write failing tests for FileReadTool**

```typescript
// chat/tests/tools/FileReadTool_test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { FileReadTool } from '../../src/tools/FileReadTool.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'

const TMP = '/tmp/chat-test-filereader'
const ctx = { abortSignal: new AbortController().signal, workingDir: TMP }

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(`${TMP}/hello.txt`, 'line1\nline2\nline3\n', 'utf8')
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('FileReadTool', () => {
  it('reads a file and returns its content', async () => {
    const tool = new FileReadTool()
    const result = await tool.execute({ file_path: `${TMP}/hello.txt` }, ctx)
    expect(result).toBe('line1\nline2\nline3\n')
  })

  it('returns error message for missing file', async () => {
    const tool = new FileReadTool()
    const result = await tool.execute({ file_path: `${TMP}/missing.txt` }, ctx)
    expect(result).toContain('Error')
  })

  it('is concurrency safe', () => {
    const tool = new FileReadTool()
    expect(tool.isConcurrencySafe({})).toBe(true)
  })
})
```

- [ ] **Step 6: Run tests to confirm they fail**

```bash
bun test tests/tools/FileReadTool_test.ts
```

Expected: FAIL — `FileReadTool` module not found.

- [ ] **Step 7: Write `chat/src/tools/FileReadTool.ts`**

```typescript
import { readFileSync } from 'fs'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface FileReadInput {
  file_path: string
}

export class FileReadTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Read',
      description: 'Read the contents of a file from the filesystem.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        },
        required: ['file_path'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true
  }

  async execute(input: unknown, _ctx: ToolUseContext): Promise<string> {
    const { file_path } = input as FileReadInput
    try {
      return readFileSync(file_path, 'utf-8')
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`
    }
  }
}
```

- [ ] **Step 8: Write `chat/src/tools/registry.ts`**

```typescript
import type { Tool } from '../types/tool.js'

const toolMap = new Map<string, Tool>()

export function registerTool(tool: Tool): void {
  toolMap.set(tool.definition().name, tool)
}

export function findToolByName(name: string): Tool | undefined {
  return toolMap.get(name)
}

export function getAllTools(): Tool[] {
  return [...toolMap.values()]
}

export function getToolDefinitions() {
  return getAllTools().map(t => t.definition())
}
```

- [ ] **Step 9: Run all tool tests**

```bash
bun test tests/tools/
```

Expected: 8 tests pass.

- [ ] **Step 10: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/tools/ chat/tests/tools/
git commit -m "feat(chat): add tool registry, BashTool, FileReadTool"
```

---

## Task 4: Remaining Tools (FileEdit, Glob, Grep, WebFetch)

**Files:**
- Create: `chat/src/tools/FileEditTool.ts`
- Create: `chat/src/tools/GlobTool.ts`
- Create: `chat/src/tools/GrepTool.ts`
- Create: `chat/src/tools/WebFetchTool.ts`
- Create: `chat/tests/tools/GlobTool_test.ts`
- Create: `chat/tests/tools/GrepTool_test.ts`

- [ ] **Step 1: Write failing tests for GlobTool**

```typescript
// chat/tests/tools/GlobTool_test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { GlobTool } from '../../src/tools/GlobTool.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'

const TMP = '/tmp/chat-test-glob'
const ctx = { abortSignal: new AbortController().signal, workingDir: TMP }

beforeAll(() => {
  mkdirSync(`${TMP}/sub`, { recursive: true })
  writeFileSync(`${TMP}/a.ts`, '', 'utf8')
  writeFileSync(`${TMP}/b.ts`, '', 'utf8')
  writeFileSync(`${TMP}/sub/c.ts`, '', 'utf8')
  writeFileSync(`${TMP}/ignore.md`, '', 'utf8')
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('GlobTool', () => {
  it('finds files matching a pattern', async () => {
    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
    expect(result).toContain('c.ts')
    expect(result).not.toContain('ignore.md')
  })

  it('returns empty message when no matches', async () => {
    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '**/*.xyz' }, ctx)
    expect(result).toContain('No files found')
  })

  it('is concurrency safe', () => {
    expect(new GlobTool().isConcurrencySafe({})).toBe(true)
  })
})
```

- [ ] **Step 2: Write failing tests for GrepTool**

```typescript
// chat/tests/tools/GrepTool_test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { GrepTool } from '../../src/tools/GrepTool.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'

const TMP = '/tmp/chat-test-grep'
const ctx = { abortSignal: new AbortController().signal, workingDir: TMP }

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(`${TMP}/foo.ts`, 'export function hello() {}\nexport function world() {}', 'utf8')
  writeFileSync(`${TMP}/bar.ts`, 'const x = 1', 'utf8')
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('GrepTool', () => {
  it('finds lines matching pattern', async () => {
    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'function', path: TMP }, ctx)
    expect(result).toContain('hello')
    expect(result).toContain('world')
  })

  it('returns no matches message when pattern is absent', async () => {
    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'ZZZNOTFOUND', path: TMP }, ctx)
    expect(result).toContain('No matches')
  })

  it('is concurrency safe', () => {
    expect(new GrepTool().isConcurrencySafe({})).toBe(true)
  })
})
```

- [ ] **Step 3: Run to confirm they fail**

```bash
bun test tests/tools/GlobTool_test.ts tests/tools/GrepTool_test.ts
```

Expected: FAIL.

- [ ] **Step 4: Write `chat/src/tools/GlobTool.ts`**

```typescript
import { globSync } from 'glob'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface GlobInput {
  pattern: string
}

export class GlobTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Glob',
      description: 'Find files matching a glob pattern relative to the working directory.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern e.g. "**/*.ts" or "src/**/*.py"' },
        },
        required: ['pattern'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true
  }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { pattern } = input as GlobInput
    try {
      const matches = globSync(pattern, { cwd: ctx.workingDir, dot: false })
      if (matches.length === 0) return 'No files found matching pattern.'
      return matches.join('\n')
    } catch (err) {
      return `Glob error: ${(err as Error).message}`
    }
  }
}
```

Note: add `glob` to `package.json` dependencies before running:
```bash
bun add glob @types/glob
```

- [ ] **Step 5: Write `chat/src/tools/GrepTool.ts`**

```typescript
import { spawnSync } from 'child_process'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
}

export class GrepTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Grep',
      description: 'Search file contents using ripgrep (rg). Returns matching lines with file paths.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in' },
          glob: { type: 'string', description: 'File glob filter e.g. "*.ts"' },
        },
        required: ['pattern'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true
  }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { pattern, path: searchPath, glob } = input as GrepInput
    const args = ['-n', '--color=never', pattern]
    if (glob) args.push('--glob', glob)
    args.push(searchPath ?? ctx.workingDir)

    const result = spawnSync('rg', args, { encoding: 'utf8', cwd: ctx.workingDir })
    const output = (result.stdout ?? '').trim()
    if (!output) return 'No matches found.'
    return output
  }
}
```

- [ ] **Step 6: Write `chat/src/tools/FileEditTool.ts`**

```typescript
import { readFileSync, writeFileSync } from 'fs'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface FileEditInput {
  file_path: string
  old_string: string
  new_string: string
}

export class FileEditTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'Edit',
      description: 'Replace an exact string in a file. The old_string must appear exactly once in the file.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'Exact string to find and replace' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return false
  }

  async execute(input: unknown, _ctx: ToolUseContext): Promise<string> {
    const { file_path, old_string, new_string } = input as FileEditInput
    try {
      const content = readFileSync(file_path, 'utf-8')
      const count = content.split(old_string).length - 1
      if (count === 0) return `Error: old_string not found in file.`
      if (count > 1) return `Error: old_string found ${count} times — must be unique.`
      writeFileSync(file_path, content.replace(old_string, new_string), 'utf-8')
      return `File edited successfully.`
    } catch (err) {
      return `Error editing file: ${(err as Error).message}`
    }
  }
}
```

- [ ] **Step 7: Write `chat/src/tools/WebFetchTool.ts`**

```typescript
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface WebFetchInput {
  url: string
  max_length?: number
}

export class WebFetchTool implements Tool {
  definition(): ToolDefinition {
    return {
      name: 'WebFetch',
      description: 'Fetch the text content of a URL. Returns the raw text (HTML stripped where possible).',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          max_length: { type: 'number', description: 'Maximum characters to return (default 10000)' },
        },
        required: ['url'],
      },
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true
  }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { url, max_length = 10_000 } = input as WebFetchInput
    try {
      const res = await fetch(url, { signal: ctx.abortSignal })
      const text = await res.text()
      // Strip HTML tags for readability
      const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return stripped.slice(0, max_length)
    } catch (err) {
      return `Error fetching URL: ${(err as Error).message}`
    }
  }
}
```

- [ ] **Step 8: Run all tool tests**

```bash
bun test tests/tools/
```

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/tools/ chat/tests/tools/
git commit -m "feat(chat): add FileEdit, Glob, Grep, WebFetch tools"
```

---

## Task 5: Core Agent Query Loop

**Files:**
- Create: `chat/src/query.ts`
- Create: `chat/tests/query_test.ts`

This is the heart of the agent — an async generator that drives the model→tool→model loop.

- [ ] **Step 1: Write failing tests**

```typescript
// chat/tests/query_test.ts
import { describe, it, expect, mock } from 'bun:test'
import { queryLoop } from '../src/query.js'
import type { Message } from '../src/types/message.js'
import type { Tool } from '../src/types/tool.js'

// Minimal mock tool that echoes its input
const echoTool: Tool = {
  definition: () => ({
    name: 'Echo',
    description: 'Echoes input',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'text' } }, required: ['text'] },
  }),
  isConcurrencySafe: () => true,
  execute: async (input: unknown) => (input as { text: string }).text,
}

describe('queryLoop', () => {
  it('emits text_delta events from a pure text response', async () => {
    // This test requires a real API key — skip in CI with env guard
    if (!process.env['ANTHROPIC_API_KEY']) return

    const messages: Message[] = [{ role: 'user', content: 'Say "hello" only' }]
    const events: string[] = []

    for await (const event of queryLoop(messages, [], {
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 3,
      systemPrompt: 'You are a minimal test assistant.',
      abortSignal: new AbortController().signal,
      workingDir: '/tmp',
    })) {
      if (event.type === 'text_delta' && event.text) events.push(event.text)
    }

    expect(events.join('')).toContain('hello')
  })
})
```

- [ ] **Step 2: Run test to confirm it skips in CI (no API key) but structure is valid**

```bash
bun test tests/query_test.ts
```

Expected: Test runs but skips (no ANTHROPIC_API_KEY), or passes if key is set.

- [ ] **Step 3: Write `chat/src/query.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, toApiMessage } from './types/message.js'
import { toApiMessage as msgToApi } from './types/message.js'
import type { Tool, ToolResult } from './types/tool.js'

export interface QueryOptions {
  model: string
  maxTurns: number
  systemPrompt: string
  abortSignal: AbortSignal
  workingDir: string
}

const client = new Anthropic()

/**
 * Core agent loop. Streams model responses, dispatches tool calls, and
 * re-enters the loop with tool results until the model stops calling tools
 * or maxTurns is reached.
 */
export async function* queryLoop(
  messages: Message[],
  tools: Tool[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { model, maxTurns, systemPrompt, abortSignal, workingDir } = options
  const history = [...messages]
  let turns = 0

  while (turns < maxTurns) {
    turns++

    const toolDefs = tools.map(t => t.definition())
    const apiMessages = history.map(msgToApi)

    let stream: Awaited<ReturnType<typeof client.messages.stream>>

    try {
      stream = client.messages.stream({
        model,
        max_tokens: 8096,
        system: systemPrompt,
        messages: apiMessages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      })
    } catch (err) {
      yield { type: 'error', error: (err as Error).message }
      return
    }

    const assistantContent: Anthropic.ContentBlock[] = []
    const pendingToolUse: Array<{ id: string; name: string; inputJson: string }> = []

    for await (const event of stream) {
      if (abortSignal.aborted) {
        yield { type: 'error', error: 'Aborted' }
        return
      }

      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          pendingToolUse.push({
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          })
          yield { type: 'tool_use_start', toolName: event.content_block.name, toolUseId: event.content_block.id }
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          const last = pendingToolUse.at(-1)
          if (last) last.inputJson += event.delta.partial_json
          yield { type: 'tool_use_delta', toolInput: event.delta.partial_json }
        }
      } else if (event.type === 'content_block_stop') {
        yield { type: 'tool_use_end' }
      } else if (event.type === 'message_stop') {
        yield { type: 'message_stop' }
      }
    }

    // Collect the full assistant message from the accumulated stream
    const finalMsg = await stream.finalMessage()
    history.push({ role: 'assistant', content: finalMsg.content })

    if (pendingToolUse.length === 0) break  // No tool calls — we're done

    // Dispatch tools: concurrent-safe tools in parallel, others serial
    const safeCalls = pendingToolUse.filter(t => {
      const tool = tools.find(x => x.definition().name === t.name)
      if (!tool) return false
      try { return tool.isConcurrencySafe(JSON.parse(t.inputJson || '{}')) } catch { return false }
    })
    const unsafeCalls = pendingToolUse.filter(t => !safeCalls.includes(t))

    const toolResults: ToolResult[] = []

    // Run safe tools in parallel
    const safeResults = await Promise.all(safeCalls.map(async (call) => {
      const tool = tools.find(x => x.definition().name === call.name)
      if (!tool) return { tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true }
      try {
        const input = JSON.parse(call.inputJson || '{}')
        const content = await tool.execute(input, { abortSignal, workingDir })
        return { tool_use_id: call.id, content, is_error: false }
      } catch (err) {
        return { tool_use_id: call.id, content: (err as Error).message, is_error: true }
      }
    }))
    toolResults.push(...safeResults)

    // Run unsafe tools serially
    for (const call of unsafeCalls) {
      const tool = tools.find(x => x.definition().name === call.name)
      if (!tool) {
        toolResults.push({ tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true })
        continue
      }
      try {
        const input = JSON.parse(call.inputJson || '{}')
        const content = await tool.execute(input, { abortSignal, workingDir })
        toolResults.push({ tool_use_id: call.id, content, is_error: false })
      } catch (err) {
        toolResults.push({ tool_use_id: call.id, content: (err as Error).message, is_error: true })
      }
    }

    history.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error || undefined,
      })),
    })
  }
}
```

- [ ] **Step 4: Run query test**

```bash
ANTHROPIC_API_KEY=your_key bun test tests/query_test.ts
```

Expected: PASS (or skip if no key set).

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/query.ts chat/tests/query_test.ts
git commit -m "feat(chat): implement core agent query loop with concurrent tool dispatch"
```

---

## Task 6: Session Persistence

**Files:**
- Create: `chat/src/session/store.ts`
- Create: `chat/tests/session/store_test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// chat/tests/session/store_test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
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
    expect(list[0]?.id).toBe(id2)
    expect(list[1]?.id).toBe(id1)
  })

  it('returns null for missing session', async () => {
    const store = new SessionStore(TMP)
    const result = await store.load('nonexistent-id')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
bun test tests/session/store_test.ts
```

- [ ] **Step 3: Write `chat/src/session/store.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Message } from '../types/message.js'

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

export class SessionStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  async create(title: string): Promise<string> {
    const id = randomUUID()
    const session: Session = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    writeFileSync(this.path(id), JSON.stringify(session, null, 2), 'utf-8')
    return id
  }

  async appendMessages(id: string, messages: Message[]): Promise<void> {
    const session = await this.load(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    session.messages.push(...messages)
    session.updatedAt = Date.now()
    writeFileSync(this.path(id), JSON.stringify(session, null, 2), 'utf-8')
  }

  async load(id: string): Promise<Session | null> {
    const p = this.path(id)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as Session
  }

  async list(): Promise<Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>[]> {
    if (!existsSync(this.dir)) return []
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const sessions = files.map(f => {
      const raw = readFileSync(join(this.dir, f), 'utf-8')
      const { id, title, createdAt, updatedAt } = JSON.parse(raw) as Session
      return { id, title, createdAt, updatedAt }
    })
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test tests/session/store_test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/session/ chat/tests/session/
git commit -m "feat(chat): add disk-based session persistence"
```

---

## Task 7: Slash Command System

**Files:**
- Create: `chat/src/commands/index.ts`
- Create: `chat/src/commands/help.ts`
- Create: `chat/src/commands/clear.ts`
- Create: `chat/src/commands/config.ts`
- Create: `chat/src/commands/session.ts`
- Create: `chat/src/commands/memory.ts`
- Create: `chat/tests/commands/commands_test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// chat/tests/commands/commands_test.ts
import { describe, it, expect } from 'bun:test'
import { parseSlashCommand, CommandRegistry } from '../../src/commands/index.js'
import { HelpCommand } from '../../src/commands/help.js'
import { ClearCommand } from '../../src/commands/clear.js'

const ctx = {
  clearMessages: () => {},
  getMessages: () => [],
  workingDir: '/tmp',
}

describe('parseSlashCommand', () => {
  it('detects a slash command', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' })
  })

  it('extracts args', () => {
    expect(parseSlashCommand('/session list')).toEqual({ name: 'session', args: 'list' })
  })

  it('returns null for non-slash input', () => {
    expect(parseSlashCommand('just text')).toBeNull()
  })

  it('returns null for empty slash', () => {
    expect(parseSlashCommand('/')).toBeNull()
  })
})

describe('CommandRegistry', () => {
  it('dispatches /help to HelpCommand', async () => {
    const registry = new CommandRegistry()
    registry.register(new HelpCommand(registry))
    const result = await registry.dispatch('help', '', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('/help')
  })

  it('dispatches /clear to ClearCommand', async () => {
    const registry = new CommandRegistry()
    registry.register(new ClearCommand())
    const result = await registry.dispatch('clear', '', ctx)
    expect(result.type).toBe('clear')
  })

  it('returns output for unknown command', async () => {
    const registry = new CommandRegistry()
    const result = await registry.dispatch('unknown', '', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('Unknown command')
  })
})
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
bun test tests/commands/commands_test.ts
```

- [ ] **Step 3: Write `chat/src/commands/index.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export function parseSlashCommand(input: string): { name: string; args: string } | null {
  if (!input.startsWith('/')) return null
  const trimmed = input.slice(1).trim()
  if (!trimmed) return null
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return { name: trimmed, args: '' }
  return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() }
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>()

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd)
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias, cmd)
    }
  }

  async dispatch(name: string, args: string, ctx: CommandContext): Promise<CommandResult> {
    const cmd = this.commands.get(name)
    if (!cmd) return { type: 'output', text: `Unknown command: /${name}. Type /help for available commands.` }
    return cmd.execute(args, ctx)
  }

  all(): SlashCommand[] {
    const seen = new Set<SlashCommand>()
    for (const cmd of this.commands.values()) seen.add(cmd)
    return [...seen]
  }
}
```

- [ ] **Step 4: Write `chat/src/commands/help.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import type { CommandRegistry } from './index.js'

export class HelpCommand implements SlashCommand {
  name = 'help'
  description = 'Show available slash commands'

  constructor(private readonly registry: CommandRegistry) {}

  async execute(_args: string, _ctx: CommandContext): Promise<CommandResult> {
    const lines = ['Available commands:', '']
    for (const cmd of this.registry.all()) {
      const aliases = cmd.aliases?.map(a => `/${a}`).join(', ') ?? ''
      lines.push(`  /${cmd.name}${aliases ? ` (${aliases})` : ''}  — ${cmd.description}`)
    }
    return { type: 'output', text: lines.join('\n') }
  }
}
```

- [ ] **Step 5: Write `chat/src/commands/clear.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export class ClearCommand implements SlashCommand {
  name = 'clear'
  description = 'Clear the conversation history'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    ctx.clearMessages()
    return { type: 'clear' }
  }
}
```

- [ ] **Step 6: Write `chat/src/commands/config.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

interface ChatConfig {
  model: string
  systemPrompt: string
  maxTurns: number
}

let _config: ChatConfig = {
  model: process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-6',
  systemPrompt: process.env['CHAT_SYSTEM_PROMPT'] ?? 'You are a helpful coding assistant.',
  maxTurns: 20,
}

export function getConfig(): ChatConfig {
  return { ..._config }
}

export function setConfig(partial: Partial<ChatConfig>): void {
  _config = { ..._config, ...partial }
}

export class ConfigCommand implements SlashCommand {
  name = 'config'
  description = 'View or set config: /config [key] [value]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/)
    const cfg = getConfig()

    if (!parts[0] || parts[0] === '') {
      return {
        type: 'output',
        text: [
          'Current config:',
          `  model       = ${cfg.model}`,
          `  maxTurns    = ${cfg.maxTurns}`,
          `  systemPrompt = ${cfg.systemPrompt}`,
        ].join('\n'),
      }
    }

    const [key, ...rest] = parts
    const value = rest.join(' ')

    if (key === 'model') { setConfig({ model: value }); return { type: 'output', text: `model set to ${value}` } }
    if (key === 'maxTurns') { setConfig({ maxTurns: parseInt(value, 10) }); return { type: 'output', text: `maxTurns set to ${value}` } }
    if (key === 'systemPrompt') { setConfig({ systemPrompt: value }); return { type: 'output', text: `systemPrompt updated` } }

    return { type: 'output', text: `Unknown config key: ${key}` }
  }
}
```

- [ ] **Step 7: Write `chat/src/commands/session.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { SessionStore } from '../session/store.js'
import { homedir } from 'os'
import { join } from 'path'

export class SessionCommand implements SlashCommand {
  name = 'session'
  aliases = ['s']
  description = 'Manage sessions: /session list | /session load <id>'
  private store: SessionStore

  constructor(sessionsDir?: string) {
    this.store = new SessionStore(sessionsDir ?? join(homedir(), '.ai-orchestrator', 'sessions'))
  }

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    if (sub === 'list') {
      const sessions = await this.store.list()
      if (sessions.length === 0) return { type: 'output', text: 'No saved sessions.' }
      const lines = sessions.map(s => {
        const date = new Date(s.updatedAt).toLocaleString()
        return `  ${s.id.slice(0, 8)}  ${date}  ${s.title}`
      })
      return { type: 'output', text: ['Sessions:', ...lines].join('\n') }
    }

    return { type: 'output', text: `Unknown session subcommand: ${sub}. Use: list` }
  }
}
```

- [ ] **Step 8: Write `chat/src/commands/memory.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export class MemoryCommand implements SlashCommand {
  name = 'memory'
  description = 'Show conversation memory stats: /memory'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    const messages = ctx.getMessages() as Array<{ role: string }>
    const userCount = messages.filter(m => m.role === 'user').length
    const assistantCount = messages.filter(m => m.role === 'assistant').length
    const text = [
      `Conversation memory:`,
      `  User turns:      ${userCount}`,
      `  Assistant turns: ${assistantCount}`,
      `  Total messages:  ${messages.length}`,
    ].join('\n')
    return { type: 'output', text }
  }
}
```

- [ ] **Step 9: Run command tests — expect PASS**

```bash
bun test tests/commands/commands_test.ts
```

- [ ] **Step 10: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/commands/ chat/tests/commands/
git commit -m "feat(chat): add slash command system with help/clear/config/session/memory"
```

---

## Task 8: QueryEngine (Session Orchestrator)

**Files:**
- Create: `chat/src/QueryEngine.ts`

This wraps `queryLoop` with session persistence, config injection, tool wiring, and slash command handling.

- [ ] **Step 1: Write `chat/src/QueryEngine.ts`**

```typescript
import { queryLoop } from './query.js'
import { getConfig } from './commands/config.js'
import { parseSlashCommand, CommandRegistry } from './commands/index.js'
import { HelpCommand } from './commands/help.js'
import { ClearCommand } from './commands/clear.js'
import { ConfigCommand } from './commands/config.js'
import { SessionCommand } from './commands/session.js'
import { MemoryCommand } from './commands/memory.js'
import { SessionStore } from './session/store.js'
import { BashTool } from './tools/BashTool.js'
import { FileReadTool } from './tools/FileReadTool.js'
import { FileEditTool } from './tools/FileEditTool.js'
import { GlobTool } from './tools/GlobTool.js'
import { GrepTool } from './tools/GrepTool.js'
import { WebFetchTool } from './tools/WebFetchTool.js'
import type { Message, StreamEvent } from './types/message.js'
import type { Tool } from './types/tool.js'
import { homedir } from 'os'
import { join } from 'path'

export type EngineEvent =
  | StreamEvent
  | { type: 'command_output'; text: string }
  | { type: 'command_clear' }
  | { type: 'session_saved'; sessionId: string }

export class QueryEngine {
  private messages: Message[] = []
  private readonly tools: Tool[]
  private readonly commandRegistry: CommandRegistry
  private readonly sessionStore: SessionStore
  private currentSessionId: string | null = null
  readonly workingDir: string

  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir
    this.tools = [
      new BashTool(),
      new FileReadTool(),
      new FileEditTool(),
      new GlobTool(),
      new GrepTool(),
      new WebFetchTool(),
    ]
    this.commandRegistry = new CommandRegistry()
    this.sessionStore = new SessionStore(join(homedir(), '.ai-orchestrator', 'sessions'))
    this._registerCommands()
  }

  private _registerCommands(): void {
    this.commandRegistry.register(new HelpCommand(this.commandRegistry))
    this.commandRegistry.register(new ClearCommand())
    this.commandRegistry.register(new ConfigCommand())
    this.commandRegistry.register(new SessionCommand())
    this.commandRegistry.register(new MemoryCommand())
  }

  async* submit(input: string, abortSignal: AbortSignal): AsyncGenerator<EngineEvent> {
    const parsed = parseSlashCommand(input)

    if (parsed) {
      const result = await this.commandRegistry.dispatch(parsed.name, parsed.args, {
        clearMessages: () => { this.messages = [] },
        getMessages: () => this.messages,
        workingDir: this.workingDir,
      })

      if (result.type === 'clear') {
        this.messages = []
        yield { type: 'command_clear' }
        return
      }

      if (result.type === 'output') {
        yield { type: 'command_output', text: result.text }
        return
      }

      return
    }

    // Regular message — create session on first turn
    if (!this.currentSessionId) {
      this.currentSessionId = await this.sessionStore.create(input.slice(0, 60))
    }

    const userMsg: Message = { role: 'user', content: input }
    this.messages.push(userMsg)

    const cfg = getConfig()
    const assistantContent: string[] = []

    for await (const event of queryLoop(this.messages, this.tools, {
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      systemPrompt: cfg.systemPrompt,
      abortSignal,
      workingDir: this.workingDir,
    })) {
      if (event.type === 'text_delta' && event.text) {
        assistantContent.push(event.text)
      }
      yield event
    }

    // Persist turn to session
    if (this.currentSessionId) {
      await this.sessionStore.appendMessages(this.currentSessionId, [userMsg])
      yield { type: 'session_saved', sessionId: this.currentSessionId }
    }
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/QueryEngine.ts
git commit -m "feat(chat): add QueryEngine session orchestrator"
```

---

## Task 9: Ink TUI — Input Bar + Message List

**Files:**
- Create: `chat/src/screens/InputBar.tsx`
- Create: `chat/src/screens/MessageList.tsx`
- Create: `chat/src/screens/ToolProgress.tsx`

- [ ] **Step 1: Write `chat/src/screens/InputBar.tsx`**

```tsx
import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

interface InputBarProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  placeholder?: string
}

export function InputBar({ onSubmit, disabled = false, placeholder = 'Type a message… (/help for commands)' }: InputBarProps) {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      const trimmed = value.trim()
      if (trimmed) {
        onSubmit(trimmed)
        setValue('')
      }
      return
    }

    if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1))
      return
    }

    if (!key.ctrl && !key.meta && input) {
      setValue(prev => prev + input)
    }
  })

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
      <Text color="cyan">{'> '}</Text>
      <Text>{value || <Text color="gray">{placeholder}</Text>}</Text>
      {!disabled && <Text color="cyan">{'█'}</Text>}
    </Box>
  )
}
```

- [ ] **Step 2: Write `chat/src/screens/MessageList.tsx`**

```tsx
import React from 'react'
import { Box, Text } from 'ink'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'command'
  content: string
  timestamp: number
}

interface MessageListProps {
  messages: ChatMessage[]
}

const ROLE_COLOR: Record<ChatMessage['role'], string> = {
  user: 'green',
  assistant: 'white',
  system: 'yellow',
  command: 'cyan',
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: 'You',
  assistant: 'Claude',
  system: 'System',
  command: 'Command',
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text color={ROLE_COLOR[msg.role]} bold>
            {ROLE_LABEL[msg.role]}
          </Text>
          <Text wrap="wrap">{msg.content}</Text>
        </Box>
      ))}
    </Box>
  )
}
```

- [ ] **Step 3: Write `chat/src/screens/ToolProgress.tsx`**

```tsx
import React from 'react'
import { Box, Text } from 'ink'

export interface ActiveTool {
  toolUseId: string
  name: string
  inputBuffer: string
  done: boolean
}

interface ToolProgressProps {
  activeTools: ActiveTool[]
}

export function ToolProgress({ activeTools }: ToolProgressProps) {
  const pending = activeTools.filter(t => !t.done)
  if (pending.length === 0) return null

  return (
    <Box flexDirection="column" paddingX={1}>
      {pending.map(tool => (
        <Box key={tool.toolUseId}>
          <Text color="yellow">{'⚙ '}</Text>
          <Text color="yellow">{tool.name}</Text>
          <Text color="gray">{' running…'}</Text>
        </Box>
      ))}
    </Box>
  )
}
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/screens/
git commit -m "feat(chat): add Ink TUI components (InputBar, MessageList, ToolProgress)"
```

---

## Task 10: Main REPL Screen + Entry Point

**Files:**
- Create: `chat/src/screens/REPL.tsx`
- Modify: `chat/src/index.ts`

- [ ] **Step 1: Write `chat/src/screens/REPL.tsx`**

```tsx
import React, { useState, useCallback, useRef } from 'react'
import { Box, Text, useApp, useStdout } from 'ink'
import { MessageList } from './MessageList.js'
import { InputBar } from './InputBar.js'
import { ToolProgress } from './ToolProgress.js'
import { QueryEngine } from '../QueryEngine.js'
import type { ChatMessage } from './MessageList.js'
import type { ActiveTool } from './ToolProgress.js'

interface REPLProps {
  workingDir: string
}

export function REPL({ workingDir }: REPLProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'system',
      content: 'Chat agent ready. Type /help for available commands. Ctrl+C to exit.',
      timestamp: Date.now(),
    },
  ])
  const [streaming, setStreaming] = useState(false)
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([])
  const [currentResponse, setCurrentResponse] = useState('')
  const engineRef = useRef(new QueryEngine(workingDir))
  const abortRef = useRef<AbortController | null>(null)

  const handleSubmit = useCallback(async (input: string) => {
    if (input === '/exit' || input === '/quit') {
      exit()
      return
    }

    setMessages(prev => [...prev, { role: 'user', content: input, timestamp: Date.now() }])
    setStreaming(true)
    setCurrentResponse('')

    const abort = new AbortController()
    abortRef.current = abort

    let responseText = ''
    let isCommand = false

    for await (const event of engineRef.current.submit(input, abort.signal)) {
      if (event.type === 'command_output') {
        isCommand = true
        setMessages(prev => [...prev, { role: 'command', content: event.text, timestamp: Date.now() }])
        break
      }

      if (event.type === 'command_clear') {
        setMessages([{ role: 'system', content: 'Conversation cleared.', timestamp: Date.now() }])
        break
      }

      if (event.type === 'text_delta' && event.text) {
        responseText += event.text
        setCurrentResponse(responseText)
      }

      if (event.type === 'tool_use_start') {
        setActiveTools(prev => [...prev, {
          toolUseId: event.toolUseId ?? '',
          name: event.toolName ?? '',
          inputBuffer: '',
          done: false,
        }])
      }

      if (event.type === 'tool_use_end') {
        setActiveTools(prev => prev.map(t => ({ ...t, done: true })))
      }

      if (event.type === 'message_stop' && responseText) {
        setMessages(prev => [...prev, { role: 'assistant', content: responseText, timestamp: Date.now() }])
        responseText = ''
        setCurrentResponse('')
      }
    }

    setStreaming(false)
    setCurrentResponse('')
    setActiveTools([])
  }, [exit])

  const terminalHeight = stdout.rows ?? 24

  return (
    <Box flexDirection="column" height={terminalHeight}>
      <Box borderStyle="double" borderColor="blue" paddingX={2}>
        <Text bold color="blue">{'AI Orchestrator — Chat Agent'}</Text>
      </Box>

      <MessageList messages={messages} />

      {streaming && currentResponse && (
        <Box paddingX={1}>
          <Text color="blue" bold>{'Claude  '}</Text>
          <Text wrap="wrap">{currentResponse}</Text>
        </Box>
      )}

      <ToolProgress activeTools={activeTools} />

      <InputBar onSubmit={handleSubmit} disabled={streaming} />
    </Box>
  )
}
```

- [ ] **Step 2: Write the entry point `chat/src/index.ts`**

```typescript
import React from 'react'
import { render } from 'ink'
import { REPL } from './screens/REPL.js'
import { parseArgs } from 'util'

const { values } = parseArgs({
  options: {
    dir: { type: 'string', short: 'd', default: process.cwd() },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`
AI Orchestrator Chat Agent

Usage: bun run tui [options]

Options:
  -d, --dir <path>   Working directory for tools (default: cwd)
  -h, --help         Show this help message

Slash commands: /help, /clear, /config, /session, /memory
  `)
  process.exit(0)
}

const { waitUntilExit } = render(
  React.createElement(REPL, { workingDir: values.dir ?? process.cwd() })
)

await waitUntilExit()
```

- [ ] **Step 3: Launch the TUI manually to smoke test**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
ANTHROPIC_API_KEY=your_key bun run tui
```

Expected: Terminal renders the REPL with a header, system message, and input bar. Type `/help` and see available commands. Type `hello` and see a streaming response.

- [ ] **Step 4: Verify /clear and /config work**

In the running TUI:
- Type `/clear` → conversation resets
- Type `/config` → shows current config
- Type `/config model claude-haiku-4-5-20251001` → model updated
- Type `Ctrl+C` → exits cleanly

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/screens/REPL.tsx chat/src/index.ts
git commit -m "feat(chat): add Ink REPL screen and TUI entry point"
```

---

## Task 11: Wire into ai-orchestrator root

**Files:**
- Modify: `/home/mcarls/projects/ai-orchestrator/package.json`

- [ ] **Step 1: Update root package.json**

Read the current file first. It should currently contain `{}`. Replace with:

```json
{
  "name": "ai-orchestrator",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["chat"],
  "scripts": {
    "chat": "cd chat && bun run tui",
    "chat:test": "cd chat && bun test"
  }
}
```

- [ ] **Step 2: Verify the chat command runs from root**

```bash
cd /home/mcarls/projects/ai-orchestrator
bun run chat -- --help
```

Expected: Help text printed, process exits 0.

- [ ] **Step 3: Final test run**

```bash
bun run chat:test
```

Expected: All tests pass.

- [ ] **Step 4: Final commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add package.json
git commit -m "feat(chat): wire chat package into root workspace and add run scripts"
```

---

## Self-Review

### Spec Coverage Check

| Requirement | Covered by |
|-------------|-----------|
| Chatbot agent mode | QueryEngine + queryLoop (Tasks 5, 8) |
| TypeScript implementation | All tasks (Task 1 scaffold) |
| Reuse claude-code patterns | query.ts pattern, Tool interface, concurrency safety (Tasks 3–5) |
| TUI like claude-code | Ink REPL with InputBar, MessageList, ToolProgress (Tasks 9–10) |
| Slash commands | CommandRegistry, 5 built-in commands (Task 7) |
| /help | HelpCommand (Task 7) |
| /clear | ClearCommand (Task 7) |
| /config | ConfigCommand (Task 7) |
| /session | SessionCommand (Task 7) |
| /memory | MemoryCommand (Task 7) |
| Session persistence | SessionStore on disk (Task 6) |
| Tool dispatch with concurrency | queryLoop parallel/serial dispatch (Task 5) |
| Abort/interrupt | AbortController threaded everywhere (Task 5) |
| Tool: Bash | BashTool with timeout + readonly detection (Task 3) |
| Tool: FileRead | FileReadTool (Task 3) |
| Tool: FileEdit | FileEditTool (Task 4) |
| Tool: Glob | GlobTool (Task 4) |
| Tool: Grep | GrepTool (Task 4) |
| Tool: WebFetch | WebFetchTool (Task 4) |
| Existing chatbot mode overwrite | Starting fresh in `chat/` |
| Web UI (Plan B) | Not in this plan — separate plan B |

### Placeholder Scan

No TBD, TODO, or "implement later" patterns found. All code blocks are complete.

### Type Consistency

- `Message` type defined in `types/message.ts`, used consistently across `query.ts`, `QueryEngine.ts`, `session/store.ts`
- `Tool` interface defined in `types/tool.ts`, implemented by all 6 tool classes
- `SlashCommand` defined in `types/command.ts`, implemented by all 5 command classes
- `StreamEvent` emitted by `query.ts`, consumed by `QueryEngine.ts` and `REPL.tsx`
- `EngineEvent` (superset of StreamEvent) emitted by `QueryEngine.ts`, consumed by `REPL.tsx`
- `ChatMessage` defined in `MessageList.tsx`, constructed in `REPL.tsx`
- `ActiveTool` defined in `ToolProgress.tsx`, managed in `REPL.tsx`

No naming inconsistencies found.

---

## Task 12: Project Auto-Detection + Context Injection

**Files:**
- Create: `chat/src/project/detector.ts`
- Create: `chat/src/project/context.ts`
- Create: `chat/tests/project/detector_test.ts`

When the TUI or server starts, detect if the working directory is inside a git repo. Load project-level memory from `CHAT.md` at the repo root and inject into the system prompt. Embeddings toggle is in Task 13.

- [ ] **Step 1: Write failing tests**

```typescript
// chat/tests/project/detector_test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { detectProject } from '../../src/project/detector.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'

const TMP = '/tmp/chat-project-detector-test'

beforeAll(() => {
  mkdirSync(`${TMP}/git-repo`, { recursive: true })
  // spawnSync is safe: fixed args array, no shell, no user input
  spawnSync('git', ['init'], { cwd: `${TMP}/git-repo` })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: `${TMP}/git-repo` })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: `${TMP}/git-repo` })
  writeFileSync(`${TMP}/git-repo/CHAT.md`, '# My Project\nThis is my test project.\n', 'utf8')
  mkdirSync(`${TMP}/plain-dir`, { recursive: true })
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('detectProject', () => {
  it('detects git root from a subdirectory', async () => {
    mkdirSync(`${TMP}/git-repo/sub`, { recursive: true })
    const info = await detectProject(`${TMP}/git-repo/sub`)
    expect(info).not.toBeNull()
    expect(info!.gitRoot).toBe(`${TMP}/git-repo`)
  })

  it('loads CHAT.md content when present', async () => {
    const info = await detectProject(`${TMP}/git-repo`)
    expect(info).not.toBeNull()
    expect(info!.chatMd).toContain('My Project')
  })

  it('returns null for non-git directory', async () => {
    const info = await detectProject(`${TMP}/plain-dir`)
    expect(info).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test tests/project/detector_test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `chat/src/project/detector.ts`**

```typescript
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface ProjectInfo {
  gitRoot: string
  projectName: string
  chatMd: string | null
}

/**
 * Detect project context from a working directory.
 * Uses spawnSync with fixed args arrays — no shell interpolation, no injection risk.
 * Returns null if not inside a git repo.
 */
export async function detectProject(workingDir: string): Promise<ProjectInfo | null> {
  // Fixed args array — safe from injection
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workingDir,
    encoding: 'utf8',
  })

  if (result.status !== 0 || !result.stdout) return null

  const gitRoot = result.stdout.trim()

  const chatMdPath = join(gitRoot, 'CHAT.md')
  const chatMd = existsSync(chatMdPath) ? readFileSync(chatMdPath, 'utf-8') : null

  // Derive name from git remote or directory name
  const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: gitRoot,
    encoding: 'utf8',
  })
  const remoteName = remoteResult.stdout?.trim()
  const dirName = gitRoot.split('/').pop() ?? 'unknown'
  const projectName = remoteName
    ? (remoteName.split('/').pop()?.replace(/\.git$/, '') ?? dirName)
    : dirName

  return { gitRoot, projectName, chatMd }
}
```

- [ ] **Step 4: Write `chat/src/project/context.ts`**

```typescript
import type { ProjectInfo } from './detector.js'

export interface ProjectContext {
  enabled: boolean
  info: ProjectInfo | null
  embeddingsEnabled: boolean
}

let _ctx: ProjectContext = {
  enabled: true,
  info: null,
  embeddingsEnabled: true,
}

export function setProjectContext(ctx: Partial<ProjectContext>): void {
  _ctx = { ..._ctx, ...ctx }
}

export function getProjectContext(): ProjectContext {
  return { ..._ctx }
}

export function buildProjectSystemPromptAddition(): string {
  const { enabled, info } = _ctx
  if (!enabled || !info) return ''

  const lines = [
    `\n\n## Current Project: ${info.projectName}`,
    `Working directory root: ${info.gitRoot}`,
  ]

  if (info.chatMd) {
    lines.push('\n### Project Memory (CHAT.md)\n')
    lines.push(info.chatMd)
  }

  return lines.join('\n')
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
bun test tests/project/detector_test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/project/ chat/tests/project/
git commit -m "feat(chat): add project auto-detection and CHAT.md context injection"
```

---

## Task 13: Additional Slash Commands

**Files:**
- Create: `chat/src/commands/model.ts`
- Create: `chat/src/commands/context_cmd.ts`
- Create: `chat/src/commands/cost.ts`
- Create: `chat/src/commands/compact.ts`
- Create: `chat/src/commands/project_cmd.ts`
- Create: `chat/src/commands/embeddings.ts`
- Create: `chat/src/commands/tools_cmd.ts`
- Create: `chat/src/session/tokenTracker.ts`
- Modify: `chat/src/types/command.ts` (add `requestCompact?`)
- Modify: `chat/src/QueryEngine.ts` (register new commands, inject project prompt)
- Create: `chat/tests/commands/additional_commands_test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// chat/tests/commands/additional_commands_test.ts
import { describe, it, expect } from 'bun:test'
import { ModelCommand } from '../../src/commands/model.js'
import { ToolsCommand } from '../../src/commands/tools_cmd.js'
import { EmbeddingsCommand } from '../../src/commands/embeddings.js'
import { ProjectCommand } from '../../src/commands/project_cmd.js'
import { getConfig } from '../../src/commands/config.js'
import { getProjectContext, setProjectContext } from '../../src/project/context.js'

const ctx = { clearMessages: () => {}, getMessages: () => [], workingDir: '/tmp' }

describe('ModelCommand', () => {
  it('shows current model when called with no args', async () => {
    const cmd = new ModelCommand()
    const result = await cmd.execute('', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('model')
  })

  it('sets model when given a name', async () => {
    const cmd = new ModelCommand()
    await cmd.execute('claude-haiku-4-5-20251001', ctx)
    expect(getConfig().model).toBe('claude-haiku-4-5-20251001')
  })
})

describe('EmbeddingsCommand', () => {
  it('disables embeddings with off', async () => {
    setProjectContext({ embeddingsEnabled: true })
    const cmd = new EmbeddingsCommand()
    await cmd.execute('off', ctx)
    expect(getProjectContext().embeddingsEnabled).toBe(false)
  })

  it('enables embeddings with on', async () => {
    setProjectContext({ embeddingsEnabled: false })
    const cmd = new EmbeddingsCommand()
    await cmd.execute('on', ctx)
    expect(getProjectContext().embeddingsEnabled).toBe(true)
  })
})

describe('ProjectCommand', () => {
  it('disables project context with off', async () => {
    setProjectContext({ enabled: true })
    const cmd = new ProjectCommand()
    await cmd.execute('off', ctx)
    expect(getProjectContext().enabled).toBe(false)
  })

  it('enables project context with on', async () => {
    setProjectContext({ enabled: false })
    const cmd = new ProjectCommand()
    await cmd.execute('on', ctx)
    expect(getProjectContext().enabled).toBe(true)
  })
})

describe('ToolsCommand', () => {
  it('lists available tools', async () => {
    const cmd = new ToolsCommand()
    const result = await cmd.execute('', ctx)
    expect(result.type).toBe('output')
    expect((result as { type: 'output'; text: string }).text).toContain('Bash')
  })
})
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
bun test tests/commands/additional_commands_test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `chat/src/session/tokenTracker.ts`**

```typescript
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turns: number
}

let _usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 }

export function recordTokenUsage(input: number, output: number, cacheRead = 0): void {
  _usage = {
    inputTokens: _usage.inputTokens + input,
    outputTokens: _usage.outputTokens + output,
    cacheReadTokens: _usage.cacheReadTokens + cacheRead,
    turns: _usage.turns + 1,
  }
}

export function getTokenUsage(): TokenUsage {
  return { ..._usage }
}

export function resetTokenUsage(): void {
  _usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 }
}
```

- [ ] **Step 4: Write `chat/src/commands/model.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig, setConfig } from './config.js'

const KNOWN_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

export class ModelCommand implements SlashCommand {
  name = 'model'
  aliases = ['m']
  description = 'View or switch model: /model [name]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const name = args.trim()
    const cfg = getConfig()

    if (!name) {
      const modelList = KNOWN_MODELS
        .map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`))
        .join('\n')
      return {
        type: 'output',
        text: `Current model: ${cfg.model}\n\nKnown models:\n${modelList}\n\nUsage: /model <name>`,
      }
    }

    setConfig({ model: name })
    return { type: 'output', text: `Model switched to: ${name}` }
  }
}
```

- [ ] **Step 5: Write `chat/src/commands/context_cmd.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig } from './config.js'
import { getProjectContext } from '../project/context.js'

export class ContextCommand implements SlashCommand {
  name = 'context'
  description = 'Show current session context, project, and settings'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    const cfg = getConfig()
    const proj = getProjectContext()
    const msgCount = (ctx.getMessages() as unknown[]).length

    const lines = [
      '=== Session Context ===',
      `  Model:       ${cfg.model}`,
      `  Max turns:   ${cfg.maxTurns}`,
      `  Messages:    ${msgCount}`,
      `  Working dir: ${ctx.workingDir}`,
      '',
      '=== Project Context ===',
      `  Enabled:     ${proj.enabled}`,
      `  Embeddings:  ${proj.embeddingsEnabled}`,
    ]

    if (proj.info) {
      lines.push(`  Project:     ${proj.info.projectName}`)
      lines.push(`  Git root:    ${proj.info.gitRoot}`)
      lines.push(`  CHAT.md:     ${proj.info.chatMd ? 'loaded' : 'not found'}`)
    } else {
      lines.push('  Project:     not detected')
    }

    lines.push('')
    lines.push('=== System Prompt (first 200 chars) ===')
    lines.push(`  ${cfg.systemPrompt.slice(0, 200)}`)

    return { type: 'output', text: lines.join('\n') }
  }
}
```

- [ ] **Step 6: Write `chat/src/commands/cost.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getTokenUsage } from '../session/tokenTracker.js'

// Per-million-token pricing (approximate, claude-sonnet-4-6)
const INPUT_PRICE_PER_M = 3.0
const OUTPUT_PRICE_PER_M = 15.0
const CACHE_READ_PRICE_PER_M = 0.30

export class CostCommand implements SlashCommand {
  name = 'cost'
  description = 'Show estimated token usage and cost for this session'

  async execute(_args: string, _ctx: CommandContext): Promise<CommandResult> {
    const usage = getTokenUsage()

    const inputCost = (usage.inputTokens / 1_000_000) * INPUT_PRICE_PER_M
    const outputCost = (usage.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M
    const cacheCost = (usage.cacheReadTokens / 1_000_000) * CACHE_READ_PRICE_PER_M
    const totalCost = inputCost + outputCost + cacheCost

    const lines = [
      '=== Token Usage ===',
      `  Input:      ${usage.inputTokens.toLocaleString()}`,
      `  Output:     ${usage.outputTokens.toLocaleString()}`,
      `  Cache read: ${usage.cacheReadTokens.toLocaleString()}`,
      `  Turns:      ${usage.turns}`,
      '',
      '=== Estimated Cost (claude-sonnet-4-6) ===',
      `  Input:      $${inputCost.toFixed(4)}`,
      `  Output:     $${outputCost.toFixed(4)}`,
      `  Cache:      $${cacheCost.toFixed(4)}`,
      `  Total:      $${totalCost.toFixed(4)}`,
    ]

    return { type: 'output', text: lines.join('\n') }
  }
}
```

- [ ] **Step 7: Write `chat/src/commands/compact.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export class CompactCommand implements SlashCommand {
  name = 'compact'
  description = 'Request conversation compaction before the next message'

  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    const messages = ctx.getMessages() as Array<{ role: string }>
    const turnCount = messages.filter(m => m.role === 'user').length

    if (turnCount < 4) {
      return { type: 'output', text: 'Conversation is short — no compaction needed yet.' }
    }

    ctx.requestCompact?.()
    return {
      type: 'output',
      text: `Compaction requested. ${turnCount} turns will be summarized before next message.`,
    }
  }
}
```

- [ ] **Step 8: Write `chat/src/commands/project_cmd.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getProjectContext, setProjectContext } from '../project/context.js'
import { detectProject } from '../project/detector.js'

export class ProjectCommand implements SlashCommand {
  name = 'project'
  description = 'Manage project context: /project [on|off|reload|status]'

  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const sub = args.trim().toLowerCase() || 'status'
    const projCtx = getProjectContext()

    if (sub === 'off') {
      setProjectContext({ enabled: false })
      return { type: 'output', text: 'Project context disabled.' }
    }

    if (sub === 'on') {
      setProjectContext({ enabled: true })
      return { type: 'output', text: 'Project context enabled.' }
    }

    if (sub === 'reload') {
      const info = await detectProject(ctx.workingDir)
      setProjectContext({ info: info ?? null })
      if (info) return { type: 'output', text: `Project reloaded: ${info.projectName}` }
      return { type: 'output', text: 'No project detected in current directory.' }
    }

    // status (default)
    const lines = [
      `Project context: ${projCtx.enabled ? 'enabled' : 'disabled'}`,
      `Embeddings:      ${projCtx.embeddingsEnabled ? 'enabled' : 'disabled'}`,
    ]
    if (projCtx.info) {
      lines.push(`Project:         ${projCtx.info.projectName}`)
      lines.push(`Root:            ${projCtx.info.gitRoot}`)
      lines.push(`CHAT.md:         ${projCtx.info.chatMd ? 'loaded' : 'not found'}`)
    } else {
      lines.push('No project detected. Use /project reload or navigate to a git repo.')
    }
    return { type: 'output', text: lines.join('\n') }
  }
}
```

- [ ] **Step 9: Write `chat/src/commands/embeddings.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getProjectContext, setProjectContext } from '../project/context.js'

export class EmbeddingsCommand implements SlashCommand {
  name = 'embeddings'
  aliases = ['emb']
  description = 'Toggle semantic context injection: /embeddings [on|off|status]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const sub = args.trim().toLowerCase() || 'status'
    const projCtx = getProjectContext()

    if (sub === 'off') {
      setProjectContext({ embeddingsEnabled: false })
      return { type: 'output', text: 'Embeddings disabled.' }
    }

    if (sub === 'on') {
      setProjectContext({ embeddingsEnabled: true })
      return { type: 'output', text: 'Embeddings enabled.' }
    }

    return {
      type: 'output',
      text: `Embeddings: ${projCtx.embeddingsEnabled ? 'enabled' : 'disabled'}\nUsage: /embeddings on|off`,
    }
  }
}
```

- [ ] **Step 10: Write `chat/src/commands/tools_cmd.ts`**

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

const BUILTIN_TOOLS = [
  { name: 'Bash',     description: 'Execute bash commands (timeout: 30s)' },
  { name: 'Read',     description: 'Read file contents' },
  { name: 'Edit',     description: 'Search-and-replace edit files' },
  { name: 'Glob',     description: 'Find files by glob pattern' },
  { name: 'Grep',     description: 'Search file contents (ripgrep)' },
  { name: 'WebFetch', description: 'Fetch URL text content' },
]

export class ToolsCommand implements SlashCommand {
  name = 'tools'
  description = 'List available tools'

  async execute(_args: string, _ctx: CommandContext): Promise<CommandResult> {
    const lines = ['Available tools:', '']
    for (const tool of BUILTIN_TOOLS) {
      lines.push(`  ${tool.name.padEnd(12)} ${tool.description}`)
    }
    lines.push('')
    lines.push('Tools are invoked automatically by the model as needed.')
    return { type: 'output', text: lines.join('\n') }
  }
}
```

- [ ] **Step 11: Update `chat/src/types/command.ts` — add `requestCompact?`**

Add the optional method to `CommandContext`:

```typescript
export interface CommandContext {
  clearMessages: () => void
  getMessages: () => unknown[]
  workingDir: string
  requestCompact?: () => void
}
```

- [ ] **Step 12: Update `chat/src/QueryEngine.ts` — register new commands + project context**

Add imports:
```typescript
import { ModelCommand } from './commands/model.js'
import { ContextCommand } from './commands/context_cmd.js'
import { CostCommand } from './commands/cost.js'
import { CompactCommand } from './commands/compact.js'
import { ProjectCommand } from './commands/project_cmd.js'
import { EmbeddingsCommand } from './commands/embeddings.js'
import { ToolsCommand } from './commands/tools_cmd.js'
import { detectProject } from './project/detector.js'
import { setProjectContext, buildProjectSystemPromptAddition } from './project/context.js'
import { recordTokenUsage, resetTokenUsage } from './session/tokenTracker.js'
```

Update `_registerCommands()` to register all new commands after existing ones:
```typescript
this.commandRegistry.register(new ModelCommand())
this.commandRegistry.register(new ContextCommand())
this.commandRegistry.register(new CostCommand())
this.commandRegistry.register(new CompactCommand())
this.commandRegistry.register(new ProjectCommand())
this.commandRegistry.register(new EmbeddingsCommand())
this.commandRegistry.register(new ToolsCommand())
```

Add `initialize()` method to the class:
```typescript
async initialize(): Promise<void> {
  const info = await detectProject(this.workingDir)
  if (info) {
    setProjectContext({ info })
  }
}
```

In `submit()`, append project system prompt:
```typescript
const cfg = getConfig()
const projectAddition = buildProjectSystemPromptAddition()
// Pass cfg.systemPrompt + projectAddition to queryLoop as systemPrompt
```

Add `requestCompact` to the command context object passed to `dispatch()`:
```typescript
let compactRequested = false
const result = await this.commandRegistry.dispatch(parsed.name, parsed.args, {
  clearMessages: () => { this.messages = []; resetTokenUsage() },
  getMessages: () => this.messages,
  workingDir: this.workingDir,
  requestCompact: () => { compactRequested = true },
})
```

- [ ] **Step 13: Run all tests**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 14: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/commands/ chat/src/session/tokenTracker.ts chat/src/types/command.ts chat/src/QueryEngine.ts chat/tests/commands/additional_commands_test.ts
git commit -m "feat(chat): add /model /context /cost /compact /project /embeddings /tools slash commands"
```

---

## Task 14: `ai` CLI Command

**Files:**
- Create: `chat/src/cli.ts`
- Create: `bin/ai`
- Modify: `chat/package.json`

**Usage:**
```
ai [options] [initial message]
  -m, --model <name>      Model (default: claude-sonnet-4-6)
      --no-project        Disable project auto-detection
      --no-embeddings     Disable semantic context injection
  -d, --dir <path>        Working directory (default: cwd)
  -s, --system <prompt>   Override system prompt
      --serve             Start WebSocket API server instead of TUI
      --port <port>       Port for --serve (default: 8765)
  -h, --help              Show help
  -v, --version           Show version
```

- [ ] **Step 1: Write `chat/src/cli.ts`**

```typescript
import { parseArgs } from 'util'
import { setConfig } from './commands/config.js'
import { setProjectContext } from './project/context.js'

const VERSION = '0.1.0'

const { values, positionals } = parseArgs({
  options: {
    model:          { type: 'string',  short: 'm' },
    'no-project':   { type: 'boolean', default: false },
    'no-embeddings':{ type: 'boolean', default: false },
    dir:            { type: 'string',  short: 'd', default: process.cwd() },
    system:         { type: 'string',  short: 's' },
    serve:          { type: 'boolean', default: false },
    port:           { type: 'string',  default: '8765' },
    help:           { type: 'boolean', short: 'h', default: false },
    version:        { type: 'boolean', short: 'v', default: false },
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

// Apply flag overrides before loading Ink (avoids unnecessary import)
if (values.model)          setConfig({ model: values.model })
if (values.system)         setConfig({ systemPrompt: values.system })
if (values['no-project'])  setProjectContext({ enabled: false })
if (values['no-embeddings']) setProjectContext({ embeddingsEnabled: false })

const workingDir = values.dir ?? process.cwd()
const initialMessage = positionals.length > 0 ? positionals.join(' ') : undefined

if (values.serve) {
  // Import server entry point dynamically to avoid loading Ink in server mode
  process.env['CHAT_PORT'] = values.port ?? '8765'
  process.env['CHAT_DIR']  = workingDir
  await import('./server.js')
} else {
  // TUI mode — import React and Ink only when needed
  const { default: React } = await import('react')
  const { render } = await import('ink')
  const { REPL } = await import('./screens/REPL.js')
  const { QueryEngine } = await import('./QueryEngine.js')

  const engine = new QueryEngine(workingDir)
  await engine.initialize()

  const { waitUntilExit } = render(
    React.createElement(REPL, { workingDir, engine, initialMessage })
  )
  await waitUntilExit()
}
```

Note: `REPL.tsx` props need updating to accept `engine` and `initialMessage`. In `chat/src/screens/REPL.tsx`, update:

```typescript
interface REPLProps {
  workingDir: string
  engine?: QueryEngine
  initialMessage?: string
}
// In the component body:
const engineRef = useRef(engine ?? new QueryEngine(workingDir))
// And add useEffect for initialMessage after component mounts
```

Also update `chat/src/server.ts` to read port/dir from env if set:
```typescript
const PORT = parseInt(process.env['CHAT_PORT'] ?? values.port ?? '8765', 10)
const WORKING_DIR = process.env['CHAT_DIR'] ?? values.dir ?? process.cwd()
```

- [ ] **Step 2: Create `bin/ai` shell wrapper**

```bash
#!/usr/bin/env bash
# ai — AI Orchestrator chat agent CLI
# Install: ln -sf "$(pwd)/bin/ai" ~/.local/bin/ai
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAT_DIR="$(dirname "$SCRIPT_DIR")/chat"
exec bun run "$CHAT_DIR/src/cli.ts" "$@"
```

Make executable:
```bash
chmod +x /home/mcarls/projects/ai-orchestrator/bin/ai
```

- [ ] **Step 3: Update `chat/package.json` scripts**

```json
{
  "name": "ai-orchestrator-chat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "tui":       "bun run src/cli.ts",
    "serve":     "bun run src/cli.ts --serve",
    "test":      "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 4: Install `ai` to PATH**

```bash
mkdir -p ~/.local/bin
ln -sf /home/mcarls/projects/ai-orchestrator/bin/ai ~/.local/bin/ai
```

Verify PATH:
```bash
echo $PATH | tr ':' '\n' | grep -q ".local/bin" && echo "OK" || echo "Add ~/.local/bin to PATH in ~/.zshrc"
```

If missing:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

- [ ] **Step 5: Smoke tests**

```bash
ai --version
# Expected: ai-orchestrator chat v0.1.0

ai --help
# Expected: full help text

ai --no-project --help
# Expected: help text, no errors

# From a git repo — detects project:
cd /home/mcarls/projects/ai-orchestrator
ANTHROPIC_API_KEY=your_key ai --no-embeddings
# Expected: TUI opens, shows project name "ai-orchestrator" in system context
```

- [ ] **Step 6: Run full test suite**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
bun test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/cli.ts bin/ai chat/package.json
git commit -m "feat(chat): add \`ai\` CLI with --model --no-project --no-embeddings flags"
```

---

## Updated Self-Review (Tasks 12-14 additions)

| New Requirement | Covered by |
|-----------------|-----------|
| `ai` CLI command | Task 14 — `bin/ai` + `src/cli.ts` |
| `ai --model` flag | Task 14 cli.ts |
| `ai --no-project` flag | Task 14 cli.ts |
| `ai --no-embeddings` flag | Task 14 cli.ts |
| /model slash command | Task 13 ModelCommand |
| /context slash command | Task 13 ContextCommand |
| /cost + token tracking | Task 13 CostCommand + tokenTracker.ts |
| /compact | Task 13 CompactCommand |
| /project on/off/reload | Task 13 ProjectCommand |
| /embeddings on/off | Task 13 EmbeddingsCommand |
| /tools | Task 13 ToolsCommand |
| Project auto-detection | Task 12 detector.ts |
| CHAT.md project memory | Task 12 detector.ts loads it |
| Project context in system prompt | Task 12 context.ts |
| Initial message via CLI args | Task 14 cli.ts positionals |
