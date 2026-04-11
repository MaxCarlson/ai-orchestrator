import React from 'react'
import { Box, Text } from 'ink'

export const SLASH_COMMANDS = [
  { name: '/help',       description: 'List all commands' },
  { name: '/clear',      description: 'Clear conversation history' },
  { name: '/model',      description: 'View or switch model' },
  { name: '/config',     description: 'View or set config' },
  { name: '/context',    description: 'Show session info and project' },
  { name: '/cost',       description: 'Show token usage and cost' },
  { name: '/compact',    description: 'Request conversation compaction' },
  { name: '/session',    description: 'Manage saved sessions' },
  { name: '/memory',     description: 'Show message count' },
  { name: '/project',    description: 'Toggle project context' },
  { name: '/embeddings', description: 'Toggle semantic context' },
  { name: '/tools',      description: 'List available tools' },
  { name: '/exit',       description: 'Exit the TUI' },
]

export const SUGGESTION_VISIBLE = 6

export interface SlashSuggestion {
  name: string
  description: string
}

interface InputBarProps {
  value: string
  suggestions: SlashSuggestion[]
  suggestionIndex: number   // index into suggestions[]
  disabled?: boolean
  hasThinking?: boolean     // show Ctrl+O hint when last message has thinking
  hasTools?: boolean        // show Ctrl+T hint when last request used tools
}

export function InputBar({ value, suggestions, suggestionIndex, disabled = false, hasThinking = false, hasTools = false }: InputBarProps) {
  // Compute scrolling window so selected item is always visible
  const count = Math.min(suggestions.length, SUGGESTION_VISIBLE)
  const windowStart = Math.min(
    Math.max(0, suggestionIndex - SUGGESTION_VISIBLE + 1),
    Math.max(0, suggestions.length - SUGGESTION_VISIBLE),
  )
  const visible = suggestions.slice(windowStart, windowStart + count)
  const nameColWidth = SLASH_COMMANDS.reduce((m, c) => Math.max(m, c.name.length), 0) + 2

  // Build hint parts dynamically so it stays concise
  const hintParts: string[] = ['/ commands', 'PgUp/↑↓ scroll']
  if (hasThinking) hintParts.push('Ctrl+O thinking')
  if (hasTools)    hintParts.push('Ctrl+T tools')
  hintParts.push('Ctrl+C exit')
  const hint = hintParts.join('  ·  ')

  return (
    <Box flexDirection="column">
      {/* Slash command suggestions — above input */}
      {visible.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" marginX={1} paddingX={1}>
          {windowStart > 0 && (
            <Text color="gray" dimColor>  ↑ {windowStart} more</Text>
          )}
          {visible.map((s, i) => {
            const absIdx = windowStart + i
            const selected = absIdx === suggestionIndex
            return (
              <Box key={s.name}>
                <Text color={selected ? 'cyan' : 'white'} bold={selected} dimColor={!selected}>
                  {s.name.padEnd(nameColWidth)}
                </Text>
                <Text color="gray" dimColor={!selected}>{s.description}</Text>
              </Box>
            )
          })}
          {windowStart + count < suggestions.length && (
            <Text color="gray" dimColor>
              {'  ↓ ' + (suggestions.length - windowStart - count) + ' more'}
            </Text>
          )}
        </Box>
      )}

      {/* Input row */}
      <Box paddingX={1}>
        <Text color={disabled ? 'gray' : 'green'} bold>{'❯ '}</Text>
        <Text wrap="wrap">{value}</Text>
        {!disabled && <Text color="green">{'█'}</Text>}
        {disabled && <Text color="gray" dimColor>{' (thinking…)'}</Text>}
      </Box>

      {/* Hint line */}
      {!value && !disabled && (
        <Box paddingX={3}>
          <Text color="gray" dimColor>{hint}</Text>
        </Box>
      )}
    </Box>
  )
}
