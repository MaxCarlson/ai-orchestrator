• # Plan

  We will focus on two tracks: (1) bootstrapping  GPU-powered, code-aware indexing and retrieval  (vector-first, with incremental steps toward    hybrid/pagerank), and (2) standardizing KM/     KMTUI/KOWEB to always point at the WSL2 hoster  database. The approach is to define the         minimal schema + pipeline first, wire it into   the orchestrator, then validate end-to-end      with a small repo and a KM task assignment.                                                     ## Scope                                                                                        - In: code-aware indexing schema + chunker +      embedding + retrieval + orchestrator context    injection; KM/KMTUI/KOWEB host DB               configuration alignment.                      - Out: full UI work, advanced pagerank/graph      ranking, multi-worker scheduling beyond         basic orchestration.                                                                          ## Action items                                                                                 [ ] Review memory/advanced-code-embedding-      implementation-plan.md and select the minimal   Phase 1 subset (AST chunking + CodeBERT         embeddings + vector-only retrieval).            [ ] Define the new code_chunks schema and       create a migration/init path alongside memory/  models.py or orchestrator bootstrap.            [ ] Implement a symbol-aware chunker module     (Python AST first; safe fallback for            unsupported files).                             [ ] Implement the embedding adapter (CodeBERT   768-dim) with GPU/CPU fallback and batch        embedding.                                      [ ] Implement incremental indexer (content      hash skip) and wire a minimal code-search API   in the orchestrator.                            [ ] Inject top‑K code context into task JSON    before CLI worker spawn (cap size and include   file/line metadata).                            [ ] Standardize KM/KMTUI/KOWEB env config for

  ## Open questions

  - Confirm the exact host/port to use as the
    “hoster DB” for KM/KMTUI/KOWEB on this WSL2
    instance.
  - Prefer env vars (shell config) only, or also
    add a shared .env/config file for
    repeatability?
  - Should the first iteration include lexical
    search (tsvector) or stay vector-only until
    the GPU pipeline is stable?



  ## Open questions

  - Confirm the exact host/port to use as the
    “hoster DB” for KM/KMTUI/KOWEB on this WSL2
    instance.
  - Prefer env vars (shell config) only, or also    add a shared .env/config file for
    repeatability?
  - Should the first iteration include lexical
    search (tsvector) or stay vector-only until
    the GPU pipeline is stable?


› 1. Don't know or really care.. just make sure
  its not commonlg used by other programs  of

  ## Open questions

  - Confirm the exact host/port to use as the
    “hoster DB” for KM/KMTUI/KOWEB on this WSL2     instance.
  - Prefer env vars (shell config) only, or also
    add a shared .env/config file for
    repeatability?
  - Should the first iteration include lexical
    search (tsvector) or stay vector-only until
    the GPU pipeline is stable?

