# AI Orchestrator - Current Execution Priorities

Keep this list short. The current goal is to prove the built core works before
adding new architecture.

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
