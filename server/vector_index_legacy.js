/**
 * Vector Index — In-memory metadata index + lazy-loaded binary embeddings.
 *
 * ARCHITECTURE:
 *   - Metadata (chunks without embeddings) is loaded immediately on startup.
 *   - Embeddings are stored in a separate binary file (rag_embeddings.bin)
 *     and loaded lazily. All searches use batched search (searchBatched).
 *   - After search completes, embeddings can be unloaded to free RAM.
 *
 * STORAGE:
 *   - Uses vector_store.js (Float32BinaryStore) — abstracted for future LanceDB swap.
 *   - Embedding file: server/rag_embeddings.bin
 *
 * MEMORY EFFICIENCY:
 *   - Batched search loads B vectors at a time, scoring them, then releasing.
 *   - loadAll() is deprecated — no longer called internally.
 */

import { getCurrentIndex, getEmbeddingFilePath, getEmbeddingDimension, setCurrentEmbeddingStore, getCurrentEmbeddingStore } from './index_manager.js';
import { VectorStore, logMemorySnapshot } from './vector_store.js';

// ─── Debug flag ────────────────────────────────────────────────────────────
const DEBUG = false;

function debugLog(...args) {
    if (DEBUG) console.log('[VectorIndex]', ...args);
}

// ─── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 10;
const BATCH_SIZE = 500;

// ─── Internal state ─────────────────────────────────────────────────────────

let vectorIndex = null;        // Array of { chunk, embeddingIndex } — metadata only
let vectorIndexBuildPromise = null;

// ─── Build index from metadata ──────────────────────────────────────────────

function buildInMemoryIndex(chunks) {
    if (!Array.isArray(chunks)) return [];
    return chunks.map(function (c) {
        return {
            chunk: c,
            embeddingIndex: c.embeddingIndex
        };
    });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the vector index (metadata only).
 * Loading the index only requires metadata, NOT embeddings.
 */
export async function getVectorIndex() {
    if (vectorIndex) return vectorIndex;
    if (vectorIndexBuildPromise) return vectorIndexBuildPromise;

    vectorIndexBuildPromise = (async () => {
        try {
            const index = getCurrentIndex();
            if (!index || !Array.isArray(index.chunks)) {
                throw new Error('No index loaded. Call ensureIndex() first.');
            }
            vectorIndex = buildInMemoryIndex(index.chunks);
            debugLog('Loaded ' + vectorIndex.length + ' chunk metadata entries');
        } catch (error) {
            console.warn('[VectorIndex] Failed to build index:', error.message);
            vectorIndex = [];
        }
        return vectorIndex;
    })();

    return vectorIndexBuildPromise;
}

/**
 * Open the embedding store for reading (lazy — no data loaded into RAM).
 * Returns the VectorStore instance for batched search.
 */
export async function loadEmbeddings() {
    let store = getCurrentEmbeddingStore();
    if (store) {
        return store;
    }

    const embedPath = getEmbeddingFilePath();
    const exists = await VectorStore.fileExists(embedPath);

    if (!exists) {
        debugLog('Embedding file not found at: ' + embedPath);
        return null;
    }

    try {
        debugLog('Opening embeddings from: ' + embedPath);
        logMemorySnapshot('[VectorIndex] Before opening embed store');

        store = await VectorStore.open(embedPath);
        setCurrentEmbeddingStore(store);

        logMemorySnapshot('[VectorIndex] After opening embed store');
        debugLog('Opened ' + store.size() + ' embeddings (dim=' + store.dimension() + ')');

        return store;
    } catch (error) {
        console.warn('[VectorIndex] Failed to open embeddings:', error.message);
        return null;
    }
}

/**
 * Unload embeddings from RAM to free memory.
 * After calling this, search will need to reopen embeddings.
 */
export async function unloadEmbeddings() {
    const store = getCurrentEmbeddingStore();
    if (store) {
        logMemorySnapshot('[VectorIndex] Before embedding unload');
        await store.close();
        setCurrentEmbeddingStore(null);
        logMemorySnapshot('[VectorIndex] After embedding unload');
    }
}

/**
 * Retrieve topK chunks by cosine similarity (semantic search).
 * Uses searchBatched exclusively for memory efficiency.
 * Loads embeddings lazily if not already loaded.
 */
export async function retrieveTopKByCosine(queryEmbedding, { topK = DEFAULT_TOP_K, selectedDataset = '__ALL__' } = {}) {
    const index = await getVectorIndex();

    if (!index || index.length === 0) return [];

    // Filter by dataset if requested
    const filtered = (selectedDataset && selectedDataset !== '__ALL__')
        ? index.filter((item) => item.chunk?.dataset === selectedDataset)
        : index;

    if (filtered.length === 0) return [];

    // Open embeddings lazily (no loadAll — just open the store)
    const store = await loadEmbeddings();
    if (!store || store.size() === 0) {
        debugLog('No embeddings available for cosine search');
        return [];
    }

    // Always use batched search — memory efficient
    logMemorySnapshot('[VectorIndex] Before batched search');
    const searchResults = await store.searchBatched(queryEmbedding, topK, BATCH_SIZE);
    logMemorySnapshot('[VectorIndex] After batched search');

    // Map results back to chunks using embeddingIndex
    const chunkByEmbeddingIndex = new Map();
    for (const item of filtered) {
        if (item.embeddingIndex !== undefined && item.embeddingIndex !== null) {
            chunkByEmbeddingIndex.set(item.embeddingIndex, item.chunk);
        }
    }

    const results = [];
    for (const sr of searchResults) {
        const chunk = chunkByEmbeddingIndex.get(sr.index);
        if (chunk) {
            results.push({ chunk, similarity: sr.score });
        }
    }

    return results.slice(0, topK);
}

/**
 * Ensure the vector index is sync-loaded (for synchronous access patterns).
 */
export function ensureVectorIndexLoadedSync() {
    if (!vectorIndex) {
        throw new Error('Vector index not loaded yet. Call getVectorIndex() first.');
    }
    return vectorIndex;
}

/**
 * Index statistics.
 */
export function vectorIndexStats() {
    const store = getCurrentEmbeddingStore();
    return {
        loaded: !!vectorIndex,
        size: vectorIndex?.length ?? 0,
        embeddingsOpened: store ? true : false,
        embeddingMemoryBytes: store ? store.getMemoryBytes() : 0,
        embeddingFile: getEmbeddingFilePath()
    };
}
