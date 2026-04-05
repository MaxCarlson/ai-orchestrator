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
  command: 'Output',
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
