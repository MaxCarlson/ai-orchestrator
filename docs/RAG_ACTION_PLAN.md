# Text RAG Completion + Project Ingestion UX Action Plan

## Objective

Complete and harden the new per-project text RAG system, finish integration of the new `text_chunks` / `global_text_chunks` pipeline, and add first-class ingestion workflows for:

- plain-text files
- markdown files
- PDF files
- exported LLM conversations

These workflows must be available from:

- the web UI
- the terminal CLI

The final UX goal is that a user can easily attach documents and conversations to a specific project so they become searchable through that project's text retrieval layer.

---

## High-Level Outcome Required

After this work is complete, the system must support all of the following:

1. **Reliable project-scoped text indexing**
   - Batch indexing of project documents into `text_chunks`
   - Optional global indexing into `global_text_chunks`
   - Hybrid retrieval with dense + BM25 + optional reranker
   - Correct chunk reconciliation on file updates, deletes, and replacements

2. **Direct user ingestion into a project**
   - Upload one or more files from the web UI into a selected project
   - Ingest files directly from the CLI using a short command
   - Ingest exported LLM conversation files into a selected project
   - Support both immediate ingestion and queued ingestion

3. **Usable selection UX**
   - In the web UI: select project from a list, upload files, see progress, success, and failures
   - In the CLI: run something like:

    ```bash
    ai --ingest path/to/file.ext
    ai -i path/to/file.ext
    ```

   and then either:
   - use the currently active/default project, or
   - choose the project from a scrollable / interactive list, or
   - pass the project explicitly

4. **Production-ready behavior**
   - correct cache invalidation
   - correct deletion behavior
   - dedupe / idempotent behavior
   - validation and error handling
   - tests for all core flows

---

## Problems That Must Be Fixed First

## 1. The new text pipeline is not fully wired into the standard indexing flow

### Current problem
The system now contains a strong new document ingestion pipeline:

- `memory/ingest_pipeline.py`
- `memory/langchain_loaders.py`
- `memory/langchain_splitters.py`
- `memory/retrieval.py`
- `text_chunks`
- `global_text_chunks`

However, the regular queued indexing path still appears to route text mode through `memory/embed_repo.py` via `memory/run_embeddings.py` rather than through `index_text_documents()`.

### Required fix
The normal queued text indexing job must use the new structured text ingestion pipeline as the authoritative implementation.

### Required implementation
Update `memory/run_embeddings.py` so that:

- code mode continues to use the code indexing path
- text mode uses `index_text_documents(...)`
- global text mode uses `index_text_documents(...)` with:
  - `table="global_text_chunks"`
  - `owner_column="source_key"`
  - `source_project_id=...`

### Acceptance criteria
- Running queued text indexing populates `text_chunks`
- Running global text indexing populates `global_text_chunks`
- text mode no longer relies on the legacy text storage path for project document retrieval

---

## 2. Deleted files are not removed from the index

### Current problem
`index_text_documents()` reconciles per-file chunk count for files that still exist, but if a file disappears entirely, its chunks remain in the database.

### Required fix
Add full file-level reconciliation.

### Required implementation
During indexing:

1. collect the set of currently discovered source files
2. query the database for all previously indexed files under the same owner scope
3. compute:

- `files_present_now`
- `files_present_before`
- `deleted_files = before - now`

4. delete all chunks belonging to deleted files

### Required helper
Add a helper such as:

```python
async def _delete_removed_files(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    current_file_paths: set[str],
) -> int:
    ...
```

### Acceptance criteria
- removing a file from disk removes all of its chunks on the next indexing run
- removed files no longer appear in search results or chunk listings

---

## 3. Direct ingest does not fully reconcile updates to the same logical source

### Current problem
`ingest_text_direct()` upserts chunks but does not appear to delete stale higher-index chunks when the same `source_label` is reused with shorter content.

### Required fix
Make direct ingestion fully idempotent.

### Required implementation
Refactor `ingest_text_direct()` so it uses the same reconciliation logic as file-backed ingestion:

- fetch existing chunks for `source_label`
- upsert changed/new chunks
- delete stale chunk indices
- optionally delete source entirely before reinsert if that is simpler and safe

### Acceptance criteria
- ingesting the same logical source twice does not leave orphan chunks
- shorter replacements fully replace earlier longer versions

---

## 4. BM25 cache invalidation is incomplete

### Current problem
BM25 invalidation is present for direct ingest but not clearly triggered after batch indexing.

### Required fix
Invalidate BM25 cache whenever any write modifies the searchable text corpus for a project or global scope.

### Required implementation
Invalidate cache after:

- batch project text indexing
- batch global text indexing
- direct text ingest
- file uploads
- conversation ingest
- delete / replace / reindex operations

### Required note
If global search uses `source_key`, invalidation must support both:
- project scope
- global scope

The invalidation API may need either:
- `invalidate_bm25_cache(owner_id)`
- or a more explicit key-based invalidation:
  - `invalidate_bm25_cache(table, owner_column, owner_id)`

### Acceptance criteria
- search results reflect new documents immediately after ingestion/indexing
- no stale BM25 results persist until TTL expiry after writes

---

## 5. Service availability detection must be made real and trustworthy

### Current problem
The frontend now probes service status, but the probed endpoints must actually exist and reliably represent the real service state.

### Required fix
Verify or add the required endpoints.

### Required implementation
Ensure the following are real and stable:

- `/api/system/db`
- `/api/system/lmstudio`
- `/api/orchestrator/stats` or replace with an existing health endpoint

If `/api/orchestrator/stats` does not already exist, add a dedicated lightweight health endpoint such as:

```text
GET /api/orchestrator/health
```

with response:

```json
{
    "status": "ok",
    "service": "orchestrator"
}
```

Then update `services.js` to probe the real endpoint.

### Acceptance criteria
- service badges reflect actual backend state
- memory / embeddings views only show offline state when the orchestrator is actually unavailable

---

## 6. The new frontend modularization should be completed cleanly

### Current problem
The split from `app.js` into `knowledge.js`, `memory.js`, `system.js`, and `services.js` is good, but the boundaries are still mixed.

### Required fix
Complete the extraction so each domain file owns its own helpers.

### Required implementation
Reorganize the frontend roughly as:

- `services.js`
  - service probes
  - badge rendering
  - service gating helpers

- `knowledge.js`
  - projects
  - tasks
  - tracking
  - indexing controls

- `memory.js`
  - memory stats
  - memory add/delete/feedback
  - semantic search
  - text chunk browser
  - document ingest controls

- `system.js`
  - system stats
  - database view
  - LM Studio view
  - logs

- `app.js`
  - only bootstrap, global state setup, view switching, shared glue

### Acceptance criteria
- memory-related helpers are no longer stranded in `system.js`
- `app.js` becomes mostly orchestration/bootstrap code

---

## New Feature Set: Project File + Conversation Ingestion

## User-facing goal

Users must be able to add content to a project's text database from either the web UI or terminal.

Supported content types:

- `.txt`
- `.md`
- `.rst`
- `.markdown`
- `.pdf`
- LLM conversation exports as plain text, markdown, JSON, or NDJSON

This ingestion should attach the content to a selected project and index it into `text_chunks`.

---

## Design Principles

1. **Project-first**
   - every ingest action targets a specific project

2. **Simple UX**
   - selecting a project must be easy
   - file ingestion should not require the user to understand internals

3. **Idempotent**
   - repeated ingest of the same file should not create junk duplicates unless explicitly intended

4. **Traceable**
   - each ingested source should have metadata describing:
     - origin
     - source label
     - ingest time
     - source type
     - upload / CLI / conversation

5. **Extensible**
   - the same ingest infrastructure should later support:
     - web article captures
     - pasted text
     - transcripts
     - screenshots with OCR
     - external tool integrations

---

## Backend Work Required

## 1. Add a durable uploaded-source model

The current `text_chunks` schema stores chunk data, but there should also be a source-level record for uploaded and ingested assets.

### Required new table
Add a source registry table, for example:

```text
project_text_sources
```

Suggested fields:

- `id UUID PRIMARY KEY`
- `project_id UUID NOT NULL`
- `source_label TEXT NOT NULL`
- `source_type TEXT NOT NULL`
- `original_filename TEXT NULL`
- `stored_path TEXT NULL`
- `mime_type TEXT NULL`
- `sha256 TEXT NULL`
- `ingest_method TEXT NOT NULL`
- `status TEXT NOT NULL`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### Suggested `source_type` values
- `uploaded_file`
- `pdf`
- `plain_text`
- `markdown`
- `conversation_export`
- `api_direct`
- `repo_file`

### Suggested `ingest_method` values
- `web_upload`
- `cli`
- `api`
- `repo_scan`

### Why this is needed
This gives the system a source-of-truth record for:

- what was uploaded
- what project it belongs to
- how to reprocess / replace / delete it
- file metadata and dedupe
- UI listing and status display

### Acceptance criteria
- every uploaded / directly ingested source has a source-level registry record
- chunk records can be traced back to their source label or source id

---

## 2. Extend chunk metadata to reference source identity

### Required fix
Chunks should be tied to a stable source identity, not just `file_path`.

### Required implementation
Add either:
- `source_id UUID REFERENCES project_text_sources(id)`, or
- a stronger stable `source_label` / `source_key` linkage

Best option: use `source_id`.

### Acceptance criteria
- deleting an uploaded asset can delete all chunks for that exact source
- replacing an uploaded asset can reconcile chunks cleanly

---

## 3. Add file upload endpoints

### Required endpoints

#### Upload one or more files to a project
```text
POST /memory/upload-files/{project_id}
```

Multipart form-data.

Inputs:
- one or more files
- optional flags:
  - `replace_existing`
  - `dedupe_by_hash`
  - `reindex_if_same_name`
  - `conversation_format`

Behavior:
- store files in a controlled upload directory
- create `project_text_sources` rows
- queue ingestion or ingest immediately depending on size
- return per-file status

#### List uploaded sources for a project
```text
GET /memory/sources/{project_id}
```

#### Delete a source from a project
```text
DELETE /memory/sources/{project_id}/{source_id}
```

Behavior:
- delete source row
- delete associated chunks
- optionally remove stored file
- invalidate cache

#### Reingest or replace a source
```text
POST /memory/sources/{project_id}/{source_id}/reingest
POST /memory/sources/{project_id}/{source_id}/replace
```

### Acceptance criteria
- files can be uploaded through the API
- upload results are visible in the UI
- deleting a source removes its chunks

---

## 4. Add a unified source ingestion service

### Required fix
Do not scatter ingestion logic across endpoints.

### Required implementation
Create a source-level ingestion orchestration layer, for example:

```text
memory/source_ingestion.py
```

Responsibilities:
- accept uploaded files or raw content
- determine source type
- normalize the input
- call the correct loader / conversation parser / splitter
- write source metadata
- index chunks
- invalidate cache
- handle replacement / dedupe rules

### Required public functions
Suggested functions:

```python
async def ingest_uploaded_files(...)
async def ingest_source_file(...)
async def ingest_conversation_export(...)
async def delete_project_source(...)
async def reingest_project_source(...)
```

### Acceptance criteria
- all ingestion entrypoints use the same core service
- API, CLI, and UI reuse the same backend behavior

---

## 5. Add conversation ingestion support

### Goal
LLM conversation exports should be ingested as searchable project text.

### Supported input forms
The system should support at least:

- plain text transcript
- markdown transcript
- JSON export
- NDJSON export

### Required behavior
The system should normalize conversation content into structured text before chunking.

### Required normalization rules
For conversation input:

- preserve chronological order
- preserve speaker role labels:
  - `user`
  - `assistant`
  - `system`
  - `tool` if present
- preserve timestamps if available
- preserve conversation title if available
- optionally preserve message boundaries with lightweight markup

### Suggested normalized format
Example:

```text
Conversation: Debugging text indexing
Date: 2026-04-03

[USER]
Why is my text pipeline not indexing PDFs?

[ASSISTANT]
Possible causes include...
```

### Required implementation
Create something like:

```text
memory/conversation_ingest.py
```

with parsers for:
- plain transcript
- markdown transcript
- JSON conversation exports

### Acceptance criteria
- imported conversations become searchable per project
- query results return meaningful snippets with role/context preserved

---

## 6. Add upload storage management

### Required behavior
Uploaded files must be stored in a known root on disk.

### Suggested path layout
```text
<storage_root>/project_uploads/<project_id>/<source_id>/<original_filename>
```

### Required rules
- sanitize filenames
- do not trust client filenames
- compute hash after write
- optionally reject oversized files
- keep storage path in source metadata

### Acceptance criteria
- uploaded files are stored safely and traceably
- source record includes stable stored path and hash

---

## CLI Work Required

## Goal
The CLI must support lightweight, ergonomic project ingestion from the terminal.

The minimum requirement is:

```bash
ai --ingest path/to/file.ext
ai -i path/to/file.ext
```

But it should also support multi-file and project selection.

---

## 1. Add a first-class ingest subcommand and short flag flow

### Required CLI UX
Support both:

```bash
ai --ingest path/to/file.ext
ai -i path/to/file.ext
```

and:

```bash
ai ingest path/to/file.ext
```

### Recommended behavior
If a project is not explicitly supplied:

1. use current/default project if configured
2. otherwise show interactive project selection
3. if interactive mode is unavailable, print a numbered project list and prompt

### Strongly recommended flags
Use both short and long forms for every argument.

Examples:

```bash
ai -i path/to/file.ext
ai -i file1.pdf file2.txt
ai -i path/to/file.ext -p my-project
ai -i path/to/file.ext --project my-project
ai ingest path/to/file.ext --conversation
ai ingest conversation.json --project my-project --source-label chat-debug-session
```

### Suggested arguments
- `-i`, `--ingest`
- `-p`, `--project`
- `-s`, `--source-label`
- `-c`, `--conversation`
- `-r`, `--replace`
- `-d`, `--dedupe`
- `-j`, `--json` for machine-readable output
- `-y`, `--yes` to skip interactive confirmation

### Acceptance criteria
- user can ingest a file with one short command
- project selection is easy and ergonomic

---

## 2. Add project selection UX for terminal users

### Goal
Terminal users interact with LLMs constantly, so the project picker must be frictionless.

### Required behavior
When no project is supplied:

- if `fzf` is available, use it
- otherwise show a numbered scrollable/interactive list where possible
- otherwise print a simple numbered prompt

### Suggested order
Sort projects by:
- currently active/default project first
- recently active next
- alphabetical fallback

### Acceptance criteria
- selecting a project from terminal is fast
- no one is forced to copy/paste raw UUIDs

---

## 3. Support multiple file ingest in one command

### Required behavior
The CLI must accept multiple input paths:

```bash
ai -i notes.md paper.pdf transcript.json
```

### Required backend behavior
Each input path should:
- create or reuse a source record
- be ingested independently
- return per-file result status

### Acceptance criteria
- one command can attach multiple files to a project
- partial failures do not destroy the whole batch result
- CLI returns clear success/failure output per file

---

## 4. Add conversation-specific CLI shortcuts

### Required UX
Make conversation ingestion explicit and easy.

Examples:

```bash
ai ingest chat_export.json --conversation
ai ingest chat.md -c
```

Optionally later:

```bash
ai ingest-conversation path/to/export.json
```

### Acceptance criteria
- conversation export files can be distinguished from generic documents when needed
- conversation parser selection is deterministic and testable

---

## Web UI Work Required

## Goal
The web UI must let the user quickly choose a project and upload files that become part of that project's searchable text corpus.

---

## 1. Add a project documents / sources panel

### Required location
Add this under either:
- the project/knowledge section, or
- the memory section scoped to the selected project

Best option:
- inside the project/knowledge view for the currently selected project

### Required UI elements
Add a panel such as:

- **Project Documents**
- list of existing project sources
- upload button
- drag-and-drop target
- delete / reingest actions
- status badges

Each source row should show:
- source label
- original filename
- type
- size if known
- ingest status
- created time
- action buttons

### Acceptance criteria
- user can see what files/conversations belong to a project
- sources are manageable from the UI

---

## 2. Add upload flow for files

### Required flow
1. user selects a project
2. user clicks upload or drags files in
3. UI sends multipart request
4. backend queues or performs ingestion
5. UI shows status:
   - uploading
   - ingesting
   - indexed
   - failed

### Required supported file types
- `.txt`
- `.md`
- `.rst`
- `.markdown`
- `.pdf`
- `.json`
- `.ndjson`

### Acceptance criteria
- multi-file upload works
- result messages are specific per file
- uploaded files become searchable in project text search

---

## 3. Add conversation upload affordance

### Required UX
The UI should make it obvious that conversation exports are valid inputs.

### Required implementation
Either:
- one shared upload control with helper text
- or two tabs:
  - Documents
  - Conversations

Helper text should clarify that supported uploads include:
- plain text
- PDFs
- exported LLM chats

### Acceptance criteria
- users understand they can upload conversation exports without guesswork

---

## 4. Add project text search UI

### Goal
Now that project documents are uploadable, the UI should expose project text retrieval directly.

### Required UI
For the selected project, add:
- text search input
- reranker toggle
- result count selector
- results list showing:
  - file/source label
  - chunk type
  - header context
  - snippet
  - similarity / rerank / hybrid indicators optionally

### Endpoint
Use:

```text
POST /memory/text-search/{project_id}
```

### Acceptance criteria
- newly uploaded content is discoverable through the UI
- results show which source they came from

---

## 5. Add source deletion / replacement / reingest controls

### Required actions
For each source in the UI:
- delete source
- reingest source
- replace source file

### Acceptance criteria
- source lifecycle is manageable without DB surgery
- deleting a source removes it from chunk listings and retrieval

---

## Retrieval and Metadata Improvements

## 1. Improve chunk response schema

### Current issue
`TextChunkResponse` exists, but the API should expose richer source-level metadata once project sources are added.

### Required additions
Return fields such as:
- `source_id`
- `source_label`
- `original_filename`
- `mime_type`
- `ingest_method`

### Acceptance criteria
- search results and chunk listings can identify the true source clearly

---

## 2. Improve conversation chunk labeling

### Required behavior
Conversation chunks should include metadata such as:
- `chunk_type = "conversation_turns"` or similar
- `header_context = conversation title / section / date`
- optional role markers embedded in content

### Acceptance criteria
- search results from conversations are distinguishable from document chunks

---

## 3. Add dedupe strategy

### Required behavior
Uploads and CLI ingest should optionally dedupe by content hash.

### Minimum rules
- same project + same hash + same source type may reuse the source or prompt replacement behavior
- dedupe must be configurable, not silently destructive

### Acceptance criteria
- repeated accidental uploads do not spam duplicates when dedupe is enabled

---

## Testing Requirements

## 1. Backend unit tests

Add tests for:

- `index_text_documents()`
- deleted file reconciliation
- stale chunk deletion
- `ingest_text_direct()` replacement behavior
- BM25 cache invalidation
- `hybrid_search()`
- conversation normalization / parsing
- file upload ingestion service
- source deletion and reingestion

### Required edge cases
- empty file
- short replacement content
- deleted file
- duplicate upload
- unsupported file type
- malformed JSON conversation export
- PDF loader unavailable
- reranker unavailable

---

## 2. API tests

Add tests for:

- `POST /memory/text-search/{project_id}`
- `POST /memory/text-index/{project_id}`
- `POST /memory/ingest-text/{project_id}`
- `POST /memory/upload-files/{project_id}`
- `GET /memory/sources/{project_id}`
- `DELETE /memory/sources/{project_id}/{source_id}`

### Acceptance criteria
- APIs validate input correctly
- APIs return consistent structured responses
- error payloads are actionable

---

## 3. CLI tests

Add tests for:

- `ai -i path/to/file.ext`
- `ai ingest path/to/file.ext`
- project selection fallback logic
- multi-file ingest
- explicit project argument
- conversation ingest flag
- JSON output mode

### Acceptance criteria
- CLI behavior is deterministic
- interactive and non-interactive modes both work

---

## 4. Frontend tests or manual validation checklist

At minimum validate:

- service status bar reflects backend truth
- memory view offline gating works
- project source upload works
- chunk listing updates after upload
- project text search returns newly uploaded content
- delete source removes search results
- replacement source updates search results
- project selection is preserved

---

## Recommended Implementation Order

## Phase 1: Finish correctness of the new text pipeline
1. wire `run_embeddings.py` text mode to `index_text_documents()`
2. add deleted file reconciliation
3. fix `ingest_text_direct()` stale chunk cleanup
4. add complete cache invalidation
5. verify/fix health endpoints
6. add tests for the above

### Deliverable
The new text RAG pipeline is correct and production-safe.

---

## Phase 2: Add source registry and ingestion service
1. add `project_text_sources`
2. add source linkage from chunks
3. create `memory/source_ingestion.py`
4. implement upload-backed source ingest
5. implement delete / replace / reingest flows
6. add tests

### Deliverable
The backend can track user-added project sources robustly.

---

## Phase 3: Add conversation ingestion
1. create `memory/conversation_ingest.py`
2. support `.txt`, `.md`, `.json`, `.ndjson`
3. normalize into searchable structured text
4. add tests

### Deliverable
LLM conversations can be ingested and searched like project knowledge.

---

## Phase 4: Add CLI ingestion UX
1. add `ai -i` / `ai ingest`
2. add project selection flow
3. add multi-file support
4. add conversation flag
5. add machine-readable output
6. add tests

### Deliverable
Terminal workflows become first-class.

---

## Phase 5: Add web UI ingestion UX
1. add project sources panel
2. add upload flow
3. add source management actions
4. add project text search UI
5. complete frontend modularization cleanup
6. validate UX end-to-end

### Deliverable
Users can manage project knowledge visually from the web UI.

---

## Specific File-Level Work Items

## Backend
- `memory/run_embeddings.py`
- `memory/ingest_pipeline.py`
- `memory/retrieval.py`
- `memory/models.py`
- `memory/manager.py`
- `memory/model_registry.py`
- `memory/langchain_loaders.py`
- `memory/langchain_splitters.py`
- `memory/source_ingestion.py` **new**
- `memory/conversation_ingest.py` **new**
- `docker/orchestrator/main.py`
- `docker/orchestrator/requirements.txt`

## API proxy / web backend
- `orchestrator_web_viewer/orchestrator_web_viewer/api/memory_proxy.py`
- add upload/source endpoints to the appropriate API layer

## Frontend
- `orchestrator_web_viewer/orchestrator_web_viewer/static/app.js`
- `orchestrator_web_viewer/orchestrator_web_viewer/static/knowledge.js`
- `orchestrator_web_viewer/orchestrator_web_viewer/static/memory.js`
- `orchestrator_web_viewer/orchestrator_web_viewer/static/system.js`
- `orchestrator_web_viewer/orchestrator_web_viewer/static/services.js`
- `orchestrator_web_viewer/orchestrator_web_viewer/static/index.html`
- `orchestrator_web_viewer/orchestrator_web_viewer/static/style.css`

## CLI
- whichever file currently implements the `ai` command entrypoint
- add ingest command handling there
- add terminal project-selection helper if not already present

---

## Definition of Done

This work is only done when all of the following are true:

- queued text indexing uses the new `text_chunks` pipeline
- deleted files are removed from the index
- direct ingest is idempotent and reconciles stale chunks
- BM25 cache invalidates correctly after all writes
- service probes reflect real backend status
- users can upload files to a project in the web UI
- users can ingest files into a project from the CLI with `ai -i ...`
- users can ingest LLM conversation exports into a project
- users can browse and manage project sources
- users can search uploaded project text in the UI
- tests cover the core backend, API, and CLI flows

---

## Explicit Instructions for the Implementing LLM

Follow these instructions exactly.

1. **Do not replace the new text RAG architecture with the legacy path.**
   - Keep `text_chunks` / `global_text_chunks` as the canonical path for document retrieval.

2. **First fix correctness before adding UX.**
   - Wire the new indexing path fully.
   - Fix deletion and stale chunk reconciliation.
   - Fix cache invalidation.
   - Verify service health endpoints.

3. **Introduce a source registry before building upload UX.**
   - Do not build uploads on top of raw chunk rows alone.
   - Add source-level records so files/conversations can be listed, replaced, deleted, and reingested.

4. **Create one shared ingestion service.**
   - API, CLI, and web UI must all call the same backend ingestion logic.
   - Avoid separate behavior paths for upload vs CLI vs conversation ingest.

5. **Implement conversation ingest as normalized structured text.**
   - Preserve role boundaries and order.
   - Make imported chats searchable and interpretable.

6. **Make the CLI ergonomic.**
   - Support `-i` and `--ingest`.
   - Support explicit or interactive project selection.
   - Support multiple files in one call.
   - Include machine-readable output.

7. **Make the web UI project-centric.**
   - The user should always understand which project they are ingesting into.
   - Show sources, upload controls, status, and search together.

8. **Keep the frontend modular.**
   - Continue the split away from the monolithic `app.js`.
   - Move memory logic fully into `memory.js`.
   - Keep `app.js` lean.

9. **Add tests alongside implementation.**
   - Do not postpone test coverage until the end.
   - Each phase should include its own tests.

10. **Prefer clean reconciliation over patchy mutation.**
    - When a source is updated or replaced, the stored chunks must exactly match the current source content.

---

## Suggested Nice-to-Haves After Core Delivery

These are not part of the initial required delivery, but the architecture should not block them:

- drag-and-drop upload
- paste raw text into a project from the UI
- bulk delete / bulk reingest
- source tags or categories
- automatic OCR pipeline for images/screenshots
- project-level ingest quotas / file size limits
- per-source last search-hit metadata
- conversation viewer for imported chat sources

---

## Merge Recommendation

Do **not** treat the current work as fully complete yet.

It should be treated as:

- a strong architectural step
- a good frontend modularization start
- a partially integrated text RAG foundation

The next implementation should:
1. finish correctness,
2. add source-level ingestion infrastructure,
3. then add CLI and web UX on top of that shared ingestion core.
