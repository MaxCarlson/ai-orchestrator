import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useApp, useStdout } from 'ink'
import { getConfig } from '../commands/config.js'
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
  initMessages?: string[]
}

const HEADER_LINES  = 2   // model line + divider
const INPUT_LINES   = 4   // input row + hint + padding
const TOOL_LINES    = 2   // max tool progress rows
const STREAMING_LINES = 2 // streaming response preview

export function REPL({ workingDir, engine: engineProp, initialMessage, initMessages = [] }: REPLProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [messages, setMessages] = useState<ChatMessage[]>([
    ...initMessages.map(text => ({ role: 'system' as const, content: text, timestamp: Date.now() })),
  ])
  const [streaming, setStreaming] = useState(false)
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([])
  const [currentResponse, setCurrentResponse] = useState('')
  const [scrollOffset, setScrollOffset] = useState(0)  // 0 = pinned to bottom

  const engineRef = useRef<QueryEngine>(engineProp ?? new QueryEngine(workingDir))
  const abortRef  = useRef<AbortController | null>(null)

  const terminalHeight = stdout.rows ?? 24
  const toolLines = Math.min(activeTools.filter(t => !t.done).length, TOOL_LINES)
  const streamLines = (streaming && currentResponse) ? STREAMING_LINES : 0
  const viewportHeight = Math.max(4, terminalHeight - HEADER_LINES - INPUT_LINES - toolLines - streamLines)

  const scrollPageSize = Math.max(1, Math.floor(viewportHeight * 0.8))

  const handleSubmit = useCallback(async (input: string) => {
    if (input === '/exit' || input === '/quit') { exit(); return }

    // Auto-scroll to bottom on new message
    setScrollOffset(0)
    setMessages(prev => [...prev, { role: 'user', content: input, timestamp: Date.now() }])
    setStreaming(true)
    setCurrentResponse('')

    const abort = new AbortController()
    abortRef.current = abort

    let responseText = ''

    for await (const event of engineRef.current.submit(input, abort.signal)) {
      if (event.type === 'status') {
        setMessages(prev => [...prev, { role: 'system', content: event.text, timestamp: Date.now() }])
        continue
      }

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
          setScrollOffset(0)
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

  useEffect(() => {
    if (initialMessage) void handleSubmit(initialMessage)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = getConfig()
  const isLocal = !cfg.model.startsWith('claude-')
  const backend = isLocal ? 'local' : 'anthropic'
  const modelLabel = `${cfg.model}  ·  ${backend}`

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* ── Header ─────────────────────────────────────────── */}
      <Box paddingX={2} paddingY={0}>
        <Text color="cyan" bold>aioc  </Text>
        <Text color="gray" dimColor>{modelLabel}</Text>
      </Box>
      <Box paddingX={1}>
        <Text color="gray" dimColor>{'─'.repeat(Math.max(0, (stdout.columns ?? 80) - 2))}</Text>
      </Box>

      {/* ── Messages (scrollable viewport) ─────────────────── */}
      <MessageList
        messages={messages}
        scrollOffset={scrollOffset}
        viewportHeight={viewportHeight}
      />

      {/* ── Streaming response preview ──────────────────────── */}
      {streaming && currentResponse && (
        <Box paddingX={2}>
          <Text color="cyan" bold>{'Assistant  '}</Text>
          <Text color="gray" dimColor wrap="wrap">
            {currentResponse.slice(-200)}
          </Text>
        </Box>
      )}

      {/* ── Tool progress ───────────────────────────────────── */}
      <ToolProgress activeTools={activeTools} />

      {/* ── Divider + input ─────────────────────────────────── */}
      <Box paddingX={1}>
        <Text color="gray" dimColor>{'─'.repeat(Math.max(0, (stdout.columns ?? 80) - 2))}</Text>
      </Box>
      <InputBar
        onSubmit={handleSubmit}
        disabled={streaming}
        onScrollUp={() => setScrollOffset(o => o + 1)}
        onScrollDown={() => setScrollOffset(o => Math.max(0, o - 1))}
        onScrollPageUp={() => setScrollOffset(o => o + scrollPageSize)}
        onScrollPageDown={() => setScrollOffset(o => Math.max(0, o - scrollPageSize))}
      />
    </Box>
  )
}
