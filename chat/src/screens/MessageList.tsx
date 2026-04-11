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
  /** Which message is at the top. -1 = auto (tail of last message). */
  topMsgIdx: number
  /** Source lines to skip at the top of topMsgIdx's message. Ignored when auto. */
  topLineOffset: number
  viewportHeight: number
  termWidth: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const WRAP_W = (termWidth: number) => Math.max(termWidth - 4, 20)

/** Estimated terminal lines for a message (used for message selection). */
function estimateLines(msg: ChatMessage, width: number): number {
  const w = WRAP_W(width)
  const bodyLines = msg.content.split('\n').reduce(
    (sum, line) => sum + Math.max(1, Math.ceil((line.length || 1) / w)),
    0,
  )
  const labelLine = msg.role === 'system' ? 0 : 1
  return labelLine + bodyLines + 1  // +1 for marginBottom gap
}

/** First message index so the display fills viewportHeight from the bottom. */
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

/**
 * Returns the number of source lines hidden ABOVE the visible tail when
 * fitting `maxTermLines` terminal lines of `content`.
 * Used by REPL scroll handlers to know where the tail starts.
 */
export function computeTailStartLine(
  content: string,
  maxTermLines: number,
  termWidth: number,
): number {
  const w = WRAP_W(termWidth)
  const srcLines = content.split('\n')
  let used = 0
  let start = srcLines.length
  while (start > 0) {
    const line = srcLines[start - 1] ?? ''
    const wrapCount = Math.max(1, Math.ceil((line.length || 1) / w))
    if (used + wrapCount > maxTermLines) break
    used += wrapCount
    start--
  }
  return start
}

/**
 * Returns the tail content (last N terminal lines worth of source lines) and
 * the number of source lines hidden above it.
 */
function computeTail(
  content: string,
  maxTermLines: number,
  termWidth: number,
): { visible: string; hiddenSrcLines: number } {
  const startSrc = computeTailStartLine(content, maxTermLines, termWidth)
  return {
    visible: content.split('\n').slice(startSrc).join('\n'),
    hiddenSrcLines: startSrc,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MessageList({
  messages,
  topMsgIdx,
  topLineOffset,
  viewportHeight,
  termWidth,
}: MessageListProps) {
  const isAuto = topMsgIdx < 0
  const autoTop = isAuto
    ? computeAutoTopIndex(messages, viewportHeight, termWidth)
    : topMsgIdx

  const clampedTop = Math.max(0, Math.min(autoTop, messages.length - 1))
  const hasAboveMsgs = clampedTop > 0

  // Walk forward from clampedTop, accumulate until viewport is full.
  let remaining = viewportHeight - (hasAboveMsgs ? 1 : 0)
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
    <Box flexDirection="column" flexGrow={1} overflow="hidden" minHeight={0}>
      {/* Earlier-messages scroll indicator */}
      {hasAboveMsgs && (
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

      {displayMessages.map((msg, idx) => {
        const isSystem      = msg.role === 'system'
        const isFirstMsg    = idx === 0
        const isLastActual  = (clampedTop + idx) === messages.length - 1

        let displayContent  = msg.content
        let hiddenLineCount = 0

        if (isFirstMsg && !isAuto && topLineOffset > 0 && !isSystem) {
          // Manual scroll with line offset: skip first N source lines.
          const srcLines = msg.content.split('\n')
          hiddenLineCount = Math.min(topLineOffset, srcLines.length - 1)
          displayContent  = srcLines.slice(hiddenLineCount).join('\n')
        } else if (isAuto && isLastActual && !isSystem && displayMessages.length === 1) {
          // Auto mode: show tail of the last message so the user always sees
          // the most recently generated content, not the beginning.
          //   reserve: hasAboveMsgs(1) + label(1) + marginBottom(1) + indicator(1)
          const availLines = viewportHeight - (hasAboveMsgs ? 1 : 0) - 1 - 1 - 1
          if (availLines > 2) {
            const tail = computeTail(msg.content, availLines, termWidth)
            if (tail.hiddenSrcLines > 0) {
              displayContent  = tail.visible
              hiddenLineCount = tail.hiddenSrcLines
            }
          }
        }

        return (
          <Box key={`${clampedTop}:${idx}`} flexDirection="column" marginBottom={1} paddingX={1}>
            {/* Role label */}
            {!isSystem && (
              <Text color={ROLE_COLOR[msg.role]} bold>
                {ROLE_LABEL[msg.role]}
                {msg.thinking
                  ? (msg.thinkingExpanded ? '  [thinking ↕Ctrl+O]' : '  [thinking — Ctrl+O]')
                  : ''}
              </Text>
            )}

            {/* Lines-above indicator (tail trim or manual line offset) */}
            {hiddenLineCount > 0 && (
              <Text color="gray" dimColor>
                {'  ↑ '}
                {hiddenLineCount}
                {' line'}
                {hiddenLineCount !== 1 ? 's' : ''}
                {' above — PgUp to scroll'}
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
              {isSystem ? `  ${displayContent}` : displayContent}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
