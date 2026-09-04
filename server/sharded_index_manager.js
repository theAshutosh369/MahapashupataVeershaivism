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
const IGNORED_SHARD_CATEGORIES = new Set(['other']);

let ragRoot = DEFAULT_RAG_ROOT;
let manifest = null;
let readyPromise = null;

function normalize(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

// Matching form only. Original source text is never modified.
function normalizeForMatch(value) {
    return normalize(value)
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[।॥]/g, ' ')
        .replace(/[“”„‟″]/g, '"')
        .replace(/[‘’‚‛′]/g, "'")
        .replace(/[^\p{L}\p{N}\s'"_-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function queryVariants(query) {
    const original = normalize(query);
    const match = normalizeForMatch(original);
    const variants = new Set();
    if (original) variants.add(original);
    if (match && match !== original) variants.add(match);

    // Keep expansion lexical-only. This deliberately does not create extra
    // Gemini embedding requests, so one user question still uses one embedding.
    const tokens = match.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
        for (const token of tokens) {
            if (token.length >= 3) variants.add(token);
        }
    }
    return [...variants].slice(0, 8);
}

function shardCategory(name) {
    const value = normalize(name);
    return value ? value.split('/')[0] : '';
}
function isIgnoredShard(name) {
    return IGNORED_SHARD_CATEGORIES.has(shardCategory(name).toLowerCase());
}
function safeShardPath(shardName) {
    const name = normalize(shardName);
    if (!name || name === '.' || name === '..' || name.includes('..') || isIgnoredShard(name)) return null;
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
async function discoverShards(dir = ragRoot, relative = '') {
    if (relative && isIgnoredShard(relative)) return [];
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    let hasIndex = false;
    let hasEmbeddings = false;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name === 'index.json') hasIndex = true;
        if (entry.name === 'embeddings.bin') hasEmbeddings = true;
    }
    if (hasIndex && hasEmbeddings && relative) return [normalize(relative)];
    const result = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (isIgnoredShard(child)) continue;
        result.push(...await discoverShards(path.join(dir, entry.name), child));
    }
    return result;
}

export async function ensureIndex(dataRoot, opts = {}) {
    void dataRoot;
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
        ragRoot = opts.ragRoot ? path.resolve(opts.ragRoot) : DEFAULT_RAG_ROOT;
        console.log('[ShardedRAG] RAG root:', ragRoot);
        console.log('[ShardedRAG] Runtime is read-only; source data is not scanned or chunked.');
        console.log('[ShardedRAG] Ignoring unused shard category: Other');
        let savedManifest = null;
        try { savedManifest = await readJson(path.join(ragRoot, 'manifest.json')); } catch { savedManifest = null; }
        const discovered = await discoverShards();
        const configured = Array.isArray(savedManifest?.shards)
            ? savedManifest.shards.map(s => typeof s === 'string' ? s : s?.path || s?.name).filter(Boolean).map(normalize).filter(s => !isIgnoredShard(s))
            : [];
        const candidates = configured.length ? configured : discovered;
        const shards = [];
        for (const shard of candidates) {
            if (isIgnoredShard(shard)) continue;
            const dir = safeShardPath(shard);
            if (!dir) continue;
            try {
                await fs.access(path.join(dir, 'index.json'));
                await fs.access(path.join(dir, 'embeddings.bin'));
                if (!shards.includes(shard)) shards.push(shard);
            } catch { /* stale manifest entry */ }
        }
        for (const shard of discovered) {
            if (!isIgnoredShard(shard) && !shards.includes(shard)) shards.push(shard);
        }
        if (!shards.length) throw new Error('No RAG shards found under ' + ragRoot + '.');
        const datasetNames = [];
        const shardInfo = [];
        let chunkCount = 0;
        for (const shard of shards.sort((a, b) => a.localeCompare(b))) {
            const dir = safeShardPath(shard);
            if (!dir) continue;
            try {
                const index = await readJson(path.join(dir, 'index.json'));
                const count = Array.isArray(index.chunks) ? index.chunks.length : Number(index.chunkCount) || 0;
                chunkCount += count;
                if (Array.isArray(index.datasetNames)) datasetNames.push(...index.datasetNames);
                shardInfo.push({ name: shard, path: shard, category: shardCategory(shard), chunkCount: count });
            } catch (error) {
                console.warn('[ShardedRAG] Ignoring invalid shard ' + shard + ': ' + error.message);
            }
        }
        manifest = { sharded: true, ragRoot, shards: shardInfo, datasetNames: [...new Set(datasetNames)].sort((a, b) => a.localeCompare(b)), chunkCount };
        console.log('[ShardedRAG] Loaded ' + shardInfo.length + ' shards, ' + chunkCount + ' chunks');
        console.log('[ShardedRAG] Retrieval mode: shard-local keyword + batched semantic candidates + query expansion + reranking');
        return manifest;
    })();
    try { return await readyPromise; }
    catch (error) { readyPromise = null; throw error; }
}
export function getCurrentIndex() { return manifest; }
export function getIndexFilePath() { return path.join(ragRoot, 'manifest.json'); }
export function getEmbeddingFilePath() { return path.join(ragRoot, '<shard>', 'embeddings.bin'); }
export function getEmbeddingModelName() { return EMBEDDING_MODEL; }
export function getEmbeddingDimension() { return EMBEDDING_DIMENSION; }
export function getCurrentEmbeddingStore() { return null; }

async function loadShard(shardName) {
    if (isIgnoredShard(shardName)) throw new Error('Ignored RAG shard: ' + shardName);
    const dir = safeShardPath(shardName);
    if (!dir) throw new Error('Invalid RAG shard: ' + shardName);
    const index = await readJson(path.join(dir, 'index.json'));
    if (!Array.isArray(index.chunks)) throw new Error('Shard index has no chunks array: ' + shardName);
    const category = shardCategory(shardName);
    for (const chunk of index.chunks) {
        const dataset = normalize(chunk?.dataset);
        if (dataset && shardCategory(dataset) !== category) throw new Error(`Shard/category mismatch in ${shardName}: ${dataset}`);
    }
    const store = await VectorStore.open(path.join(dir, 'embeddings.bin'));
    if (store.dimension() !== EMBEDDING_DIMENSION) {
        await store.close();
        throw new Error(`Embedding dimension mismatch in ${shardName}: ${store.dimension()} != ${EMBEDDING_DIMENSION}`);
    }
    return { name: shardName, dir, index, store };
}
function selectedShards(selection) {
    const all = (manifest?.shards || []).map(s => s.name).filter(name => !isIgnoredShard(name));
    if (!selection) return all;
    const values = (Array.isArray(selection) ? selection : [selection]).map(normalize).filter(Boolean);
    if (!values.length) return all;
    const categories = new Set(values.map(shardCategory));
    return all.filter(name => categories.has(shardCategory(name)) || values.includes(name));
}
function selectedDatasets(selection) {
    if (!selection) return null;
    const values = (Array.isArray(selection) ? selection : [selection]).map(normalize).filter(Boolean);
    return values.length ? new Set(values) : null;
}
function matchesSelection(chunk, selectedSet) {
    if (!selectedSet) return true;
    const dataset = normalize(chunk?.dataset);
    for (const selected of selectedSet) {
        if (dataset === selected) return true;
        if (selected === shardCategory(selected) && shardCategory(dataset) === selected) return true;
    }
    return false;
}

function textForRerank(chunk) {
    return normalizeForMatch([
        chunk?.text,
        chunk?.title,
        chunk?.author,
        chunk?.dataset,
        chunk?.source,
        chunk?.file,
        chunk?.vachanaNumber
    ].filter(v => v !== undefined && v !== null).join(' '));
}

function lexicalScore(query, chunk) {
    const q = normalizeForMatch(query);
    if (!q) return 0;
    const text = textForRerank(chunk);
    if (!text) return 0;
    let score = 0;
    if (text.includes(q)) score += 1;
    const terms = q.split(/\s+/).filter(t => t.length >= 2);
    let hits = 0;
    for (const term of terms) if (text.includes(term)) hits++;
    if (terms.length) score += hits / terms.length * 0.75;
    return Math.min(1.75, score);
}

function rerankResults(results, query, expandedQueries) {
    const original = normalizeForMatch(query);
    const variants = expandedQueries.map(normalizeForMatch).filter(Boolean);
    const unique = new Map();
    for (const item of results) {
        const chunk = item?.chunk;
        if (!chunk) continue;
        const id = chunk.id || `${item.shard || ''}:${chunk.embeddingIndex ?? ''}:${chunk.dataset || ''}`;
        const semantic = Number(item.similarity ?? item.semanticScore ?? 0);
        const base = Number(item.score ?? 0);
        const originalLex = lexicalScore(original, chunk);
        const expansionLex = variants.reduce((best, variant) => Math.max(best, lexicalScore(variant, chunk)), 0);
        const metadata = normalizeForMatch([chunk.title, chunk.author, chunk.dataset, chunk.file].filter(Boolean).join(' '));
        const entityBoost = original && metadata.includes(original) ? 0.45 : 0;
        const score = base * 0.45 + semantic * 0.30 + originalLex * 0.20 + expansionLex * 0.08 + entityBoost;
        const existing = unique.get(id);
        const enriched = { ...item, score, rerankScore: score };
        if (!existing || score > existing.rerankScore) unique.set(id, enriched);
    }
    return [...unique.values()].sort((a, b) => b.rerankScore - a.rerankScore);
}

export async function retrieveFromShards(query, datasetSelection, topK = 10, queryEmbedding = null) {
    if (!manifest) throw new Error('Sharded RAG is not initialized. Call ensureIndex() first.');
    const shardNames = selectedShards(datasetSelection);
    const selectedSet = selectedDatasets(datasetSelection);
    const expandedQueries = queryVariants(query);
    const perShardTop = Math.max(20, Math.min(50, Number(topK) * 4));
    const allResults = [];

    console.log('[ShardedRAG] Hierarchical retrieval: ' + shardNames.length + ' selected shard(s)');
    console.log('[ShardedRAG] Query expansion: ' + expandedQueries.length + ' lexical variant(s)');

    for (const shardName of shardNames) {
        let shard = null;
        try {
            shard = await loadShard(shardName);
            let candidates = shard.index.chunks;
            if (selectedSet) candidates = candidates.filter(chunk => matchesSelection(chunk, selectedSet));
            if (!candidates.length) continue;

            // Query expansion is lexical-only; it adds recall without extra API calls.
            const keywordMap = new Map();
            for (const expandedQuery of expandedQueries) {
                const found = keywordSearch(expandedQuery, candidates, { topK: perShardTop });
                for (const item of found) {
                    if (!item?.chunk?.id) continue;
                    const current = keywordMap.get(item.chunk.id);
                    if (!current || Number(item.score ?? 0) > Number(current.score ?? 0)) {
                        keywordMap.set(item.chunk.id, item);
                    }
                }
            }
            const keywordCandidates = [...keywordMap.values()];

            let semanticCandidates = [];
            if (queryEmbedding && shard.store.size() > 0) {
                const hits = await shard.store.searchBatched(queryEmbedding, perShardTop, 500);
                const byIndex = new Map();
                for (const chunk of candidates) {
                    if (Number.isInteger(chunk.embeddingIndex) && chunk.embeddingIndex >= 0) {
                        byIndex.set(chunk.embeddingIndex, chunk);
                    }
                }
                for (const hit of hits) {
                    const chunk = byIndex.get(hit.index);
                    if (chunk) semanticCandidates.push({ chunk, similarity: hit.score });
                }
            }

            const union = new Map();
            for (const item of keywordCandidates) if (item?.chunk?.id) union.set(item.chunk.id, item.chunk);
            for (const item of semanticCandidates) if (item?.chunk?.id) union.set(item.chunk.id, item.chunk);
            const candidateArray = [...union.values()];
            if (!candidateArray.length) continue;

            const semanticMap = new Map(semanticCandidates.map(item => [item.chunk.id, item.similarity]));
            if (queryEmbedding && semanticMap.size) {
                for (const chunk of candidateArray) {
                    if (!semanticMap.has(chunk.id)) continue;
                    try { chunk.embedding = await shard.store.get(chunk.embeddingIndex); } catch { /* keyword fallback */ }
                }
            }

            const results = queryEmbedding && candidateArray.some(c => c.embedding)
                ? hybridSearch(queryEmbedding, query, candidateArray, { topK: perShardTop, retrieveK: perShardTop, preserveSemanticCandidates: true })
                : keywordCandidates;

            for (const result of results) {
                if (result?.chunk) {
                    result.shard = shardName;
                    allResults.push(result);
                }
            }
            for (const chunk of candidateArray) delete chunk.embedding;
        } finally {
            if (shard?.store) try { await shard.store.close(); } catch { /* ignore */ }
        }
    }

    // Global reranking is the final hierarchical stage: shard-local retrieval
    // first, then a single global ranking across the selected shards.
    const reranked = rerankResults(allResults, query, expandedQueries);
    const seen = new Set();
    const finalResults = [];
    const limit = Math.min(25, Number(topK) || 10);
    for (const item of reranked) {
        const id = item.chunk?.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        finalResults.push(item);
        if (finalResults.length >= limit) break;
    }
    console.log('[ShardedRAG] Final reranked results: ' + finalResults.length);
    return finalResults;
}
