import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionToolMessageParam } from 'openai/resources/chat/completions.js'
import { recordTokenUsage } from '../session/tokenTracker.js'
import { dispatchTools } from '../query.js'
import type { Message, StreamEvent } from '../types/message.js'
import type { Tool } from '../types/tool.js'
import type { QueryOptions } from '../query.js'
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages.js'

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
  const { model, maxTurns, systemPrompt, abortSignal, workingDir, localUrl } = options

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

    let responseText = ''
    const toolCallMap = new Map<number, { id: string; name: string; argumentsJson: string }>()

    for await (const chunk of stream) {
      if (abortSignal.aborted) { yield { type: 'error', error: 'Aborted' }; return }

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

    // Assemble assistant message in unified ContentBlock format
    const assistantContent: ContentBlock[] = []
    if (responseText) {
      assistantContent.push({ type: 'text', text: responseText } as unknown as ContentBlock)
    }
    for (const [, tc] of toolCallMap) {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(tc.argumentsJson || '{}') as Record<string, unknown> } catch { /* empty */ }
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
    }
    messages.push({ role: 'assistant', content: assistantContent })

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
