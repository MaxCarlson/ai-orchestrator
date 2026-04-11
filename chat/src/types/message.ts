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

export function toApiMessage(msg: Message): MessageParam {
  if (msg.role === 'user' && typeof (msg as UserMessage).content === 'string') {
    return { role: 'user', content: (msg as UserMessage).content }
  }
  return msg as MessageParam
}

export interface StreamEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_end' | 'tool_result' | 'message_stop' | 'error' | 'thinking_start' | 'thinking_delta' | 'thinking_end'
  text?: string
  toolName?: string
  toolUseId?: string
  toolInput?: string   // partial JSON for tool_use_delta; full JSON for tool_result
  result?: string      // tool result content (tool_result events)
  isError?: boolean    // true if tool errored (tool_result events)
  error?: string
}
