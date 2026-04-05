import React from 'react'
import { Box, Text } from 'ink'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'command'
  content: string
  timestamp: number
  thinking?: string           // model reasoning, toggled via Ctrl+O
  thinkingExpanded?: boolean
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
  topIndex: number        // first message to show; -1 = auto (tail)
  viewportHeight: number  // used only for message selection, NOT for Box height
  termWidth: number
}

/** Conservative line estimate for message selection. */
function estimateLines(msg: ChatMessage, width: number): number {
  const w = Math.max(width - 4, 20)
  const bodyLines = msg.content.split('\n').reduce(
    (sum, line) => sum + Math.max(1, Math.ceil((line.length || 1) / w)),
    0,
  )
  const labelLine = msg.role === 'system' ? 0 : 1
  return labelLine + bodyLines + 1  // +1 for marginBottom gap
}

export function computeAutoTopIndex(
  messages: ChatMessage[],
  viewportHeight: number,
  width: number,
): number {
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
  const hasAbove = clampedTop > 0

  // Select which messages to show: walk forward from clampedTop until
  // we exceed viewportHeight. Always include at least one message.
  let remaining = viewportHeight - (hasAbove ? 1 : 0)
  const displayMessages: ChatMessage[] = []

  for (let i = clampedTop; i < messages.length; i++) {
    const est = estimateLines(messages[i]!, termWidth)
    const isLast = i === messages.length - 1
    if (remaining >= est || isLast || displayMessages.length === 0) {
      displayMessages.push(messages[i]!)
      remaining -= est
    } else {
      break
    }
  }

  return (
    // flexGrow={1} tells Ink's flex engine to give this box all remaining
    // vertical space after header, input, tools, etc. are laid out.
    // overflow="hidden" clips any over-estimation, but content is never
    // pushed off the bottom because we selected the right slice above.
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {hasAbove && (
        <Box paddingX={2}>
          <Text color="gray" dimColor>
            {'↑  '}
            {clampedTop}
            {' earlier message'}
            {clampedTop !== 1 ? 's' : ''}
            {' — PgUp to scroll'}
          </Text>
        </Box>
      )}

      {displayMessages.map((msg, i) => {
        const isSystem = msg.role === 'system'
        return (
          <Box key={`${clampedTop}:${i}`} flexDirection="column" marginBottom={1} paddingX={1}>
            {/* Label row (for non-system messages) */}
            {!isSystem && (
              <Text color={ROLE_COLOR[msg.role]} bold>
                {ROLE_LABEL[msg.role]}
                {msg.thinking
                  ? (msg.thinkingExpanded ? '  [thinking ↕Ctrl+O]' : '  [thinking — Ctrl+O]')
                  : ''}
              </Text>
            )}

            {/* Expanded thinking block */}
            {msg.thinking && msg.thinkingExpanded && (
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor="gray"
                paddingX={1}
                marginY={1}
              >
                <Text color="gray" dimColor bold>{'⟳ thinking'}</Text>
                <Text color="gray" dimColor wrap="wrap">{msg.thinking}</Text>
              </Box>
            )}

            {/* Message content */}
            <Text color={isSystem ? 'gray' : 'white'} dimColor={isSystem} wrap="wrap">
              {isSystem ? `  ${msg.content}` : msg.content}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
