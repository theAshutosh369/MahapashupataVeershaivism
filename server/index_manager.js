import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureIndex as ensureShardedIndex, getIndexFilePath as getShardedIndexPath, getEmbeddingFilePath as getShardedEmbeddingPath, getEmbeddingModelName as getShardedEmbeddingModel, getEmbeddingDimension as getShardedEmbeddingDimension } from './sharded_index_manager.js';
import { scanAndIncrementallyIndex } from './incremental_shard_indexer.js';
import { getCompatIndex } from './sharded_compat.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RAG_ROOT = path.join(PROJECT_ROOT, 'public', 'rag');
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

// Explicit compatibility entry point. It reconciles the source tree against
// the existing shards and processes only files that are not already indexed.
export async function incrementalUpdate(dataRoot, opts = {}) {
    const ragRoot = opts.ragRoot ? path.resolve(opts.ragRoot) : DEFAULT_RAG_ROOT;
    const results = await scanAndIncrementallyIndex({ dataRoot, ragRoot });
    return { ok: true, results };
}

// A full rebuild remains an explicit offline operation. Runtime startup and
// file changes must never silently rebuild the 24k+ chunk corpus.
export const buildIndex = undefined;
