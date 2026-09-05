import { ensureIndex as ensureShardedIndex, getIndexFilePath as getShardedIndexPath, getEmbeddingFilePath as getShardedEmbeddingPath, getEmbeddingModelName as getShardedEmbeddingModel, getEmbeddingDimension as getShardedEmbeddingDimension } from './sharded_index_manager.js';
import { scanAndIncrementallyIndex } from './incremental_shard_indexer.js';
import { getCompatIndex } from './sharded_compat.js';

let currentCompatIndex = null;

// Compatibility facade for the legacy index_manager API. Runtime retrieval is
// backed by public/rag shards. Incremental source changes are handled by the
// shard manager without rebuilding the complete corpus.
export async function ensureIndex(dataRoot, opts) {
    await ensureShardedIndex(dataRoot, opts);
    currentCompatIndex = await getCompatIndex();
    return currentCompatIndex;
}

export function getCurrentIndex() { return currentCompatIndex; }
export function getIndexFilePath() { return getShardedIndexPath(); }
export function getEmbeddingFilePath() { return getShardedEmbeddingPath(); }
export function getEmbeddingModelName() { return getShardedEmbeddingModel(); }
export function getEmbeddingDimension() { return getShardedEmbeddingDimension(); }
export function getCurrentEmbeddingStore() { return null; }
export function setCurrentEmbeddingStore(_store) { /* Sharded stores remain lazy. */ }

// Public compatibility entry point for callers that explicitly request an
// incremental reconciliation. It scans source files, skips anything already
// present in its shard, and processes only newly discovered files.
export async function incrementalUpdate(dataRoot, opts = {}) {
    const ragRoot = opts.ragRoot || undefined;
    if (!ragRoot) {
        await ensureShardedIndex(dataRoot, opts);
        return { ok: true, results: [] };
    }
    const results = await scanAndIncrementallyIndex({ dataRoot, ragRoot });
    return { ok: true, results };
}

// A full rebuild remains an explicit offline operation. Runtime startup and
// file changes must never silently rebuild the 24k+ chunk corpus.
export const buildIndex = undefined;
