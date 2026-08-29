import { ensureShardedIndex, getCurrentIndex as getShardedIndex, getIndexFilePath as getShardedIndexPath, getEmbeddingFilePath as getShardedEmbeddingPath, getEmbeddingModelName as getShardedEmbeddingModel, getEmbeddingDimension as getShardedEmbeddingDimension } from './sharded_index_manager.js';
import { getCompatIndex } from './sharded_compat.js';

// Compatibility facade for the legacy index_manager API. Runtime retrieval is
// now backed exclusively by public/rag shards; legacy build functions remain
// available in index_manager_legacy.js for offline/index-generation tooling.
export async function ensureIndex(dataRoot, opts) {
    return ensureShardedIndex(dataRoot, opts);
}

export async function getCurrentIndex() {
    return getCompatIndex();
}

export function getIndexFilePath() {
    return getShardedIndexPath();
}

export function getEmbeddingFilePath() {
    return getShardedEmbeddingPath();
}

export function getEmbeddingModelName() {
    return getShardedEmbeddingModel();
}

export function getEmbeddingDimension() {
    return getShardedEmbeddingDimension();
}

export function getCurrentEmbeddingStore() {
    return null;
}

export function setCurrentEmbeddingStore(_store) {
    // Legacy setter retained for compatibility. Sharded stores are opened
    // lazily per shard by sharded_compat.js.
}

// Kept as an explicit named export so tooling that imports the old module does
// not fail at module-load time. Production runtime must not call these build
// paths; use the original implementation in index_manager_legacy.js instead.
export const buildIndex = undefined;
export const incrementalUpdate = undefined;
