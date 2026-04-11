import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useApp, useStdout, useInput } from 'ink'
import { getConfig } from '../commands/config.js'
import { MessageList, computeAutoTopIndex, computeTailStartLine } from './MessageList.js'
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

const HEADER_LINES   = 2   // model line + top divider
const INPUT_MIN      = 3   // bottom divider + input row + hint
const TOOL_MAX_LINES = 3

interface ToolRun {
  name: string
  inputJson: string
  result: string
  isError: boolean
}

export function REPL({ workingDir, engine: engineProp, initialMessage, initMessages = [] }: REPLProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [messages, setMessages] = useState<ChatMessage[]>(
    initMessages.map(t => ({ role: 'system' as const, content: t, timestamp: Date.now() }))
  )
  const [streaming, setStreaming]       = useState(false)
  const [thinking, setThinking]         = useState(false)
  const [thinkingText, setThinkingText] = useState('')
  const [activeTools, setActiveTools]   = useState<ActiveTool[]>([])
  const [currentResponse, setCurrentResponse] = useState('')

  // Tool debug overlay
  const [lastToolRuns, setLastToolRuns] = useState<ToolRun[]>([])
  const [showToolDebug, setShowToolDebug] = useState(false)

  // Input state
  const [inputValue, setInputValue]     = useState('')
  const [suggestionIdx, setSuggestionIdx] = useState(0)

  // Scroll state.
  //   topMsgIdx  = -1  → auto mode (shows tail of last message)
  //   topMsgIdx  ≥ 0  → manual: that message is at the top
  //   topLineOffset   → source lines to skip within the top message (manual only)
  const [topMsgIdx,    setTopMsgIdx]    = useState(-1)
  const [topLineOffset, setTopLineOffset] = useState(0)

  const engineRef = useRef<QueryEngine>(engineProp ?? new QueryEngine(workingDir))
  const abortRef  = useRef<AbortController | null>(null)

  const termWidth  = stdout.columns ?? 80
  const termHeight = stdout.rows    ?? 24

  // Slash suggestions
  const showSuggestions = inputValue.startsWith('/') && !inputValue.includes(' ')
  const suggestions = showSuggestions
    ? SLASH_COMMANDS.filter(c => c.name.startsWith(inputValue))
    : []
  const clampedSugIdx = Math.min(suggestionIdx, Math.max(0, suggestions.length - 1))

  // Suggestion box height
  const visibleSugCount = Math.min(suggestions.length, SUGGESTION_VISIBLE)
  const sugBoxLines = suggestions.length > 0
    ? 2 + visibleSugCount + (suggestions.length > SUGGESTION_VISIBLE ? 2 : 0)
    : 0

  // Tool debug overlay height estimate
  const debugOverlayLines = showToolDebug && lastToolRuns.length > 0
    ? Math.min(3 + lastToolRuns.length * 3, 16)
    : 0

  const toolLines     = Math.min(activeTools.filter(t => !t.done).length, TOOL_MAX_LINES)
  const streamLines   = (streaming && currentResponse) ? 3 : 0
  const thinkingLines = thinking ? (thinkingText ? 3 : 1) : 0
  const viewportHeight = Math.max(4,
    termHeight - HEADER_LINES - INPUT_MIN - toolLines - streamLines - thinkingLines - sugBoxLines - debugOverlayLines
  )

  const scrollPageSize = Math.max(3, Math.floor(viewportHeight * 0.7))

  // ── Snap to auto mode ─────────────────────────────────────────────────────
  const snapToBottom = useCallback(() => {
    setTopMsgIdx(-1)
    setTopLineOffset(0)
  }, [])

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (text: string) => {
    if (text === '/exit' || text === '/quit') { exit(); return }

    snapToBottom()
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: Date.now() }])
    setStreaming(true)
    setCurrentResponse('')

    const abort = new AbortController()
    abortRef.current = abort
    let responseText = ''
    let thinkText = ''
    const toolRunsAccum: ToolRun[] = []

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
      if (event.type === 'tool_result') {
        toolRunsAccum.push({
          name:      event.toolName  ?? '',
          inputJson: event.toolInput ?? '',
          result:    event.result    ?? '',
          isError:   event.isError   ?? false,
        })
      }
      if (event.type === 'message_stop' && responseText.trim()) {
        // Capture NOW before resetting — React calls the updater asynchronously,
        // so by then the mutable `let` vars would already be '' again.
        const savedText  = responseText
        const savedThink = thinkText
        setMessages(prev => [...prev, {
          role: 'assistant' as const,
          content: savedText,
          timestamp: Date.now(),
          ...(savedThink ? { thinking: savedThink, thinkingExpanded: false } : {}),
        }])
        snapToBottom()
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
    snapToBottom()
    if (toolRunsAccum.length > 0) setLastToolRuns(toolRunsAccum)
  }, [exit, snapToBottom])

  // ── Unified key handler ───────────────────────────────────────────────────
  useInput((input, key) => {
    // ── Slash suggestion navigation ───────────────────────────────────────
    if (showSuggestions && suggestions.length > 0) {
      if (key.upArrow) { setSuggestionIdx(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setSuggestionIdx(i => Math.min(suggestions.length - 1, i + 1)); return }
      if (key.tab || key.return) {
        const completed = suggestions[clampedSugIdx]?.name ?? inputValue
        setInputValue(completed + ' ')
        setSuggestionIdx(0)
        if (key.return && completed === inputValue.trimEnd()) {
          const trimmed = completed.trim()
          if (trimmed) { void handleSubmit(trimmed); setInputValue('') }
        }
        return
      }
    }

    // ── avail helper for tail calculation ─────────────────────────────────
    // Reserve: hasAboveMsgs(≤1) + label(1) + marginBottom(1) + indicator(1)
    const availLinesForTail = Math.max(1, viewportHeight - 1 - 1 - 1 - 1)

    // ── PgUp ─────────────────────────────────────────────────────────────
    if (key.pageUp) {
      if (topMsgIdx < 0) {
        // Auto mode → enter manual mode, one page before the tail
        const autoIdx = computeAutoTopIndex(messages, viewportHeight, termWidth)
        const msg = messages[autoIdx]
        if (msg) {
          const ts = computeTailStartLine(msg.content, availLinesForTail, termWidth)
          setTopMsgIdx(autoIdx)
          setTopLineOffset(Math.max(0, ts - scrollPageSize))
        } else {
          setTopMsgIdx(0)
          setTopLineOffset(0)
        }
      } else if (topLineOffset >= scrollPageSize) {
        setTopLineOffset(prev => prev - scrollPageSize)
      } else if (topLineOffset > 0) {
        setTopLineOffset(0)
      } else {
        // At start of this message → go to previous message
        const prev = topMsgIdx - 1
        if (prev >= 0) { setTopMsgIdx(prev); setTopLineOffset(0) }
      }
      return
    }

    // ── PgDn ─────────────────────────────────────────────────────────────
    if (key.pageDown) {
      if (topMsgIdx < 0) return   // already at bottom
      const msg = messages[topMsgIdx]
      if (!msg) { snapToBottom(); return }
      const srcLen = msg.content.split('\n').length
      const newOff = topLineOffset + scrollPageSize
      if (newOff < srcLen) {
        setTopLineOffset(newOff)
      } else if (topMsgIdx < messages.length - 1) {
        setTopMsgIdx(topMsgIdx + 1)
        setTopLineOffset(0)
      } else {
        snapToBottom()
      }
      return
    }

    // ── ↑ (single line up) ────────────────────────────────────────────────
    if (key.upArrow && !showSuggestions) {
      if (topMsgIdx < 0) {
        const autoIdx = computeAutoTopIndex(messages, viewportHeight, termWidth)
        const msg = messages[autoIdx]
        if (msg) {
          const ts = computeTailStartLine(msg.content, availLinesForTail, termWidth)
          setTopMsgIdx(autoIdx)
          setTopLineOffset(Math.max(0, ts - 1))
        } else {
          setTopMsgIdx(0); setTopLineOffset(0)
        }
      } else if (topLineOffset > 0) {
        setTopLineOffset(prev => prev - 1)
      } else {
        const prev = topMsgIdx - 1
        if (prev >= 0) { setTopMsgIdx(prev); setTopLineOffset(0) }
      }
      return
    }

    // ── ↓ (single line down) ──────────────────────────────────────────────
    if (key.downArrow && !showSuggestions) {
      if (topMsgIdx < 0) return
      const msg = messages[topMsgIdx]
      if (!msg) { snapToBottom(); return }
      const srcLen = msg.content.split('\n').length
      if (topLineOffset + 1 < srcLen) {
        setTopLineOffset(prev => prev + 1)
      } else if (topMsgIdx < messages.length - 1) {
        setTopMsgIdx(topMsgIdx + 1)
        setTopLineOffset(0)
      } else {
        snapToBottom()
      }
      return
    }

    // ── Ctrl+O: toggle thinking ───────────────────────────────────────────
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

    // ── Ctrl+T: toggle tool debug overlay ────────────────────────────────
    if (key.ctrl && input === 't') {
      setShowToolDebug(prev => !prev)
      return
    }

    // ── Escape ────────────────────────────────────────────────────────────
    if (key.escape) {
      if (inputValue) { setInputValue(''); setSuggestionIdx(0) }
      else if (streaming) abortRef.current?.abort()
      return
    }

    if (streaming) return

    // ── Text editing ──────────────────────────────────────────────────────
    if (key.return) {
      const trimmed = inputValue.trim()
      if (trimmed) { void handleSubmit(trimmed); setInputValue(''); setSuggestionIdx(0) }
      return
    }
    if (key.backspace || key.delete) {
      setInputValue(prev => prev.slice(0, -1)); setSuggestionIdx(0); return
    }
    if (key.ctrl && input === 'u') { setInputValue(''); setSuggestionIdx(0); return }
    if (key.ctrl && input === 'w') {
      setInputValue(prev => prev.replace(/\S+\s*$/, ''))
      setSuggestionIdx(0); return
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
  const scrollIndicator = topMsgIdx >= 0 ? ` [↑ scrolled — PgDn/↓ to return]` : ''
  const divider = '─'.repeat(Math.max(0, termWidth - 2))

  const hasThinking = messages.some(m => m.role === 'assistant' && Boolean(m.thinking))
  const hasTools    = lastToolRuns.length > 0

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* ── Header ───────────────────────────────── */}
      <Box paddingX={2} flexShrink={0}>
        <Text color="cyan" bold>aioc  </Text>
        <Text color="gray" dimColor>{cfg.model}  ·  {backend}{scrollIndicator}</Text>
      </Box>
      <Box paddingX={1} flexShrink={0}><Text color="gray" dimColor>{divider}</Text></Box>

      {/* ── Messages ─────────────────────────────── */}
      <MessageList
        messages={messages}
        topMsgIdx={topMsgIdx}
        topLineOffset={topLineOffset}
        viewportHeight={viewportHeight}
        termWidth={termWidth}
      />

      {/* ── Thinking indicator ───────────────────── */}
      {thinking && (
        <Box flexDirection="column" paddingX={2} flexShrink={0}>
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
        <Box flexDirection="column" paddingX={2} flexShrink={0}>
          <Text color="cyan" bold>{'Assistant'}</Text>
          <Text color="gray" dimColor wrap="wrap">{currentResponse.slice(-(termWidth * 2))}</Text>
        </Box>
      )}

      {/* ── Tool progress ────────────────────────── */}
      <Box flexShrink={0}>
        <ToolProgress activeTools={activeTools} />
      </Box>

      {/* ── Tool debug overlay (Ctrl+T) ───────────── */}
      {showToolDebug && lastToolRuns.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          marginX={1}
          paddingX={1}
          flexShrink={0}
        >
          <Text color="cyan" bold>
            {'🔧 Tool Debug ('}
            {lastToolRuns.length}
            {' call'}
            {lastToolRuns.length !== 1 ? 's' : ''}
            {') — Ctrl+T to close'}
          </Text>
          {lastToolRuns.map((run, i) => (
            <Box key={i} flexDirection="column" marginTop={1}>
              <Text color={run.isError ? 'red' : 'green'} bold>
                {'  '}{run.isError ? '✗' : '✓'}{'  '}{run.name}
              </Text>
              <Text color="gray" dimColor>
                {'  in:  '}{run.inputJson.slice(0, termWidth - 8)}
              </Text>
              <Text color={run.isError ? 'red' : 'white'} wrap="wrap">
                {'  out: '}{run.result.slice(0, termWidth * 2)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* ── Divider + input ──────────────────────── */}
      <Box paddingX={1} flexShrink={0}><Text color="gray" dimColor>{divider}</Text></Box>
      <Box flexShrink={0}>
        <InputBar
          value={inputValue}
          suggestions={suggestions}
          suggestionIndex={clampedSugIdx}
          disabled={streaming}
          hasThinking={hasThinking}
          hasTools={hasTools}
        />
      </Box>
    </Box>
  )
}
