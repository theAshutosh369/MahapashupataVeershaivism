# RAG (Retrieval Augmented Generation) Implementation

This document describes the production RAG system powering the AI Agent. It indexes JSON datasets, JSON author files, TXT documents, and PDF documents into shard-local semantic indexes, then answers questions using the provider abstraction in `server/llm/`.

## Architecture

```text
public/data/
├── Agamas/*.txt       → Agamas shard
├── datasets/*.json    → datasets shard
├── authors/*.json     → authors shard
└── *.pdf              → root shard
```

### Index pipeline

| Step | Responsibility |
|---|---|
| Source discovery | Recursively scans `public/data/` for JSON/PDF/TXT |
| Chunking | `server/chunker.js` creates retrieval chunks |
| Embeddings | Google `gemini-embedding-001` (768-dim) |
| Storage | Each shard has `index.json` + `embeddings.bin` |
| Runtime retrieval | Loads only the selected shards and searches embeddings in batches |

## Incremental indexing

New source files are indexed without rebuilding the full corpus.

When a file such as:

```text
public/data/Agamas/NewAgama.txt
```

appears, the server detects it through the source-tree watcher or the startup reconciliation scan and performs:

```text
New file detected
       ↓
Chunk only NewAgama.txt
       ↓
Generate embeddings for only its chunks
       ↓
Append vectors to the Agamas shard
       ↓
Append chunk metadata to Agamas/index.json
       ↓
Update public/rag/manifest.json
```

Existing chunks are never re-chunked or re-embedded for a new file. Older prebuilt shards that do not contain `sourceFiles` metadata are protected by checking the existing chunk `dataset` values, so the first startup reconciliation cannot duplicate the existing 24k+ corpus.

The watcher is debounced and serializes file updates. Vector data is finalized before the shard metadata is atomically replaced, so readers can continue using the previous consistent metadata while an update is being written.

The incremental implementation is in `server/incremental_shard_indexer.js` and is activated by `server/sharded_index_manager.js`.

### Important deployment note

Incremental indexing requires a writable `public/rag/` directory and source files that exist on the running server. A deployment that intentionally uses a read-only external prebuilt index cannot persist runtime-created shard changes back to that external storage. For such deployments, rebuild/publish the generated shards to the external storage as part of the deployment process.

## Storage format

Each shard contains:

- `index.json` — chunk metadata only, including `embeddingIndex` and source-file fingerprints.
- `embeddings.bin` — Float32 vectors in the same order as `embeddingIndex`.
- `manifest.json` — corpus-level shard and chunk metadata.

Embeddings are not loaded into RAM at startup; shard searches use batched vector reads.

## Backend components

1. **Sharded index manager** (`server/sharded_index_manager.js`)
   - Loads shard metadata
   - Starts incremental reconciliation and source-tree watcher
   - Refreshes the manifest after new files are indexed
   - Performs shard-local retrieval and global reranking

2. **Incremental shard indexer** (`server/incremental_shard_indexer.js`)
   - Detects new JSON/PDF/TXT files
   - Chunks only the new file
   - Generates embeddings in batches of 100
   - Appends embeddings and metadata to the correct shard
   - Uses atomic metadata replacement

3. **Vector store** (`server/vector_store.js`)
   - Float32 binary storage
   - Lazy batched reads
   - Streaming append/finalization

4. **RAG engine** (`server/rag_engine.js`)
   - Query embedding
   - Hybrid retrieval
   - Strict grounded answer generation

5. **RAG routes** (`server/rag_routes.js`)
   - `GET /api/rag/status`
   - `GET /api/rag/datasets`
   - `POST /api/rag/query`
   - `POST /api/rag/query/stream`
   - `POST /api/rag/concept-search`

## Full rebuild

A full rebuild remains an explicit offline operation. It is not triggered by adding a single source file.

```bash
node --max-old-space-size=4096 server/rebuild_index.js
```

Use a full rebuild only when changing chunking rules, embedding model/dimension, or intentionally rebuilding the complete corpus.
