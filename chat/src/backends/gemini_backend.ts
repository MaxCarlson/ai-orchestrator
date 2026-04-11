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

    // ToolResultMessages (role: 'user', content: ToolResultBlock[]) are skipped —
    // they are spliced into the current-turn function_response parts below.
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
      parameters: def.input_schema as unknown as import('@google/generative-ai').FunctionDeclarationSchema,
    }
  })
}

// ── Extract pending tool results from message list ────────────────────────────

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
          name: block.tool_use_id,
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
    ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
    ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
  })

  let turns = 0

  while (turns < maxTurns) {
    turns++

    const allButLast = messages.slice(0, -1)
    const last = messages.at(-1)
    if (!last) break

    const history = toGeminiHistory(allButLast)

    let currentParts: Part[]
    if (last.role === 'user' && typeof last.content === 'string') {
      currentParts = [{ text: last.content }]
    } else if (last.role === 'user' && Array.isArray(last.content)) {
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

    try {
      const finalResponse = await streamResult.response
      const usage = finalResponse.usageMetadata
      if (usage) {
        recordTokenUsage(usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0, 0)
      }
    } catch { /* usage not always available */ }

    yield { type: 'message_stop' }

    const assistantContent: Message['content'] = []
    if (responseText) {
      (assistantContent as Array<{ type: 'text'; text: string }>).push({ type: 'text', text: responseText })
    }
    for (const [i, tc] of pendingToolCalls.entries()) {
      const id = `gemini_tc_${i}`;
      (assistantContent as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>).push(
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

    for (const r of toolResults) {
      yield {
        type: 'tool_result',
        toolName: r.tool_use_id,
        toolInput: pendingToolUse.find(t => t.id === r.tool_use_id)?.inputJson ?? '',
        result: r.content,
        isError: r.is_error,
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
