import React from 'react'
import { Box, Text, useStdout } from 'ink'

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
  scrollOffset: number   // 0 = pinned to bottom; positive = lines scrolled up
  viewportHeight: number
}

/** Estimate rendered line count for a message given terminal width. */
function estimateLines(msg: ChatMessage, width: number): number {
  const contentWidth = Math.max(width - 4, 20)
  const contentLines = msg.content.split('\n').reduce((acc, line) => {
    return acc + Math.max(1, Math.ceil(line.length / contentWidth))
  }, 0)
  return 1 + contentLines + 1  // role label + content + margin
}

export function MessageList({ messages, scrollOffset, viewportHeight }: MessageListProps) {
  const { stdout } = useStdout()
  const width = stdout.columns ?? 80

  // Build line-count array from bottom up, selecting messages that fit
  const lineCounts = messages.map(m => estimateLines(m, width))
  const totalLines = lineCounts.reduce((a, b) => a + b, 0)

  // scrollOffset is in lines from bottom. 0 = stick to bottom.
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, totalLines - viewportHeight)))

  // Find which messages to render given the viewport window
  // Window: [totalLines - viewportHeight - clampedOffset, totalLines - clampedOffset]
  const windowBottom = totalLines - clampedOffset
  const windowTop    = windowBottom - viewportHeight

  let linesCounted = 0
  const visible: ChatMessage[] = []
  let hasAbove = false

  for (let i = 0; i < messages.length; i++) {
    const msgTop = linesCounted
    const msgBottom = linesCounted + lineCounts[i]!
    linesCounted = msgBottom

    if (msgBottom <= windowTop) { hasAbove = true; continue }
    if (msgTop >= windowBottom) break
    visible.push(messages[i]!)
  }

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {hasAbove && (
        <Box paddingX={2}>
          <Text color="gray" dimColor>↑ scroll up for more  (PgUp / ↑)</Text>
        </Box>
      )}
      {clampedOffset > 0 && !hasAbove && (
        <Box paddingX={2}>
          <Text color="gray" dimColor>↑ beginning of conversation</Text>
        </Box>
      )}
      {visible.map((msg, i) => {
        const isSystem = msg.role === 'system'
        const isCommand = msg.role === 'command'
        return (
          <Box key={i} flexDirection="column" marginBottom={1} paddingX={1}>
            {!isSystem && (
              <Text color={ROLE_COLOR[msg.role]} bold={!isSystem}>
                {ROLE_LABEL[msg.role]}
              </Text>
            )}
            <Text
              {...(isSystem ? { color: 'gray' as const } : {})}
              dimColor={isSystem}
              wrap="wrap"
            >
              {isSystem ? `  ${msg.content}` : msg.content}
            </Text>
            {isCommand && (
              <Box marginTop={0}>
                <Text color="gray" dimColor>{'─'.repeat(Math.min(40, width - 4))}</Text>
              </Box>
            )}
          </Box>
        )
      })}
      {clampedOffset > 0 && (
        <Box paddingX={2}>
          <Text color="gray" dimColor>↓ PgDn / ↓ to scroll down</Text>
        </Box>
      )}
    </Box>
  )
}
