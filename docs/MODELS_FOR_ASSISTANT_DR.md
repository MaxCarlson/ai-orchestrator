# Best Local Model Stack for Max’s Agentic AI Assistant on a 32GB RTX 5090

## Hardware and hard constraints that shape the stack

Your GPU budget is unusually favorable for local agent work: a entity["company","NVIDIA","gpu manufacturer"] RTX 5090 has **32 GB of GDDR7** VRAM and very high memory bandwidth (1,792 GB/s). citeturn36search0turn36search4 That VRAM size is the real gating factor for “one or two large models” running locally: it supports **~30–36B-class** models comfortably with 4-bit weight quantization and a practical context window, but it does *not* support today’s frontier open-weight MoE flagships (hundreds of billions of total parameters) fully resident.

Two memory facts matter more than parameter count headlines:

The **weights are only the starting point**. Even if a model’s quantized weights fit, you still need runtime overhead plus **KV-cache** (context window memory), which grows with prompt length and generation length. The entity["organization","Google AI for Developers","developer documentation"] Gemma 4 documentation explicitly calls out that published “base weight” memory estimates **exclude** the additional VRAM needed for software overhead and **exclude KV-cache**, which increases dynamically with total tokens. citeturn35view0

For long-context models, **context length is the silent VRAM killer**. A model advertising 256K context is not a promise you can *use* 256K on a 32GB card at good throughput; it’s a promise you can *configure that maximum*, and you’ll choose a smaller cap for day-to-day agent work unless you offload KV-cache or reduce batch/parallelism. citeturn35view0turn22view0turn7view0

Given your repo’s architecture (router → specialized agent → RAG), the best practical interpretation of “the entire model stack must always fit on my GPU” is:

You can keep **one large “active” LLM** resident most of the time, plus one or more small always-on models (router + embedder + reranker). When you switch major modes (agentic coding vs deep research vs bulk indexing), you **swap** the large model rather than trying to keep two big ones loaded concurrently.

## Best large model for agentic coding and patch generation

For your “agentic coding” slot, the highest-signal, locally runnable pick (32GB-safe) is **Devstral Small 2 24B Instruct** from entity["company","Mistral AI","llm developer"].

It is explicitly positioned as an **agentic software engineering model** (tool-driven codebase exploration, multi-file editing, SWE-agent style workflows). citeturn22view0 Its model card reports:

- **SWE-bench Verified: 68.0%** (and 55.7% on SWE-bench Multilingual). citeturn22view0  
- **256K context window**, which is specifically helpful for “repo-scale” tasks, even if you often run smaller caps day-to-day for VRAM reasons. citeturn22view0  
- A practical deployment claim: “light enough to run on a single RTX 4090,” implying it is designed with single-GPU local serving in mind (your RTX 5090 has more VRAM headroom than a 4090). citeturn22view0  
- Direct guidance for **tool calling in vLLM** (tool-call parser + auto tool choice). citeturn22view0turn37search8  

Why this fits your repo’s requirements:

Devstral’s strengths align with the parts of your orchestrator that are hardest to “prompt around”: multi-step tool use, iterated patching, and iterative repo navigation—exactly the behaviors evaluated by SWE-bench-style setups. citeturn22view0turn20view0

Practical notes for your 32GB constraint:

Although Devstral advertises 256K context, treat that as **maximum configurable length**, not a default. Your orchestrator should set a “working context cap” per task (e.g., ~16K–64K typical), and only escalate when needed (and when RAG can’t substitute for raw context). This is the same memory-planning warning repeatedly emphasized in long-context model docs: KV-cache drives incremental VRAM growth with token count. citeturn35view0turn22view0

Strong alternatives for the agentic coding slot (still 32GB-feasible):

**Qwen3-Coder-30B-A3B-Instruct** (Apache-2.0, MoE with ~3.3B activated; 256K context) is also explicitly built for tool calling and “repository-scale understanding.” citeturn7view0turn32search1 As a local coding agent it’s credible, but the strongest widely cited SWE-bench number attached to this specific model in public discussions is ~51–52% (with scaffolding details varying), notably below Devstral Small 2’s 68%. citeturn32search2turn22view0

In practice: if you want one “coding-first” model that behaves like a serious code agent out of the box, Devstral Small 2 is the best anchor model for that role on a single 32GB GPU. citeturn22view0turn37search8

## Best large model for agentic research, planning, and general orchestration

For “Google Deep Research”-style work, you want a model that combines:

- high reasoning quality,
- robust tool calling / structured output,
- strong long-context handling for reading sources,
- and enough coding skill to move fluidly between analysis and implementation.

The strongest “fits in 32GB, open-weights, agent-ready” candidate *as of April 2026* is **Gemma 4 31B instruction-tuned**, built by entity["organization","Google DeepMind","ai research lab"]. citeturn27view0turn37search5

What makes it unusually compelling for your repo:

The Gemma 4 31B model card reports very strong scores across **reasoning, coding, and tool/agent evals**, including (selected highlights):

- **LiveCodeBench v6: 80.0%** and **Codeforces Elo: 2150** (coding strength). citeturn27view0  
- **Tau2 (agent/tool benchmark): 76.9%** (agentic/tool competence signal). citeturn27view0  
- **MMLU-Pro: 85.2%** and **GPQA Diamond: 84.3%** (broad, hard knowledge/reasoning). citeturn27view0  
- Explicit “Enhanced Coding & Agentic Capabilities” with **native function calling support**, plus native system prompt support. citeturn27view0turn35view0turn37search5  

Most importantly for your GPU constraint, the Gemma 4 docs provide explicit base weight memory guidance:

- **Gemma 4 31B at Q4_0 (4-bit) is ~17.4 GB** just to load the weights. citeturn35view0  

That leaves meaningful VRAM headroom on a 32GB RTX 5090 for:

- KV-cache at sane working context sizes,
- an embedding model,
- a reranker,
- and your serving/runtime overhead. citeturn35view0  

This is unusually well-aligned with your architecture: a powerful “research/planning/general agent” plus separate specialized coding and retrieval components.

High-quality alternatives for this “deep research” slot

If you want multiple top-tier options (because local model quality and tooling evolve quickly), these are the best “near-top performance” substitutes that still plausibly fit in 32GB with quantization:

**Seed-OSS-36B-Instruct** from entity["company","ByteDance","technology company"] is an Apache-2.0 open model explicitly positioned for long-context reasoning and “agentic intelligence” (tool use and issue resolving), with an explicit “thinking budget” control concept similar to your minimal/advanced modes. citeturn39search0turn39search7 It is slightly larger than Gemma 4 31B but the same class (mid-30B), and should be viable on 32GB with 4-bit weights in most inference stacks.

**Qwen3-32B** from entity["company","Alibaba","technology company"] is open-weighted under Apache-2.0, supports switching between “thinking” and “non-thinking” modes, and is explicitly optimized for coding and agentic capabilities. citeturn4view1turn31view0 When quantized, it’s workable on a single GPU: the Qwen team’s own benchmark page reports that **Qwen3-32B with AWQ INT4** uses about **19.1 GB** VRAM at minimal input length and rises with longer inputs (e.g., **~27.7 GB** around a ~30K input length in their test setup), underscoring that context and runtime overhead matter. citeturn29view0

**DeepSeek-R1-Distill-Qwen-32B** (MIT license) is an excellent “deep reasoning” specialist and includes strong benchmark claims for dense models (e.g., LiveCodeBench pass@1 and Codeforces rating in its model card). citeturn38view0 The main caveat is integration ergonomics: its own usage recommendations discourage adding system prompts and note behaviors that can affect performance, which can be inconvenient for an orchestrator that relies heavily on system-role policy prompting and structured schemas. citeturn38view0

Practical recommendation for your “two large models” budget

If you want the cleanest specialization split (and the best “agentic coding” and “agentic research” you can reasonably run locally on 32GB):

- **Large Model A (Deep Research / Planning / General Agent): Gemma 4 31B-it**, in thinking mode when needed. citeturn27view0turn35view0turn37search5  
- **Large Model B (Agentic Coding / Repo Editing): Devstral Small 2 24B**. citeturn22view0turn37search8  

That pairing gives you two complementary “workhorse” agents with strong published evidence for exactly the tasks your repo is designed to route. citeturn22view0turn27view0turn35view0

## On-GPU RAG models for chat, documents, and codebases

Your repo’s design calls for at least three retrieval components:

- an embedding model for **text and conversation memory**,  
- an embedding model for **code**,  
- and a **reranker** for quality.

Text and conversation embeddings

The most practical default for your stack is:

**Qwen3-Embedding-0.6B** (text embedding): it is small enough for “always-on” GPU usage and is explicitly configured for retrieval pipelines.

Key published properties:

- **32K context length** for embedding long chunks, and
- adjustable **embedding dimensionality up to 1024** (useful if you want smaller vectors for speed/storage). citeturn37search3  

The Qwen team positions the Qwen3 embedding/reranking series as state-of-the-art across multiple embedding and reranking benchmarks, and also publishes reference implementations for combining embedding + reranking in RAG. citeturn30search16turn37search15

If you’d like a “quality-first” upgrade while still remaining GPU-feasible, you can swap to a larger Qwen3 embedding size (4B or 8B) during heavy indexing windows, then switch back to 0.6B for day-to-day query embedding to maximize responsiveness. (This matches your “offload / swap models” allowance.)

Code embeddings

For code RAG specifically, the best “purpose-built” option in the open ecosystem remains:

**nomic-embed-code (7B)** from entity["company","Nomic AI","ai company"].

It is explicitly described as a **state-of-the-art code retriever** and is reported to achieve SOTA performance on CodeSearchNet in Nomic’s release materials. citeturn30search2turn30search6 A practical advantage for your repo is ecosystem support:

- There are GGUF/llama.cpp-compatible builds for local embedding servers, and community packaging highlights its **32K context support** and multi-language code focus. citeturn37search2turn37search10  

This is a strong fit for your “structural awareness” code RAG goals: high-quality code embeddings reduce your dependence on the main LLM reading entire repositories in-context.

Reranking

A reranker is the most cost-effective leverage point for RAG quality once you have “good enough” embeddings.

Two top-tier open options that fit easily on your GPU:

**Qwen3-Reranker (0.6B / 4B / 8B)**: designed explicitly for reranking; the Qwen team publishes both the models and reference code for integrating them into RAG. citeturn30search4turn37search15

**bge-reranker-v2-m3**: a cross-encoder reranker (query + passage → relevance score) designed for second-stage refinement, a standard and well-supported pattern in modern RAG systems. citeturn30search1turn30search5

If you want a single default: pick Qwen3-Reranker-0.6B for simplicity and “same-family” pairing with Qwen3 embeddings, and move to larger rerankers only if your evaluation shows consistent gains. citeturn30search4turn37search15

A strong “hybrid retrieval” alternative

If you want a single embedding model that supports **dense + lexical + multi-vector** retrieval (helpful for hybrid pipelines when BM25 plus dense embeddings are both important), **BGE-M3** is explicitly positioned as supporting all three retrieval methods and achieving strong performance on multilingual and cross-lingual benchmarks. citeturn30search10turn2search8 This can simplify your retrieval layer if you want fewer moving parts at the cost of deviating from Qwen3’s embedding/rerank ecosystem.

## Small models for routing, summarization, and transcript cleanup

A multi-model assistant like yours benefits dramatically from a cheap, fast “front model” that decides what to do next and whether to wake up the expensive agent.

Routing / intent classification (minimal mode)

Use a very small model with strong instruction following and low VRAM footprint. Since you’re already likely to include Gemma 4 in the stack, the cleanest option is:

**Gemma 4 E2B** as the router. It has tiny memory needs in 4-bit and is designed for on-device execution. The Gemma documentation’s inference memory table reports approximately **3.2 GB at Q4_0** for E2B (weights only). citeturn35view0

As a pragmatic router design, this lets you:

- detect “simple request, no tools” vs “needs RAG” vs “needs coding agent,”
- enforce structured schemas (JSON routing outputs),
- and keep CLI interactions snappy.

Summarization / memory compression

This workload wants coherence and instruction following, but doesn’t require 31B-scale intelligence most of the time.

**Gemma 4 E4B** is a strong candidate: still small, but much more capable than E2B. The same Gemma memory table reports around **5.0 GB at Q4_0** for E4B (weights only). citeturn35view0

If you prefer to stay in the Qwen ecosystem for small models, Qwen3’s smaller open-weight dense models (e.g., 4B) are explicitly part of the family and intended for local use. citeturn31view0

Conversation ingestion / transcript cleanup

This is closely related to summarization but often benefits from:

- de-duplication,
- standardizing formatting,
- extracting structured “memory items,”
- and generating stable titles/tags.

A practical best practice is to use the same “summarizer” model (Gemma 4 E4B) for ingestion and compression so you get consistent style and schema formatting across stored memory. citeturn35view0turn27view0

## A concrete “best stack” recommendation and how it fits in 32GB

Below is a stack that emphasizes (a) top-tier local agentic coding and (b) top-tier local research/planning, while respecting your 32GB GPU limit by swapping the active large model.

Large LLMs (swap by mode)

**Agentic research / planning (Advanced mode): Gemma 4 31B-it (Q4_0 or similar)**  
- Fits locally: base weights ~17.4 GB at Q4_0 (weights only). citeturn35view0  
- Strong published reasoning, coding, and tool/agent benchmarks (LiveCodeBench, Codeforces, Tau2). citeturn27view0turn37search5  
- Native function calling + structured JSON + system role support for orchestrators. citeturn27view0turn37search1turn35view0

**Agentic coding / patcher (Advanced mode for code changes): Devstral Small 2 24B (FP8 if possible; otherwise quantized)**  
- Designed for tool-driven code agent workflows. citeturn22view0turn37search8  
- Strong SWE-bench Verified score (68%). citeturn22view0

Always-on small LLMs (minimal mode + support)

**Router / classifier: Gemma 4 E2B (Q4_0)**  
- Very low VRAM footprint (~3.2 GB weights-only at Q4_0). citeturn35view0  

**Summarizer / memory writer: Gemma 4 E4B (Q4_0)**  
- Low VRAM footprint (~5.0 GB weights-only at Q4_0). citeturn35view0  

RAG models (can be kept loaded with the active LLM, or swapped during indexing)

**Text/chat embeddings: Qwen3-Embedding-0.6B**  
- 32K context and up to 1024 dimensions. citeturn37search3  
- Purpose-built for embedding + retrieval, with an accompanying reranker family. citeturn37search15turn30search16  

**Code embeddings: nomic-embed-code (7B)**  
- Positioned as SOTA for code retrieval (CodeSearchNet) and broadly used for local codebase indexing. citeturn30search2turn37search10turn37search2  

**Reranker: Qwen3-Reranker-0.6B (default) or bge-reranker-v2-m3 (alt)**  
- Cross-encoder reranking is explicitly recommended as a second-stage refinement step for retrieval systems. citeturn30search5turn30search1turn37search15  

Why this stays within VRAM

Gemma 4 31B at 4-bit (weights-only) is ~17.4 GB. citeturn35view0 Your always-on embedder + reranker + small router/summarizer can be arranged so that only a subset is loaded concurrently during interactive sessions (router can be CPU-bound if needed), leaving enough VRAM for KV-cache at workable context sizes. The key is to enforce per-mode limits because KV-cache grows with token count. citeturn35view0

If you want a “single large model” fallback

If managing two large models feels operationally heavy at first, you can start with **Gemma 4 31B** as your only big model and route both research and coding through it, then add Devstral Small 2 once you’re ready to optimize the coding path. Gemma 4 is explicitly positioned as strong on coding and agentic workflows, with native tool calling and strong coding evals. citeturn27view0turn37search5

## Validation criteria for “best” in your repo’s context

Because your orchestrator is explicitly multi-workload, you’ll get the most reliable model selection by validating on **the kinds of tasks your system actually runs**, not just general benchmarks.

For agentic coding, SWE-bench Verified is directly aligned with your “multi-step patch + tooling” objective. citeturn20view0turn22view0 Devstral Small 2’s published 68% provides a strong baseline expectation. citeturn22view0

For agentic research, favor models with:

- proven tool/agent eval performance (Gemma 4 reports Tau2), citeturn27view0  
- strong long-context design (256K support), citeturn27view0turn35view0  
- and explicit function calling support suitable for orchestrators. citeturn37search1turn37search5  

For RAG quality, evaluate retrieval end-to-end:

- embeddings only vs embeddings + rerank (rerankers are widely described as the standard second-stage precision booster). citeturn30search5turn30search1  
- code retrieval separately from doc retrieval (your repo already models these as separate chunk stores, which makes it natural to use separate embedders). citeturn30search2turn37search3  

If you adopt the recommended stack, you end up with exactly what your repo brief asks an evaluator to produce: a **model stack**—specialized by workload, with a cheap/fast path and an advanced high-accuracy path—while staying inside a single 32GB consumer GPU by swapping only the currently active large model. citeturn36search0turn35view0turn22view0turn27view0turn37search3turn30search2