import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useApp, useStdout } from 'ink'
import { MessageList } from './MessageList.js'
import { InputBar } from './InputBar.js'
import { ToolProgress } from './ToolProgress.js'
import { QueryEngine } from '../QueryEngine.js'
import type { ChatMessage } from './MessageList.js'
import type { ActiveTool } from './ToolProgress.js'

interface REPLProps {
  workingDir: string
  engine?: QueryEngine
  initialMessage?: string
}

export function REPL({ workingDir, engine: engineProp, initialMessage }: REPLProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'system',
      content: 'Chat agent ready. Type /help for available commands. Ctrl+C to exit.',
      timestamp: Date.now(),
    },
  ])
  const [streaming, setStreaming] = useState(false)
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([])
  const [currentResponse, setCurrentResponse] = useState('')
  const engineRef = useRef<QueryEngine>(engineProp ?? new QueryEngine(workingDir))
  const abortRef = useRef<AbortController | null>(null)

  const handleSubmit = useCallback(async (input: string) => {
    if (input === '/exit' || input === '/quit') {
      exit()
      return
    }

    setMessages(prev => [...prev, { role: 'user', content: input, timestamp: Date.now() }])
    setStreaming(true)
    setCurrentResponse('')

    const abort = new AbortController()
    abortRef.current = abort

    let responseText = ''

    for await (const event of engineRef.current.submit(input, abort.signal)) {
      if (event.type === 'command_output') {
        setMessages(prev => [...prev, { role: 'command', content: event.text, timestamp: Date.now() }])
        break
      }

      if (event.type === 'command_clear') {
        setMessages([{ role: 'system', content: 'Conversation cleared.', timestamp: Date.now() }])
        break
      }

      if (event.type === 'text_delta' && event.text) {
        responseText += event.text
        setCurrentResponse(responseText)
      }

      if (event.type === 'tool_use_start') {
        setActiveTools(prev => [...prev, {
          toolUseId: event.toolUseId ?? '',
          name: event.toolName ?? '',
          done: false,
        }])
      }

      if (event.type === 'tool_use_end') {
        setActiveTools(prev => prev.map(t => ({ ...t, done: true })))
      }

      if (event.type === 'message_stop') {
        if (responseText) {
          setMessages(prev => [...prev, { role: 'assistant', content: responseText, timestamp: Date.now() }])
          responseText = ''
          setCurrentResponse('')
        }
      }

      if (event.type === 'error' && event.error) {
        setMessages(prev => [...prev, { role: 'system', content: `Error: ${event.error}`, timestamp: Date.now() }])
        break
      }
    }

    setStreaming(false)
    setCurrentResponse('')
    setActiveTools([])
  }, [exit])

  // Auto-submit initial message if provided
  useEffect(() => {
    if (initialMessage) {
      void handleSubmit(initialMessage)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const terminalHeight = stdout.rows ?? 24

  return (
    <Box flexDirection="column" height={terminalHeight}>
      <Box borderStyle="double" borderColor="blue" paddingX={2}>
        <Text bold color="blue">{'AI Orchestrator — Chat Agent'}</Text>
      </Box>

      <MessageList messages={messages} />

      {streaming && currentResponse && (
        <Box paddingX={1}>
          <Text color="blue" bold>{'Claude  '}</Text>
          <Text wrap="wrap">{currentResponse}</Text>
        </Box>
      )}

      <ToolProgress activeTools={activeTools} />

      <InputBar onSubmit={handleSubmit} disabled={streaming} />
    </Box>
  )
}
