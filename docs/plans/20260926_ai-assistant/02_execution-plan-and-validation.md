# Execution plan, current audit and validation contract

**Reviewed:** 2026-09-26 America/Los_Angeles / 2026-09-27 UTC.
**Baseline:** `agent/ai-assistant-architecture-roadmap` at `3e14e826bca044f88dd52cd951526b8bd5f43f83`, including main `47a768d96bafbe9126a0e1fcfcfb296378632e1f`.
**Authority:** [00_implementation-plan.md](00_implementation-plan.md) remains the product architecture and S0–S8 order. This document supplies the refreshed implementation status and executable work packages. [01_feature-design-and-code-audit.md](01_feature-design-and-code-audit.md) is the earlier detailed design, subject to the corrections here.

## 1. Decision and scope

Proceed with a bounded S0 validator and immediate S1 containment, then repair the smallest demonstrated failures. The existing code is substantial enough to test and salvage. There is no evidence yet to justify replacing the application with a different agent framework, vector database or workflow engine.

The first usable product slice is: select an isolated project, ask a local model through either client, retain the complete conversation after restart, and retrieve a cited file from an index whose scope and freshness are visible. Durable autonomous runs follow this slice and the tool boundary.

This review inspected source through GitHub. The user supplied a successful compile command and 31 passing focused Python tests on main `47a768d9`, with seven datetime deprecation warnings. The reviewer did not execute those tests, PostgreSQL, an embedding model, LM Studio, Bun, the worker or a restart test. All live gates remain unverified.

### Current findings that change the earlier plan

Links below identify the reviewed immutable source, so future agents can distinguish a fixed issue from stale advice.

| ID | Evidence and effect | Required action |
| --- | --- | --- |
| R1 | [`memory/code_indexer.py`](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/memory/code_indexer.py), `index_repository`: recursive traversal of every file; no ignore/size policy or deleted-symbol/file reconciliation; `include_text=False`. | Prove small code and document fixtures separately. Add scope-aware enumeration and reconciliation in S4; do not mistake excluded Markdown/config for a parser crash. |
| R2 | Same file: unchanged detection uses content hash and symbol name, without embedding model or parser version. `_upsert_chunk` shares that check. | Define a model/parser fingerprint; model changes must invalidate embeddings even for unchanged content. Line-only movement must refresh location metadata. |
| R3 | [API](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/docker/orchestrator/main.py), `code_index_endpoint`: accepts `force_reindex` in context but omits the flag from the command it constructs. | Trace the worker path and add a route-to-worker argument test; ensure requested forced indexing reaches the indexer. |
| R4 | API `get_code_embedder` creates a default singleton; index endpoint accepts arbitrary model IDs. [Schema](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/memory/models.py) fixes code vectors to 768 dimensions; search does not filter embedding model. | Validate query/index model identity, dimensions, normalization and revision as one contract. Reject incompatibility clearly; stage a new index before activating another model. Equal dimensions alone do not imply compatible vector spaces. |
| R5 | [`code_chunking.py`](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/memory/code_chunking.py) now extracts Python, TypeScript and shell symbols and returns richer metadata. TS/shell extraction is heuristic; `_make_chunk` stores the supplied path string. | Retain new coverage as a baseline; test braces in strings/comments, nested constructs, duplicate symbols, invalid syntax, Unicode and offsets. Store root-relative paths with explicit workspace binding; persist useful metadata through a migration. |
| R6 | [`code_search.py`](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/memory/code_search.py) now does dense + PostgreSQL FTS + RRF. Both API call sites pass the new query argument. [Tests](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/tests/test_code_search.py) use `FakeConn` and schema-string assertions. | Keep hybrid code search; validate generated SQL, schema upgrade, vector casts and actual ranking against real PostgreSQL. Passing these unit tests does not prove indexing or SQL execution. |
| R7 | [Evaluation runner](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/eval/retrieval/run_eval.py) scores supplied JSON, with exact path/symbol matching; it has no live API collection mode. | Add a bounded result collector; canonicalize paths relative to the declared root without basename matching. Distinguish request failure, missing result, and zero relevance. Preserve raw API responses. |
| R8 | `memory/models.py`, `memory/kinds.py`, `MemoryManager.add_memory/search`, list/add/vector-search APIs already implement kinds. Text memory search does not forward kinds; `memory/retrieval.py` operates on text chunks, not memory-item taxonomy. | Stop planning to create existing fields/CLIs. Finish consistent memory API filtering with scope and review state; avoid blindly adding a kind filter to unrelated text tables. Preserve the existing taxonomy and map any future aliases explicitly. |
| R9 | [`ingest_notes.py`](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/memory/ingest_notes.py) validates and prints `--kind` but does not pass/store it. [`promote_candidate.py`](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/memory/promote_candidate.py) inserts through `MemoryManager`, with no durable candidate-review lifecycle. | Decide whether a note is a document source or canonical memory; persist its selected kind at that layer. Add idempotency, provenance, scope, candidate state and explicit write gating. Existing helpers are seeds, not completed memory governance. |
| R10 | Both new note CLIs use opt-in dry-run. Legacy indexer requires a password argument; API puts that password in a task command/description. | New validator must default to preview and never print credentials. Add environment/protected configuration credentials and structured worker payloads; migrate existing call sites before retiring unsafe argv usage. Existing CLI behavior changes require a documented compatibility decision. |
| R11 | [`QueryEngine.submit`](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/chat/src/QueryEngine.ts) still appends only the user message after inference; [project context](https://github.com/MaxCarlson/ai-orchestrator/blob/3e14e826bca044f88dd52cd951526b8bd5f43f83/chat/src/project/context.ts) is module-global. | S2 remains essential. Test persisted assistant/tool messages and cross-client context; a successful reply alone is insufficient. |
| R12 | `LLM-README.md` refers to scripts-repo paths such as `modules/termdash` and unrelated tests. NEXT_STEPS still calls already-added schema/CLIs absent. Original architecture says the branch contains only planning, although it contains a worker fix and merged implementation. | Correct active instructions and status incrementally; retain older documents as dated history. This refresh corrects roadmap/priority status; onboarding path repair belongs to S0 inventory. |

These are static findings, not a declaration that the live indexer fails in every environment. In particular, the known deletion and model-invalidation shortcomings do not prove initial insertion fails.

## 2. S0 must become a single runnable validator

**First implementation work package: S0.1.** Add `bin/validate_s0.py`, focused tests and a short runbook. These paths and options are proposed interfaces, not commands claimed to exist today. Reuse current project registration, schemas, queue and index entrypoints; do not implement an alternate indexer in the test harness.

### Validator interface and evidence

- Python argparse; `-s/--suite` selects preflight, indexing, chat, worker or all; `-o/--output-dir`; `-w/--write` explicitly enables fixture creation and disposable-service changes; `-n/--dry-run` is the default; `-t/--timeout` bounds each check. Provide short aliases for every new option.
- Preview prints the selected commands, proposed local resources, model download requirements and checks without mutating application data. An explicit live mode writes only run-owned fixture resources. Do not opportunistically upgrade packages, download models, migrate an existing database, restart an existing service or consume a production queue.
- Default live isolation is a separate Compose project/database, queue directory and temporary Git fixture. Avoid fixed conflicting host ports. Validate ownership by a generated run marker before cleanup. If isolation cannot be established, report BLOCKED with the exact missing prerequisite.
- Distinguish evidence generation from application mutation: report files may be written by an explicitly invoked validation command; live DB/queue/service changes require `--write`. No global environment dump, credential-bearing argv, full Compose secrets, or private source content in reports.
- Write `report.json`, `report.md` and bounded redacted per-check logs atomically. Include schema version, UTC timestamps, branch/commit/dirty state, OS, Python/Bun versions, service URLs with secrets removed, model ID/revision/device, database/schema/extension versions, fixture IDs, exact safe argv, exit code, elapsed time, assertions and artifacts.
- Each check has a stable ID and PASS, FAIL, BLOCKED or NOT_RUN. FAIL means an executed assertion failed; BLOCKED means a prerequisite prevented the check; NOT_RUN means it was unselected. Do not turn expected defects into PASS.
- Report generation continues after independent failures. Overall exit code: 0 only if all selected required checks pass; 1 for executed failures; 2 for missing prerequisites with no failures; invalid invocation uses argparse exit 2 with a distinct machine-readable error where possible.
- Record operational fixture failures separately from product defects. On interruption preserve enough manifest/evidence for explicit cleanup; never run a broad prune or delete the user's normal queue/database.

### Ordered checks and exact assertions

| Check | Action and required evidence | S0 success condition |
| --- | --- | --- |
| S0-PREFLIGHT | Inspect current checkout and actual launch configuration. Resolve host-versus-container repo/DB/model addresses. Enumerate dependencies without installing. Probe configured health and schemas read-only. | Every dependency has version/readiness or a precise block; report identifies the active interpreter and code commit. |
| S0-UNIT | Run the user's nine focused Python test files; run the branch worker-loop regression test; from `chat/`, run the declared Bun typecheck/test scripts in separate correctly rooted subprocesses. | Exit codes and bounded logs recorded. Passing fakes are labeled unit coverage. |
| S0-DB | Bootstrap only the disposable DB using current schema path; record schema objects/extension version. Add fresh-vs-upgrade migration comparison once migrations exist. | Real inserts and vector/FTS queries execute; a preexisting DB is never silently upgraded. |
| S0-CODE-DIRECT | Create project A and decoy B; fixture contains known Python function, TS symbol, shell function, a Markdown fact and an ignored file. Invoke existing code indexer with real embedding model. | Positive chunk count, expected code symbol/path/span/content, correct owner and embedding model/dimension. Document/config handling is explicitly separate. |
| S0-CODE-SEARCH | Call actual `POST /memory/code-search/{project_id}`; save payload/response and independently inspect relevant rows. Query exact symbol and natural-language description. | Expected symbol in bounded top-k, valid source span, no B-owned decoy in A results. An empty 200 response is not PASS. |
| S0-TEXT | Invoke existing text ingestion directly on the fixture, then `POST /memory/text-search/{project_id}`. | Known Markdown fact retrieved with provenance and correct project; this is document retrieval, distinct from memory-item search. |
| S0-REINDEX | Repeat unchanged run; modify function and document; delete one symbol/file; rename a file. Capture counts/hashes/IDs before and after each. | Stable unchanged content, refreshed changed metadata/content, no stale deleted/renamed results. Current code deletion is expected to fail until S4 repair; keep its reproduction. |
| S0-WORKER | Start a worker against only the isolated queue; enqueue a harmless deterministic task, then queued code and text indexing separately. | Correct state/result/exit code, bounded logs, direct and queued fixture results agree. Direct index success cannot stand in for queue success. |
| S0-WORKER-RESTART | Stop only the validator-owned loop between tasks; restart it and finish queued work. Exercise a task failure followed by another task. | Loop survives recorded task failure; state and output retained. Hard-crash lease recovery is separately assessed, not assumed from this check. |
| S0-MODEL | Probe `lms` status and configured `/v1/models`, then make a small direct request using one actually loaded model. | Server, loaded model and response each evidenced separately; no implicit cloud fallback or automatic model download. |
| S0-CHAT | Send a nonce and recall turn through aioc and through web `/ws/chat`; preserve request/event ordering, provider/model, completion/error and bounded transcript. | Both clients deliver a real reply and an internally consistent second turn. Tool-call support is a separate capability probe. |
| S0-HISTORY | Restart only isolated chat/API processes, reopen the same conversation and inspect persisted canonical transcript. | User, assistant and tool messages/links survive and replay in order. Expected current failure is recorded and becomes a required S2 acceptance test. |
| S0-ROUTES | Compare OpenAPI/routes, README, CURRENT_STATE, NEXT_STEPS and older June plans. | Inventory distinguishes code, document and memory search, host/container entrypoints, implemented versus verified features; concrete doc corrections listed. |

If the current clients lack a bounded programmatic interface, mark that automated check blocked and supply an exact manual transcript procedure in the runbook. Do not invent a CLI option. Add the smallest compatible test entrypoint only as a separately reviewed change.

**S0 is complete as an investigation when every selected baseline check has evidence and each failure/block has an owner and next action.** The product is not declared working until required checks pass. Hardware absence is never success. Start with preflight + indexing; expand to remaining checks after the harness is usable.

## 3. Work packages and acceptance gates

Each package should normally fit one reviewable change. Split further when schema, API and UI cannot be verified together. Existing functions/routes and queue directories remain compatible unless an explicit migration is approved.

| Package / dependency | Implementation and desired architecture | Meaningful acceptance tests |
| --- | --- | --- |
| S0.1 / now | Validator, fixture manifest, stable evidence format, exact operator runbook. Pure check functions plus a subprocess/resource adapter; no global machine reconfiguration. | Preview performs no application mutation; timeout/redaction/interrupt tests; one deliberately failing check stays FAIL; unavailable model is BLOCKED. |
| S1.1 / parallel with S0 | Contain published services; eliminate password-bearing task payloads/logs. Central settings for addresses/credentials. Keep necessary host access explicit. | Inspect effective bindings; scan generated task artifacts for sentinel secrets; old supported clients still connect locally. |
| S0.2 / S0.1 | Run direct code/text fixture before queue; capture first failure, repair its narrowest cause, rerun failed and affected checks. | Real DB/model/endpoint evidence with reproducible fixture. Report initial failure as well as repaired result. |
| S1.2 / S1.1 | Add authenticated actor/project authorization, WS handshake/origin checks and server-owned approval records. Extract routers/services as touched. | Unauthorized direct API/Bun/proxy access, guessed project ID and forged/replayed approval rejected; authorized HTTP/WS flows pass. |
| S1.3 / inventory | Establish Alembic baseline against actual populated schema. Centralize migration ownership; stop runtime DDL after compatibility rollout. | Fresh DB equals upgraded fixture schema; rollback/restore rehearsed; existing indexed rows retained. |
| S2.1 / S1.2–3 | Workspace/project binding and immutable request context. One logical project may bind multiple checkout roots, but every turn/tool uses one explicit binding. | Two simultaneous clients/projects, root change, missing root, symlink escape, relative path and unicode path cases. |
| S2.2 / S2.1 | Server-owned conversation/turn/message/event persistence. Save accepted user input before inference, append tool proposals/results/final assistant state transactionally; replay by sequence. | Kill after user acceptance/tool result/finalization; reconnect and duplicate request; interrupted turn visible; complete history exact after restart. |
| S2.3 / S2.2 | Versioned context builder for global/project/repo instructions, bounded history, summaries and later retrieval. Preserve originals in incomplete JSON session import. | Deterministic precedence; two-project isolation; instruction edit provenance; budget with response reserve; idempotent import with missing assistant history labeled. |
| S3.1 / S1.2 + S2.1 | Typed tool broker ports with filesystem/process/Git/network adapters. Execution-time capabilities; exact approval payload hash and expiry. | Path/URL containment, cancellation/process group cleanup, output limits, approval TOCTOU/replay, denied operation audit. |
| S3.2 / S3.1 | Restrictive provider native-tool boundary in an isolated worktree/process. Review/apply patches through approved workflow. | Child native tool cannot gain broader authority from a parent approval; unsupported permissions reported; ambiguous interrupted edits trigger reconciliation. |
| S4.1 / S0.2 + S1.3 | Shared source manifest, safe Git-aware enumeration, relative paths, per-source generations and model/parser fingerprint. Keep separate code/text extraction adapters. | Ignore/generated/secret/binary/oversized files; unchanged/edit/delete/rename/model-change; concurrent reindex; failed scan never causes mass deletion. |
| S4.2 / S4.1 | Stage parse/embed/write then atomically activate successful generation. Preserve prior valid source on parse/model/DB failure; safely GC superseded generations. | Fail after each stage and before commit; previous results remain searchable; retries idempotent; stale generations filtered from retrieval. |
| S4.3 / S4.1 | Extractor interface; improve TS/shell based on fixture failures. Pilot Tree-sitter only if heuristic coverage fails acceptance. Separate symbol identity from display name and location. | Comments/templates/heredocs/nesting/duplicate definitions; large symbols split within token limits; parse failure falls back visibly; provenance remains accurate. |
| S4.4 / S4.2–3 | Live result collector feeding existing eval, exact/lexical/dense/hybrid comparisons, cache invalidation, then context injection through S2. | Fixed held-out queries, Recall@k/MRR/latency/index size; second-project decoys; canonical path matching; no silent stale cache; citations and context cap. |
| S5.1 / S1.3 + S2 | Complete existing memory-kind paths; explicitly separate source notes from approved memory. Candidate/review/revision/provenance records; default-preview CLIs with explicit write mode. | Kind survives ingestion or rejects unsupported destination; repeat promotion deduplicates; scope validated; approve/reject/edit/supersede/tombstone retained. |
| S5.2 / S4.4 + S5.1 | Inject only allowed reviewed memory through same context builder; inspect/export/import revisions. | No candidate/expired/cross-project injection; global scope intentional; round-trip and disable behavior; retrieval outage shown. |
| S6.1 / worker proof + S2 + S3 | Run/step/attempt/checkpoint schema; one writer lease; Git plan reference; explicit wait/approval/blocked/reconciliation states; narrow filesystem compatibility. | Double claim race, lease loss, dirty checkout, action ambiguity, approval pause, durable timestamp and cancellation. |
| S6.2 / S6.1 | Bounded DBOS-vs-minimal-Postgres scheduler experiment; use same two-step workload and failure matrix. Choose one scheduler and drain/import old tasks. | Crash during cooldown/effect/checkpoint, workflow upgrade, duplicates, restored DB; counts/ID mapping; documented operational advantage and migration rollback. |
| S7.1 / S3 + S6.1 | One coding-agent adapter with explicit capabilities, normalized events, cancellation/session hint, cooldown and cost/data budget. Prefer existing official provider interfaces. | Simulator conformance first; one live bounded task; expired session rehydrates from Git/checkpoint; no unauthorized provider switch or duplicate write. |
| S7.2 / S7.1 | Add further providers only against same contract; model API and coding-agent process are distinct adapter types. | Text/tool stream, usage, error, timeout, rate limit, approval and resume conformance per pinned version. |
| S8 / incremental | Thin clients expose durable projects/chats, source status, exact approvals and run timeline. Add first-run doctor and packaging after stable contracts. | Fresh WSL2 install, backup/restore, offline startup, upgrade; later macOS/Windows/Termux gates separately recorded. |

S1.1 can begin immediately; S0 does not excuse exposed execution. S4 source correctness work can proceed after S0 evidence while S2 persistence is built in an isolated branch. Retrieval/memory prompt injection waits for S2 scope and context contracts. A provider simulator may be built before S6, but production resumable provider work waits for its durable authority.

### Index architecture details to settle before S4 code

Use a source record plus staged index generation. At minimum track workspace binding, project, relative path/source ID, Git commit or dirty content hash, parser fingerprint, embedding model revision/dimension/normalization, active generation, index time, status/error and chunk offsets. Identity and active-generation switching belong in PostgreSQL; original files remain in the workspace or managed upload store.

Use per-source transactional activation first. Define whole-repository snapshot activation only if consumers actually need cross-file consistency. Reconcile deletions only after a complete successful enumeration; distinguish inaccessible root, cancelled scan and genuinely empty repo. Never infer deletion from a partial scan.

Search only compatible active chunks inside authorized scope; embeddings and lexical indexes refer to the same generation. Model changes are staged, evaluated, then activated. The current 768-dimensional table can remain for the proven initial model; do not redesign arbitrary-dimension storage until a measured candidate requires it. Query embeddings should run in bounded workers so CPU/GPU work does not block async HTTP handling.

## 4. Tool reuse and decisions intentionally deferred

| Candidate | Proposed role | Required decision before adoption |
| --- | --- | --- |
| Existing FastAPI/Postgres/pgvector/Bun | Product skeleton and durable authority. | Fix contracts incrementally; no replacement justified by this audit. |
| Aider repository map | Reference/pilot for a budgeted structural code overview alongside retrieved chunks. | Its map uses repository symbols/references; measure whether a separately exposed map improves fixture answers. Do not import a second complete chat/workspace system. |
| Tree-sitter | Parser adapter behind current chunking interface. | Pin grammar/binding versions and prove offsets/coverage on real languages. |
| Serena / SCIP | Candidates for semantic navigation or persisted symbol relations after basic retrieval works. | Verify exact upstream project/version/license and language/toolchain costs; compare with simpler AST map. Neither is a prerequisite for S0. |
| OpenCode / pi | Candidates for replaceable UI or agent-runtime integrations. | Bounded spike must demonstrate local model tools, cancellation, history export, permission control and provider adapter compatibility; canonical project/chat/run state stays ours. No core adoption chosen here. |
| agent-deck / conduit | Optional operator conveniences outside the core. | Identify exact repositories and confirm workspace/session ownership; terminal management must not become durable job state. |
| Pallium / PAL | Optional bounded consultation or messaging experiments. | Identify exact implementation, trust and persistence limits; defer inter-agent coordination until one safe durable run works. Earlier PAL audit remains historical. |
| DBOS | First durable scheduler candidate after run contract exists. | Restart/effect reconciliation/upgrade experiment; no parallel competing task authority. |

This is an integration placement decision, not a fresh feature certification of every shortlist project. Uniquely identify ambiguous names and verify maintenance, license, extensibility and current APIs when their spike becomes actionable. Repeating a full market survey now would delay the immediate evidence gap.

Primary sources checked for this refresh: [pgvector README](https://github.com/pgvector/pgvector) (exact versus approximate search and filtered recall), [DBOS workflows](https://docs.dbos.dev/python/tutorials/workflow-tutorial) (recorded steps and recovery), [Tree-sitter Python bindings](https://tree-sitter.github.io/py-tree-sitter/), [Aider repository map](https://aider.chat/docs/repomap.html). These support the candidate boundaries; none proves integration with this repo.

Keep `ai-assistant` as a reference and `scripts` as the source of reusable workflow conventions, following the prior audit. No cross-repo merge is proposed by this refresh. Port only independently tested behavior with provenance/license review; do not import duplicate task, vector or workspace stores.

## 5. Agent allocation and handoff rules

Use one owner per writable branch/worktree. The coordinator owns the roadmap branch. Local code repairs use a separate branch from a pinned commit; no simultaneous local/remote editing of that same branch. Read-only audits can run alongside implementation if they consume a fixed commit.

- **Astra:** this bounded architecture/plan review, and later only unresolved cross-system decisions or security/recovery design. Do not spend it on repetitive file inventories.
- **Sol or a competent Gemini coding model:** one implementation package such as S0.1 or a concrete reproduced bug. Give exact paths, base SHA, allowed changes, acceptance IDs, output files and stop conditions.
- **Luna/Flash:** deterministic documentation route/status inventory, limited review of one patch, or evidence triage once scope is clear. Avoid duplicate full-repo reviews.
- **Local GPU models:** fixture suggestions, candidate retrieval queries, summarizing already-redacted logs, draft symbol descriptions and read-only code-map experiments. Human or tested logic verifies gold labels and security claims. Their availability does not justify unlimited context growth or concurrent GPU contention with embedding validation.
- **Human/local host:** run the validator, approve intended destructive/service changes when relevant, report hardware-only observations and accept the finished result.

Start at most one paid implementation agent plus one genuinely independent bounded audit. Stop on missing prerequisite, ambiguous external side effect, scope expansion or exhausted agreed budget; return a concise blocker and evidence. Do not have several models research the same feature by default.

### Required handoff packet

Every assigned package must contain: objective; pinned starting SHA; branch/worktree; owned files; dependencies; exact commands; required environment; mutation boundary; check IDs and expected results; stable report paths; tested versus blocked status; commit SHA; next command for the user. No handoff may end with only “test indexing” or “send logs.”

The next code change is S0.1. Its author must deliver a working command and report path before asking the user to validate. Review the resulting evidence, implement the smallest repair, rerun affected checks, then obtain user acceptance before merge. This documentation commit does not declare S0 or any feature complete.
