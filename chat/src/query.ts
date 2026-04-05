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
}

const client = new Anthropic()

/**
 * Core agent loop. Streams model responses, dispatches tool calls, and
 * re-enters the loop with tool results until no more tool calls or maxTurns.
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

    const toolDefs = tools.map(t => t.definition() as unknown as AnthropicTool)
    const apiMessages = history.map(toApiMessage)

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

    const pendingToolUse: Array<{ id: string; name: string; inputJson: string }> = []
    let currentBlockIsToolUse = false

    for await (const event of stream) {
      if (abortSignal.aborted) {
        yield { type: 'error', error: 'Aborted' }
        return
      }

      if (event.type === 'content_block_start') {
        currentBlockIsToolUse = event.content_block.type === 'tool_use'
        if (event.content_block.type === 'tool_use') {
          pendingToolUse.push({
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          })
          yield {
            type: 'tool_use_start',
            toolName: event.content_block.name,
            toolUseId: event.content_block.id,
          }
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
        if (currentBlockIsToolUse) {
          yield { type: 'tool_use_end' }
        }
        currentBlockIsToolUse = false
      } else if (event.type === 'message_stop') {
        yield { type: 'message_stop' }
      }
    }

    // Collect the final message (all content blocks assembled)
    const finalMsg = await stream.finalMessage()
    recordTokenUsage(
      finalMsg.usage.input_tokens,
      finalMsg.usage.output_tokens,
      finalMsg.usage.cache_read_input_tokens ?? 0,
    )
    history.push({ role: 'assistant', content: finalMsg.content })

    if (pendingToolUse.length === 0) break  // No tool calls — done

    // Separate tools into concurrency-safe and unsafe
    const safeCalls = pendingToolUse.filter(call => {
      const tool = tools.find(x => x.definition().name === call.name)
      if (!tool) return false
      try {
        return tool.isConcurrencySafe(JSON.parse(call.inputJson || '{}'))
      } catch {
        return false
      }
    })
    const unsafeCalls = pendingToolUse.filter(call => !safeCalls.includes(call))

    const toolResults: ToolResult[] = []

    // Safe tools run in parallel
    const safeResults = await Promise.all(safeCalls.map(async call => {
      const tool = tools.find(x => x.definition().name === call.name)
      if (!tool) {
        return { tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true }
      }
      try {
        const input = JSON.parse(call.inputJson || '{}') as unknown
        const content = await tool.execute(input, { abortSignal, workingDir })
        return { tool_use_id: call.id, content, is_error: false }
      } catch (err) {
        return { tool_use_id: call.id, content: (err as Error).message, is_error: true }
      }
    }))
    toolResults.push(...safeResults)

    // Unsafe tools run serially
    for (const call of unsafeCalls) {
      const tool = tools.find(x => x.definition().name === call.name)
      if (!tool) {
        toolResults.push({ tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true })
        continue
      }
      try {
        const input = JSON.parse(call.inputJson || '{}') as unknown
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
        ...(r.is_error ? { is_error: true } : {}),
      })),
    })
  }
}
