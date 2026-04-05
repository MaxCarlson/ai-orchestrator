import React from 'react'
import { Box, Text } from 'ink'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'command'
  content: string
  timestamp: number
}

const ROLE_COLOR: Record<ChatMessage['role'], string> = {
  user:      'green',
  assistant: 'cyan',
  system:    'gray',
  command:   'white',
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user:      'You',
  assistant: 'Assistant',
  system:    '·',
  command:   'Output',
}

interface MessageListProps {
  messages: ChatMessage[]
  topIndex: number        // index of first message to show; -1 means auto (show tail)
  viewportHeight: number
  termWidth: number
}

/** Rough line count for a message — used only for auto-scroll positioning. */
function estimateLines(msg: ChatMessage, width: number): number {
  const w = Math.max(width - 6, 20)
  const bodyLines = msg.content.split('\n').reduce(
    (sum, line) => sum + Math.max(1, Math.ceil((line.length || 1) / w)), 0,
  )
  return (msg.role === 'system' ? 0 : 1) + bodyLines + 1   // label? + body + gap
}

export function computeAutoTopIndex(messages: ChatMessage[], viewportHeight: number, width: number): number {
  // Walk from the end, accumulating estimated lines until we fill the viewport
  let lines = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const est = estimateLines(messages[i]!, width)
    if (lines + est > viewportHeight && i < messages.length - 1) return i + 1
    lines += est
  }
  return 0
}

export function MessageList({ messages, topIndex, viewportHeight, termWidth }: MessageListProps) {
  const autoTop = topIndex < 0
    ? computeAutoTopIndex(messages, viewportHeight, termWidth)
    : topIndex

  const clampedTop = Math.max(0, Math.min(autoTop, messages.length - 1))
  const visible = messages.slice(clampedTop)
  const hasAbove = clampedTop > 0

  return (
    <Box flexDirection="column" height={viewportHeight} overflow="hidden">
      {hasAbove && (
        <Box paddingX={2}>
          <Text color="gray" dimColor>↑  {clampedTop} earlier message{clampedTop !== 1 ? 's' : ''} — PgUp to scroll</Text>
        </Box>
      )}

      {visible.map((msg, i) => {
        const isSystem = msg.role === 'system'
        return (
          <Box key={clampedTop + i} flexDirection="column" marginBottom={1} paddingX={1}>
            {!isSystem && (
              <Text color={ROLE_COLOR[msg.role]} bold>{ROLE_LABEL[msg.role]}</Text>
            )}
            <Text
              {...(isSystem ? { color: 'gray' as const, dimColor: true } : {})}
              wrap="wrap"
            >
              {isSystem ? `  ${msg.content}` : msg.content}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
