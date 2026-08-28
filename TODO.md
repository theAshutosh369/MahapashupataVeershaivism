# AI Agent Dataset Fix Plan - Progress

## ✅ Step 1: Fix `/api/rag/datasets` - Decouple from embedding/index
- [x] Modified datasets endpoint to try index first, fall back to filesystem scan

## ✅ Step 2: Fix `buildIndex()` - Make embedding failure non-fatal  
- [x] Index is saved with chunks but without embeddings when embeddings fail
- [x] `getEmbeddingProvider()` returns `null` instead of throwing

## ✅ Step 3: Fix `selectTopChunks()` - Add keyword fallback
- [x] Added `selectTopChunksByKeyword()` function
- [x] `selectTopChunks()` now falls back to keyword search when embeddings aren't available

## ✅ Step 4: Fix query endpoints - Handle embedding failures
- [x] Both stream and regular query endpoints wrap embedding in try/catch
- [x] Fall back to keyword-only retrieval when embedding fails

## ✅ Step 5: Fix incremental update in ensureIndex
- [x] Incremental embedding wrapped in try/catch

## ✅ Step 6: Fix frontend dataset name formatting
- [x] `listRagDatasets` now handles filesystem scan paths properly

## ⬜ Step 7: Verify server starts and works
- [ ] Start server and verify datasets endpoint returns data
- [ ] Test query with keyword-only fallback
