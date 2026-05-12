// chat.js — Chat view for the AI Orchestrator SPA
// XSS safety: all server-sourced content set via .textContent only. Never innerHTML.
'use strict'

;(function () {
    var WS_URL = 'ws://' + location.host + '/ws/chat'
    var MAX_LOG_ENTRIES = 500

    // DOM refs — resolved lazily when the view first activates
    var messageList, inputEl, sendBtn, statusEl, toolProgress,
        modelSelect, logList, logClearBtn, workdirEl

    var ws = null
    var streaming = false
    var streamingMsgEl = null
    var activeTools = new Map()
    var chatInitialized = false

    // Log accumulation state
    var currentThinkingEntry = null
    var currentModelEntry = null
    var currentToolEntry = null

    // Toggle state: category name → boolean (true = visible)
    var toggleState = {
        'thinking':     true,
        'tool-use':     true,
        'tool-result':  true,
        'model-output': true,
    }

    // ── Entry point called by app.js on first Chat tab activation ────────────

    window.chatViewActivated = function () {
        if (chatInitialized) return
        chatInitialized = true

        // Resolve DOM refs
        messageList  = document.getElementById('chat-message-list')
        inputEl      = document.getElementById('chat-input')
        sendBtn      = document.getElementById('chat-btn-send')
        statusEl     = document.getElementById('chat-conn-status')
        toolProgress = document.getElementById('chat-tool-progress')
        modelSelect  = document.getElementById('chat-model-select')
        logList      = document.getElementById('chat-log-list')
        logClearBtn  = document.getElementById('chat-btn-log-clear')
        workdirEl    = document.getElementById('chat-workdir')

        bindUI()
        loadModels()
        connect()
        inputEl.focus()
    }

    // ── Model list — fetched from /api/chat/models at runtime ────────────────

    function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild)
    }

    function loadModels() {
        fetch('/api/chat/models')
            .then(function (r) { return r.json() })
            .then(function (data) { populateModelSelect(data.models || []) })
            .catch(function () {
                clearChildren(modelSelect)
                var opt = document.createElement('option')
                opt.value = ''
                opt.textContent = 'Failed to load — check server'
                modelSelect.appendChild(opt)
            })
    }

    function populateModelSelect(models) {
        var savedModel = window.localStorage.getItem('chatSelectedModel') || ''

        // Group models by their group label
        var groupOrder = []
        var groups = {}
        models.forEach(function (m) {
            var g = m.group || 'Other'
            if (!groups[g]) { groups[g] = []; groupOrder.push(g) }
            groups[g].push(m)
        })

        clearChildren(modelSelect)

        groupOrder.forEach(function (groupLabel) {
            var og = document.createElement('optgroup')
            og.label = groupLabel  // these are hardcoded server-side strings, not user input
            groups[groupLabel].forEach(function (m) {
                var opt = document.createElement('option')
                opt.value = m.id
                opt.textContent = m.label  // safe: textContent
                if (m.id === savedModel) opt.selected = true
                og.appendChild(opt)
            })
            modelSelect.appendChild(og)
        })

        if (!savedModel && modelSelect.options.length > 0) {
            modelSelect.selectedIndex = 0
        }
    }

    // ── UI event bindings ─────────────────────────────────────────────────────

    function bindUI() {
        // Submit on Enter (Shift+Enter = newline)
        document.getElementById('chat-form').addEventListener('submit', function (e) {
            e.preventDefault()
            doSend()
        })
        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() }
        })

        // Send / Abort dual-mode button
        sendBtn.addEventListener('click', function () {
            if (streaming) {
                if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'abort' }))
                setStreaming(false)
            }
        })

        // Model selector — send /model slash command to switch backend
        modelSelect.addEventListener('change', function () {
            var model = modelSelect.value
            if (!model || streaming || !ws || ws.readyState !== 1) return
            window.localStorage.setItem('chatSelectedModel', model)
            ws.send(JSON.stringify({ type: 'message', text: '/model ' + model }))
            setStreaming(true)
        })

        // Refresh model list (re-queries LM Studio for currently loaded models)
        document.getElementById('chat-btn-refresh-models').addEventListener('click', loadModels)

        // Folder picker — change working directory
        document.getElementById('chat-btn-folder').addEventListener('click', function () {
            var current = workdirEl ? workdirEl.textContent : ''
            var newDir = window.prompt('Working directory:', current || '')
            if (!newDir || !newDir.trim()) return
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'set_workdir', dir: newDir.trim() }))
            }
        })

        // Toolbar action buttons
        document.getElementById('chat-btn-clear').addEventListener('click', function () {
            if (streaming || !ws || ws.readyState !== 1) return
            ws.send(JSON.stringify({ type: 'message', text: '/clear' }))
            setStreaming(true)
        })
        document.getElementById('chat-btn-cost').addEventListener('click', function () {
            if (streaming || !ws || ws.readyState !== 1) return
            ws.send(JSON.stringify({ type: 'message', text: '/cost' }))
            setStreaming(true)
        })

        // Log clear
        logClearBtn.addEventListener('click', function () {
            clearChildren(logList)
            currentThinkingEntry = null
            currentModelEntry = null
            currentToolEntry = null
        })

        // Category toggle checkboxes
        var toggleIds = {
            'tog-thinking':     'thinking',
            'tog-tool-use':     'tool-use',
            'tog-tool-result':  'tool-result',
            'tog-model-output': 'model-output',
        }
        Object.keys(toggleIds).forEach(function (id) {
            var cat = toggleIds[id]
            var el = document.getElementById(id)
            if (!el) return
            el.addEventListener('change', function () {
                toggleState[cat] = el.checked
                applyToggles()
            })
        })
    }

    // ── WebSocket connection ──────────────────────────────────────────────────

    function connect() {
        ws = new WebSocket(WS_URL)
        ws.addEventListener('open', function () {
            setStatus('connected')
            // Switch to the user's last-selected model so the server doesn't stay on its default
            var model = modelSelect ? modelSelect.value : ''
            if (model && model !== '' && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'message', text: '/model ' + model }))
                setStreaming(true)
            }
        })
        ws.addEventListener('close', function () {
            setStatus('disconnected')
            setTimeout(connect, 2500)
        })
        ws.addEventListener('error', function () { setStatus('disconnected') })
        ws.addEventListener('message', function (e) {
            var event = JSON.parse(e.data)
            handleChatEvent(event)
            handleLogEvent(event)
        })
    }

    function setStatus(state) {
        statusEl.className = 'chat-conn-status ' + state
        statusEl.textContent = state  // safe: hardcoded state strings
    }

    // ── Send message ──────────────────────────────────────────────────────────

    function doSend() {
        var text = inputEl.value.trim()
        if (!text || streaming || !ws || ws.readyState !== 1) return
        appendChatMsg('user', text)
        inputEl.value = ''
        setStreaming(true)
        ws.send(JSON.stringify({ type: 'message', text: text }))
        chatScrollBottom()
    }

    // ── Chat panel event handler ──────────────────────────────────────────────

    function handleChatEvent(event) {
        if (event.type === 'text_delta' && event.text) {
            if (!streamingMsgEl) {
                streamingMsgEl = appendChatMsg('assistant', '')
                streamingMsgEl.querySelector('p').classList.add('streaming-cursor')
            }
            streamingMsgEl.querySelector('p').textContent += event.text  // safe: textContent
            chatScrollBottom()
            setStatus('streaming')

        } else if (event.type === 'tool_use_start') {
            var toolEl = document.createElement('div')
            toolEl.className = 'chat-tool-item'
            toolEl.textContent = '\u2699 ' + (event.toolName || '?') + '\u2026'  // safe: textContent
            toolProgress.appendChild(toolEl)
            activeTools.set(event.toolUseId || '', toolEl)

        } else if (event.type === 'tool_use_end') {
            activeTools.forEach(function (el) { el.remove() })
            activeTools.clear()

        } else if (event.type === 'message_stop') {
            if (streamingMsgEl) {
                streamingMsgEl.querySelector('p').classList.remove('streaming-cursor')
                streamingMsgEl = null
            }
            setStreaming(false)
            setStatus('connected')

        } else if (event.type === 'command_output') {
            appendChatMsg('command', event.text || '')
            setStreaming(false)
            setStatus('connected')

        } else if (event.type === 'command_clear') {
            clearChildren(messageList)
            appendChatMsg('system', 'Conversation cleared.')
            setStreaming(false)
            setStatus('connected')

        } else if (event.type === 'error' && event.error) {
            appendChatMsg('error', 'Error: ' + event.error)  // safe: textContent in appendChatMsg
            setStreaming(false)
            setStatus('connected')

        } else if (event.type === 'status' && event.text) {
            appendChatMsg('system', event.text)

        } else if (event.type === 'workdir_changed' && event.dir) {
            if (workdirEl) workdirEl.textContent = event.dir  // safe: textContent
            appendChatMsg('system', 'Working directory: ' + event.dir)
        }
    }

    // ── Log panel event handler ───────────────────────────────────────────────

    function handleLogEvent(event) {
        if (event.type === 'thinking_start') {
            currentThinkingEntry = appendLogEntry('thinking', 'Thinking', '\u2026')

        } else if (event.type === 'thinking_delta' && event.text) {
            if (!currentThinkingEntry) {
                currentThinkingEntry = appendLogEntry('thinking', 'Thinking', '')
            }
            var contentEl = currentThinkingEntry.querySelector('.log-content')
            if (contentEl) contentEl.textContent += event.text  // safe: textContent

        } else if (event.type === 'thinking_end') {
            if (currentThinkingEntry) {
                var contentEl = currentThinkingEntry.querySelector('.log-content')
                var chars = contentEl ? (contentEl.textContent || '').length : 0
                var labelEl = currentThinkingEntry.querySelector('.log-label')
                if (labelEl) labelEl.textContent = 'Thinking (' + chars + ' chars)'  // safe
                currentThinkingEntry = null
            }

        } else if (event.type === 'tool_use_start') {
            currentToolEntry = appendLogEntry(
                'tool-use',
                '\u2699 Tool: ' + (event.toolName || '?'),
                'id: ' + (event.toolUseId || '?'),
            )

        } else if (event.type === 'tool_use_delta' && event.toolInput) {
            if (currentToolEntry) {
                var contentEl = currentToolEntry.querySelector('.log-content')
                if (contentEl) contentEl.textContent += event.toolInput  // safe: textContent
            }

        } else if (event.type === 'tool_use_end') {
            currentToolEntry = null

        } else if (event.type === 'tool_result') {
            var label = (event.isError ? '\u2717 Tool Error' : '\u2713 Tool Output') +
                        (event.toolName ? ': ' + event.toolName : '')
            appendLogEntry('tool-result', label, event.result || '')

        } else if (event.type === 'text_delta' && event.text) {
            if (!currentModelEntry) {
                currentModelEntry = appendLogEntry('model-output', 'Model Output', '')
            }
            var contentEl = currentModelEntry.querySelector('.log-content')
            if (contentEl) contentEl.textContent += event.text  // safe: textContent

        } else if (event.type === 'message_stop') {
            currentModelEntry = null

        } else if (event.type === 'error' && event.error) {
            appendLogEntry('error', 'Error', event.error)
            currentThinkingEntry = null
            currentModelEntry = null
            currentToolEntry = null
        }
    }

    // ── Log DOM helpers ───────────────────────────────────────────────────────

    function appendLogEntry(cat, label, content) {
        var entry = document.createElement('div')
        entry.className = 'log-entry'
        entry.dataset.cat = cat

        var labelEl = document.createElement('span')
        labelEl.className = 'log-label'
        labelEl.textContent = label  // safe: textContent

        var contentEl = document.createElement('span')
        contentEl.className = 'log-content'
        contentEl.textContent = content  // safe: textContent

        entry.appendChild(labelEl)
        entry.appendChild(contentEl)

        if (toggleState[cat] === false) entry.style.display = 'none'

        logList.appendChild(entry)
        logScrollBottom()
        pruneLogEntries()
        return entry
    }

    function applyToggles() {
        var entries = logList.querySelectorAll('.log-entry')
        entries.forEach(function (el) {
            var cat = el.dataset.cat
            el.style.display = (toggleState[cat] !== false) ? '' : 'none'
        })
    }

    function pruneLogEntries() {
        var entries = logList.querySelectorAll('.log-entry')
        if (entries.length > MAX_LOG_ENTRIES) {
            for (var i = 0; i < 50; i++) {
                if (entries[i]) entries[i].remove()
            }
        }
    }

    function logScrollBottom() {
        logList.scrollTop = logList.scrollHeight
    }

    // ── Chat DOM helpers ──────────────────────────────────────────────────────

    var ROLE_LABELS = {
        user: 'You', assistant: 'AI', command: 'Output', error: 'Error', system: 'System'
    }

    function appendChatMsg(role, text) {
        var div = document.createElement('div')
        div.className = 'chat-msg ' + role

        if (role !== 'system') {
            var roleEl = document.createElement('span')
            roleEl.className = 'chat-role'
            roleEl.textContent = ROLE_LABELS[role] || role  // safe: hardcoded or textContent
            div.appendChild(roleEl)
        }

        var p = document.createElement('p')
        p.textContent = text  // safe: all server-sourced text via textContent
        div.appendChild(p)

        messageList.appendChild(div)
        chatScrollBottom()
        return div
    }

    function chatScrollBottom() {
        messageList.scrollTop = messageList.scrollHeight
    }

    // ── Streaming state ───────────────────────────────────────────────────────

    function setStreaming(active) {
        streaming = active
        inputEl.disabled = active
        modelSelect.disabled = active
        if (active) {
            sendBtn.textContent = 'Abort'  // safe: hardcoded string
            sendBtn.classList.add('aborting')
            sendBtn.disabled = false
        } else {
            sendBtn.textContent = 'Send'  // safe: hardcoded string
            sendBtn.classList.remove('aborting')
            sendBtn.disabled = false
            inputEl.focus()
        }
    }

    // If app.js restored the chat view before this script ran, chatViewActivated
    // was undefined at that moment — call it now.
    if (document.getElementById('chat-view') &&
        document.getElementById('chat-view').classList.contains('active')) {
        window.chatViewActivated()
    }

})()
