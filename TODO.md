# Vachana Sanchaya — Dual LLM Provider (Gemini + OpenAI) Implementation

## Steps
- [x] Inspect codebase (rag_engine.js, rag_routes.js, server.js, conversation_memory.js, frontend streaming)
- [x] Create `server/llm/errors.js` — error classification
- [x] Create `server/llm/base.js` — LLMProvider base class
- [x] Create `server/llm/gemini_provider.js` — extract Gemini logic behind provider
- [x] Create `server/llm/openai_provider.js` — new OpenAI provider
- [x] Create `server/llm/provider_factory.js` — provider selection + auto fallback + config validation
- [x] Create `server/llm/index.js` — barrel export
- [x] Refactor `server/rag_engine.js` to use provider abstraction
- [x] Update `server/rag_routes.js` status endpoint + config validation
- [x] Add `openai` dependency to `server/package.json`
- [x] Update `render.yaml` env vars
- [x] Update `server/README_RAG.md`
- [x] Install `openai` package
- [x] Test scenarios (gemini / openai / auto / fallback / streaming)
