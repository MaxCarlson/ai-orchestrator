# AI Orchestrator — Consolidation Plan

**Date:** February 15, 2026  
**Purpose:** Reconcile all conflicting documentation, incorporate the 2026 tooling landscape, and produce a single coherent plan that CLI agents can execute immediately.

---

## Part 1: The Honest Assessment

Your AI Orchestrator is **not obsolete**. The tools that have emerged (TaskMaster AI, Claude Squad, various MCP memory servers) solve *pieces* of what you're building, but none of them provide the integrated, self-hosted, GPU-accelerated, multi-model routing system you've designed. What HAS changed is that MCP has become the universal protocol for tool communication, which means your orchestrator should **speak MCP** rather than reinventing the interfaces. The architecture stays; the integration layer evolves.

The real problem right now is simpler: you have **22 markdown files** across the repo that give conflicting instructions, three external analysis documents (two from Gemini, one from my earlier research) that each recommend different frameworks, and an RTX 5090 that has been sitting idle since you bought it. The code itself is actually in decent shape — the foundation (PostgreSQL, FastAPI, task queue, Claude worker) works. What's broken is the planning layer, not the implementation layer.

---

## Part 2: Markdown File Audit — Every File, Every Verdict

### Root Directory

**`README.md`** → **KEEP, UPDATE**  
Currently accurate for operational commands (docker compose up, build_all.sh, etc). Needs a section added pointing to the new unified plan and removing references to outdated phase numbering. This should remain the "how to run it" document, not the "what are we building" document.

**`GOALS.md`** → **KEEP AS CANONICAL ROADMAP, RENAME to `ROADMAP.md`**  
This is your most current and accurate strategic document (January 2026 baseline). The mission statement, guiding principles, and end-state vision are all solid and still correct. Gemini's recommendation to rename this to ROADMAP.md is sound — it better reflects the document's actual function. Update the "Current Baseline" and "Immediate Goals" sections to reflect the new tooling decisions below.

**`PLAN.md`** → **ARCHIVE to `docs/archive/PLAN_2025_DEC.md`**  
This is the most dangerous file in the repo. It says "Real CLI Worker Execution: NOT Working Yet" when it has been working since early January. It references a "simulation worker" that no longer exists. It lists Phases 4–9 with status markers that are wrong. Any agent reading this will waste tokens trying to implement things that already exist. Archive it — the history is valuable, but it must not be in the root where agents will read it as authoritative.

**`PROGRESS.md`** → **ARCHIVE to `docs/archive/PROGRESS_2025_DEC.md`**  
Same problem as PLAN.md. The "Current Status" section is frozen at December 31, 2025 and contradicts what GOALS.md and BRIEFING_FOR_NEXT_SESSION.md describe. The session history is useful as a historical record but actively harmful as a planning document.

**`cliplan.md`** → **DELETE**  
This is a raw, unformatted Claude conversation dump with duplicated "Open questions" sections (literally appears three times). The content about GPU-powered code-aware indexing is covered more thoroughly in `memory/IMPLEMENTATION_STRAT.md` and `docs/NEXT_STEPS.md`. The formatting alone (monospaced block with manual line wrapping) makes it hostile to any agent trying to parse it. Nothing in here is unique enough to save.

**`hierarchy.md`** → **DELETE**  
This is just an `eza --tree` output dump of the repo. Any agent can regenerate this in seconds. It's 120 lines of file listings with no analysis or context. Dead weight.

**`PERSONAL_NOTES_WHEN_DOWM.md`** → **MOVE to `docs/archive/personal_notes.md`**  
The "cheats" markdown server idea and the module-splitting observation are interesting future ideas but don't belong in the root. The typos in the filename ("DOWM") and content suggest this was written on Termux in a hurry. Keep it as a backlog idea in the archive.

**`ai-orchestrator-briefing.md`** → **KEEP, but mark as REFERENCE ONLY**  
This is the comprehensive project briefing document you have in your Claude Project. It's excellent as a onboarding document for new agents, but it's a snapshot — it doesn't evolve with the project. Add a header note: "This document is a point-in-time reference (January 2026). For current status and active plan, see ROADMAP.md."

### docs/ Directory

**`docs/BRIEFING_FOR_NEXT_SESSION.md`** → **KEEP, RENAME to `docs/CURRENT_STATUS.md`**  
This is actually your most operationally accurate document. It correctly identifies what's working, what's newly added (code chunking, embeddings, indexer, search), and what hasn't been run yet. The "How To Run First Code Index" section is exactly the kind of actionable content agents need. Rename it to remove the session-specific framing — this should be the living "where are we right now" document.

**`docs/NEXT_STEPS.md`** → **MERGE into `ROADMAP.md`, then DELETE**  
The P1 (GPU Code Indexing) and P2 (KM/KMTUI Host DB Consistency) priorities are still valid and should be incorporated into the updated ROADMAP.md under a "Current Sprint" section. The file itself is too small to justify its own existence and will inevitably drift out of sync.

**`docs/CONTAINERIZATION_STRATEGY.md`** → **KEEP**  
Architecture decisions about what runs in Docker vs. host. Still accurate, still useful for onboarding. No changes needed.

**`docs/MULTI_DEVICE_SETUP.md`** → **KEEP**  
Detailed LAN access setup for PostgreSQL. Operationally useful, technically accurate. No changes needed.

**`docs/ORCHESTRATOR_VIEWER_DESIGN.md`** → **ARCHIVE to `docs/archive/`**  
This designs a Textual-based TUI viewer. The TUI exists in `orchestrator_viewer/` and works at a basic level, but the strategic direction is clearly toward the Web UI. This document describes a UI that won't receive further investment. Archive it — don't delete, because the TUI might be useful as a lightweight fallback.

**`docs/POSTGRESQL_MIGRATION_STATUS.md`** → **ARCHIVE to `docs/archive/`**  
Historical record of the SQLite → PostgreSQL migration completed in December 2025. Valuable as history, no longer operationally relevant.

**`docs/TASK_QUEUE_DESIGN.md`** → **KEEP**  
The filesystem queue design is still the active implementation. Even if you eventually migrate to PostgreSQL-only queuing, this document describes the current reality. Keep it until the migration actually happens.

**`docs/WEB_UI_DESIGN.md`** → **REPLACE with new `docs/WEB_UI_PLAN.md`**  
The current document describes a basic FastAPI + static HTML dashboard that's already partially implemented in `orchestrator_web_viewer/`. The new plan needs to reflect the decision between SvelteKit (Gemini's recommendation) vs. a Python-native approach (see Part 4 below). This file should be rewritten, not patched.

### memory/ Directory

**`memory/README.md`** → **KEEP, UPDATE**  
Good architectural overview of the memory subsystem. The "What This Folder Does NOT Do (Yet)" section is still accurate. Update the "Status" section to reflect that code chunking, embedding, indexing, and search modules now exist (they were "pending" when this was written).

**`memory/PLAN.md`** → **KEEP, UPDATE**  
The phased integration plan (Phase 0–8) is well-structured and still relevant. Update to mark Phase 0–1 as complete and Phase 2–3 as in-progress. Add a note that Serena MCP can supplement the retrieval layer.

**`memory/IMPLEMENTATION_STRAT.md`** → **MERGE into `memory/PLAN.md` section, then DELETE**  
This was generated by Perplexity and contains detailed requirements for code-aware indexing that overlap heavily with `memory/advanced-code-embedding-implementation-plan.md`. The implementation it describes (code_chunks schema, AST chunker, CodeBERT adapter, incremental indexer) has ALREADY BEEN PARTIALLY BUILT — the files `code_chunking.py`, `code_embeddings.py`, `code_indexer.py`, and `code_search.py` exist. Keeping this document around risks an agent re-implementing what's already there. Merge any remaining unimplemented requirements into memory/PLAN.md and delete.

**`memory/advanced-code-embedding-implementation-plan.md`** → **ARCHIVE to `docs/archive/`**  
This is the most detailed technical plan in the repo (covers AST chunking, dependency analysis, embedding generation, hybrid storage, intelligent retrieval). Much of it has been implemented. The unimplemented portions (ParadeDB BM25, PageRank scoring, dependency graph) should be captured as future phases in memory/PLAN.md. The document itself is too long and detailed to serve as an active plan — it reads like a research paper, not a task list.

### models/ Directory

**`models/MODELS_RESEARCH_v1.md`** → **KEEP**  
Research on available models for local inference. Still relevant for RTX 5090 model selection.

### orchestrator_web_viewer/

**`orchestrator_web_viewer/README.md`** → **KEEP, UPDATE**  
Documents the existing web viewer module. Update to reflect the planned replacement/upgrade.

---

## Part 3: The Consolidated Architecture

After reading everything — your repo, Gemini's recommendations, and my research on the 2026 tooling landscape — here is what the orchestrator should actually become. I'm being deliberately pragmatic about Gemini's recommendations because some of them are good and some are overengineered for where you are right now.

### What Gemini Got Right

**ParadeDB for hybrid search.** This is the single highest-value recommendation. Swapping `pgvector/pgvector:pg16` for `paradedb/paradedb` in your docker-compose.yml is a drop-in replacement that gives you BM25 keyword search alongside your existing vector search, which is exactly what `memory/IMPLEMENTATION_STRAT.md` was trying to design from scratch. Do this immediately.

**PostgreSQL SKIP LOCKED for task queuing.** The filesystem queue works, but it's the source of your sync problems (workers update filesystem but not database). Moving to `SELECT ... FOR UPDATE SKIP LOCKED` eliminates the entire class of "task stuck in assigned/" bugs. This doesn't mean deleting the filesystem queue overnight — keep `results/` for artifacts — but state transitions should move to PostgreSQL.

**Documentation consolidation.** The "Git Ops Sanitation Protocol" is exactly right. The conflicting docs are your biggest blocker right now.

### What Gemini Got Wrong (or Overcomplicated)

**LangGraph is overkill for your use case.** Gemini recommends replacing your FastAPI orchestrator with LangGraph state machines. This would require rewriting your entire backend in a framework that's designed for complex conversational agents with branching reasoning loops. Your orchestrator doesn't need that — it needs to: poll a queue, pick a worker, dispatch, collect results. That's a straightforward FastAPI application with PostgreSQL, which is what you already have. LangGraph adds a massive dependency for marginal benefit. If you want state machine semantics later, you can add them incrementally without adopting a framework.

**SvelteKit is the right technology but wrong timing.** Building a SvelteKit frontend from scratch when you have a working (if ugly) FastAPI + static HTML viewer is a multi-week project that won't get your RTX 5090 running. Gemini's analysis of why SvelteKit outperforms React for real-time dashboards is correct, but the recommendation ignores the fact that you're a solo developer who needs to get the GPU pipeline working before polishing the UI. The pragmatic path: keep the existing Python web viewer working, plan the SvelteKit rewrite as a separate project that happens AFTER the core pipeline is stable.

**The "web_ai_automator" module is a distraction.** This Selenium-based web scraper for automating ChatGPT/Gemini web interfaces is clever but belongs to a different era. With Claude Code, Codex CLI, and Gemini CLI all available as proper CLI tools (and all supporting MCP), there's no reason to automate web browsers. This module should not be part of the orchestrator's future.

### The Actual Architecture Going Forward

```
┌─────────────────── YOUR WORKSTATION (WSL2) ───────────────────┐
│                                                                 │
│  YOU (human)                                                    │
│    │                                                            │
│    ├── kmtui (task creation, project management)                │
│    ├── Web UI (monitoring, control, memory browser)             │
│    └── Claude Code + MCP plugins (hands-on coding)              │
│         ├── Serena (semantic code nav via LSP)                  │
│         ├── Context7 (live docs)                                │
│         └── Your orchestrator MCP server (memory + tasks)       │
│                                                                 │
│  DOCKER ─────────────────────────────────────────────────────   │
│  │                                                              │
│  ├── ParadeDB (PostgreSQL 16 + pgvector + BM25)                │
│  │     └── All state: tasks, projects, memories, embeddings     │
│  │                                                              │
│  ├── Orchestrator (FastAPI, port 8000)                          │
│  │     ├── Task dispatcher (PostgreSQL SKIP LOCKED)             │
│  │     ├── Memory manager (hybrid search API)                   │
│  │     ├── Code context injection (pre-dispatch RAG)            │
│  │     ├── REST API + WebSocket                                 │
│  │     └── MCP server interface (exposes memory + tasks)        │
│  │                                                              │
│  └── Web UI container (FastAPI + static or SvelteKit later)     │
│                                                                 │
│  HOST PROCESSES ─────────────────────────────────────────────   │
│  │                                                              │
│  ├── Claude Code worker (spawned by orchestrator)               │
│  ├── Codex CLI worker (future)                                  │
│  ├── Gemini CLI worker (future)                                 │
│  └── GPU embedding service (RTX 5090)                           │
│        ├── CodeBERT (code embeddings, 768-dim)                  │
│        ├── BGE-base-en (text embeddings, 768-dim)               │
│        └── Batch indexing pipeline                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 4: The Unified Execution Plan

### Sprint 0: Documentation Cleanup (Do This First — 1 Hour)

This is not optional. Every agent you launch will waste tokens on conflicting docs until this is done.

```bash
# Create archive directory
mkdir -p docs/archive

# Archive outdated files
git mv PLAN.md docs/archive/PLAN_2025_DEC.md
git mv PROGRESS.md docs/archive/PROGRESS_2025_DEC.md
git mv docs/ORCHESTRATOR_VIEWER_DESIGN.md docs/archive/
git mv docs/POSTGRESQL_MIGRATION_STATUS.md docs/archive/
git mv memory/advanced-code-embedding-implementation-plan.md docs/archive/
git mv PERSONAL_NOTES_WHEN_DOWM.md docs/archive/personal_notes.md

# Delete truly redundant files
git rm cliplan.md
git rm hierarchy.md

# Merge IMPLEMENTATION_STRAT.md into memory/PLAN.md, then delete
# (manual step — merge unimplemented requirements first)
git rm memory/IMPLEMENTATION_STRAT.md

# Rename for clarity
git mv GOALS.md ROADMAP.md
git mv docs/BRIEFING_FOR_NEXT_SESSION.md docs/CURRENT_STATUS.md
git mv docs/NEXT_STEPS.md docs/archive/NEXT_STEPS_merged.md

# Add header to briefing doc
echo "<!-- REFERENCE ONLY - see ROADMAP.md for current plan -->" | \
  cat - ai-orchestrator-briefing.md > temp && mv temp ai-orchestrator-briefing.md

git add -A && git commit -m "docs: consolidate and archive conflicting documentation"
```

After this, the root directory has: `ROADMAP.md` (strategy), `README.md` (operations), `ai-orchestrator-briefing.md` (reference). Clean.

### Sprint 1: Get the RTX 5090 Working (Priority — Days 1–3)

This is the single most impactful thing you can do. The code exists but has never been run.

**Step 1: Switch to ParadeDB** (30 minutes)

In `docker-compose.yml`, change:
```yaml
# FROM:
image: pgvector/pgvector:pg16
# TO:
image: paradedb/paradedb:latest
```

ParadeDB includes pgvector, so all existing functionality is preserved. You gain BM25 full-text search for free. Rebuild: `docker compose down && docker compose up -d`.

**Step 2: Run the first embedding job** (1–2 hours)

The code exists in `memory/code_indexer.py`. The task is: make it actually run against one of your repos.

```bash
# Set up environment
cp config/hoster.env.example config/hoster.env
# Edit config/hoster.env with your actual PostgreSQL password

# Ensure the code_chunks table exists
# (check if bootstrap_memory_and_settings in main.py creates it,
# or run the SQL migration manually)

# Run against the orchestrator repo itself as a test
source config/hoster.env
python memory/code_indexer.py \
  --repo-path ~/projects/ai-orchestrator \
  --project-id $(psql -h localhost -U km_user -d knowledge_manager -t -c \
    "SELECT id FROM projects WHERE name = 'ai-orchestrator' LIMIT 1") \
  --db-host localhost --db-port 5432 \
  --db-name knowledge_manager --db-user km_user \
  --db-password "$KM_POSTGRES_PASSWORD"
```

**Step 3: Verify search works** (30 minutes)

```bash
curl -X POST http://localhost:8000/memory/code-search/<project-id> \
  -H "Content-Type: application/json" \
  -d '{"query": "task queue atomic operations", "top_k": 5}'
```

If this returns relevant code chunks, your RTX 5090 is now earning its keep.

**Step 4: Wire context injection into task dispatch** (1–2 hours)

The orchestrator's `process_pending_tasks()` function needs to call `search_code()` before spawning the worker, and inject the results into the task JSON's `context.code_context` field. The `code_search.py` module already has the search API — this is a ~50 line integration in `main.py`.

### Sprint 2: MCP Server for Your Memory System (Days 4–6)

This is the highest-leverage architectural change. Instead of only accessing your memory system through REST APIs, expose it as an MCP server. This lets every Claude Code instance, every Codex CLI session, and every future agent tool query your PostgreSQL memory directly.

**What to build:** A FastMCP server (Python) that exposes:
- `search_code(project_name, query, top_k)` — semantic + lexical code search
- `search_memory(query, project_name, categories)` — general memory search  
- `list_projects()` — show tracked projects with embedding status
- `get_task_queue_status()` — current queue state
- `submit_task(project, title, description, priority)` — add to queue

**Where it lives:** `mcp_server/` in the repo root, configured in Claude Code via:
```json
{
  "mcpServers": {
    "ai-orchestrator": {
      "command": "python",
      "args": ["/home/max/projects/ai-orchestrator/mcp_server/server.py"]
    }
  }
}
```

This is the bridge between the existing tools ecosystem and your custom infrastructure.

### Sprint 3: PostgreSQL Task Queue Migration (Days 7–9)

Replace filesystem-based state transitions with PostgreSQL `SKIP LOCKED`:

```sql
-- Claim next task atomically
UPDATE tasks 
SET status = 'assigned', 
    assigned_at = NOW(), 
    assigned_to = $1
WHERE id = (
    SELECT id FROM tasks 
    WHERE status = 'queued' 
    ORDER BY priority DESC, created_at ASC 
    FOR UPDATE SKIP LOCKED 
    LIMIT 1
)
RETURNING *;
```

Keep `task_queue/results/` for artifact storage (stdout, stderr, modified files). Remove `queued/`, `assigned/`, `in_progress/`, `completed/`, `failed/` directories — their state now lives in PostgreSQL.

### Sprint 4: Web UI Rebuild (Week 2–3)

Given that you're primarily a Python developer working in WSL2, and the current web viewer is already FastAPI-based, here is the pragmatic path:

**Phase A: Improve the existing Python web viewer.** The `orchestrator_web_viewer/` module works. Add WebSocket support for live updates, improve the static HTML/CSS/JS to be denser and more informative. This gets you a usable dashboard quickly.

**Phase B: Plan the SvelteKit rewrite as a separate project.** When the core pipeline (GPU indexing, task dispatch, memory search) is stable and you're tired of the Python web viewer's limitations, scaffold a SvelteKit app. Gemini's recommendations for TanStack Table, Shadcn-Svelte, and Svelte Flow are all correct for the eventual high-density dashboard. But don't start this until the backend is solid.

### Sprint 5: Multi-CLI Workers + Claude Squad (Week 3–4)

With the task queue in PostgreSQL, adding Codex and Gemini workers is straightforward. Use Claude Squad for parallel execution of multiple Claude Code instances on concurrent tasks.

Install the MCP plugins that make the most difference:
```bash
# In each project where you use Claude Code:
claude mcp add serena -- uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context ide-assistant --project $(pwd)
claude mcp add context7 -- npx -y @upstash/context7-mcp@latest
claude mcp add ai-orchestrator -- python ~/projects/ai-orchestrator/mcp_server/server.py
```

---

## Part 5: What NOT to Do

**Do not adopt LangGraph.** Your orchestrator is a task dispatcher, not a conversational agent. FastAPI + PostgreSQL is the right stack for what you're building.

**Do not build the web UI first.** Every hour spent on CSS is an hour the RTX 5090 sits idle. Get the GPU pipeline working, then make it pretty.

**Do not try to use the web_ai_automator module.** Selenium-based web scraping of ChatGPT/Gemini is fragile and unnecessary when CLI tools exist. If this is a separate project, keep it separate. It has no place in the orchestrator.

**Do not install all 50 MCP servers.** Context window bloat is real. Start with Serena + Context7 + your own orchestrator MCP server. Add others only when you hit a specific need.

**Do not keep conflicting markdown files around.** This is the #1 cause of wasted agent tokens and contradictory implementations. Run Sprint 0 before anything else.

---

## Part 6: File Operations Summary

### DELETE (3 files)
| File | Reason |
|------|--------|
| `cliplan.md` | Duplicated content, broken formatting, superseded |
| `hierarchy.md` | Auto-generated tree dump, zero value |
| `memory/IMPLEMENTATION_STRAT.md` | Merged into memory/PLAN.md, code already partially built |

### ARCHIVE to docs/archive/ (5 files)
| File | Reason |
|------|--------|
| `PLAN.md` → `PLAN_2025_DEC.md` | Contradicts current state, historically valuable |
| `PROGRESS.md` → `PROGRESS_2025_DEC.md` | Frozen at Dec 2025, misleading |
| `PERSONAL_NOTES_WHEN_DOWM.md` | Backlog ideas, not active planning |
| `docs/ORCHESTRATOR_VIEWER_DESIGN.md` | TUI deprioritized in favor of web |
| `docs/POSTGRESQL_MIGRATION_STATUS.md` | Completed migration, historical only |
| `memory/advanced-code-embedding-impl...` | Research doc, implemented portions, archive remaining ideas |

### RENAME (3 files)
| From | To | Reason |
|------|-----|--------|
| `GOALS.md` | `ROADMAP.md` | Better reflects function as living roadmap |
| `docs/BRIEFING_FOR_NEXT_SESSION.md` | `docs/CURRENT_STATUS.md` | Remove session-specific framing |
| `docs/NEXT_STEPS.md` | Merge into ROADMAP.md, then archive | Too small to standalone |

### UPDATE (4 files)
| File | Changes Needed |
|------|---------------|
| `README.md` | Add pointer to ROADMAP.md, remove phase references |
| `ai-orchestrator-briefing.md` | Add "reference only" header |
| `memory/README.md` | Update status section to reflect existing code |
| `memory/PLAN.md` | Mark phases 0-1 complete, merge IMPLEMENTATION_STRAT requirements |

### KEEP UNCHANGED (4 files)
| File | Reason |
|------|--------|
| `docs/CONTAINERIZATION_STRATEGY.md` | Still accurate |
| `docs/MULTI_DEVICE_SETUP.md` | Still accurate |
| `docs/TASK_QUEUE_DESIGN.md` | Still active implementation |
| `models/MODELS_RESEARCH_v1.md` | Still relevant for RTX 5090 model selection |

### CREATE NEW (2 files)
| File | Purpose |
|------|---------|
| `docs/WEB_UI_PLAN.md` | Replace outdated WEB_UI_DESIGN.md with new direction |
| `mcp_server/server.py` | MCP server exposing memory + tasks to Claude Code |

---

## Part 7: The 30-Second Pitch for Your Future Self

When you come back to this project after a break, here's what you need to know:

The AI Orchestrator is a self-hosted system that coordinates CLI coding agents (Claude Code, Codex, Gemini) using PostgreSQL as the single source of truth, with an RTX 5090 generating code embeddings so agents have project context before they start working. You interact with it through kmtui (terminal task management), a web dashboard (monitoring), and Claude Code with MCP plugins (hands-on coding). The orchestrator automatically picks the right agent for each task, injects relevant code context from memory, and captures results.

Start here: `ROADMAP.md`. Run it: `docker compose up -d`. Check status: `curl localhost:8000/health`.
