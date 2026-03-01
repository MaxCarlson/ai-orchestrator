# Orchestrator Viewer TUI - Design Document

**Created**: 2025-12-29
**Purpose**: Real-time monitoring dashboard for AI orchestrator
**Command**: `kmorch` or `orchestrator-viewer`

---

## Overview

A comprehensive TUI dashboard for monitoring and managing the AI orchestrator ecosystem in real-time.

**Key Features**:
- Grid view of all active CLI workers
- Live output streaming from each worker
- Real-time statistics (tokens, memory, RAG, models)
- Worker detail view with drill-down capability
- Task queue status and health monitoring

**Think**: `htop` meets `tmux` for AI orchestration

---

## Screen Layout

### Main Dashboard View

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ AI Orchestrator Dashboard                                    [Q]uit [H]elp  │
├─────────────────────────────────────────────────────────────────────────────┤
│ ┌─ System Stats ──────────────────────────────────────────────────────────┐ │
│ │ Queue: 3 queued | 2 in-progress | 15 completed | 1 failed              │ │
│ │ Workers: 2 active | 1 idle | 0 stalled                                  │ │
│ │ Tokens: 45.2K used | 954.8K remaining (Claude: 1M daily)                │ │
│ │ Memory: 1,234 items | 45 categories | 23 hits (last hour)               │ │
│ │ GPU: RTX 5090 | 78% util | 18.5GB VRAM | Model: qwen-2.5-coder-32b      │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│ ┌─ Active Workers ────────────────────────────────────────────────────────┐ │
│ │ ┌─ claude-code-1 ──────────┐  ┌─ codex-1 ────────────┐                 │ │
│ │ │ Task: Implement auth      │  │ Task: Fix bug #42    │  [Empty]        │ │
│ │ │ Status: IN_PROGRESS       │  │ Status: IN_PROGRESS  │                 │ │
│ │ │ Duration: 5m 23s          │  │ Duration: 2m 10s     │                 │ │
│ │ │ Tokens: 12.5K / 100K      │  │ Tokens: 3.2K / 50K   │                 │ │
│ │ │ ─────────────────────────  │  │ ────────────────────  │                 │ │
│ │ │ > Analyzing codebase...   │  │ > Running tests...   │                 │ │
│ │ │ > Found 5 files to modify │  │ ✓ All tests passed   │                 │ │
│ │ │ > Creating auth/jwt.py... │  │ > Creating fix...    │                 │ │
│ │ │ ▓▓▓▓▓░░░░░ 50%            │  │ ▓▓▓▓▓▓▓░░░ 75%       │                 │ │
│ │ └───────────────────────────┘  └──────────────────────┘                 │ │
│ │                                                                           │ │
│ │ [Empty]                        [Empty]                                   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│ ┌─ Recent Activity ───────────────────────────────────────────────────────┐ │
│ │ 09:47:23  Task 550e8400 assigned to claude-code-1                       │ │
│ │ 09:45:10  Task ab12cd34 completed (duration: 8m 15s)                    │ │
│ │ 09:43:05  Memory added: "JWT implementation pattern" (category: auth)   │ │
│ │ 09:42:00  RAG hit: Retrieved 3 memories for task cd56ef78               │ │
│ │ 09:40:15  GPU model loaded: qwen-2.5-coder-32b (VRAM: 18.5GB)           │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│ Navigation: [↑↓←→] Select worker  [Enter] Detail view  [R] Reload  [Q] Quit │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Worker Detail View (after pressing Enter on a worker)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Worker Detail: claude-code-1                          [Esc] Back  [K] Kill  │
├─────────────────────────────────────────────────────────────────────────────┤
│ Task ID: 550e8400-e29b-41d4-a716-446655440000                               │
│ Task: Implement JWT-based authentication for API                            │
│ Project: ai-orchestrator                                                     │
│ Status: IN_PROGRESS | Started: 09:47:23 | Duration: 5m 23s                  │
│ Worker PID: 45231 | CLI: claude-code | Priority: NORMAL                     │
│                                                                               │
│ ┌─ Metrics ───────────────────────────────────────────────────────────────┐ │
│ │ Tokens: 12,543 / 100,000 (12.5%) | Est. completion: 3m 15s              │ │
│ │ Memory hits: 3 | Files modified: 2 | Lines added: 234 | Lines rm: 12    │ │
│ │ Heartbeat: 2s ago (healthy)                                              │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│ ┌─ Live Output ───────────────────────────────────────────────────────────┐ │
│ │ [09:47:25] Starting task execution...                                    │ │
│ │ [09:47:26] Reading project context from PostgreSQL                       │ │
│ │ [09:47:28] RAG query: "JWT authentication patterns"                      │ │
│ │ [09:47:29]   → Retrieved 3 memories:                                     │ │
│ │ [09:47:29]     • JWT token generation best practices                     │ │
│ │ [09:47:29]     • Refresh token rotation patterns                         │ │
│ │ [09:47:29]     • PostgreSQL session storage                              │ │
│ │ [09:47:30] Analyzing codebase structure...                               │ │
│ │ [09:47:32] Found existing auth module at: src/auth/                      │ │
│ │ [09:47:35] Creating new file: src/auth/jwt.py                            │ │
│ │ [09:47:40] Implementing token generation...                              │ │
│ │ [09:48:15] Creating API endpoint: /api/auth/login                        │ │
│ │ [09:49:02] Updating user model with password hashing...                  │ │
│ │ [09:50:45] Running tests...                                              │ │
│ │ [09:51:12]   ✓ test_token_generation PASSED                              │ │
│ │ [09:51:15]   ✓ test_token_validation PASSED                              │ │
│ │ [09:51:18]   ✓ test_refresh_token PASSED                                 │ │
│ │ [09:51:20] All tests passing. Preparing summary...                       │ │
│ │ ▓▓▓▓▓▓▓▓▓░ 85% complete                                                  │ │
│ │ [Scroll: ↑↓ | Follow: F | Copy: C | Save: S]                             │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│ ┌─ Task Context ──────────────────────────────────────────────────────────┐ │
│ │ Related files: src/auth/jwt.py, src/api/auth.py, src/models/user.py     │ │
│ │ Dependencies: PyJWT, bcrypt, python-jose                                 │ │
│ │ Categories: backend, security, authentication                            │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│ [Esc] Back to grid  [K] Kill worker  [R] Restart  [L] View logs            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1. Main Dashboard Screen (`OrchestratorDashboard`)

**Widgets**:
- `SystemStatsPanel` (top) - System-wide metrics
- `WorkerGridPanel` (center) - 2x2 or 3x3 grid of worker cards
- `ActivityLogPanel` (bottom) - Scrolling recent activity

**Data Sources**:
- Task queue filesystem (poll every 2s)
- PostgreSQL LISTEN/NOTIFY (real-time updates)
- Worker log files (tail -f style)
- Memory system queries (stats)

### 2. Worker Card Widget (`WorkerCard`)

**Displays**:
- Task title (truncated)
- Worker status badge (color-coded)
- Duration timer
- Token usage progress bar
- Last 3 lines of output (preview)
- Progress indicator (percentage or spinner)

**States**:
- `idle` - Gray, no task
- `assigned` - Yellow, task assigned but not started
- `active` - Green, task in progress
- `stalled` - Red, no heartbeat
- `completed` - Blue, task finished

### 3. Worker Detail Screen (`WorkerDetailScreen`)

**Widgets**:
- `WorkerMetricsPanel` - Detailed metrics
- `LiveOutputWidget` - Scrollable log viewer with auto-follow
- `TaskContextPanel` - Task metadata and context

**Features**:
- Real-time log tailing
- Auto-scroll (toggle with 'F' key)
- Log search (Ctrl+F)
- Copy output (Ctrl+C)
- Save logs to file

### 4. System Stats Panel (`SystemStatsPanel`)

**Metrics Tracked**:
- **Queue stats**: queued, in-progress, completed, failed counts
- **Worker stats**: active, idle, stalled counts
- **Token usage**: per-CLI aggregated (Claude, Codex, Gemini)
- **Memory stats**: total items, categories, recent hits
- **GPU stats**: utilization, VRAM, current model
- **Disk usage**: task queue size, log size

### 5. Activity Log Panel (`ActivityLogPanel`)

**Event Types**:
- Task state changes (queued → assigned → in-progress → completed/failed)
- Worker spawns and exits
- Memory additions and retrievals
- GPU model loads/unloads
- Errors and warnings
- User actions

**Features**:
- Color-coded by event type
- Timestamps
- Filterable (show only errors, etc.)
- Exportable

---

## Data Flow

### Real-time Updates

```
┌─────────────┐
│ PostgreSQL  │  LISTEN/NOTIFY
│ NOTIFY      │────────────────┐
│ channel     │                │
└─────────────┘                │
                               ▼
┌─────────────┐         ┌─────────────────┐
│ Task Queue  │         │  Orchestrator   │
│ Filesystem  │◄────────│  Viewer TUI     │
│ (poll 2s)   │         │                 │
└─────────────┘         └─────────────────┘
                               ▲
┌─────────────┐                │
│ Worker Logs │                │
│ (tail -f)   │────────────────┘
└─────────────┘
```

### Update Strategy

1. **Fast updates** (every 500ms):
   - Worker heartbeats
   - Progress indicators
   - Live output tails

2. **Medium updates** (every 2s):
   - Task queue state
   - Worker status
   - System stats

3. **Slow updates** (every 10s):
   - Memory statistics
   - GPU metrics
   - Disk usage

4. **Event-driven** (immediate):
   - PostgreSQL NOTIFY events
   - File system changes (inotify)
   - Worker process exits

---

## Key Bindings

### Main Dashboard
- `↑↓←→` - Navigate worker grid
- `Enter` - Open worker detail view
- `R` - Refresh all data
- `Q` - Quit
- `H` - Help screen
- `F` - Toggle auto-refresh
- `/` - Filter activity log
- `1-9` - Jump to worker N

### Worker Detail View
- `Esc` - Back to dashboard
- `K` - Kill worker (with confirmation)
- `R` - Restart task
- `F` - Toggle auto-follow logs
- `↑↓` - Scroll output
- `PgUp/PgDn` - Page up/down
- `Home/End` - Jump to start/end
- `Ctrl+F` - Search logs
- `Ctrl+C` - Copy selected output
- `S` - Save logs to file
- `L` - Open full log in editor

---

## Implementation Plan

### Phase 1: Core Structure (Priority 1)
- [x] Design document (this file)
- [ ] Create `orchestrator_viewer/` directory in ai-orchestrator
- [ ] Basic Textual app with main screen
- [ ] System stats panel (static data first)
- [ ] Worker grid layout (2x2 grid)
- [ ] Task queue polling

### Phase 2: Worker Cards
- [ ] WorkerCard widget with status display
- [ ] Task info display (title, duration, tokens)
- [ ] Output preview (last 3 lines)
- [ ] Progress indicator
- [ ] State transitions (colors)

### Phase 3: Worker Detail View
- [ ] WorkerDetailScreen implementation
- [ ] Live log tailing (tail -f style)
- [ ] Auto-scroll with toggle
- [ ] Metrics panel
- [ ] Task context panel

### Phase 4: Real-time Updates
- [ ] PostgreSQL LISTEN/NOTIFY integration
- [ ] Worker log file monitoring
- [ ] Heartbeat tracking
- [ ] Stale worker detection
- [ ] Activity log events

### Phase 5: Advanced Features
- [ ] Token usage tracking per CLI
- [ ] Memory/RAG statistics
- [ ] GPU monitoring
- [ ] Log search and filtering
- [ ] Export logs
- [ ] Kill/restart workers

---

## Technical Requirements

### Dependencies
- `textual` - TUI framework (already installed)
- `psycopg2` - PostgreSQL connection (already installed)
- `watchdog` - File system monitoring (optional)
- `psutil` - Process monitoring

### File Structure
```
ai-orchestrator/
├── orchestrator_viewer/
│   ├── __init__.py
│   ├── app.py                    # Main TUI application
│   ├── screens/
│   │   ├── __init__.py
│   │   ├── dashboard.py          # Main dashboard screen
│   │   └── worker_detail.py      # Worker detail screen
│   ├── widgets/
│   │   ├── __init__.py
│   │   ├── system_stats.py       # System stats panel
│   │   ├── worker_card.py        # Worker card widget
│   │   ├── worker_grid.py        # Worker grid layout
│   │   └── activity_log.py       # Activity log panel
│   └── utils/
│       ├── __init__.py
│       ├── task_monitor.py       # Task queue monitoring
│       ├── log_tailer.py         # Log file tailing
│       └── metrics_collector.py  # Stats collection
├── bin/
│   └── kmorch                    # CLI entry point
└── shared/
    └── task_queue.py             # Shared task queue module
```

### Entry Point (bin/kmorch)
```bash
#!/usr/bin/env python3
import sys
from orchestrator_viewer.app import OrchestratorViewerApp

if __name__ == "__main__":
    app = OrchestratorViewerApp()
    app.run()
```

---

## Error Handling

### Scenarios
1. **PostgreSQL connection lost**: Fall back to polling only, show warning
2. **Task queue directory missing**: Create it, show notification
3. **Worker process died**: Mark as failed, show in activity log
4. **Log file too large**: Tail last N lines, offer to truncate
5. **No active workers**: Show empty state with helpful message

---

## Testing Strategy

### Manual Testing
1. Start orchestrator viewer
2. Assign task from kmtui (Ctrl+A)
3. Watch task appear in queue
4. Watch worker spawn and start
5. View live output
6. Navigate to worker detail
7. Watch task complete
8. Verify stats update

### Automated Testing
- Mock task queue filesystem
- Mock PostgreSQL notifications
- Test worker state transitions
- Test metrics calculations
- Test UI updates

---

## Future Enhancements

### Phase 6+
- **Multi-orchestrator support**: Monitor multiple orchestrator instances
- **Historical graphs**: Token usage over time, task completion rates
- **Alerts**: Notifications for failures, stalls, quota limits
- **Remote monitoring**: Connect to orchestrators on other machines
- **Web UI**: Browser-based dashboard (FastAPI + WebSockets)
- **Mobile app**: Monitor from phone
- **Slack/Discord integration**: Post updates to channels

---

## Success Metrics

**MVP is successful when**:
1. User assigns task in kmtui (Ctrl+A)
2. Task appears in viewer within 2 seconds
3. Worker starts and output streams in real-time
4. User can navigate to worker detail view
5. Stats update accurately (tokens, duration, progress)
6. Task completion shows in activity log
7. No crashes or data loss

---

**End of Design Document**
