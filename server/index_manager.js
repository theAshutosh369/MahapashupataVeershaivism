import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureIndex as ensureShardedIndex, getIndexFilePath as getShardedIndexPath, getEmbeddingFilePath as getShardedEmbeddingPath, getEmbeddingModelName as getShardedEmbeddingModel, getEmbeddingDimension as getShardedEmbeddingDimension } from './sharded_index_manager.js';
import { scanAndIncrementallyIndex } from './incremental_shard_indexer.js';
import { reconcileDevelopmentSources, startDevelopmentWatcher } from './development_incremental_indexer.js';
import { getCompatIndex } from './sharded_compat.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RAG_ROOT = path.join(PROJECT_ROOT, 'public', 'rag');
let currentCompatIndex = null;
let developmentWatcherStop = null;
let developmentReconcilePromise = Promise.resolve();

function isDevelopmentRuntime(opts = {}) {
    if (opts.runtimeMode) return opts.runtimeMode !== 'production';
    return String(process.env.RAG_RUNTIME_MODE || process.env.NODE_ENV || 'development').toLowerCase() !== 'production';
}

// Compatibility facade for the legacy index_manager API. Runtime retrieval is
// backed by public/rag shards. In development, source changes are reconciled
// before the shard manager loads its manifest, so newly added/edited files are
// immediately available without a full-corpus rebuild.
export async function ensureIndex(dataRoot, opts = {}) {
    const ragRoot = opts.ragRoot ? path.resolve(opts.ragRoot) : DEFAULT_RAG_ROOT;
    const development = isDevelopmentRuntime(opts);

    if (development) {
        developmentReconcilePromise = developmentReconcilePromise.then(async () => {
            const results = await reconcileDevelopmentSources({ dataRoot, ragRoot });
            const changed = results.filter((item) => item.status === 'indexed' || item.status === 'updated');
            if (changed.length) console.log(`[DevIncremental] Reconciled ${changed.length} source file(s): ${changed.map((item) => item.path).join(', ')}`);
            return results;
        }).catch((error) => {
            console.warn('[DevIncremental] Startup reconciliation failed:', error.message);
            return [];
        });
        await developmentReconcilePromise;
    }

    await ensureShardedIndex(dataRoot, { ...opts, ragRoot, runtimeMode: development ? 'development' : 'production' });
    currentCompatIndex = await getCompatIndex();

    if (development && !developmentWatcherStop) {
        developmentWatcherStop = startDevelopmentWatcher({
            dataRoot,
            ragRoot,
            onUpdate: async (result) => {
                if (result?.status === 'indexed' || result?.status === 'updated') {
                    // The shard manager reads manifest data at retrieval time;
                    // force the next compatibility/status read to see fresh data.
                    currentCompatIndex = await getCompatIndex().catch(() => currentCompatIndex);
                }
            }
        });
    }
    return currentCompatIndex;
}

export function getCurrentIndex() { return currentCompatIndex; }
export function getIndexFilePath() { return getShardedIndexPath(); }
export function getEmbeddingFilePath() { return getShardedEmbeddingPath(); }
export function getEmbeddingModelName() { return getShardedEmbeddingModel(); }
export function getEmbeddingDimension() { return getShardedEmbeddingDimension(); }
export function getCurrentEmbeddingStore() { return null; }
export function setCurrentEmbeddingStore(_store) { /* Sharded stores remain lazy. */ }

export async function incrementalUpdate(dataRoot, opts = {}) {
    const ragRoot = opts.ragRoot ? path.resolve(opts.ragRoot) : DEFAULT_RAG_ROOT;
    const results = await scanAndIncrementallyIndex({ dataRoot, ragRoot });
    return { ok: true, results };
}

// A full rebuild remains an explicit offline operation. Runtime startup and
// development file changes must never silently rebuild the 24k+ chunk corpus.
export const buildIndex = undefined;
