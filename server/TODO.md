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
- [x] Index builds without OOM (230 files, 21,077 chunks in ~100s)
- [x] Memory usage logged before/after each phase
- [x] Existing index loads incrementally
- [x] Queries return correct results
- [x] Embedding file size measured (61.75 MB / 21,077 vectors)

## 📄 PDF Support (see root TODO.md)
- [x] `unpdf` dependency added & installed
- [x] `server/pdf_extractor.js` — per-page text extraction
- [x] `chunker.chunkPdfFile()` — PDF page chunking
- [x] Index scanning + dispatch generalized for PDFs
- [x] `/api/rag/datasets` + `formatDatasetName` handle `.pdf`
- [x] `README_RAG.md` updated (Gemini-only, vector-store, PDF pipeline)
- [x] Rebuild index & verify PDF is indexed + queryable (233 datasets, 22,382 chunks; 1,305 PDF chunks with page numbers; JSON unchanged at 21,077)

