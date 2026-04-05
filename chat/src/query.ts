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
  thinkingEnabled?: boolean
}

export interface PendingToolCall {
  id: string
  name: string
  inputJson: string
}

const client = new Anthropic()

/**
 * Dispatches a list of pending tool calls, running concurrency-safe tools
 * in parallel and unsafe tools serially. Shared by all query backends.
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
  const { model, maxTurns, systemPrompt, abortSignal, workingDir, thinkingEnabled } = options
  let turns = 0

  while (turns < maxTurns) {
    turns++

    const toolDefs = tools.map(t => t.definition() as unknown as AnthropicTool)
    const apiMessages = messages.map(toApiMessage)

    let stream: Awaited<ReturnType<typeof client.messages.stream>>
    try {
      stream = client.messages.stream({
        model,
        max_tokens: thinkingEnabled ? 16000 : 8096,
        system: systemPrompt,
        messages: apiMessages,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        ...(thinkingEnabled ? { thinking: { type: 'enabled' as const, budget_tokens: 8000 } } : {}),
      } as Parameters<typeof client.messages.stream>[0])
    } catch (err) {
      yield { type: 'error', error: (err as Error).message }
      return
    }

    const pendingToolUse: PendingToolCall[] = []
    let currentBlockType: string = ''

    for await (const event of stream) {
      if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }

      if (event.type === 'content_block_start') {
        currentBlockType = event.content_block.type
        if (event.content_block.type === 'tool_use') {
          pendingToolUse.push({ id: event.content_block.id, name: event.content_block.name, inputJson: '' })
          yield { type: 'tool_use_start', toolName: event.content_block.name, toolUseId: event.content_block.id }
        } else if (event.content_block.type === 'thinking') {
          yield { type: 'thinking_start' }
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          const last = pendingToolUse.at(-1)
          if (last) last.inputJson += event.delta.partial_json
          yield { type: 'tool_use_delta', toolInput: event.delta.partial_json }
        }
        if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking_delta', text: event.delta.thinking }
        }
      } else if (event.type === 'content_block_stop') {
        if (currentBlockType === 'tool_use') yield { type: 'tool_use_end' }
        if (currentBlockType === 'thinking') yield { type: 'thinking_end' }
        currentBlockType = ''
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
