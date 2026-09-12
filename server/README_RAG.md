# RAG (Retrieval Augmented Generation) Implementation

This document describes the production-quality RAG system powering the AI Agent. It indexes **JSON datasets, JSON author files, and PDF documents** into a unified semantic search index, then answers questions using a pluggable LLM provider layer (Google Gemini and/or OpenAI).

The final LLM generation layer is behind a **provider abstraction** (`server/llm/`) so the RAG engine never depends directly on a specific vendor. It supports Gemini, OpenAI, and automatic Gemini → OpenAI fallback.

## Architecture

```
public/data/
├── datasets/*.json      → { name, data: [{ page, number, kannada, transliteration, translation, ... }] }
├── authors/*.json       → { name, vachanas: [{ kannada, transliteration, translation, ... }] }
└── *.pdf                → scanned recursively (page-by-page text extraction)
```

### Index pipeline

| Step | File | Responsibility |
|---|---|---|
| Scan files | `server/index_manager.js` | Recursively scans `datasets/`, `authors/` (`.json`) and the whole data tree (`.pdf`) |
| PDF extraction | `server/pdf_extractor.js` | Per-page text extraction via [`unpdf`](https://github.com/unjs/unpdf) (pdf.js build) |
| Chunking | `server/chunker.js` | Token-aware splitter (~700 tokens, ~120 overlap) for JSON rows and PDF pages |
| Embeddings | `server/index_manager.js` | Google `gemini-embedding-001` (768-dim) via `batchEmbedContents` (≤100/batch) |
| Storage | `server/vector_store.js` | Separate metadata + embedding stores |

### Storage format

- **`server/rag_index.json`** — chunk **metadata only** (id, dataset, page, vachanaNumber, author, title, language, chunkIndex, tokenCount, text, `embeddingIndex`). No embeddings live here.
- **`server/rag_embeddings.bin`** — raw **Float32 binary vectors**, one per chunk, indexed by position (`embeddingIndex`).

Embeddings are never loaded into RAM at startup; `server/vector_index.js` lazily loads them in batches and `server/rag_engine.js` searches via `server/hybrid_search.js`.

### PDF support

PDFs are placed anywhere under `public/data/` (e.g. `public/data/Basava_Purāṇa.pdf`). The pipeline:

1. `index_manager.getSourceFiles()` → `scanPdfFiles(dataRoot)` finds them (recursive).
2. `chunkSourceFile()` reads the PDF buffer → `extractPdf(buffer)` → per-page `{ page, text }`.
3. `chunker.chunkPdfFile()` splits each page with the same splitter used for JSON, storing the real page number for citations.
4. PDF chunks get the **same Gemini embeddings** as JSON chunks and are written to the same `rag_index.json` + `rag_embeddings.bin`.
5. PDFs appear in the dataset dropdown (`formatDatasetName` strips `.pdf`) and are filtered/retrieved exactly like JSON datasets.

PDF chunk fields:
```json
{
  "id": "Basava_Purāṇa.pdf#p2#c0",
  "dataset": "Basava_Purāṇa.pdf",
  "page": 2,
  "vachanaNumber": null,
  "author": "Palakuriki Somanatha, ...",
  "title": "Śiva's Warriors",
  "language": "kannada | sanskrit | tamil | telugu | malayalam | bengali | english",
  "text": "..."
}
```

Language is auto-detected from the page's Unicode script. Page numbers flow through retrieval so Gemini cites **"Page: N"**.

> **Note on scanned PDFs:** PDFs that are image-only (scans without an OCR text layer) will extract little or no text. Add an OCR layer first for best results. A per-file size cap (`RAG_PDF_MAX_BYTES`, default 1 GB) prevents indexing runaway files.

## Backend components

1. **Index Manager** (`server/index_manager.js`)
   - Streaming index build/incremental update (never holds full index in RAM)
   - Change detection via sha1 content hashes (robust against git mtime changes)
   - Error recovery: preserves the previous working index on failure
   - Rebuilds automatically when `vectorCacheVersion` or `embeddingModel` changes

2. **Vector Store** (`server/vector_store.js`)
   - Abstract storage layer (swappable for LanceDB/SQLite later)
   - Float32 binary format, buffered streaming writes, lazy batched reads

3. **RAG Engine** (`server/rag_engine.js`)
   - Query embedding via `gemini-embedding-001`
   - Hybrid scoring: semantic (0.5) + keyword (0.25) + fuzzy (0.15) + boost (0.10)
   - Graceful fallback to pure keyword search when embeddings/API are unavailable
   - Prompt building with strict RAG constraints and bracket citations `[1], [2], ...`
   - Answer generation via the pluggable LLM provider layer (Gemini and/or OpenAI, streaming + non-streaming)

4. **RAG Routes** (`server/rag_routes.js`)
   - `GET /api/rag/status` — health + index stats
   - `GET /api/rag/datasets` — dataset list (falls back to a filesystem scan on error)
   - `POST /api/rag/query` — non-streaming query
   - `POST /api/rag/query/stream` — SSE streaming query
   - `POST /api/rag/clear-cache` — admin: clear query-embedding cache

## Environment Variables

```bash
# ── LLM Provider (answer generation) ──────────────────────────────────────
# LLM_PROVIDER controls which provider(s) generate answers:
#   auto   → Gemini primary, OpenAI fallback (default)
#   gemini → Gemini only
#   openai → OpenAI only
LLM_PROVIDER=auto

# Gemini (required for embeddings + as an LLM provider)
GEMINI_API_KEY=AIza...
GEMINI_MODEL=models/gemini-flash-latest     # answer model
GEMINI_FALLBACK_MODELS=                      # optional comma-separated fallback models
GEMINI_TEMPERATURE=0.2
GEMINI_MAX_OUTPUT_TOKENS=2048
GEMINI_TIMEOUT_MS=30000                   # streaming LLM timeout
GEMINI_MAX_ATTEMPTS=3
GEMINI_STREAM_MAX_ATTEMPTS=3
GEMINI_BACKOFF_BASE_MS=1000

# OpenAI (optional; used when LLM_PROVIDER=openai or as auto fallback)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
OPENAI_TEMPERATURE=0.2
OPENAI_MAX_OUTPUT_TOKENS=2048
OPENAI_MAX_ATTEMPTS=2
OPENAI_STREAM_MAX_ATTEMPTS=2
OPENAI_BACKOFF_BASE_MS=1000

# ── Indexing / retrieval ──────────────────────────────────────────────────
RAG_WARM_INDEX=0                          # set to 1 to build index at startup
RAG_DEBUG=0                               # set to 1 for verbose debug logging
RAG_PDF_MAX_BYTES=1073741824              # per-PDF size cap (default 1 GB)
```

API keys stay **backend-only** — they are never sent to the React frontend.

### Provider selection & auto-fallback

- `LLM_PROVIDER=gemini` → uses only the configured Gemini model.
- `LLM_PROVIDER=openai` → uses only the configured OpenAI model.
- `LLM_PROVIDER=auto` → tries Gemini first. If Gemini fails with a quota-exhausted / model-not-found / rate-limit / auth error, it **immediately switches to OpenAI** (no long repeated retries). If only one key is configured, auto uses that provider.

Both non-streaming and streaming answer generation flow through the provider chain (`server/llm/provider_factory.js`). If Gemini streaming hits a 429, OpenAI takes over the stream without the user resubmitting.

Note: `GEMINI_API_KEY` is still required for **embeddings** (query-time and index-time). If it is missing, retrieval falls back to pure keyword search.

## API Endpoints

### `GET /api/rag/status`
```json
{
  "ok": true,
  "ready": true,
  "datasetCount": 233,
  "chunkCount": 21800,
  "embeddingModel": "gemini-embedding-001",
  "embeddingDimension": 768,
  "llmProvider": "gemini",
  "llmModel": "models/gemini-flash-latest",
  "embeddingStorage": "Float32 binary",
  "embeddingFilePath": ".../rag_embeddings.bin"
}
```

### `GET /api/rag/datasets`
Lists all indexed datasets — JSON files (with `datasets/` / `authors/` prefixes) and top-level PDFs:
```json
{
  "ok": true,
  "datasets": ["authors/basavaṇṇa.json", "datasets/ViraktotpattiKriyaLakshana.json", "Basava_Purāṇa.pdf", ...]
}
```

### `POST /api/rag/query`
```json
// Request
{
  "query": "What does the Basava Purana say about Shiva's warriors?",
  "selectedDataset": "Basava_Purāṇa.pdf",
  "topK": 10,
  "answerMode": "detailed",
  "includeConversationMemory": false,
  "conversationHistory": []
}
```

```json
// Response (sources reference the PDF page)
{
  "ok": true,
  "answer": "...",
  "sources": [
    {
      "id": "Basava_Purāṇa.pdf#p42#c0",
      "dataset": "Basava_Purāṇa.pdf",
      "page": 42,
      "vachanaNumber": null,
      "author": "...",
      "title": "Śiva's Warriors",
      "language": "english",
      "score": 0.91,
      "excerpt": "..."
    }
  ],
  "confidence": 91,
  "retrievedChunks": [...],
  "prompt": "..."
}
```

### `POST /api/rag/query/stream`
SSE streaming variant. Events: `token`, `done`, `error`.

## Development

### Install dependencies
```bash
cd server
npm install
```

### Rebuild the index
```bash
# From the project root
node --max-old-space-size=4096 server/rebuild_index.js
```

`rebuild_index.js` deletes `rag_index.json` + `rag_embeddings.bin` and rebuilds every chunk from scratch with fresh Gemini embeddings.

### Run the server
```bash
cd server
npm run dev        # or: node server.js
```

On startup (or first query), the index manager:
1. Scans `public/data/datasets/**/*.json`, `public/data/authors/**/*.json`, and `public/data/**/*.pdf`
2. Extracts + chunks all files (PDFs page-by-page)
3. Computes Gemini embeddings in batches of ≤100
4. Streams chunks to `rag_index.json` and vectors to `rag_embeddings.bin`

Subsequent runs load the cached index; changed/new files trigger an incremental update that only re-embeds the affected files.

## Troubleshooting

**"unpdf is not installed"**
→ Run `npm install unpdf` in `server/`.

**Embedding API 429 / quota errors during build**
→ The build continues with zero-vector placeholders. Restore quota, delete `rag_index.json` + `rag_embeddings.bin`, and rebuild to get real embeddings.

**PDF indexed but returns no matches**
→ The PDF is likely image-only (scanned). Check the extracted text by searching for a known phrase; add an OCR text layer if needed.

**Answers say "could not find" even though data exists**
→ Check `GEMINI_API_KEY` (needed for embeddings) and that at least one LLM provider key is configured (`GEMINI_API_KEY` and/or `OPENAI_API_KEY`). Without a provider key the engine cannot generate answers.

**Index not rebuilding on dataset changes**
→ Delete `server/rag_index.json` to force a full rebuild.

