/**
 * Sharded RAG runtime manager.
 *
 * Runtime storage mirrors public/data exactly under public/rag:
 *   public/data/Agamas/...           -> public/rag/Agamas/index.json + embeddings.bin
 *   public/data/Smritis/...          -> public/rag/Smritis/...
 *   public/data/Upanishadas/...      -> public/rag/Upanishadas/...
 *   public/data/Vachanas/...         -> public/rag/Vachanas/...
 *   public/data/Veershaiv Granthas/... -> public/rag/Veershaiv Granthas/...
 *
 * This module is read-only at runtime. It never scans public/data, never chunks
 * source files, and never creates a monolithic rag_index.json/rag_embeddings.bin.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorStore } from './vector_store.js';
import { hybridSearch, keywordSearch } from './hybrid_search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RAG_ROOT = path.join(PROJECT_ROOT, 'public', 'rag');
const EMBEDDING_DIMENSION = 768;
const EMBEDDING_MODEL = 'gemini-embedding-001';

let ragRoot = DEFAULT_RAG_ROOT;
let manifest = null;
let readyPromise = null;

function normalize(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function shardNameForDataset(dataset) {
    const value = normalize(dataset);
    if (!value) return null;
    return value.split('/')[0];
}

function safeShardPath(shardName) {
    const name = normalize(shardName);
    if (!name || name === '.' || name === '..' || name.includes('..')) return null;
    const full = path.resolve(ragRoot, name);
    if (full !== path.resolve(ragRoot) && !full.startsWith(path.resolve(ragRoot) + path.sep)) return null;
    return full;
}

async function readJson(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Invalid RAG JSON: ' + filePath);
    return value;
}

async function discoverShards() {
    const entries = await fs.readdir(ragRoot, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = safeShardPath(entry.name);
        if (!dir) continue;
        try {
            await fs.access(path.join(dir, 'index.json'));
            await fs.access(path.join(dir, 'embeddings.bin'));
            names.push(entry.name);
        } catch {
            // Ignore non-RAG directories.
        }
    }
    return names.sort((a, b) => a.localeCompare(b));
}

export async function ensureIndex(dataRoot, opts = {}) {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
        if (opts.ragRoot) ragRoot = path.resolve(opts.ragRoot);
        else if (dataRoot) ragRoot = path.resolve(path.dirname(dataRoot), 'rag');

        console.log('[ShardedRAG] RAG root:', ragRoot);

        let loadedManifest = null;
        try {
            loadedManifest = await readJson(path.join(ragRoot, 'manifest.json'));
        } catch {
            loadedManifest = null;
        }

        const shards = Array.isArray(loadedManifest?.shards)
            ? loadedManifest.shards.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean)
            : await discoverShards();

        if (shards.length === 0) {
            throw new Error('No RAG shards found under ' + ragRoot + '. Expected public/rag/<category>/index.json and embeddings.bin.');
        }

        const datasetNames = [];
        let chunkCount = 0;
        const shardInfo = [];

        // Only read small metadata counts here. Do NOT load chunk arrays.
        for (const shard of shards) {
            const dir = safeShardPath(shard);
            if (!dir) continue;
            try {
                const idx = await readJson(path.join(dir, 'index.json'));
                const count = Array.isArray(idx.chunks) ? idx.chunks.length : Number(idx.chunkCount) || 0;
                chunkCount += count;
                if (Array.isArray(idx.datasetNames)) datasetNames.push(...idx.datasetNames);
                shardInfo.push({ name: shard, chunkCount: count });
            } catch (e) {
                console.warn('[ShardedRAG] Ignoring invalid shard ' + shard + ': ' + e.message);
            }
        }

        manifest = {
            sharded: true,
            ragRoot,
            shards: shardInfo,
            datasetNames: [...new Set(datasetNames)].sort((a, b) => a.localeCompare(b)),
            chunkCount
        };

        console.log('[ShardedRAG] Loaded manifest: ' + shardInfo.length + ' shards, ' + chunkCount + ' chunks');
        console.log('[ShardedRAG] Runtime mode: shard-local metadata + lazy batched embeddings');
        return manifest;
    })();

    return readyPromise;
}

export function getCurrentIndex() {
    return manifest;
}

export function getIndexFilePath() {
    return path.join(ragRoot, 'manifest.json');
}

export function getEmbeddingFilePath() {
    return path.join(ragRoot, '<shard>', 'embeddings.bin');
}

export function getEmbeddingModelName() { return EMBEDDING_MODEL; }
export function getEmbeddingDimension() { return EMBEDDING_DIMENSION; }
export function getCurrentEmbeddingStore() { return null; }

async function loadShard(shardName) {
    const dir = safeShardPath(shardName);
    if (!dir) throw new Error('Invalid RAG shard: ' + shardName);
    const index = await readJson(path.join(dir, 'index.json'));
    if (!Array.isArray(index.chunks)) throw new Error('Shard index has no chunks array: ' + shardName);
    const embeddingPath = path.join(dir, 'embeddings.bin');
    const store = await VectorStore.open(embeddingPath);
    return { name: shardName, dir, index, store };
}

function selectedShards(selection) {
    const all = manifest?.shards?.map(s => s.name) || [];
    if (!selection) return all;
    const values = Array.isArray(selection) ? selection : [selection];
    const wanted = new Set(values.map(v => shardNameForDataset(v)).filter(Boolean));
    if (wanted.size === 0) return all;
    return all.filter(name => wanted.has(name));
}

function selectedDatasets(selection) {
    if (!selection) return null;
    const values = Array.isArray(selection) ? selection : [selection];
    const set = new Set(values.map(v => normalize(v)).filter(Boolean));
    return set.size ? set : null;
}

export async function retrieveFromShards(query, datasetSelection, topK = 10, queryEmbedding = null) {
    if (!manifest) throw new Error('Sharded RAG is not initialized. Call ensureIndex() first.');

    const shardNames = selectedShards(datasetSelection);
    const selectedSet = selectedDatasets(datasetSelection);
    const perShardTop = Math.max(20, Math.min(50, Number(topK) * 4));
    const allResults = [];

    for (const shardName of shardNames) {
        let shard;
        try {
            shard = await loadShard(shardName);
            let candidates = shard.index.chunks;
            if (selectedSet) {
                candidates = candidates.filter(chunk => selectedSet.has(normalize(chunk.dataset)));
            }
            if (!candidates.length) continue;

            // Keyword retrieval stays shard-local. This prevents one huge global
            // array and also guarantees that a file can never migrate between
            // categories during retrieval.
            const keywordCandidates = keywordSearch(query, candidates, { topK: perShardTop });

            let semanticCandidates = [];
            if (queryEmbedding && shard.store.size() > 0) {
                const semantic = await shard.store.searchBatched(queryEmbedding, perShardTop, 500);
                const byEmbedding = new Map();
                for (const chunk of candidates) {
                    if (Number.isInteger(chunk.embeddingIndex) && chunk.embeddingIndex >= 0) {
                        byEmbedding.set(chunk.embeddingIndex, chunk);
                    }
                }
                for (const hit of semantic) {
                    const chunk = byEmbedding.get(hit.index);
                    if (chunk) semanticCandidates.push({ chunk, similarity: hit.score });
                }
            }

            // Union only the small candidate sets. Attach embeddings only for
            // these candidates, never for the entire shard.
            const union = new Map();
            for (const item of keywordCandidates) union.set(item.chunk.id, item.chunk);
            for (const item of semanticCandidates) union.set(item.chunk.id, item.chunk);

            const candidateArray = [...union.values()];
            if (queryEmbedding && candidateArray.length) {
                const semanticMap = new Map(semanticCandidates.map(item => [item.chunk.id, item.similarity]));
                for (const chunk of candidateArray) {
                    if (semanticMap.has(chunk.id)) {
                        try { chunk.embedding = await shard.store.get(chunk.embeddingIndex); } catch { /* keyword still works */ }
                    }
                }
            }

            let results = [];
            if (queryEmbedding && candidateArray.some(c => c.embedding)) {
                results = hybridSearch(queryEmbedding, query, candidateArray, { topK: perShardTop, retrieveK: perShardTop });
            } else {
                results = keywordCandidates;
            }

            for (const result of results) {
                result.shard = shardName;
                allResults.push(result);
            }

            for (const chunk of candidateArray) {
                try { delete chunk.embedding; } catch { /* ignore */ }
            }
        } finally {
            if (shard?.store) {
                try { await shard.store.close(); } catch { /* ignore */ }
            }
        }
    }

    allResults.sort((a, b) => (Number(b.score ?? b.similarity ?? 0) - Number(a.score ?? a.similarity ?? 0)));
    const seen = new Set();
    const finalResults = [];
    for (const item of allResults) {
        const id = item.chunk?.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        finalResults.push(item);
        if (finalResults.length >= Math.min(25, Number(topK) || 10)) break;
    }
    return finalResults;
}
