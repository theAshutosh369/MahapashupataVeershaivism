import { ensureIndex as ensureShardedIndex, getIndexFilePath as getShardedIndexPath, getEmbeddingFilePath as getShardedEmbeddingPath, getEmbeddingModelName as getShardedEmbeddingModel, getEmbeddingDimension as getShardedEmbeddingDimension } from './sharded_index_manager.js';
import { getCompatIndex } from './sharded_compat.js';

let currentCompatIndex = null;

// Compatibility facade for the legacy index_manager API. Runtime retrieval is
// backed exclusively by public/rag shards. The original index builder is kept
// in index_manager_legacy.js for offline/index-generation tooling.
export async function ensureIndex(dataRoot, opts) {
    await ensureShardedIndex(dataRoot, opts);
    currentCompatIndex = await getCompatIndex();
    return currentCompatIndex;
}

export function getCurrentIndex() {
    return currentCompatIndex;
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
    // Legacy setter retained for compatibility. Sharded stores remain lazy.
}

export const buildIndex = undefined;
export const incrementalUpdate = undefined;
