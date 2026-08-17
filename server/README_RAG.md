# RAG (Retrieval Augmented Generation) Implementation

This document outlines the production-quality RAG system that replaces keyword-based search with semantic retrieval.

## Architecture

### Backend (Node.js/Express)

The RAG backend is embedded in `/server/server.js` and consists of:

1. **RAG Routes** (`/server/rag_routes.js`)
   - Pre-indexes all datasets with semantic embeddings
   - Provides `/api/rag/datasets` to list available datasets
   - Provides `/api/rag/query` for semantic search with LLM answering

2. **Chunking Strategy**
   - Splits datasets into chunks with metadata (author, page, vachana number, language)
   - Supports two formats:
     - `public/data/datasets/*.json` → `{ name, data: [{page,...}] }`
     - `public/data/authors/*.json` → `{ name, vachanas: [{kannada, transliteration,...}] }`

3. **Embeddings**
   - Ollama embeddings via `nomic-embed-text` by default
   - Local fallback embeddings via `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`)
   - Fallback to OpenAI embeddings if `OPENAI_API_KEY` is set
   - Embeddings cached in `server/rag_index.json`
   - Cache is tagged by embedding provider/model and auto-rebuilt when changed
   - Auto-rebuild on dataset changes (file size/mtime check)

4. **Retrieval**
   - Cosine similarity search
   - Hybrid scoring (semantic + token overlap)
   - Top-K filtering with deduplication
   - Optional reranking

5. **LLM Integration**
   - Sends only retrieved chunks (no full datasets)
   - Enforces RAG constraints: "Answer ONLY using supplied context"
   - Ollama `qwen3:8b` by default, OpenAI fallback, or custom LLM via `LLM_API_URL`

### Frontend (React/TypeScript)

1. **New File Structure**
   - `src/types/rag.ts` – RAG types
   - `src/services/rag/retriever.ts` – API client
   - `src/hooks/useRagAssistant.ts` – State management
   - `src/components/ai/QueryControls.tsx` – Controls
   - `src/components/ai/AnswerPanel.tsx` – Answer display with markdown
   - `src/components/ai/ReferencesPanel.tsx` – Retrieved sources
   - `src/pages/AiAgent.tsx` – Main page (refactored)

2. **Features**
   - Semantic search via embeddings
   - Markdown rendering of answers
   - Expandable source references
   - Copy answer/references buttons
   - Conversation memory option
   - Confidence score display

## Environment Variables

```bash
# Embeddings
EMBEDDING_MODE=ollama                         # "ollama", "local", or "openai"
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
OPENAI_API_KEY=sk-...                         # For OpenAI embeddings
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# LLM
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen3:8b
OLLAMA_NUM_CTX=8192
OPENAI_API_KEY=sk-...                         # For GPT-based answers
OPENAI_MODEL=gpt-3.5-turbo
OPENAI_API_URL=https://api.openai.org/v1

# Custom LLM
LLM_API_URL=http://localhost:5000/api/generate

# Frontend
VITE_RAG_API_URL=http://localhost:3001
```

## API Endpoints

### `/api/rag/status` (GET)
Returns RAG index readiness and chunk count.

```json
{
  "ok": true,
  "ready": true,
  "datasetCount": 50,
  "chunkCount": 5000
}
```

### `/api/rag/datasets` (GET)
Lists all indexed datasets.

```json
{
  "ok": true,
  "datasets": ["authors/basavanna.json", "authors/allama.json", ...]
}
```

### `/api/rag/query` (POST)
Semantic search + LLM answer.

**Request:**
```json
{
  "query": "What did Basavanna teach?",
  "selectedDataset": "__ALL__",
  "topK": 10,
  "answerMode": "detailed",
  "includeConversationMemory": true,
  "conversationHistory": ["Previous question 1", "Previous question 2"]
}
```

**Response:**
```json
{
  "ok": true,
  "answer": "Basavanna taught...",
  "sources": [
    {
      "id": "authors/basavanna.json#145#276",
      "dataset": "authors/basavanna.json",
      "page": 145,
      "vachanaNumber": 276,
      "author": "Basavanna",
      "title": "Basavanna",
      "language": "kannada",
      "score": 0.92,
      "excerpt": "..."
    }
  ],
  "confidence": 92,
  "retrievedChunks": [...],
  "prompt": "..."
}
```

## Performance Optimization

1. **Lazy Loading**
   - Index built on first request or server start
   - Saved to disk for fast startup

2. **Caching**
   - Vector index cached in memory
   - Embeddings precomputed for all chunks

3. **Chunking**
   - Balanced chunk size (not too small, not too large)
   - Metadata included for precise citations

4. **Hybrid Search**
   - Semantic similarity (embeddings) + keyword overlap
   - Better recall than pure semantic or keyword alone

## Development

### Install dependencies
```bash
npm install
```

### Ollama setup
Install Ollama, start it, then pull the local models:

```bash
ollama pull nomic-embed-text
ollama pull qwen3:8b
```

The default backend uses `nomic-embed-text` for embeddings and `qwen3:8b` for answers. No API key is required.

### Run the system
```bash
npm start
# or individual servers:
npm run server-main    # Translation API (3001)
npm run server-dataset # Dataset API (3002)
npm run server-list    # Dataset List API (3003)
npm run frontend       # Vite dev server (5173)
```

### First run
On startup, the RAG backend will:
1. Scan `public/data/datasets/**/*.json` and `public/data/authors/**/*.json`
2. Parse all JSON files
3. Create chunks with metadata
4. Compute embeddings (takes time on first run, especially with local models)
5. Save index to `server/rag_index.json`

Subsequent runs load the cached index from disk.

When switching embedding models, the backend automatically rebuilds `server/rag_index.json`. Switching from the old MiniLM index to `nomic-embed-text` will therefore trigger one full rebuild.

## Extending the System

### Adding a New Embedding Model

Edit `/server/rag_routes.js`:
```javascript
const DEFAULT_LOCAL_MODEL = 'your-model-id'; // from huggingface
```

### Switching to Custom LLM

Set `LLM_API_URL` environment variable:
```bash
export LLM_API_URL=http://localhost:8000/api/generate
npm start
```

### Changing RAG Constraints

Modify the prompt in `buildPrompt()` in `/server/rag_routes.js`:
```javascript
const topInstructions = [
  'Your custom RAG instruction...',
  ...
];
```

## Production Checklist

- [ ] Pre-compute embeddings offline if datasets are large
- [ ] Use OpenAI embeddings for better quality (requires API key)
- [ ] Set appropriate LLM (`gpt-4` for production)
- [ ] Enable conversation memory for multi-turn support
- [ ] Monitor confidence scores and adjust TopK if needed
- [ ] Cache vectors in Redis for distributed deployments
- [ ] Add rate limiting to `/api/rag/query`
- [ ] Log queries and answers for audit
- [ ] Test with multiple dataset sizes
- [ ] Validate answer quality on domain-specific examples

## Troubleshooting

**"No embedding provider configured"**
→ Install `@xenova/transformers` or set `OPENAI_API_KEY`

**"Ollama embedding request failed"**
→ Start Ollama and run `ollama pull nomic-embed-text`

**"Ollama chat request failed"**
→ Start Ollama and run `ollama pull qwen3:8b`

**Slow first response**
→ Local embeddings are slow on first run (building index). Subsequent requests use cached vectors.

**Answers don't mention sources**
→ Check that `sources` array is populated in response. Update prompt if needed.

**Index not rebuilding on dataset changes**
→ Delete `server/rag_index.json` to force rebuild.
