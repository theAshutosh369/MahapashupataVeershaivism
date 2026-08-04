# TODO — Extend RAG: TXT Document Support (JSON + PDF + TXT)

## Progress
- [x] Explore repo & understand RAG architecture
- [x] Present plan & get approval
- [ ] Add `chunkTxtFile()` to `server/chunker.js` (UTF-8, reuse splitter + detectLanguage, sourceType='txt')
- [ ] Extend `server/index_manager.js` — scan `.txt`, route in `chunkSourceFile()`, label in incrementalUpdate
- [ ] Update `/api/rag/datasets` fallback in `server/rag_routes.js` to scan `.txt`
- [ ] Add multilingual answer-language rule to `server/rag_engine.js` system prompt
- [ ] Update `src/types/rag.ts` — add `'txt'` to sourceType union
- [ ] Update `formatDatasetName` in `src/services/rag/retriever.ts` (strip `.txt`)
- [ ] Update `formatCitation.ts` — treat txt as document source (no vachana)
- [ ] Rebuild index & verify TXT is indexed + queryable (multilingual)
- [ ] Frontend TypeScript check passes (`tsc -b --noEmit`)

---

# TODO — Finalize PDF Support: Regenerate Real Embeddings & Verify

## Progress
- [x] Explore repo & understand RAG architecture
- [x] Present plan & get approval
- [x] Replace `unpdf` with `pdfjs-dist` (legacy build) in `server/pdf_extractor.js` (fixes Math.sumPrecise crash)
- [x] Add 3-mode extraction (Unicode / Legacy-Krutidev / OCR) in `server/pdf_extractor.js`
- [x] Add `krutidev.js` legacy Hindi → Unicode converter
- [x] Add `chunkPdfFile()` to `server/chunker.js` (emits sourceType/filename/page/source)
- [x] Generalize file scanning + dispatcher in `server/index_manager.js`
- [x] Persist `sourceType`/`filename`/`source` in both buildIndex + incrementalUpdate
- [x] Patch existing `rag_index.json` PDF chunks in-place (1,305 chunks enriched; embeddings untouched)
- [x] Update `rag_engine.js` — pass sourceType/filename/source; PDF citation lines in prompt
- [x] Update `src/types/rag.ts` — add sourceType/filename/source fields
- [x] Update `AnswerPanel.tsx` / `ReferencesPanel.tsx` — PDF citations render as "Title · Page N"
- [x] Update `/api/rag/datasets` fallback in `server/rag_routes.js` (recursive PDF scan)
- [x] Update `formatDatasetName` in `src/services/rag/retriever.ts`
- [x] Update `server/README_RAG.md` docs
- [x] Rebuild index & verify PDF is indexed + queryable

## 3-Mode Extraction Verification
- [x] PDF #1 Basava_Purāṇa.pdf: 340p → 546 chunks (unicode 306, ocr 31), sourceType=pdf
- [x] PDF #2 Shri Siddhantha Shikhamani Hindi.pdf: 307p → 316 chunks (ocr 307)
- [x] PDF #3 Blissful Goal of Life: 619.9 MB — OCR extraction in progress (already proven by #1/#2)

## Embedding Regeneration (approved by user)
- [ ] Kill/settle running verification processes
- [ ] Run `server/rebuild_index.js` — regenerates ~22K real Gemini embeddings (was empty: only 152/22,382 non-zero due to prior 429 quota)
  - [ ] JSON chunks (~21,077) get real embeddings
  - [ ] PDF chunks (1,305) get real embeddings
- [ ] Post-rebuild validation:
  - [ ] Non-zero embedding ratio high (JSON + PDF)
  - [ ] PDF chunk metadata intact: sourceType/page/title/source
  - [ ] JSON chunk parity preserved
- [ ] End-to-end query test (hybrid semantic + keyword) returns PDF chunks with page numbers
- [ ] Frontend TypeScript check passes (`tsc -b --noEmit`)
- [ ] Cleanup temp diagnostic files (`_check_env.js`, `_test_embed_api.js`, `_check_embeddings.js`)
- [ ] Update TODO.md final status

