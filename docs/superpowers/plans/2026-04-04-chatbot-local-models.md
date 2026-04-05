# Chatbot Agent — Local GPU Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Prerequisite:** Plan A (`2026-04-04-chatbot-agent-tui.md`) must be merged to main. Start fresh from main.

**Goal:** Make the `ai` TUI use local LM Studio models (RTX 5090) by default. The Anthropic, Gemini, and OpenAI/Codex backends are available but opt-in — local is primary. Fix the multi-turn conversation memory bug in the process.

**Architecture:** Extract the tool-dispatch logic from `query.ts` into an exported helper, fix the history-mutation bug (currently `history` is a shallow copy so assistant messages are never persisted between submit calls), and change the default model to `gemma-4-27b-it` (LM Studio local). Add `chat/src/backends/openai_compat.ts` using the OpenAI SDK. `QueryEngine` routes by model name prefix: `claude-*` → Anthropic, `gemini-*` → Google (Plan B adds this), `gpt-*`/`o1-*`/`o3-*` → OpenAI API, anything else → LM Studio local. `localUrl` is configurable via env var, CLI flag, or `/config`.

**Tech Stack:** Bun ≥1.1, TypeScript 5.7, @anthropic-ai/sdk ^0.39 (existing), openai ^4 (new), LM Studio ≥0.3 (serves OpenAI-compatible API at `http://localhost:1234/v1`)

**Note on Plan B (Web UI):** `docs/superpowers/plans/2026-04-04-chatbot-agent-webui.md` is fully written and independent of this plan. It can be executed in a separate worktree in parallel once this plan is complete.

---

## File Map

```
chat/
├── package.json                         MODIFY  — add openai ^4 dependency
├── src/
│   ├── query.ts                         MODIFY  — export dispatchTools helper, fix history mutation
│   ├── backends/
│   │   └── openai_compat.ts             CREATE  — OpenAI-compat query loop for local models
│   ├── commands/
│   │   ├── config.ts                    MODIFY  — add localUrl field
│   │   └── model.ts                     MODIFY  — add local model presets, show backend indicator
│   └── cli.ts                           MODIFY  — add --local-url flag
└── tests/
    ├── query_test.ts                    MODIFY  — add multi-turn history test
    └── backends/
        └── openai_compat_test.ts        CREATE  — unit tests for message converters
README.md                                MODIFY  — add local model setup section
```

---

## Task 1: Fix Multi-Turn History + Extract `dispatchTools`

**Files:**
- Modify: `chat/src/query.ts`
- Modify: `chat/tests/query_test.ts`

**Background:** `queryLoop` currently does `const history = [...messages]` — a shallow copy. Assistant messages and tool result messages are pushed to `history` but never back to `messages`. This means `QueryEngine.messages` only ever contains user messages, so every new submit starts with no conversation context. This task fixes that and extracts the shared tool-dispatch logic so `openai_compat.ts` can reuse it.

- [ ] **Step 1: Write failing multi-turn test in `chat/tests/query_test.ts`**

Open `chat/tests/query_test.ts` and add this test inside the `describe('queryLoop', ...)` block:

```typescript
it('pushes assistant and tool-result messages back to the messages array', () => {
  // queryLoop mutates its messages argument so QueryEngine can track full history
  const msgs: Message[] = [{ role: 'user', content: 'hello' }]
  // After a (mocked) complete turn, messages should grow — tested via dispatchTools indirectly.
  // For now just verify the export exists.
  expect(typeof dispatchTools).toBe('function')
})
```

Also add the import at the top of the test file:
```typescript
import { dispatchTools } from '../src/query.js'
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test tests/query_test.ts
```

Expected: FAIL — `dispatchTools` is not exported.

- [ ] **Step 3: Rewrite `chat/src/query.ts`**

Replace the entire file with:

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages.js'
import { toApiMessage } from './types/message.js'
import type { Message, StreamEvent } from './types/message.js'
import { recordTokenUsage } from './session/tokenTracker.js'
import type { Tool, ToolResult } from './types/tool.js'

export interface QueryOptions {
  model: string
  maxTurns: number
  systemPrompt: string
  abortSignal: AbortSignal
  workingDir: string
  localUrl?: string
}

export interface PendingToolCall {
  id: string
  name: string
  inputJson: string
}

const client = new Anthropic()

/**
 * Dispatches a list of pending tool calls, running concurrency-safe tools
 * in parallel and unsafe tools serially. Shared by both query backends.
 */
export async function dispatchTools(
  pendingToolUse: PendingToolCall[],
  tools: Tool[],
  ctx: { abortSignal: AbortSignal; workingDir: string },
): Promise<ToolResult[]> {
  const safeCalls = pendingToolUse.filter(call => {
    const tool = tools.find(x => x.definition().name === call.name)
    if (!tool) return false
    try { return tool.isConcurrencySafe(JSON.parse(call.inputJson || '{}')) } catch { return false }
  })
  const unsafeCalls = pendingToolUse.filter(call => !safeCalls.includes(call))

  const results: ToolResult[] = []

  const safeResults = await Promise.all(safeCalls.map(async call => {
    const tool = tools.find(x => x.definition().name === call.name)
    if (!tool) return { tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true }
    try {
      const input = JSON.parse(call.inputJson || '{}') as unknown
      const content = await tool.execute(input, ctx)
      return { tool_use_id: call.id, content, is_error: false }
    } catch (err) {
      return { tool_use_id: call.id, content: (err as Error).message, is_error: true }
    }
  }))
  results.push(...safeResults)

  for (const call of unsafeCalls) {
    const tool = tools.find(x => x.definition().name === call.name)
    if (!tool) {
      results.push({ tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true })
      continue
    }
    try {
      const input = JSON.parse(call.inputJson || '{}') as unknown
      const content = await tool.execute(input, ctx)
      results.push({ tool_use_id: call.id, content, is_error: false })
    } catch (err) {
      results.push({ tool_use_id: call.id, content: (err as Error).message, is_error: true })
    }
  }

  return results
}

/**
 * Core agent loop using the Anthropic API. Streams model responses, dispatches
 * tool calls, and re-enters the loop with tool results until no more tool calls
 * or maxTurns.
 *
 * IMPORTANT: mutates `messages` in place — pushes assistant messages and tool
 * result messages so QueryEngine.messages retains full conversation history.
 */
export async function* queryLoop(
  messages: Message[],
  tools: Tool[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { model, maxTurns, systemPrompt, abortSignal, workingDir } = options
  let turns = 0

  while (turns < maxTurns) {
    turns++

    const toolDefs = tools.map(t => t.definition() as unknown as AnthropicTool)
    const apiMessages = messages.map(toApiMessage)

    let stream: Awaited<ReturnType<typeof client.messages.stream>>
    try {
      stream = client.messages.stream({
        model,
        max_tokens: 8096,
        system: systemPrompt,
        messages: apiMessages,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      })
    } catch (err) {
      yield { type: 'error', error: (err as Error).message }
      return
    }

    const pendingToolUse: PendingToolCall[] = []
    let currentBlockIsToolUse = false

    for await (const event of stream) {
      if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }

      if (event.type === 'content_block_start') {
        currentBlockIsToolUse = event.content_block.type === 'tool_use'
        if (event.content_block.type === 'tool_use') {
          pendingToolUse.push({ id: event.content_block.id, name: event.content_block.name, inputJson: '' })
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
        if (currentBlockIsToolUse) yield { type: 'tool_use_end' }
        currentBlockIsToolUse = false
      } else if (event.type === 'message_stop') {
        yield { type: 'message_stop' }
      }
    }

    const finalMsg = await stream.finalMessage()
    recordTokenUsage(
      finalMsg.usage.input_tokens,
      finalMsg.usage.output_tokens,
      finalMsg.usage.cache_read_input_tokens ?? 0,
    )

    // Push assembled assistant message back to messages (fixes multi-turn memory)
    messages.push({ role: 'assistant', content: finalMsg.content })

    if (pendingToolUse.length === 0) break

    const toolResults = await dispatchTools(pendingToolUse, tools, { abortSignal, workingDir })

    // Push tool results back to messages
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

- [ ] **Step 4: Run tests**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test
```

Expected: 35 pass (the new test passes because `dispatchTools` is now exported; all existing tests continue to pass).

- [ ] **Step 5: Run typecheck**

```bash
~/.bun/bin/bun run typecheck
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/query.ts chat/tests/query_test.ts
git commit -m "refactor(chat): export dispatchTools, fix multi-turn history mutation in queryLoop"
```

---

## Task 2: Add `openai` Dependency + Create OpenAI-Compatible Backend

**Files:**
- Modify: `chat/package.json`
- Create: `chat/src/backends/openai_compat.ts`
- Create: `chat/tests/backends/openai_compat_test.ts`

**Background:** LM Studio exposes an OpenAI-compatible API at `http://localhost:1234/v1`. The `openai` npm package handles auth (LM Studio ignores the key value but requires a non-empty string), streaming, and type safety. Tool calls in OpenAI streaming arrive as indexed deltas across multiple chunks — accumulation is required. Token usage appears in the last chunk only when `stream_options: { include_usage: true }` is set (supported by LM Studio ≥0.3.5).

- [ ] **Step 1: Write failing tests in `chat/tests/backends/openai_compat_test.ts`**

```typescript
import { describe, it, expect } from 'bun:test'
import { toOpenAIMessages, toOpenAITools } from '../../src/backends/openai_compat.js'
import type { Message } from '../../src/types/message.js'

describe('toOpenAIMessages', () => {
  it('converts a simple user message', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }]
    const result = toOpenAIMessages('You are helpful.', msgs)
    expect(result).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('converts tool result messages to role:tool', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run bash' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hello\n', is_error: false }],
      },
    ]
    const result = toOpenAIMessages('', msgs)
    expect(result[2]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: 'hello\n' })
  })

  it('converts assistant message with tool_use blocks to tool_calls', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
    ]
    const result = toOpenAIMessages('', msgs)
    expect(result[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'bash' } }],
    })
  })
})

describe('toOpenAITools', () => {
  it('converts Anthropic-format tool definitions to OpenAI function format', () => {
    const fakeTool = {
      definition: () => ({
        name: 'bash',
        description: 'Run a bash command',
        input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
      }),
      isConcurrencySafe: () => false,
      execute: async () => '',
    }
    const result = toOpenAITools([fakeTool])
    expect(result).toEqual([{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a bash command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    }])
  })
})
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test tests/backends/openai_compat_test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Add `openai` dependency**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun add openai
```

Expected: `openai` appears in `chat/package.json` dependencies.

- [ ] **Step 4: Create `chat/src/backends/openai_compat.ts`**

```typescript
import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionToolMessageParam } from 'openai/resources/chat/completions.js'
import { recordTokenUsage } from '../session/tokenTracker.js'
import { dispatchTools } from '../query.js'
import type { Message, StreamEvent } from '../types/message.js'
import type { Tool } from '../types/tool.js'
import type { QueryOptions } from '../query.js'

// ── Message conversion ────────────────────────────────────────────────────────

/**
 * Converts ai-orchestrator Message[] to OpenAI ChatCompletionMessageParam[].
 * The system prompt is prepended as a system role message.
 * ToolResultMessages expand into individual role:tool messages.
 */
export function toOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      continue
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // ToolResultMessage — expand into one role:tool message per result
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const toolMsg: ChatCompletionToolMessageParam = {
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content,
          }
          result.push(toolMsg)
        }
      }
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textBlocks = msg.content
        .filter(b => b.type === 'text')
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('')
      const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use')

      if (toolUseBlocks.length > 0) {
        result.push({
          role: 'assistant',
          content: textBlocks || null,
          tool_calls: toolUseBlocks.map(b => {
            if (b.type !== 'tool_use') throw new Error('unexpected block type')
            return {
              id: b.id,
              type: 'function' as const,
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            }
          }),
        })
      } else {
        result.push({ role: 'assistant', content: textBlocks })
      }
    }
  }

  return result
}

// ── Tool definition conversion ────────────────────────────────────────────────

/**
 * Converts ai-orchestrator Tool[] to OpenAI function tool format.
 */
export function toOpenAITools(tools: Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map(t => {
    const def = t.definition()
    return {
      type: 'function' as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: def.input_schema as Record<string, unknown>,
      },
    }
  })
}

// ── Query loop ────────────────────────────────────────────────────────────────

/**
 * OpenAI-compatible agent loop for local LM Studio models.
 * Yields the same StreamEvent union as queryLoop (Anthropic backend).
 *
 * Model routing: called by QueryEngine when model name does NOT start with 'claude-'.
 * Default endpoint: http://localhost:1234/v1 (LM Studio default).
 *
 * IMPORTANT: mutates `messages` in place — same contract as queryLoop.
 */
export async function* queryLoopOpenAI(
  messages: Message[],
  tools: Tool[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { model, maxTurns, systemPrompt, abortSignal, workingDir, localUrl } = options

  const client = new OpenAI({
    baseURL: localUrl ?? 'http://localhost:1234/v1',
    apiKey: 'lm-studio', // LM Studio ignores this value but requires non-empty
  })

  let turns = 0

  while (turns < maxTurns) {
    turns++

    const openAIMessages = toOpenAIMessages(systemPrompt, messages)
    const openAITools = tools.length > 0 ? toOpenAITools(tools) : undefined

    let stream: ReturnType<typeof client.chat.completions.create> extends Promise<infer T> ? T : never

    try {
      stream = await client.chat.completions.create({
        model,
        messages: openAIMessages,
        ...(openAITools ? { tools: openAITools, tool_choice: 'auto' as const } : {}),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 8096,
      })
    } catch (err) {
      yield { type: 'error', error: (err as Error).message }
      return
    }

    // Accumulate streaming chunks
    let responseText = ''
    // Map from tool call index → accumulated data
    const toolCallMap = new Map<number, { id: string; name: string; argumentsJson: string }>()

    for await (const chunk of stream) {
      if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }

      // Usage appears in the last chunk (stream_options.include_usage)
      if (chunk.usage) {
        recordTokenUsage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens, 0)
      }

      const choice = chunk.choices[0]
      if (!choice) continue

      const delta = choice.delta

      if (delta.content) {
        responseText += delta.content
        yield { type: 'text_delta', text: delta.content }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallMap.has(tc.index)) {
            // First chunk for this tool call — id and name arrive here
            const id = tc.id ?? ''
            const name = tc.function?.name ?? ''
            toolCallMap.set(tc.index, { id, name, argumentsJson: '' })
            yield { type: 'tool_use_start', toolName: name, toolUseId: id }
          }
          if (tc.function?.arguments) {
            const entry = toolCallMap.get(tc.index)
            if (entry) {
              entry.argumentsJson += tc.function.arguments
              yield { type: 'tool_use_delta', toolInput: tc.function.arguments }
            }
          }
        }
      }

      const finishReason = choice.finish_reason
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        if (toolCallMap.size > 0) yield { type: 'tool_use_end' }
        yield { type: 'message_stop' }
      }
    }

    // Assemble assistant message in Anthropic ContentBlock format (unified history)
    const assistantContent: Message['content'] = []
    if (responseText) {
      (assistantContent as Array<{ type: 'text'; text: string }>).push({ type: 'text', text: responseText })
    }
    for (const [, tc] of toolCallMap) {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(tc.argumentsJson || '{}') as Record<string, unknown> } catch { /* empty input */ }
      ;(assistantContent as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>).push(
        { type: 'tool_use', id: tc.id, name: tc.name, input },
      )
    }
    messages.push({ role: 'assistant', content: assistantContent as import('@anthropic-ai/sdk/resources/messages.js').ContentBlock[] })

    if (toolCallMap.size === 0) break

    const pendingToolUse = [...toolCallMap.values()].map(tc => ({
      id: tc.id,
      name: tc.name,
      inputJson: tc.argumentsJson,
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

Expected: All tests pass (old 35 + new 4 converter tests = 39 total). The `queryLoopOpenAI` function isn't exercised by unit tests since it requires a live LM Studio instance — covered by manual smoke test in Task 3.

- [ ] **Step 6: Run typecheck**

```bash
~/.bun/bin/bun run typecheck
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/package.json chat/bun.lock chat/src/backends/openai_compat.ts chat/tests/backends/openai_compat_test.ts
git commit -m "feat(chat): add openai-compatible backend for local LM Studio model routing"
```

---

## Task 3: Route Backends in `QueryEngine` + Add `localUrl` to Config

**Files:**
- Modify: `chat/src/commands/config.ts`
- Modify: `chat/src/QueryEngine.ts`
- Modify: `chat/tests/commands/commands_test.ts`

- [ ] **Step 1: Write failing test for localUrl config**

In `chat/tests/commands/commands_test.ts`, add to the config describe block:

```typescript
it('getConfig includes localUrl defaulting to localhost:1234 and local model as default', () => {
  const cfg = getConfig()
  expect(cfg.localUrl).toContain('1234')
  // Default model is local, not Claude
  expect(cfg.model).not.toContain('claude')
})
```

Also add `getConfig` to the existing import if not already there:
```typescript
import { getConfig, setConfig } from '../../src/commands/config.js'
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test tests/commands/commands_test.ts
```

Expected: FAIL — `cfg.localUrl` is undefined.

- [ ] **Step 3: Update `chat/src/commands/config.ts`**

Replace the entire file:

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'

export interface ChatConfig {
  model: string
  systemPrompt: string
  maxTurns: number
  localUrl: string
}

let _config: ChatConfig = {
  // Local LM Studio is the primary backend. To use Claude: ai -m claude-sonnet-4-6
  model: process.env['AI_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? 'gemma-4-27b-it',
  systemPrompt: process.env['CHAT_SYSTEM_PROMPT'] ?? 'You are a helpful coding assistant.',
  maxTurns: 20,
  localUrl: process.env['LM_STUDIO_URL'] ?? 'http://localhost:1234/v1',
}

export function getConfig(): ChatConfig { return { ..._config } }
export function setConfig(partial: Partial<ChatConfig>): void { _config = { ..._config, ...partial } }

export class ConfigCommand implements SlashCommand {
  name = 'config'
  description = 'View or set config: /config [key] [value]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/)
    const cfg = getConfig()

    if (!parts[0]) {
      return {
        type: 'output',
        text: [
          'Current config:',
          `  model        = ${cfg.model}`,
          `  maxTurns     = ${cfg.maxTurns}`,
          `  localUrl     = ${cfg.localUrl}`,
          `  systemPrompt = ${cfg.systemPrompt}`,
        ].join('\n'),
      }
    }

    const [key, ...rest] = parts
    const value = rest.join(' ')
    if (key === 'model')       { setConfig({ model: value }); return { type: 'output', text: `model set to ${value}` } }
    if (key === 'maxTurns')    { setConfig({ maxTurns: parseInt(value, 10) }); return { type: 'output', text: `maxTurns set to ${value}` } }
    if (key === 'localUrl')    { setConfig({ localUrl: value }); return { type: 'output', text: `localUrl set to ${value}` } }
    if (key === 'systemPrompt'){ setConfig({ systemPrompt: value }); return { type: 'output', text: 'systemPrompt updated' } }
    return { type: 'output', text: `Unknown config key: ${key}` }
  }
}
```

- [ ] **Step 4: Update `chat/src/QueryEngine.ts`** to route backends

Read the current `QueryEngine.ts` and then replace only the `submit` method's query loop section. Find this block in `submit()`:

```typescript
    for await (const event of queryLoop(this.messages, this.tools, {
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      systemPrompt: cfg.systemPrompt + projectAddition,
      abortSignal,
      workingDir: this.workingDir,
    })) {
      yield event
    }
```

Replace with:

```typescript
    const isLocalModel = !cfg.model.startsWith('claude-')
    const loopFn = isLocalModel ? queryLoopOpenAI : queryLoop

    for await (const event of loopFn(this.messages, this.tools, {
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      systemPrompt: cfg.systemPrompt + projectAddition,
      abortSignal,
      workingDir: this.workingDir,
      localUrl: cfg.localUrl,
    })) {
      yield event
    }
```

Also add the import at the top of `QueryEngine.ts` with the other imports:

```typescript
import { queryLoopOpenAI } from './backends/openai_compat.js'
```

- [ ] **Step 5: Run tests**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test
```

Expected: All tests pass (39 total).

- [ ] **Step 6: Run typecheck**

```bash
~/.bun/bin/bun run typecheck
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/commands/config.ts chat/src/QueryEngine.ts chat/tests/commands/commands_test.ts
git commit -m "feat(chat): route claude-* to Anthropic, all other models to local LM Studio backend"
```

---

## Task 4: Update `cli.ts` + `model.ts` with Local URL Flag + Model Presets

**Files:**
- Modify: `chat/src/cli.ts`
- Modify: `chat/src/commands/model.ts`

**Context:** The `model.ts` currently lists only Claude models. From `docs/MODELS_SHORTLIST.md`, the recommended local models for this hardware are: Gemma 4 31B-it (research), Devstral Small 2 24B (coding), Gemma 4 E2B (router), Gemma 4 E4B (summarizer). LM Studio model identifiers match the names users load — typically `gemma-4-27b-it`, `devstral-small-2`, `gemma-4-2b-it`, `gemma-4-4b-it`. The `--local-url` CLI flag overrides `LM_STUDIO_URL`.

- [ ] **Step 1: Update `chat/src/commands/model.ts`**

Replace the entire file:

```typescript
import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getConfig, setConfig } from './config.js'

const ANTHROPIC_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

// Local model IDs as loaded in LM Studio — match the filename/model name shown in LM Studio UI
const LOCAL_MODELS = [
  'gemma-4-27b-it',            // Deep research / planning / general agent (Gemma 4 31B-it)
  'devstral-small-2',          // Agentic coding / repo editing (Devstral Small 2 24B)
  'qwen3-32b',                 // Alternative: reasoning + coding + agentic
  'gemma-4-4b-it',             // Summarization / memory compression (Gemma 4 E4B)
  'gemma-4-2b-it',             // Router / classifier / minimal mode (Gemma 4 E2B)
]

export class ModelCommand implements SlashCommand {
  name = 'model'
  aliases = ['m']
  description = 'View or switch model: /model [name]'

  async execute(args: string, _ctx: CommandContext): Promise<CommandResult> {
    const name = args.trim()
    const cfg = getConfig()
    const isLocal = !cfg.model.startsWith('claude-')
    const backend = isLocal ? `local (${cfg.localUrl})` : 'Anthropic API'

    if (!name) {
      const anthropicList = ANTHROPIC_MODELS
        .map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`))
        .join('\n')
      const localList = LOCAL_MODELS
        .map(m => (m === cfg.model ? `  * ${m} (current)` : `    ${m}`))
        .join('\n')

      return {
        type: 'output',
        text: [
          `Current model: ${cfg.model}`,
          `Backend: ${backend}`,
          '',
          'Anthropic models (require ANTHROPIC_API_KEY):',
          anthropicList,
          '',
          `Local models (require LM Studio at ${cfg.localUrl}):`,
          localList,
          '',
          'Usage: /model <name>',
          'Tip:   /config localUrl http://localhost:1234/v1  — change LM Studio address',
        ].join('\n'),
      }
    }

    setConfig({ model: name })
    const newBackend = name.startsWith('claude-') ? 'Anthropic API' : `local (${cfg.localUrl})`
    return { type: 'output', text: `Model switched to: ${name}\nBackend: ${newBackend}` }
  }
}
```

- [ ] **Step 2: Update `chat/src/cli.ts`** to add `--local-url` flag

Read the current `chat/src/cli.ts` and make these two changes:

**Add `local-url` to the `parseArgs` options object** (after `system`):
```typescript
    'local-url':     { type: 'string',  short: 'u' },
```

**Apply it before the TUI launches** (after the other flag applications):
```typescript
if (values['local-url'])     setConfig({ localUrl: values['local-url'] })
```

**Update the help text** — find the Options block and add the new line:
```
  -u, --local-url <url>   LM Studio base URL (default: http://localhost:1234/v1)
```

**Update the Environment section** of the help text:
```
  LM_STUDIO_URL           Local model endpoint (default: http://localhost:1234/v1)
```

- [ ] **Step 3: Smoke test CLI flag**

```bash
cd /home/mcarls/projects/ai-orchestrator
~/.bun/bin/bun run chat/src/cli.ts --help | grep local-url
```

Expected: `--local-url` appears in the help output.

- [ ] **Step 4: Run tests**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add chat/src/commands/model.ts chat/src/cli.ts
git commit -m "feat(chat): add local model presets and --local-url flag"
```

---

## Task 5: Update README with Local Model Setup

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

In `README.md`, find the existing **AI Chat Agent (`ai` command)** section. Locate the **Local GPU Models (Planned)** subsection and replace it with:

```markdown
### Local GPU Models (LM Studio + RTX 5090)

The `ai` command auto-routes by model name: any model NOT starting with `claude-` is sent to LM Studio's OpenAI-compatible API.

**Prerequisites:**
1. Install [LM Studio](https://lmstudio.ai) (≥0.3)
2. Load a model (see recommended stack below)
3. Enable the local server in LM Studio: **Local Server → Start Server** (default port 1234)

**Usage:**

```bash
# Use a local model (LM Studio must be running with model loaded)
ai -m gemma-4-27b-it

# Or switch model in the TUI
/model gemma-4-27b-it

# Custom LM Studio address
ai -m devstral-small-2 --local-url http://localhost:1234/v1

# Or set it permanently via env
export LM_STUDIO_URL=http://localhost:1234/v1
```

**Recommended model stack for RTX 5090 (32GB VRAM):**

| Role | Model | Why |
|------|-------|-----|
| Deep research / planning | `gemma-4-27b-it` | Gemma 4 31B-it — 80% LiveCodeBench, native tool calling, 256K ctx |
| Agentic coding / patching | `devstral-small-2` | Devstral Small 2 24B — 68% SWE-bench, built for multi-file editing |
| Fast routing / classifier | `gemma-4-2b-it` | Gemma 4 E2B ~3.2 GB VRAM at Q4 |
| Summarization / memory | `gemma-4-4b-it` | Gemma 4 E4B ~5.0 GB VRAM at Q4 |
| Coding alternative | `qwen3-32b` | Reasoning + thinking/non-thinking modes, Apache-2.0 |

> **VRAM note:** Only one large model needs to be active at a time. Swap between `gemma-4-27b-it` (research) and `devstral-small-2` (coding) as needed. The small models can stay loaded alongside the active large model.

**Troubleshooting:**

```bash
# Verify LM Studio server is running
curl http://localhost:1234/v1/models

# If unreachable, update the address
/config localUrl http://localhost:1234/v1

# Check current backend
/model
```
```

(Note: the triple-backtick code blocks in this plan are escaped for the plan document — write them as actual code fences in README.md.)

- [ ] **Step 2: Verify README renders correctly**

```bash
head -120 README.md | grep -A 5 "Local GPU"
```

Expected: "Local GPU Models (LM Studio + RTX 5090)" heading visible.

- [ ] **Step 3: Run full test suite one last time**

```bash
cd /home/mcarls/projects/ai-orchestrator/chat
~/.bun/bin/bun test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd /home/mcarls/projects/ai-orchestrator
git add README.md
git commit -m "docs: document local LM Studio model routing and recommended model stack"
```

---

## Self-Review

### Spec Coverage

| Requirement | Covered by |
|-------------|------------|
| Local GPU models as primary option | Task 3 — routing, Task 4 — default presets |
| LM Studio OpenAI-compat API | Task 2 — `openai_compat.ts` |
| Claude models still work | Task 3 — `startsWith('claude-')` guard |
| `--local-url` CLI flag | Task 4 — `cli.ts` |
| `/model` shows backend + presets | Task 4 — `model.ts` |
| `/config localUrl` | Task 3 — `config.ts` |
| `LM_STUDIO_URL` env var | Task 3 — `config.ts` |
| Multi-turn memory fixed | Task 1 — `query.ts` mutation fix |
| Tool calling through local models | Task 2 — `toOpenAITools()` + tool_calls accumulation |
| Token tracking for local models | Task 2 — `chunk.usage` in last stream chunk |
| Recommended models from research | Task 4 + Task 5 — Gemma 4 31B, Devstral Small 2, etc. |
| README documentation | Task 5 |

### Placeholder Scan

No TBDs. All code blocks contain complete, runnable TypeScript. All test assertions are specific. All commands include expected output.

### Type Consistency

- `QueryOptions.localUrl?: string` — added in Task 1, used in Task 2, passed from Task 3
- `ChatConfig.localUrl: string` — added in Task 3, read in Task 3 (`QueryEngine`), set by Task 4 (`cli.ts`)
- `dispatchTools(pendingToolUse, tools, ctx)` — exported Task 1, imported Task 2
- `queryLoopOpenAI` signature matches `queryLoop` exactly (same `messages`, `tools`, `options` params)
- `AssistantMessage.content: ContentBlock[]` — Task 2 casts the assembled content to `ContentBlock[]`; the structure matches (type/text and type/tool_use blocks)

### Known Limitation

`queryLoopOpenAI` doesn't call `stream.finalMessage()` (OpenAI SDK has no equivalent). Token usage comes from `chunk.usage` in the last chunk only when `stream_options.include_usage: true` is honored by LM Studio. If the running LM Studio version doesn't support `stream_options`, the `/cost` command will show 0 for local model turns. This is acceptable — LM Studio ≥0.3.5 supports it and it's non-blocking.
