import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

interface InputBarProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  placeholder?: string
}

export function InputBar({ onSubmit, disabled = false, placeholder = 'Type a message… (/help for commands)' }: InputBarProps) {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      const trimmed = value.trim()
      if (trimmed) {
        onSubmit(trimmed)
        setValue('')
      }
      return
    }

    if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1))
      return
    }

    if (!key.ctrl && !key.meta && input) {
      setValue(prev => prev + input)
    }
  })

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
      <Text color="cyan">{'> '}</Text>
      <Text>{value || <Text color="gray">{placeholder}</Text>}</Text>
      {!disabled && <Text color="cyan">{'█'}</Text>}
    </Box>
  )
}
