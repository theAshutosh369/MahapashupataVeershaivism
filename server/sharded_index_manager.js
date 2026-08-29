/**
 * Sharded RAG runtime manager.
 *
 * Runtime storage mirrors public/data under public/rag. Runtime is READ-ONLY:
 * it never scans public/data for indexing, never chunks source files, and never
 * creates a monolithic rag_index.json/rag_embeddings.bin.
 *
 * A shard is any directory below public/rag containing BOTH index.json and
 * embeddings.bin. This allows the RAG tree to mirror public/data recursively
 * without assuming a fixed folder layout.
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

function shardCategory(shardName) {
    const value = normalize(shardName);
    return value ? value.split('/')[0] : '';
}

function datasetCategory(dataset) {
    return shardCategory(dataset);
}

function safeShardPath(shardName) {
    const name = normalize(shardName);
    if (!name || name === '.' || name === '..' || name.includes('..')) return null;
    const root = path.resolve(ragRoot);
    const full = path.resolve(root, name);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return full;
}

async function readJson(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Invalid RAG JSON: ' + filePath);
    return value;
}

/** Discover shard directories recursively without ever inspecting public/data. */
async function discoverShards(dir = ragRoot, relative = '') {
    const out = [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }

    let hasIndex = false;
    let hasEmbeddings = false;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name === 'index.json') hasIndex = true;
        if (entry.name === 'embeddings.bin') hasEmbeddings = true;
    }

    if (hasIndex && hasEmbeddings && relative) {
        out.push(normalize(relative));
        // A directory containing a shard is a leaf runtime shard. Do not mix
        // its children into another shard.
        return out;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        out.push(...await discoverShards(path.join(dir, entry.name), childRelative));
    }
    return out;
}

export async function ensureIndex(dataRoot, opts = {}) {
    // dataRoot is intentionally ignored. It remains in the signature for
    // compatibility with the existing route layer.
    void dataRoot;

    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
        if (opts.ragRoot) ragRoot = path.resolve(opts.ragRoot);
        else ragRoot = DEFAULT_RAG_ROOT;

        console.log('[ShardedRAG] RAG root:', ragRoot);
        console.log('[ShardedRAG] Runtime is read-only; source data is not scanned or chunked.');

        let loadedManifest = null;
        try {
            loadedManifest = await readJson(path.join(ragRoot, 'manifest.json'));
        } catch {
            loadedManifest = null;
        }

        const discovered = await discoverShards();
        const configured = Array.isArray(loadedManifest?.shards)
            ? loadedManifest.shards
                .map(s => typeof s === 'string' ? s : s?.path || s?.name)
                .filter(Boolean)
                .map(normalize)
            : [];

        // Prefer manifest entries that actually exist. If the manifest is
        // absent/stale, discover the real shard tree instead of rebuilding it.
        const manifestCandidates = configured.length > 0 ? configured : discovered;
        const shards = [];
        for (const shard of manifestCandidates) {
            const dir = safeShardPath(shard);
            if (!dir) continue;
            try {
                await fs.access(path.join(dir, 'index.json'));
                await fs.access(path.join(dir, 'embeddings.bin'));
                shards.push(shard);
            } catch {
                // Ignore stale manifest entries.
            }
        }

        // If a manifest omitted a newly-created shard, include it. No source
        // files are touched by this fallback.
        for (const shard of discovered) {
            if (!shards.includes(shard)) shards.push(shard);
        }

        if (shards.length === 0) {
            throw new Error('No RAG shards found under ' + ragRoot + '. Expected public/rag/**/index.json + embeddings.bin.');
        }

        const datasetNames = [];
        let chunkCount = 0;
        const shardInfo = [];

        for (const shard of shards.sort((a, b) => a.localeCompare(b))) {
            const dir = safeShardPath(shard);
            try {
                const idx = await readJson(path.join(dir, 'index.json'));
                const count = Array.isArray(idx.chunks) ? idx.chunks.length : Number(idx.chunkCount) || 0;
                chunkCount += count;
                if (Array.isArray(idx.datasetNames)) datasetNames.push(...idx.datasetNames);
                shardInfo.push({
                    name: shard,
                    path: shard,
                    category: shardCategory(shard),
                    chunkCount: count
                });
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

        console.log('[ShardedRAG] Loaded ' + shardInfo.length + ' shards, ' + chunkCount + ' chunks');
        console.log('[ShardedRAG] Retrieval mode: shard-local keyword + batched semantic candidates; no loadAll()');
        return manifest;
    })();

    try {
        return await readyPromise;
    } catch (error) {
        readyPromise = null;
        throw error;
    }
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

    // Guard against the exact class of cross-folder corruption we are trying
    // to prevent: every chunk must belong to the shard's source category.
    const category = shardCategory(shardName);
    for (const chunk of index.chunks) {
        const dataset = normalize(chunk?.dataset);
        if (dataset && datasetCategory(dataset) !== category) {
            throw new Error(`Shard/category mismatch in ${shardName}: ${dataset}`);
        }
    }

    const store = await VectorStore.open(path.join(dir, 'embeddings.bin'));
    if (store.dimension() !== EMBEDDING_DIMENSION) {
        await store.close();
        throw new Error(`Embedding dimension mismatch in ${shardName}: ${store.dimension()} != ${EMBEDDING_DIMENSION}`);
    }
    return { name: shardName, dir, index, store };
}

function selectedShards(selection) {
    const all = manifest?.shards?.map(s => s.name) || [];
    if (!selection) return all;

    const values = Array.isArray(selection) ? selection : [selection];
    const wantedDatasets = values.map(v => normalize(v)).filter(Boolean);
    if (wantedDatasets.length === 0) return all;

    const wantedCategories = new Set(wantedDatasets.map(datasetCategory));
    return all.filter(name => {
        const category = shardCategory(name);
        return wantedCategories.has(category) || wantedDatasets.includes(name);
    });
}

function selectedDatasets(selection) {
    if (!selection) return null;
    const values = Array.isArray(selection) ? selection : [selection];
    const set = new Set(values.map(v => normalize(v)).filter(Boolean));
    return set.size ? set : null;
}

function candidateMatchesSelection(chunk, selectedSet) {
    if (!selectedSet) return true;
    const dataset = normalize(chunk?.dataset);
    for (const selected of selectedSet) {
        if (dataset === selected) return true;
        // Selecting a category is allowed to include its datasets; selecting a
        // specific dataset remains exact.
        if (datasetCategory(selected) === datasetCategory(dataset) && selected === datasetCategory(selected)) return true;
    }
    return false;
}

export async function retrieveFromShards(query, datasetSelection, topK = 10, queryEmbedding = null) {
    if (!manifest) throw new Error('Sharded RAG is not initialized. Call ensureIndex() first.');

    const shardNames = selectedShards(datasetSelection);
    const selectedSet = selectedDatasets(datasetSelection);
    const perShardTop = Math.max(20, Math.min(50, Number(topK) * 4));
    const allResults = [];

    for (const shardName of shardNames) {
        let shard = null;
        try {
            shard = await loadShard(shardName);
            let candidates = shard.index.chunks;
            if (selectedSet) candidates = candidates.filter(chunk => candidateMatchesSelection(chunk, selectedSet));
            if (!candidates.length) continue;

            // Keyword search remains shard-local. It is only used to build a
            // small reranking candidate pool; embeddings are never attached to
            // every chunk.
            const keywordCandidates = keywordSearch(query, candidates, { topK: perShardTop });

            let semanticCandidates = [];
            if (queryEmbedding && shard.store.size() > 0) {
                const semanticHits = await shard.store.searchBatched(queryEmbedding, perShardTop, 500);
                const byEmbeddingIndex = new Map();
                for (const chunk of candidates) {
                    if (Number.isInteger(chunk.embeddingIndex) && chunk.embeddingIndex >= 0) {
                        byEmbeddingIndex.set(chunk.embeddingIndex, chunk);
                    }
                }
                for (const hit of semanticHits) {
                    const chunk = byEmbeddingIndex.get(hit.index);
                    if (chunk) semanticCandidates.push({ chunk, similarity: hit.score });
                }
            }

            // Union the two small candidate sets, then perform the exact same
            // hybrid scoring logic the existing agent uses.
            const union = new Map();
            for (const item of keywordCandidates) {
                if (item?.chunk?.id) union.set(item.chunk.id, item.chunk);
            }
            for (const item of semanticCandidates) {
                if (item?.chunk?.id) union.set(item.chunk.id, item.chunk);
            }

            const candidateArray = [...union.values()];
            if (!candidateArray.length) continue;

            const semanticMap = new Map(semanticCandidates.map(item => [item.chunk.id, item.similarity]));
            if (queryEmbedding && semanticMap.size > 0) {
                for (const chunk of candidateArray) {
                    if (!semanticMap.has(chunk.id)) continue;
                    try {
                        chunk.embedding = await shard.store.get(chunk.embeddingIndex);
                    } catch {
                        // Keep keyword/fuzzy retrieval available if one vector
                        // is malformed or missing.
                    }
                }
            }

            let results;
            if (queryEmbedding && candidateArray.some(c => c.embedding)) {
                results = hybridSearch(queryEmbedding, query, candidateArray, {
                    topK: perShardTop,
                    retrieveK: perShardTop
                });
            } else {
                results = keywordCandidates;
            }

            for (const result of results) {
                if (!result?.chunk) continue;
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

    allResults.sort((a, b) => Number(b.score ?? b.similarity ?? 0) - Number(a.score ?? a.similarity ?? 0));

    const seen = new Set();
    const finalResults = [];
    const limit = Math.min(25, Number(topK) || 10);
    for (const item of allResults) {
        const id = item.chunk?.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        finalResults.push(item);
        if (finalResults.length >= limit) break;
    }

    return finalResults;
}
