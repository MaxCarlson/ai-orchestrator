import React from 'react'
import { Box, Text } from 'ink'

export interface ActiveTool {
  toolUseId: string
  name: string
  done: boolean
}

interface ToolProgressProps {
  activeTools: ActiveTool[]
}

export function ToolProgress({ activeTools }: ToolProgressProps) {
  const pending = activeTools.filter(t => !t.done)
  if (pending.length === 0) return null

  return (
    <Box flexDirection="column" paddingX={1}>
      {pending.map(tool => (
        <Box key={tool.toolUseId}>
          <Text color="yellow">{'⚙ '}</Text>
          <Text color="yellow">{tool.name}</Text>
          <Text color="gray">{' running…'}</Text>
        </Box>
      ))}
    </Box>
  )
}
