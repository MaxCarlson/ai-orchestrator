# AI Orchestrator - Implementation Plan

**Last Updated:** 2025-12-31

---

## Current Status

✅ **Phase 1-3 Complete** - See [PROGRESS.md](PROGRESS.md) for details

**What's Working Now:**
- PostgreSQL database with pgvector
- Orchestrator service polling task queue
- Task queue filesystem with atomic operations
- kmtui can submit tasks via Ctrl+A
- Simulation worker (10 second fake execution)

**What's NOT Working Yet:**
- Real CLI worker execution (claude, codex, gemini)
- LLM routing to RTX 5090
- Vector database for context
- Orchestrator viewer TUI

---

## Roadmap

### Phase 4: Real CLI Workers (NEXT)

**Goal:** Replace simulation worker with actual Claude Code CLI execution

**Tasks:**
- [ ] Update `claude_worker.sh` to call real `claude` command
- [ ] Add proper error handling and timeout
- [ ] Parse Claude Code output and extract artifacts
- [ ] Update task status in PostgreSQL (not just filesystem)
- [ ] Test with real coding task from kmtui

**Implementation Strategy:**
```bash
# In claude_worker.sh, replace simulation with:
claude --project "$PROJECT_ID" "$DESCRIPTION" \
    > "$RESULTS_DIR/stdout.log" \
    2> "$RESULTS_DIR/stderr.log"
```

**Challenges:**
- Claude Code may prompt for confirmation (need --yes flag or automation)
- Working directory context - where should claude run?
- Capturing artifacts (files created/modified)
- Handling long-running tasks (timeouts, progress updates)

**Success Criteria:**
- Submit task from kmtui
- Claude Code executes and completes real work
- Results captured in task_queue/results/
- Task status updated in PostgreSQL
- Can view results in kmtui

---

### Phase 5: Multiple CLI Support

**Goal:** Support claude, codex, and gemini CLIs

**Tasks:**
- [ ] Create `codex_worker.sh` and `gemini_worker.sh`
- [ ] Add CLI preference to task metadata
- [ ] Orchestrator routes to correct worker based on preference
- [ ] Add fallback logic (if claude busy, try codex)
- [ ] Implement worker pool (max N concurrent workers)

**Architecture Decision:**
- **Option A:** Separate worker scripts per CLI
- **Option B:** Generic worker script with CLI as parameter (recommended)

**Worker Pool Design:**
```python
# In orchestrator main.py
MAX_WORKERS_PER_CLI = {
    'claude': 2,   # Max 2 concurrent Claude tasks
    'codex': 3,    # Max 3 concurrent Codex tasks
    'gemini': 2,   # Max 2 concurrent Gemini tasks
}
```

---

### Phase 6: LLM Router (RTX 5090 Integration)

**Goal:** Route tasks to local LLMs running on RTX 5090

**Tasks:**
- [ ] Implement llama.cpp client in `llm_router/`
- [ ] Add model management (load/unload models)
- [ ] Route simple tasks to local LLM instead of expensive CLI
- [ ] Add task complexity detection (simple → local, complex → Claude)
- [ ] Implement streaming responses for long generations

**Models to Support:**
- Qwen2.5-Coder (for code tasks)
- Qwen2.5 (for general tasks)
- DeepSeek-Coder (alternative for code)

**Task Routing Logic:**
```python
def select_worker(task):
    if task.estimated_tokens < 1000 and not task.requires_tool_use:
        return "local_llm"  # Fast, free, local
    elif task.requires_code_execution:
        return "claude"     # Claude Code CLI
    else:
        return "codex"      # Codex or Gemini
```

**llama.cpp Integration:**
```python
# Access from orchestrator via host.docker.internal:8080
response = requests.post(
    "http://host.docker.internal:8080/v1/completions",
    json={"prompt": task.description, "max_tokens": 2048}
)
```

---

### Phase 7: Vector Database & RAG

**Goal:** Add project context retrieval for better task execution

**Tasks:**
- [ ] Set up Qdrant or ChromaDB in Docker
- [ ] Embed project codebases using code-specific embeddings
- [ ] RAG pipeline: retrieve relevant context before task execution
- [ ] Update task submission to include relevant context
- [ ] Cache embeddings (don't re-embed on every task)

**Architecture:**
```
Task Submitted
    ↓
Orchestrator extracts project_id
    ↓
Query vector DB for relevant context
    ↓
Augment task description with context
    ↓
Dispatch to worker with enriched context
```

**Embeddings Strategy:**
- Use `text-embedding-3-small` from OpenAI (cheap, good quality)
- Or local embeddings from Qwen models
- Chunk size: 512 tokens with 50 token overlap

---

### Phase 8: Orchestrator Viewer TUI

**Goal:** Real-time monitoring of all workers and tasks

**Reference:** See [docs/ORCHESTRATOR_VIEWER_DESIGN.md](docs/ORCHESTRATOR_VIEWER_DESIGN.md)

**Tasks:**
- [ ] Implement dashboard screen (worker grid, stats, activity log)
- [ ] Connect to orchestrator API (http://localhost:8000)
- [ ] Subscribe to PostgreSQL LISTEN/NOTIFY for real-time updates
- [ ] Add task detail view (click on task to see logs)
- [ ] Add worker controls (pause, resume, cancel)

**Launch Command:**
```bash
kmorch  # km-orchestrator viewer
```

---

### Phase 9: Multi-Device Support

**Goal:** Access orchestrator from multiple machines

**Reference:** See [docs/MULTI_DEVICE_SETUP.md](docs/MULTI_DEVICE_SETUP.md)

**Tasks:**
- [ ] Expose orchestrator API externally (with auth)
- [ ] Set up SSH tunneling for remote access
- [ ] Mobile device support (view-only mode)
- [ ] Remote task submission via API

**Security Considerations:**
- API key authentication
- HTTPS for external access
- Rate limiting
- Read-only API keys for monitoring

---

## Open Questions

### Worker Execution Strategy

**Current:** Orchestrator spawns workers on host via background processes

**Alternatives:**
1. **SSH to host:** Orchestrator SSHs to localhost to spawn workers
   - Pros: Clean separation, can scale to remote hosts
   - Cons: Requires SSH setup, more complex

2. **Worker request files:** Orchestrator writes files, host daemon picks up
   - Pros: Simple, no SSH needed
   - Cons: Need separate daemon on host

3. **Workers in containers:** Each CLI worker as sidecar container
   - Pros: Consistent environment, easy scaling
   - Cons: Credential mounting complexity

**Recommendation:** Keep current approach for now, revisit when scaling needed

### Database Synchronization

**Question:** How to keep PostgreSQL in sync with task_queue filesystem?

**Current:** Workers update both filesystem and database

**Better:** Single source of truth
- Option A: PostgreSQL is source of truth, filesystem is cache
- Option B: Filesystem is source of truth, database is index
- Option C: Two-phase commit (both or neither)

**Recommendation:** Phase out filesystem queue, use PostgreSQL + LISTEN/NOTIFY only

---

## Deferred Features

These are nice-to-have but not critical:

- [ ] Web UI dashboard (use TUI for now)
- [ ] Task templates and macros
- [ ] Scheduled tasks (cron-like)
- [ ] Task dependencies (DAG execution)
- [ ] Cost tracking per task (API usage)
- [ ] Task replay (re-run with same inputs)
- [ ] Diff view (before/after task execution)

---

## Migration Path

As we implement phases, some things will change:

1. **Filesystem queue → PostgreSQL only**
   - Current: task_queue/ directories
   - Future: All state in PostgreSQL, use LISTEN/NOTIFY

2. **Worker scripts → Worker API**
   - Current: Bash scripts spawn CLI commands
   - Future: Python workers with proper process management

3. **Polling → Event-driven**
   - Current: Orchestrator polls every 5 seconds
   - Future: PostgreSQL NOTIFY triggers immediate processing

---

## Success Metrics

**Phase 4 (CLI Workers):**
- Can assign real coding task to Claude Code from kmtui
- Task completes successfully with artifacts
- Results visible in kmtui

**Phase 5 (Multi-CLI):**
- All 3 CLIs working (claude, codex, gemini)
- Can run 5+ concurrent tasks across different CLIs
- Worker pool prevents overload

**Phase 6 (LLM Router):**
- Simple tasks routed to local LLM (< 2s response time)
- Complex tasks still use Claude Code
- 50% reduction in API costs

**Phase 7 (Vector DB):**
- Tasks include relevant project context
- Context retrieval < 100ms
- Improved task completion quality

**Phase 8 (Viewer TUI):**
- Can monitor all workers in real-time
- Task logs visible without leaving TUI
- Can cancel/pause tasks

---

## Next Session Checklist

Before starting next implementation session:

1. Read [PROGRESS.md](PROGRESS.md) for current status
2. Check [docs/BRIEFING_FOR_NEXT_SESSION.md](docs/BRIEFING_FOR_NEXT_SESSION.md)
3. Review this PLAN.md for next phase
4. Ensure orchestrator is running: `docker compose ps`
5. Check for any open issues or blockers

---

**See Also:**
- [PROGRESS.md](PROGRESS.md) - What's been completed
- [README.md](README.md) - How to use the system
- [docs/CONTAINERIZATION_STRATEGY.md](docs/CONTAINERIZATION_STRATEGY.md) - Architecture decisions
