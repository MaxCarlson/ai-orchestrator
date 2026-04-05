import React, { useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'

const SLASH_COMMANDS = [
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

interface InputBarProps {
  onSubmit: (text: string) => void
  onScrollUp: () => void
  onScrollDown: () => void
  onScrollPageUp: () => void
  onScrollPageDown: () => void
  disabled?: boolean
}

export function InputBar({
  onSubmit,
  onScrollUp,
  onScrollDown,
  onScrollPageUp,
  onScrollPageDown,
  disabled = false,
}: InputBarProps) {
  const [value, setValue] = useState('')
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const { stdout } = useStdout()
  const width = stdout.columns ?? 80

  // Slash command suggestions
  const showSuggestions = value.startsWith('/') && !value.includes(' ')
  const suggestions = showSuggestions
    ? SLASH_COMMANDS.filter(c => c.name.startsWith(value))
    : []

  useInput((input, key) => {
    // Scroll keys work even when disabled
    if (key.upArrow && !showSuggestions) { onScrollUp(); return }
    if (key.downArrow && !showSuggestions) { onScrollDown(); return }
    if (key.pageUp)   { onScrollPageUp(); return }
    if (key.pageDown) { onScrollPageDown(); return }

    if (disabled) return

    if (key.return) {
      if (showSuggestions && suggestions.length > 0 && value !== suggestions[suggestionIndex]?.name) {
        // Tab-complete the selected suggestion
        const completed = suggestions[suggestionIndex]?.name ?? value
        setValue(completed + ' ')
        setSuggestionIndex(0)
        return
      }
      const trimmed = value.trim()
      if (trimmed) {
        onSubmit(trimmed)
        setValue('')
        setSuggestionIndex(0)
      }
      return
    }

    if (key.tab && showSuggestions && suggestions.length > 0) {
      const completed = suggestions[suggestionIndex]?.name ?? value
      setValue(completed + ' ')
      setSuggestionIndex(0)
      return
    }

    if (key.upArrow && showSuggestions) {
      setSuggestionIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow && showSuggestions) {
      setSuggestionIndex(i => Math.min(suggestions.length - 1, i + 1))
      return
    }

    if (key.escape) {
      setValue('')
      setSuggestionIndex(0)
      return
    }

    if (key.backspace || key.delete) {
      setValue(prev => {
        const next = prev.slice(0, -1)
        setSuggestionIndex(0)
        return next
      })
      return
    }

    if (key.ctrl && input === 'a') { /* home */ return }
    if (key.ctrl && input === 'e') { /* end */ return }
    if (key.ctrl && input === 'u') { setValue(''); setSuggestionIndex(0); return }
    if (key.ctrl && input === 'w') {
      setValue(prev => prev.replace(/\S+\s*$/, ''))
      setSuggestionIndex(0)
      return
    }

    if (!key.ctrl && !key.meta && input) {
      setValue(prev => {
        setSuggestionIndex(0)
        return prev + input
      })
    }
  })

  const nameColWidth = Math.max(...SLASH_COMMANDS.map(c => c.name.length)) + 2
  const visibleSuggestions = suggestions.slice(0, 6)

  return (
    <Box flexDirection="column">
      {/* Slash command suggestions — shown above input */}
      {visibleSuggestions.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          marginX={1}
          paddingX={1}
        >
          {visibleSuggestions.map((s, i) => {
            const selected = i === suggestionIndex
            const nameStr = s.name.padEnd(nameColWidth)
            return (
              <Box key={s.name}>
                <Text
                  color={selected ? 'cyan' : 'white'}
                  bold={selected}
                  dimColor={!selected}
                >
                  {nameStr}
                </Text>
                <Text color="gray" dimColor={!selected}>
                  {s.description}
                </Text>
              </Box>
            )
          })}
          {suggestions.length > 6 && (
            <Text color="gray" dimColor>{`  +${suggestions.length - 6} more`}</Text>
          )}
        </Box>
      )}

      {/* Input row */}
      <Box paddingX={1} paddingY={0}>
        <Text color={disabled ? 'gray' : 'green'} bold>{'❯ '}</Text>
        <Text wrap="wrap">{value}</Text>
        {!disabled && <Text color="green">{'█'}</Text>}
        {disabled && <Text color="gray" dimColor>{' (waiting…)'}</Text>}
      </Box>

      {/* Help hint */}
      {!value && !disabled && (
        <Box paddingX={3}>
          <Text color="gray" dimColor>
            {'Type a message or / for commands  ·  PgUp/↑↓ to scroll  ·  Ctrl+C to exit'}
          </Text>
        </Box>
      )}
    </Box>
  )
}
