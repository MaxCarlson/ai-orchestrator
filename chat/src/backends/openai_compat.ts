import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionToolMessageParam } from 'openai/resources/chat/completions.js'
import { recordTokenUsage } from '../session/tokenTracker.js'
import { dispatchTools } from '../query.js'
import type { Message, StreamEvent } from '../types/message.js'
import type { Tool } from '../types/tool.js'
import type { QueryOptions } from '../query.js'
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages.js'
// Logger is accessed via options.logger (typed through QueryOptions)

// ── Message conversion ────────────────────────────────────────────────────────

export function toOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  result.push({ role: 'system', content: systemPrompt })

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

export function toOpenAITools(tools: Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map(t => {
    const def = t.definition()
    return {
      type: 'function' as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: def.input_schema as unknown as Record<string, unknown>,
      },
    }
  })
}

// ── Query loop ────────────────────────────────────────────────────────────────

export async function* queryLoopOpenAI(
  messages: Message[],
  tools: Tool[],
  options: QueryOptions,
): AsyncGenerator<StreamEvent> {
  const { model, maxTurns, systemPrompt, abortSignal, workingDir, localUrl, logger } = options

  const client = new OpenAI({
    baseURL: localUrl ?? 'http://localhost:1234/v1',
    apiKey: process.env['OPENAI_API_KEY'] ?? 'lm-studio',
  })

  let turns = 0

  while (turns < maxTurns) {
    turns++

    const openAIMessages = toOpenAIMessages(systemPrompt, messages)
    const openAITools = tools.length > 0 ? toOpenAITools(tools) : undefined

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>

    // qwen3 and similar models may emit <think>…</think> blocks before the response.
    // We do NOT force enable_thinking via chat_template_kwargs — letting it decide naturally
    // avoids the model putting its entire response inside the thinking block.
    const isQwen3 = /qwen3/i.test(model)

    try {
      stream = await client.chat.completions.create({
        model,
        messages: openAIMessages,
        ...(openAITools ? { tools: openAITools, tool_choice: 'auto' as const } : {}),
        stream: true as const,
        stream_options: { include_usage: true },
        max_tokens: isQwen3 ? 32768 : 8096,
      })
    } catch (err) {
      yield { type: 'error', error: (err as Error).message }
      return
    }

    let responseText = ''
    const toolCallMap = new Map<number, { id: string; name: string; argumentsJson: string }>()
    let lastUsage: { prompt_tokens: number; completion_tokens: number } | null = null

    // Track whether we're inside a <think>...</think> block (qwen3 thinking tokens)
    let inThinkBlock = false
    let thinkBuffer = ''
    // If the model puts everything inside <think> (enabled-thinking models),
    // fall back to showing the thinking content as the response.
    let thinkingContent = ''

    for await (const chunk of stream) {
      if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }

      if (chunk.usage) {
        lastUsage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens }
      }

      const choice = chunk.choices[0]
      if (!choice) continue

      const delta = choice.delta

      if (delta.content) {
        let text = delta.content

        // Handle <think> block start (may arrive split across chunks)
        if (!inThinkBlock && (thinkBuffer + text).includes('<think>')) {
          const combined = thinkBuffer + text
          const start = combined.indexOf('<think>')
          if (start >= 0) {
            const before = combined.slice(0, start)
            if (before) { responseText += before; yield { type: 'text_delta', text: before } }
            inThinkBlock = true
            thinkBuffer = combined.slice(start)
            yield { type: 'thinking_start' }
            logger?.onThinkingStart()
            text = ''
          }
        } else if (!inThinkBlock) {
          thinkBuffer += text
          // Keep thinkBuffer small — only need enough to detect '<think>' boundary
          if (thinkBuffer.length > 20) {
            const flush = thinkBuffer.slice(0, thinkBuffer.length - 7)
            responseText += flush
            yield { type: 'text_delta', text: flush }
            thinkBuffer = thinkBuffer.slice(-7)
          }
          text = ''
        }

        if (inThinkBlock && text) {
          thinkBuffer += text
          thinkingContent += text
          yield { type: 'thinking_delta', text }
          logger?.onThinkingDelta(text)
        }

        // Check if think block ends in our buffer
        if (inThinkBlock) {
          const endIdx = thinkBuffer.indexOf('</think>')
          if (endIdx >= 0) {
            inThinkBlock = false
            yield { type: 'thinking_end' }
            logger?.onThinkingEnd()
            const after = thinkBuffer.slice(endIdx + 8)
            thinkBuffer = ''
            if (after) { responseText += after; yield { type: 'text_delta', text: after } }
          }
        }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallMap.has(tc.index)) {
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
    }

    // Flush any remaining thinkBuffer that didn't contain a <think> tag
    if (thinkBuffer && !inThinkBlock) {
      responseText += thinkBuffer
      yield { type: 'text_delta', text: thinkBuffer }
      thinkBuffer = ''
    }
    if (inThinkBlock) {
      // Unclosed think block — close it
      yield { type: 'thinking_end' }
      logger?.onThinkingEnd()
    }

    // Fallback: if model put everything in <think> (enabled-thinking mode),
    // yield the thinking content as the actual response so the user sees something.
    if (!responseText.trim() && thinkingContent.trim()) {
      const fallback = thinkingContent.replace(/<\/?think>/gi, '').trim()
      if (fallback) {
        responseText = fallback
        yield { type: 'text_delta', text: fallback }
      }
    }

    if (lastUsage) {
      recordTokenUsage(lastUsage.prompt_tokens, lastUsage.completion_tokens, 0)
    }

    for (const [,] of toolCallMap) {
      yield { type: 'tool_use_end' }
    }
    yield { type: 'message_stop' }

    // Log assistant response text
    if (responseText) logger?.assistantMessage(responseText)

    // Assemble assistant message in unified ContentBlock format
    const assistantContent: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> = []
    if (responseText) {
      assistantContent.push({ type: 'text', text: responseText })
    }
    for (const [, tc] of toolCallMap) {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(tc.argumentsJson || '{}') as Record<string, unknown> } catch { /* empty */ }
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
    }
    messages.push({ role: 'assistant', content: assistantContent as unknown as ContentBlock[] })

    if (toolCallMap.size === 0) break

    const pendingToolUse = [...toolCallMap.values()].map(tc => ({
      id: tc.id,
      name: tc.name,
      inputJson: tc.argumentsJson,
    }))

    // Log tool calls (full input accumulated) then dispatch
    for (const tc of pendingToolUse) {
      logger?.toolCall(tc.id, tc.name, tc.inputJson)
    }

    const toolResults = await dispatchTools(pendingToolUse, tools, { abortSignal, workingDir })

    // Log results and yield tool_result events for UI debug overlay
    for (const result of toolResults) {
      const toolName = pendingToolUse.find(t => t.id === result.tool_use_id)?.name ?? ''
      const inputJson = pendingToolUse.find(t => t.id === result.tool_use_id)?.inputJson ?? ''
      logger?.toolResult(result.tool_use_id, toolName, result.content, result.is_error ?? false)
      yield {
        type: 'tool_result',
        toolUseId: result.tool_use_id,
        toolName,
        toolInput: inputJson,
        result: result.content,
        isError: result.is_error ?? false,
      }
    }

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
