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
  assistant: 'Assistant',
  system: 'System',
  command: 'Output',
}

interface MessageListProps {
  messages: ChatMessage[]
  maxHeight?: number
}

export function MessageList({ messages, maxHeight = 20 }: MessageListProps) {
  // Each message takes at least 2 lines (label + content). Show only as many
  // recent messages as fit in the available height to prevent Ink overflow.
  const visible: ChatMessage[] = []
  let lines = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) break
    const msgLines = 2 + Math.ceil(msg.content.length / 60)
    if (lines + msgLines > maxHeight) break
    visible.unshift(msg)
    lines += msgLines
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
      {visible.map((msg, i) => (
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
