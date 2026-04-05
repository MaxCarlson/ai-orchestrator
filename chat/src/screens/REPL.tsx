import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useApp, useStdout, useInput } from 'ink'
import { getConfig } from '../commands/config.js'
import { MessageList, computeAutoTopIndex } from './MessageList.js'
import { InputBar, SLASH_COMMANDS, SUGGESTION_VISIBLE } from './InputBar.js'
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

const HEADER_LINES   = 3   // model line + 2 dividers
const INPUT_MIN      = 3   // input row + hint
const TOOL_MAX_LINES = 3

export function REPL({ workingDir, engine: engineProp, initialMessage, initMessages = [] }: REPLProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [messages, setMessages] = useState<ChatMessage[]>(
    initMessages.map(t => ({ role: 'system' as const, content: t, timestamp: Date.now() }))
  )
  const [streaming, setStreaming]       = useState(false)
  const [thinking, setThinking]         = useState(false)
  const [thinkingText, setThinkingText] = useState('')   // live thinking stream
  const [activeTools, setActiveTools]   = useState<ActiveTool[]>([])
  const [currentResponse, setCurrentResponse] = useState('')

  // Input state
  const [inputValue, setInputValue]     = useState('')
  const [suggestionIdx, setSuggestionIdx] = useState(0)

  // Scroll state: -1 = auto (stick to bottom), ≥0 = manual topIndex
  const [topIndex, setTopIndex]         = useState(-1)

  const engineRef = useRef<QueryEngine>(engineProp ?? new QueryEngine(workingDir))
  const abortRef  = useRef<AbortController | null>(null)

  const termWidth  = stdout.columns ?? 80
  const termHeight = stdout.rows    ?? 24

  // Slash suggestions (computed before viewportHeight so we can account for their height)
  const showSuggestions = inputValue.startsWith('/') && !inputValue.includes(' ')
  const suggestions = showSuggestions
    ? SLASH_COMMANDS.filter(c => c.name.startsWith(inputValue))
    : []
  const clampedSugIdx = Math.min(suggestionIdx, Math.max(0, suggestions.length - 1))

  // Suggestion box height: borders(2) + optional ↑(1) + items + optional ↓(1)
  const visibleSugCount = Math.min(suggestions.length, SUGGESTION_VISIBLE)
  const sugBoxLines = suggestions.length > 0
    ? 2 + (visibleSugCount) + (suggestions.length > SUGGESTION_VISIBLE ? 2 : 0)
    : 0

  const toolLines      = Math.min(activeTools.filter(t => !t.done).length, TOOL_MAX_LINES)
  const streamLines    = (streaming && currentResponse) ? 3 : 0   // label + 2 content lines
  const thinkingLines  = thinking ? (thinkingText ? 3 : 1) : 0  // label + 2 content lines when text
  const viewportHeight = Math.max(4, termHeight - HEADER_LINES - INPUT_MIN - toolLines - streamLines - thinkingLines - sugBoxLines - 1)

  const scrollPageSize = Math.max(3, Math.floor(viewportHeight * 0.7))

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (text: string) => {
    if (text === '/exit' || text === '/quit') { exit(); return }

    setTopIndex(-1)   // snap to bottom
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: Date.now() }])
    setStreaming(true)
    setCurrentResponse('')

    const abort = new AbortController()
    abortRef.current = abort
    let responseText = ''
    let thinkText = ''

    for await (const event of engineRef.current.submit(text, abort.signal)) {
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
      if (event.type === 'thinking_start') { setThinking(true); continue }
      if (event.type === 'thinking_delta' && event.text) {
        thinkText += event.text
        setThinkingText(thinkText)
        continue
      }
      if (event.type === 'thinking_end') {
        setThinking(false)
        continue
      }
      if (event.type === 'text_delta' && event.text) {
        responseText += event.text
        setCurrentResponse(responseText)
      }
      if (event.type === 'tool_use_start') {
        setActiveTools(prev => [...prev, { toolUseId: event.toolUseId ?? '', name: event.toolName ?? '', done: false }])
      }
      if (event.type === 'tool_use_end') {
        setActiveTools(prev => prev.map(t => ({ ...t, done: true })))
      }
      if (event.type === 'message_stop' && responseText.trim()) {
        // Capture values NOW before resetting — React calls the updater fn
        // asynchronously, so by then the mutable `let` vars would be '' already.
        const savedText  = responseText
        const savedThink = thinkText
        setMessages(prev => [...prev, {
          role: 'assistant' as const,
          content: savedText,
          timestamp: Date.now(),
          ...(savedThink ? { thinking: savedThink, thinkingExpanded: false } : {}),
        }])
        setTopIndex(-1)
        responseText = ''
        thinkText = ''
        setCurrentResponse('')
        setThinkingText('')
      }
      if (event.type === 'error' && event.error) {
        setMessages(prev => [...prev, { role: 'system', content: `Error: ${event.error}`, timestamp: Date.now() }])
        break
      }
    }

    setStreaming(false)
    setThinking(false)
    setCurrentResponse('')
    setThinkingText('')
    setActiveTools([])
    setTopIndex(-1)
  }, [exit])

  // ── Unified key handler ───────────────────────────────────────────────────
  useInput((input, key) => {
    // ── Slash suggestion navigation ───────────────────────────────────────
    if (showSuggestions && suggestions.length > 0) {
      if (key.upArrow) {
        setSuggestionIdx(i => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setSuggestionIdx(i => Math.min(suggestions.length - 1, i + 1))
        return
      }
      if (key.tab || key.return) {
        const completed = suggestions[clampedSugIdx]?.name ?? inputValue
        setInputValue(completed + ' ')
        setSuggestionIdx(0)
        if (key.return && completed === inputValue.trimEnd()) {
          // Already exact — submit
          const trimmed = completed.trim()
          if (trimmed) { void handleSubmit(trimmed); setInputValue('') }
        }
        return
      }
    }

    // ── Scrolling (works even while streaming) ────────────────────────────
    if (key.pageUp) {
      setTopIndex(prev => {
        const cur = prev < 0 ? computeAutoTopIndex(messages, viewportHeight, termWidth) : prev
        return Math.max(0, cur - scrollPageSize)
      })
      return
    }
    if (key.pageDown) {
      setTopIndex(prev => {
        if (prev < 0) return -1   // already at bottom
        const next = prev + scrollPageSize
        const auto = computeAutoTopIndex(messages, viewportHeight, termWidth)
        return next >= auto ? -1 : next
      })
      return
    }
    if (key.upArrow && !showSuggestions) {
      setTopIndex(prev => {
        const cur = prev < 0 ? computeAutoTopIndex(messages, viewportHeight, termWidth) : prev
        return Math.max(0, cur - 1)
      })
      return
    }
    if (key.downArrow && !showSuggestions) {
      setTopIndex(prev => {
        if (prev < 0) return -1
        const next = prev + 1
        const auto = computeAutoTopIndex(messages, viewportHeight, termWidth)
        return next >= auto ? -1 : next
      })
      return
    }

    // ── Ctrl+O: toggle thinking for latest assistant message ─────────────
    if (key.ctrl && input === 'o') {
      setMessages(prev => {
        const lastAssist = [...prev].reverse().findIndex(m => m.role === 'assistant' && m.thinking)
        if (lastAssist < 0) return prev
        const idx = prev.length - 1 - lastAssist
        return prev.map((m, i) =>
          i === idx ? { ...m, thinkingExpanded: !m.thinkingExpanded } : m,
        )
      })
      return
    }

    // ── Abort ─────────────────────────────────────────────────────────────
    if (key.escape) {
      if (inputValue) { setInputValue(''); setSuggestionIdx(0) }
      else if (streaming) abortRef.current?.abort()
      return
    }

    if (streaming) return  // no typing while streaming (except abort/scroll above)

    // ── Text editing ──────────────────────────────────────────────────────
    if (key.return) {
      const trimmed = inputValue.trim()
      if (trimmed) { void handleSubmit(trimmed); setInputValue(''); setSuggestionIdx(0) }
      return
    }
    if (key.backspace || key.delete) {
      setInputValue(prev => prev.slice(0, -1))
      setSuggestionIdx(0)
      return
    }
    if (key.ctrl && input === 'u') { setInputValue(''); setSuggestionIdx(0); return }
    if (key.ctrl && input === 'w') {
      setInputValue(prev => prev.replace(/\S+\s*$/, ''))
      setSuggestionIdx(0)
      return
    }
    if (!key.ctrl && !key.meta && input) {
      setInputValue(prev => { setSuggestionIdx(0); return prev + input })
    }
  })

  useEffect(() => {
    if (initialMessage) void handleSubmit(initialMessage)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = getConfig()
  const backend = cfg.model.startsWith('claude-') ? 'anthropic' : 'local'
  const scrollIndicator = topIndex >= 0 ? ` [↑ scrolled — PgDn/↓ to return]` : ''

  const divider = '─'.repeat(Math.max(0, termWidth - 2))

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* ── Header ───────────────────────────────── */}
      <Box paddingX={2}>
        <Text color="cyan" bold>aioc  </Text>
        <Text color="gray" dimColor>{cfg.model}  ·  {backend}{scrollIndicator}</Text>
      </Box>
      <Box paddingX={1}><Text color="gray" dimColor>{divider}</Text></Box>

      {/* ── Messages ─────────────────────────────── */}
      <MessageList
        messages={messages}
        topIndex={topIndex}
        viewportHeight={viewportHeight}
        termWidth={termWidth}
      />

      {/* ── Thinking indicator (live preview while model reasons) ─────────── */}
      {thinking && (
        <Box flexDirection="column" paddingX={2}>
          <Text color="magenta" dimColor bold>{'⟳ thinking'}</Text>
          {thinkingText && (
            <Text color="gray" dimColor wrap="wrap">
              {thinkingText.slice(-(termWidth * 2))}
            </Text>
          )}
        </Box>
      )}

      {/* ── Streaming preview ────────────────────── */}
      {streaming && currentResponse && (
        <Box flexDirection="column" paddingX={2}>
          <Text color="cyan" bold>{'Assistant'}</Text>
          <Text color="gray" dimColor wrap="wrap">{currentResponse.slice(-(termWidth * 2))}</Text>
        </Box>
      )}

      {/* ── Tool progress ────────────────────────── */}
      <ToolProgress activeTools={activeTools} />

      {/* ── Divider + input ──────────────────────── */}
      <Box paddingX={1}><Text color="gray" dimColor>{divider}</Text></Box>
      <InputBar
        value={inputValue}
        suggestions={suggestions}
        suggestionIndex={clampedSugIdx}
        disabled={streaming}
        hasThinking={messages.some(m => m.role === 'assistant' && Boolean(m.thinking))}
      />
    </Box>
  )
}
