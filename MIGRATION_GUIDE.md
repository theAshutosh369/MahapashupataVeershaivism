# RAG Migration Complete

## Summary of Changes

Your AI Agent has been completely redesigned from a keyword-search engine to a production-grade **Retrieval Augmented Generation (RAG)** system, similar to Grok, ChatGPT, and Perplexity.

## What Changed

### Backend

1. **New RAG Retrieval Service** (`/server/rag_routes.js`)
   - Semantic search using embeddings instead of token matching
   - Automatic chunking of all datasets with metadata
   - Vector index pre-computed and cached
   - Hybrid search (semantic + keyword overlap)
   - LLM integration with RAG constraints

2. **Embedded in Express** (`/server/server.js`)
   - RAG routes attached to the existing Express app
   - Runs on port 3001 (same as translation API)
   - No new server process needed

3. **New Endpoints**
   - `GET /api/rag/status` – Check index readiness
   - `GET /api/rag/datasets` – List indexed datasets
   - `POST /api/rag/query` – Semantic search + LLM answer

### Frontend

1. **Modular Architecture** (instead of monolithic component)
   - `src/types/rag.ts` – Type definitions
   - `src/services/rag/retriever.ts` – API client
   - `src/hooks/useRagAssistant.ts` – State management hook
   - `src/components/ai/QueryControls.tsx` – Input controls
   - `src/components/ai/AnswerPanel.tsx` – Answer display
   - `src/components/ai/ReferencesPanel.tsx` – Citation details
   - `src/pages/AiAgent.tsx` – Page composition

2. **Features**
   - Markdown rendering of answers
   - Copy answer/references buttons
   - Expandable source citations
   - Confidence score display
   - Conversation memory support
   - Hybrid retrieval (semantic + keyword)

## Installation & Setup

### 1. Install Dependencies

```bash
cd /path/to/vachana-sanchaya
npm install
```

This will install:
- `@xenova/transformers` – Local embedding model support
- `react-markdown` – Markdown rendering
- `remark-gfm` – GitHub-flavored markdown plugin

### 2. Configure Environment

Create `.env` file in the project root (or set OS environment variables):

```bash
# Use local embeddings (default, no API key needed)
EMBEDDING_MODE=local
LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2

# OR use OpenAI embeddings (if you have API key)
# EMBEDDING_MODE=openai
# OPENAI_API_KEY=sk-...
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# LLM for answer generation
OPENAI_API_KEY=sk-...    # Required for LLM answers
OPENAI_MODEL=gpt-3.5-turbo

# Frontend API URL
VITE_RAG_API_URL=http://localhost:3001
```

### 3. Start the System

```bash
npm start
```

This will launch:
- **Port 3001** – Translation + RAG API
- **Port 3002** – Dataset API
- **Port 3003** – Dataset list API
- **Port 5173** – Vite dev server (frontend)

### 4. First Run (Building the Index)

On first run:
1. RAG backend scans all JSON files in `public/data/datasets/**` and `public/data/authors/**`
2. Parses and chunks every dataset
3. Computes embeddings (this takes time with local models)
4. Saves index to `server/rag_index.json`

**Expected time:** 5–30 seconds depending on dataset size and embedding model.

Subsequent runs load from cache (instant).

### 5. Open the Agent

Navigate to: `http://localhost:5173/agent`

## Architecture Diagram

```
User Query
    ↓
[QueryControls]
    ↓
fetch POST /api/rag/query
    ↓
[RAG Backend]
    ├─ Tokenize & embed query
    ├─ Search vector index (cosine similarity)
    ├─ Hybrid score (semantic + keyword)
    ├─ Top-K filtering & deduplication
    └─ Retrieve best chunks
    ↓
[LLM Integration]
    ├─ Build prompt with chunks only
    ├─ Send to OpenAI (or custom LLM)
    └─ Return answer + sources
    ↓
[AnswerPanel]
    ├─ Render markdown answer
    ├─ Show confidence score
    └─ Display citations
    ↓
[ReferencesPanel]
    └─ Expandable source details (page, vachana, excerpt)
```

## Key Differences from Old System

| Aspect | Old | New |
|--------|-----|-----|
| **Search** | Keyword token matching | Semantic embeddings + hybrid |
| **Scaling** | Slow (scan every file per query) | Fast (pre-indexed vectors) |
| **Accuracy** | Low (typos, synonyms missed) | High (understands meaning) |
| **Answers** | Template strings from rows | LLM-generated, natural text |
| **Citations** | Generic row dumps | Precise, expandable references |
| **Architecture** | Monolithic React component | Modular hooks + services |
| **Markdown** | Plain text | Full markdown support |
| **Hallucination** | N/A (no generation) | Prevented (RAG constraints) |

## Configuration Options

### Choose an Embedding Model

**Local (Free)**
- `Xenova/all-MiniLM-L6-v2` (default, fastest)
- `Xenova/bge-small-en-v1.5` (better quality, slower)
- `Xenova/nomic-embed-text-v1.5` (highest quality, slowest)

Set in `.env`:
```bash
LOCAL_EMBEDDING_MODEL=Xenova/bge-small-en-v1.5
```

**OpenAI (Requires API key)**
```bash
EMBEDDING_MODE=openai
OPENAI_API_KEY=sk-...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

### Choose an LLM

**OpenAI (Requires API key)**
```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-3.5-turbo          # Fast, cheap
# or
OPENAI_MODEL=gpt-4                  # Better quality
```

**Custom Local LLM**
```bash
LLM_API_URL=http://localhost:8000/api/generate
```

## Performance Tips

1. **Pre-compute embeddings offline** (if datasets are very large)
   - Set `EMBEDDING_MODE=openai` for batch processing
   
2. **Increase TopK for better results**
   - Slider default is 10; try 15–20 for complex queries

3. **Use conversation memory** for multi-turn queries
   - Helps maintain context across questions

4. **Monitor confidence scores**
   - High confidence (>80%) = reliable answer
   - Low confidence (<50%) = check sources carefully

## Troubleshooting

### "Cannot find module '@xenova/transformers'"
```bash
npm install @xenova/transformers
```

### "No embedding provider configured"
- Either install `@xenova/transformers` (local)
- Or set `OPENAI_API_KEY` (OpenAI)

### Slow first response
- Local embeddings build index on first run (~10–30 seconds)
- This is normal; cached index loads instantly afterward
- Delete `server/rag_index.json` if you change datasets

### Index not updating
- Index auto-detects file changes (size/mtime)
- Force rebuild: `rm server/rag_index.json && restart server`

### LLM not answering
- Check `OPENAI_API_KEY` is set and valid
- Check `OPENAI_MODEL` is set to a valid model
- Check API rate limits
- Review OpenAI API errors in server logs

## Next Steps (Optional)

### 1. Add Streaming Responses
Update `src/components/ai/AnswerPanel.tsx` to stream answer text as it arrives.

### 2. Add Query Reranking
Implement a reranker (e.g., `cross-encoder`) for better top-K selection.

### 3. Multi-Language Support
Update chunking in `rag_routes.js` to detect language and filter by selected language.

### 4. Conversation History UI
Store chat turns in a sidebar; allow loading/resuming conversations.

### 5. Source Attribution
Add footnotes like `[1]` that link to full sources.

### 6. Feedback Loop
Let users rate answers (helpful/unhelpful) to improve quality.

## Production Deployment

- [ ] Test with real OpenAI API (may have costs)
- [ ] Add rate limiting to `/api/rag/query` endpoint
- [ ] Set up monitoring & logging for queries
- [ ] Cache vectors in Redis for distributed setup
- [ ] Pre-build index offline, commit to repo
- [ ] Set up CI/CD to auto-rebuild index on dataset changes
- [ ] Add authentication if exposing to public
- [ ] Monitor embedding/LLM API costs

## References

- [RAG Architecture](server/README_RAG.md) – Detailed technical guide
- [Retriever Service](src/services/rag/retriever.ts) – API client
- [Hook](src/hooks/useRagAssistant.ts) – State management
- [Components](src/components/ai/) – UI components
