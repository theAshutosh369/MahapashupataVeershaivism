# Index Manager Refactoring — Progress

## ✅ Step 1: Create `server/vector_store.js` — Abstract storage layer
- [x] Float32 binary format for embeddings
- [x] Write API: initialize(), appendEmbedding(), finalize()
- [x] Read API: loadEmbeddings(), loadBatch(), getEmbedding(), search(), unload()
- [x] Memory tracking: getMemoryUsage()
- [x] Abstract interface for future LanceDB/SQLite swap

## ✅ Step 2: Rewrite `server/index_manager.js` — Streaming build with memory diagnostics
- [x] Use vector_store.js for embedding storage
- [x] Buffered WriteStream (no appendFile per chunk)
- [x] No JSON.parse() of full index after build
- [x] Memory snapshots before/after: scan, chunk, embed, write, save
- [x] Fix GEMINI_API_KEY validation (no AIza prefix check)
- [x] Error recovery: preserve previous index on failure

## ✅ Step 3: Rewrite `server/vector_index.js` — Lazy loading
- [x] Load metadata immediately, embeddings lazily
- [x] Batch embedding loading (500 at a time)
- [x] unloadEmbeddings() to free RAM
- [x] Uses vector_store.js

## ✅ Step 4: Update `server/rag_engine.js` — Updated API calls
- [x] Use new vector_store lazy-loading API
- [x] Pass embeddings to hybridSearch()

## ✅ Step 5: Update `.env.example`
- [x] Document GEMINI_API_KEY format requirement
- [x] Add new env vars if needed

## ✅ Step 6: Verification
- [ ] Index builds without OOM
- [ ] Memory usage logged before/after each phase
- [ ] Existing index loads incrementally
- [ ] Queries return correct results
- [ ] Embedding file size measured

