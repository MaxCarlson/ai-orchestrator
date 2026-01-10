Embedding Models

For text/code embedding, modern open-source models excel. BGE (BAAI General Embedding) models (e.g. bge-small-en, bge-large-en, bge-m3) are widely regarded as state-of-the-art for semantic retrieval.  BGE-M3 in particular supports long contexts and multi-vector (dense+sparse) retrieval, achieving new SOTA on benchmarks like MIRACL and MKQA.  Nomic’s FlagEmbedding (built on BGE/Voyage) similarly offers strong multi-modal retrieval support.  Voyage-3 is another high-quality embedder (1,024-dimensional vectors) that claims to outperform OpenAI’s embeddings across tech, code, law, finance, and multilingual domains.  Standard Sentence-Transformer models (e.g. all-mpnet-base-v2, all-MiniLM) also work well on limited hardware for general purposes.  All of these embedding models are relatively small (hundreds of MB to a few GB) and run easily on a 32 GB GPU or even CPU, enabling rapid “encode-and-query” pipelines for RAG.

High-Context Reasoning Models

For agentic planning and recursive tasks, aim for 13–34 B parameter chat/LLM models (preferably instruction-tuned) that offer long context and tool-use.  Notable candidates include: Mixtral-8x7B (a Mixture-of-Experts with 47B total params but ~13B active), which in tests surpasses GPT-3.5 and Claude 2.1 on reasoning benchmarks.  Mistral 8×7B (active 13B) and Mistral 7B are very strong dense models (officially open) with high instruction-following quality.  LLaMA 2-13B (and any open LLaMA-3 small/medium releases) are solid “generalist” models, and Vicuna/Guanaco-13B are user-finetuned forks of LLaMA.  For larger capacity within 32 GB, consider Gemma 2/3-27B (Google’s open “Gemini-class” models up to 27B), Falcon-40B (in 4‑bit quant), or MPT-30B (quantized) if extreme reasoning power is needed.  (FP16 13B models need ~24 GB VRAM, but proper 4-bit quantization can cut that to ~8 GB.)  In practice, one can run these larger models in INT8/INT4 via bitsandbytes or llama.cpp; for example, a 13B model needing ~24 GB FP16 can run in ~8 GB INT4.

Co-hosting: A 32 GB GPU can run a quantized 13B–20B model comfortably, or even a 30B model in INT4.  For multi-step “orchestration” you’d typically load one large chat model (e.g. Mixtral or LLaMA-13B) and keep it resident during a session, offloading/unloading only if running out of memory.  Smaller models (e.g. an LLaMA-7B or MiniLM instance) can be kept always-loaded for tasks like summarization or text processing.  Embedding models (since they are small) can even run concurrently on the GPU (quantized) or on CPU to save VRAM.  In summary: load big models on demand (possibly use GPU offload/quantization) and leave lightweight models resident.

Multimodal Models

For image/diagram/log understanding, several open vision-language models exist: DeepSeek-VL (open 1.3B & 7B multimodal chat models) shows state-of-the-art vision-language reasoning.  GLM-4.6V-Flash (9B) is an open multimodal model supporting tool use and OCR (local-friendly version of GLM-4.6V). Qwen3-VL-30B (Alibaba) is a very capable VLM with tool-calling and native long context (instruct/“Thinking” variants available).  Molmo (AllenAI, 1B/7B/72B) delivers GPT-4V-level performance even at 7B.  Gemma 3 (Google, 12B & 27B) also supports images/videos with a 128K token window.  Pixtral-12B (Mistral’s first multimodal 12B) is an open vision-LM.  For simpler visual tasks, earlier models like LLaVA (LLaMA+vision) or BLIP can be used, but the above newer models offer explicit tool-calling interfaces.  On 32 GB, plan to use smaller variants (e.g. 7–12B versions, Flash/“-A3B” editions) and quantize them for efficiency.  (For example, Pixtral-12B and Gemma3-12B can run in ~15–20 GB FP16.)

Lightweight Models (Segmentation/Summarization)

Tasks like document chunking, summarization, or niche assistants can use small/lightweight LMs.  Good picks include LLaMA/Vicuna 7B or 13B (quantized), GPT-J-6B, or Flan-T5 (small/large variants) for summarization.  These consume only a few GB VRAM, so they can remain loaded permanently (even on GPU alongside other models) for pre- or post-processing steps.  For specialized functions (e.g. code segmentation), fine-tuned versions of LLaMA-7B or Phi-3 Mini (3–6B) are viable.

VRAM Usage & Quantization

In practice, precision and quantization determine fit.  Rough guidelines (for 4K context, batched inference) are: 7B FP16 ~16–20 GB VRAM; 7B INT4 ~6–8 GB.  13B FP16 ~24 GB; 13B INT4 ~8 GB.  33B FP16 ~70–80 GB (multi-GPU) but INT4 can run on a single 4090/4090Ti (~24GB).  MoE models like Mixtral (47B total, 13B active) require ~90 GB in FP16, but can be loaded in ~30 GB with 4-bit quant (borderline for a 32 GB card; careful offloading or multiple GPUs may be needed).  Thus on 32 GB: one can run one medium-large model (13–20B) in INT4 comfortably, plus one or more small models (7B INT4 or below).

Inference Runtimes and Tools

Several frameworks support efficient local serving:

vLLM (by UC Berkeley): Focused on high throughput. It uses innovations like PagedAttention for low VRAM KV-caches and continuous batching, and it supports multi-GPU tensor/pipeline parallelism.  vLLM pre-allocates most GPU memory and requires the full model on GPU (no offloading), but delivers up to 2–4× higher throughput than naive serving. It also provides an OpenAI-compatible API for chat. Pros: extremely fast for a fixed model, support multi-GPU and continuous batching; Cons: can’t change models on-the-fly, requires model to fit GPU, no CPU offload.

llama.cpp (+ llama.cpp GPU): A minimal C++ engine with quantization.  It shines on quantized or CPU runs: GGUF/GPQ/AWQ support lets 2–4-bit loading of many models (Llama- and Mistral-family, Mixtral, etc.).  Pros: ultra-low memory (e.g. 13B in 8GB), runs on CPUs/older GPUs, fast startup; Cons: single-instance, no native multi-GPU or batching, basic API (no built-in OpenAI compat).

Ollama: A user-friendly wrapper around llama.cpp that adds a Docker-like model registry and an OpenAI-compatible API.  It supports dynamic model switching (unloads old models) and GPU RAM offloading, allowing models larger than VRAM to run by spilling to CPU/GPU memory. Pros: very easy setup, OpenAI API, multi-model swapping, GPU offload; Cons: lower throughput under concurrency, no advanced batching.

LMDeploy (OpenMMLab): A toolkit for serving LLMs/VLMs with an OpenAI-compatible server. It supports quantization (AWQ/GPTQ, INT4/8 KV-cache) and multimodal inputs (images + text) with tool-calling capabilities. It can host multiple models via separate endpoints. Pros: OpenAI API style, vision+tool support (e.g. DeepSeek/VLM pipelines in docs), built-in support for many models (Llama3-VL, DeepSeek-VL2, etc.); Cons: relatively new, less community traction, requires Python/PyTorch environment.

TGI (Text-Generation-Inference): Hugging Face’s production server. It supports many HF Hub models, dynamic batching, LoRA, monitoring, etc. Pros: robust enterprise features, monitoring, safetensors, function calling; Cons: heavier memory use, moderate throughput (generally slower than vLLM).

TensorRT-LLM: NVIDIA’s inference engine for maximum speed on A100/L40/L40S. It uses aggressive CUDA optimizations and quantization. Pros: blazing speed (2–5× faster than other frameworks) and multi-GPU; Cons: complex model compilation, NVidia-only, tricky tuning.


In practice, vLLM is ideal for a single high-demand model (e.g. a chat server at scale), while Ollama/llama.cpp works well for flexible local use. LMDeploy/TGI provide OpenAI-like APIs if you need tool calls. All support quantized (int4/8) inference to fit models under 32 GB.

Model Management Strategy

On a 32 GB GPU, balance is key. Always-loaded small models: Keep one or two lightweight models resident (e.g. an embedder and a summarizer) since they use little VRAM. Swap heavy models on demand: Load large chat VLMs only when needed. For example, launch your orchestrator (Mixtral-8x7B or LLaMA-13B) at the start of a session, and unload or offload it when done. If switching tasks, you can use Ollama or llama.cpp to automatically unload and load new models. You may also run embedding queries in a separate process or on CPU to free GPU. In other words, structure the pipeline so that embeddings (lightweight, parallelizable) feed into the orchestrator loop (heavy, sequential).

Multiple models can run concurrently if memory allows. For example, you could run an embedding model (quantized ~2–4 GB) in parallel with an orchestrator (20+ GB), since their tasks are decoupled. If a very large model is active (~30 GB), it may preclude another on GPU; in that case run embed on CPU or serialize steps. vLLM’s multi-GPU mode is less relevant on one card, but you could spawn two separate vLLM instances on the same GPU with a model each (not optimal).

Prompt Format and Interoperability

Use a standard Chat/Function-call format (like OpenAI’s) across models to simplify switching. Both vLLM and LMDeploy support the OpenAI ChatCompletion API (LMDeploy even runs a local v1/chat/completions endpoint). Use the same JSON “messages” schema (role-content) and tool/function calling conventions in all models. This way, your orchestrator logic (prompting, tool API calls) works identically whether the model is Mixtral, LLaMA, or Claude-compatible. For example, LMDeploy can directly serve local models with OpenAI-compatible endpoints, and vLLM can consume or produce OpenAI-style chat JSON. Consistency here ensures easy model swaps and unified agent tooling.

Summary: For embeddings use compact open models (BGE, Voyage, Nomic) in low precision to index code and docs. For high-level reasoning use 13–34B chat models (Mixtral, Mistral/LLaMA, Gemma3, etc.), likely quantized. For multimodal, use emerging VLMs (DeepSeek-VL, GLM-4.6V-Flash, Qwen3-VL, Pixtral, Molmo, Gemma3). Manage VRAM by quantization and dynamic loading: keep small models resident, swap in big ones as needed, and exploit CPU offloading when possible. Tools like vLLM (high throughput) and llama.cpp/Ollama (flexible, quantized) enable efficient execution.  Overall, this yields a flexible, high-performance local orchestrator under 32 GB, with OpenAI-style prompts for easy model interchange.

Sources: Latest benchmark and architecture reports on BGE/Nomic embeddings, Mixtral performance, DeepSeek/GLM/Gemma VLMs, and LLM serving frameworks. These informed our model and infrastructure choices.
