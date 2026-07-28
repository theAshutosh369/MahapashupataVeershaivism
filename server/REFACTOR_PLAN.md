# Production-Grade RAG Refactoring Plan

## Existing Problems

1. **Ollama Dependency**: Embeddings use `nomic-embed-text` via Ollama; LLM can fallback to Ollama. Both violate the requirement to use **only Gemini**.

2. **All Embeddings Empty**: The 20,045 chunks in `rag_index.json` all have `embedding: []` (zero-length arrays), causing the vector index to return 0 results for every query.

3. **No Proper Chunking**: One JSON item = one chunk. No token-aware splitting, no overlap (chunk size undefined, ~variable length).

4. **No Hybrid Search**: `hybridScore()`, `getChunkKeywordScore()`, `metadataBoost()` exist but are **never called**. Only cosine similarity is used.

5. **No Reranking**: Retrieves `topK` chunks (default 10) and sends ALL of them to Gemini. Should retrieve 25, rerank, send 8-10.

6. **Primitive Conversation Memory**: Only passes last 5 user messages as strings — no structure, no deduplication.

7. **No Caching**: Every query generates a new embedding (duplicate cost) and calls Gemini even for identical queries.

8. **Single File Overload**: `rag_routes.js` contains ~1100+ lines handling chunking, embedding, vector search, prompt building, streaming, and routing. No separation of concerns.

9. **Dead Code**: `cosineSimilarity()` local copy, `embedOllamaLegacy()`, `hybridScore()`, `getChunkKeywordScore()`, `metadataBoost()`, `searchableChunkText()` are all defined but never invoked.

10. **No DEBUG mode toggle**: Debug logs are hardcoded, always on.

---

## Architectural Improvements

### 1. Google Gemini-Only Architecture
| Component | Before | After |
|-----------|--------|-------|
| Embeddings | Ollama `nomic-embed-text` | Google `text-embedding-004` |
| LLM | Ollama/OpenAI fallback | Google `gemini-2.5-flash` |
| Embedding Mode | ENV-based with fallback chain | Gemini ONLY |

### 2. File Separation (Modular Architecture)
```
server/
├── rag_routes.js          → Route handlers ONLY (thin)
├── gemini_service.js      → Gemini API calls (embed + generate + stream)
├── vector_index.js        → In-memory vector index + cosine similarity + persistence
├── chunker.js             → NEW: Token-aware chunking with overlap
├── hybrid_search.js       → NEW: Combined semantic + keyword + fuzzy search
├── rag_engine.js          → NEW: Orchestrator - retrieves, reranks, answers
├── conversation_memory.js → NEW: Structured conversation memory
└── index_manager.js       → NEW: Index building, incremental updates, caching
```

### 3. Improved Chunking
- Target: **500-800 tokens per chunk**
- Overlap: **100-150 tokens**
- Uses Google's `text-embedding-004` token counting (approx 4 chars/token)
- Preserves metadata: dataset, author, file, page, section, language, chunk_id
- Chunks now include: `chunk_index`, `total_chunks` for provenance

### 4. Hybrid Search (BM25 + Semantic)
- **Semantic**: Cosine similarity on `text-embedding-004` vectors (768-dim)
- **Keyword**: Token overlap scoring with Unicode normalization for Kannada/transliteration
- **Fuzzy**: Levenshtein distance for near-matches like "Revanaradhya" ↔ "Revanaaradhya"
- **Boosting**: 
  - Proper nouns +2x
  - Author names +1.5x
  - Kannada script +1.5x
  - Kannada transliteration patterns +1.2x
- **Reranking**: Retrieve top 25 → rerank with hybrid score → send top 8-10

### 5. Vector Index Improvements
- Store embeddings as `Float32Array` instead of plain arrays (memory efficient)
- Pre-compute magnitudes for faster cosine similarity
- Support 100,000+ chunks
- Lazy-load / warm-up on first query
- Incremental index updates (only re-embed changed files)

### 6. Conversation Memory
- Maintain structured history in memory
- Pass last 3 turns (user + assistant pairs) as context to Gemini
- Support follow-up questions naturally
- Avoid repeating context unnecessarily

### 7. Caching
- Query embedding cache (LRU, last 50 queries)
- Index file cache with mtime checking
- Avoid unnecessary Gemini API calls

### 8. DEBUG Mode
- Controlled by `RAG_DEBUG=1` env var
- Logs: question → retrieved chunks → similarity scores → prompt → raw response → latency
- Auto-disabled in production (when `NODE_ENV=production`)

### 9. Professional System Prompt
```
You are Mahapashupata Veershaivism AI — an expert on Veerashaiva / Lingayat literature, 
philosophy, vachanas, and sharanas. Answer naturally like ChatGPT but remain grounded 
in the retrieved context. Never hallucinate. Never invent facts. Quote verses when 
appropriate. Always include references with [bracket IDs]. If the retrieved information 
is insufficient, reply exactly: "I could not find this information in the selected dataset."
```

---

## Embedding Storage
- Embeddings stored in `server/rag_index.json` alongside chunk text and metadata
- Each chunk: `{ id, dataset, page, vachanaNumber, author, title, language, text, embedding: [768 numbers] }`
- `embeddingDimension: 768` (text-embedding-004 output)
- Index file also stores: `vectorCacheVersion`, `embeddingModel`, `sourceFiles` (with mtime/size for incremental diff)

## Incremental Indexing
1. Load existing index file
2. Scan current source files → compare mtime/size with `sourceFiles` array
3. **Unchanged files**: Skip entirely (reuse stored embeddings)
4. **New/changed files**: Re-chunk → generate embeddings via `text-embedding-004` → merge into index
5. **Deleted files**: Remove their chunks from index
6. Save updated index to disk

## How Hybrid Search Works
1. Generate query embedding via `text-embedding-004` (768-dim)
2. **Semantic**: Cosine similarity against all chunk embeddings → top 50
3. **Keyword**: Token overlap scoring (Unicode-normalized) → top 50  
4. **Fuzzy**: Levenshtein distance for near-matches → top 25
5. **Merge & Rerank**: Combine scores with weights (semantic: 0.5, keyword: 0.3, fuzzy: 0.2, boost: +0.3 for named entities)
6. **Select**: Top 8-10 chunks for Gemini context

## How AI Answers Like ChatGPT (Grounded)
1. User sends query → embedding + hybrid search → retrieve 10 best chunks
2. Build prompt with: system instructions + retrieved context + conversation history
3. Send to `gemini-2.5-flash` with `temperature=0.2` (low for grounding)
4. Gemini returns natural answer with inline citations [1], [2], etc.
5. Response includes: answer text + source metadata + confidence score

---

## Modified Files

| File | Action | Reason |
|------|--------|--------|
| `server/rag_routes.js` | **REWRITE** | Remove Ollama/OpenAI, delegate to rag_engine.js, add DEBUG mode |
| `server/gemini_service.js` | **REWRITE** | Add embedding API, conversation mode, better streaming |
| `server/vector_index.js` | **REWRITE** | Float32Array, batched cosine, pre-computed magnitudes |
| `server/chunker.js` | **NEW** | Token-aware chunking with overlap |
| `server/hybrid_search.js` | **NEW** | Semantic + keyword + fuzzy hybrid search |
| `server/rag_engine.js` | **NEW** | Orchestrator: retrieve → rerank → answer |
| `server/conversation_memory.js` | **NEW** | Structured conversation history |
| `server/index_manager.js` | **NEW** | Index building, incremental updates |
| `server/package.json` | **MODIFY** | Remove `@xenova/transformers` dep (no longer needed) |
| `.env.example` (create) | **NEW** | Document required env vars |

---

## Files NOT Modified (Preserve Existing Functionality)
All frontend files (`src/`), author/dataset API routes, GitHub sync, CSS, and other pages remain untouched.
