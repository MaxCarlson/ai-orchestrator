# AI Orchestrator - Current Execution Priorities

Keep this list short. These are the outstanding runtime checks found in the January 2026 status snapshot; mark each pass, failure, or environment block with evidence. The current architecture and dependencies are in [`docs/plans/20260926_ai-assistant/00_implementation-plan.md`](plans/20260926_ai-assistant/00_implementation-plan.md).

## P1 - Local Model Chat
- [x] Fix `aioc` project status startup type error.
- [x] Make `aioc --serve` start the WebSocket chat server.
- [x] Check LM Studio readiness before local OpenAI-compatible requests.
- [ ] Verify a real loaded LM Studio model can answer through `aioc`.
- [ ] Verify web chat streams through `/ws/chat` with the same model.

## P2 - Runtime + Indexing Proof
- [ ] Start or verify `bin/local_worker_loop.sh` on the host.
- [ ] Queue one code-index job for this repo and confirm `code_chunks` rows.
- [ ] Queue one text-index job for docs/README content and confirm `text_chunks` rows.
- [ ] Confirm code/text search endpoints return relevant snippets.
- [ ] Run the retrieval eval harness in `eval/retrieval/` against live search
      results once this repo is indexed.

## P3 - Memory Wiring (after P2 is confirmed working and workspace/chat prerequisites are in place)

Do not inject memory until project identity and auth scope are explicit and conversation history is durable.
- [ ] Add `kind TEXT` column to `memory_items` and `global_memory_items` (see `memory/PLAN.md` Phase 1 for migration SQL).
- [ ] Add `kinds` filter to `dense_search()` and `hybrid_search()` in `memory/retrieval.py`.
- [ ] Use the existing `POST /memory/search-text` endpoint for a text query (or `POST /memory/search` for a precomputed embedding); do not add a duplicate `GET` endpoint without a compatibility requirement.
- [ ] Wire context injection into `chat/src/QueryEngine.ts` — call the search endpoint before each `submit()`, inject as `<memory>` block, cap at ~1500 tokens, soft-fail if DB unreachable.
- [ ] Create `memory/notes/projects/ai-orchestrator/` with starter `overview.md` and `decisions/`.
- [ ] Write `memory/ingest_notes.py` CLI to ingest `memory/notes/` into `text_chunks` via existing `source_ingestion.py`.
- [ ] Write `memory/promote_candidate.py` CLI to approve `memory/review/*.candidate.md` into `memory_items`.

## P4 - aioc UX Polish
- [ ] Scroll wheel support in the message viewport (`chat/src/tui.ts` or equivalent input handler).
- [ ] Arrow key (↑/↓) scrolling when input is empty — currently only PgUp/PgDn work.

## Validation Commands

```bash
cd chat && ~/.bun/bin/bun run typecheck
cd chat && ~/.bun/bin/bun test
env -u PYTHONHOME -u PYTHONSTARTUP PYTHONPATH=. pytest \
  tests/test_conversation_ingest.py tests/test_retrieval.py \
  tests/test_source_ingestion.py tests/test_system_stats.py
```

If a local WebSocket test fails only in a sandboxed agent environment, rerun it
from a normal host shell; the sandbox may block listening sockets.
