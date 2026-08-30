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
    return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/*
 * Phase 1 — multilingual search normalization.
 *
 * This intentionally does not transliterate one Indic script into another:
 * doing so without a proper language model can change names and Sanskrit words.
 * Instead, it removes Unicode presentation noise, normalises punctuation and
 * diacritics, and keeps every original script intact.
 */
function normalizeSearchText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[।॥]+/g, ' ')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const QUERY_STOP_WORDS = new Set([
    'a','an','the','is','are','was','were','be','been','being','who','what','which','when','where','why','how','whom','whose',
    'do','does','did','has','have','had','of','to','in','on','at','for','with','by','from','as','and','or','but','not','no','yes',
    'it','its','he','she','they','them','we','you','i','this','that','these','those','am','will','would','can','could','should','may','might',
    'tell','me','about','give','some','info','information','explain','describe',
    'एक','एके','कौन','क्या','कब','कहाँ','क्यों','कैसे','है','हैं','था','थे','की','के','का','को','में','से','पर','और','या','यह','वह','मुझे',
    'ಯಾರು','ಏನು','ಯಾವ','ಯಾವಾಗ','ಎಲ್ಲಿ','ಏಕೆ','ಹೇಗೆ','ಇದು','ಅದು','ಇದೆ','ಇವೆ','ಯಾರು','ಮತ್ತು','ಅಥವಾ','ನನಗೆ',
    'कोण','काय','कधी','कुठे','का','कसे','आहे','आहेत','होता','होते','ची','चे','चा','ला','मध्ये','पासून','आणि','किंवा','मला',
    'कः','का','किम्','कदा','कुत्र','कथम्','कस्य','केन','च','वा','अस्ति','सन्ति','मम'
]);

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
        console.log('[ShardedRAG] Retrieval mode: hierarchical shard-local retrieval + query expansion + hybrid reranking');
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

function uniquePush(list, value, max = 8) {
    if (!value || list.includes(value) || list.length >= max) return;
    list.push(value);
}

/*
 * Phase 1 — query expansion without extra Gemini calls.
 * The original query remains first and is always used for semantic search.
 * Additional variants are lexical-only, keeping one user question to one
 * embedding API request and therefore avoiding quota/performance regressions.
 */
function expandQuery(query) {
    const original = String(query || '').trim();
    const normalized = normalizeSearchText(original);
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const meaningful = tokens.filter(token => token.length >= 2 && !QUERY_STOP_WORDS.has(token));
    const variants = [];

    uniquePush(variants, original);
    uniquePush(variants, normalized);
    uniquePush(variants, meaningful.join(' '));

    // Entity-focused variants are especially useful for questions such as
    // "who is Renukacharya and Marularadhya?" where separate names may live in
    // different chunks or even different shards.
    for (const token of meaningful) {
        if (token.length >= 4) uniquePush(variants, token, 8);
    }

    return variants;
}

function lexicalRrf(resultsByVariant, chunkId) {
    let score = 0;
    for (let rank = 0; rank < resultsByVariant.length; rank++) {
        const result = resultsByVariant[rank].find(item => item?.chunk?.id === chunkId);
        if (result) score += 1 / (30 + result.rank + 1);
    }
    return score;
}

function fieldRelevance(query, chunk) {
    const q = normalizeSearchText(query);
    const meaningful = q.split(/\s+/).filter(t => t.length >= 3 && !QUERY_STOP_WORDS.has(t));
    if (!meaningful.length) return 0;
    const fields = [chunk?.author, chunk?.title, chunk?.dataset, chunk?.filename].map(normalizeSearchText);
    const text = normalizeSearchText(chunk?.text || '');
    let matched = 0;
    for (const token of meaningful) {
        if (fields.some(field => field.includes(token))) matched += 1;
        else if (text.includes(token)) matched += 0.5;
    }
    return Math.min(1, matched / meaningful.length);
}

async function retrieveWithinShard(shardName, query, queryVariants, selectedSet, topK, queryEmbedding) {
    let shard = null;
    try {
        shard = await loadShard(shardName);
        let candidates = shard.index.chunks;
        if (selectedSet) candidates = candidates.filter(chunk => matchesSelection(chunk, selectedSet));
        if (!candidates.length) return [];

        const perShardTop = Math.max(20, Math.min(60, Number(topK) * 5));
        const lexicalResults = [];
        const union = new Map();

        // Stage 1: query expansion + lexical retrieval inside this shard.
        for (const variant of queryVariants) {
            const results = keywordSearch(variant, candidates, { topK: perShardTop });
            const ranked = [];
            for (let i = 0; i < results.length; i++) {
                const item = results[i];
                if (!item?.chunk?.id) continue;
                ranked.push({ ...item, rank: i });
                union.set(item.chunk.id, item.chunk);
            }
            lexicalResults.push(ranked);
        }

        // Stage 1b: semantic candidates are searched directly in the shard's
        // vector file. No complete embedding matrix is loaded into memory.
        if (queryEmbedding && shard.store.size() > 0) {
            const semanticHits = await shard.store.searchBatched(queryEmbedding, perShardTop, 500);
            const byIndex = new Map();
            for (const chunk of candidates) {
                if (Number.isInteger(chunk.embeddingIndex) && chunk.embeddingIndex >= 0) byIndex.set(chunk.embeddingIndex, chunk);
            }
            for (const hit of semanticHits) {
                const chunk = byIndex.get(hit.index);
                if (chunk) union.set(chunk.id, chunk);
            }
        }

        if (!union.size) return [];

        // Stage 2: retrieve embeddings only for the small candidate union and
        // use the existing proven hybrid scorer as the semantic+lexical base.
        const candidateArray = [...union.values()].slice(0, 400);
        if (queryEmbedding) {
            for (const chunk of candidateArray) {
                if (!Number.isInteger(chunk.embeddingIndex) || chunk.embeddingIndex < 0) continue;
                try { chunk.embedding = await shard.store.get(chunk.embeddingIndex); } catch { /* lexical result remains usable */ }
            }
        }

        const baseResults = queryEmbedding && candidateArray.some(c => c.embedding)
            ? hybridSearch(queryEmbedding, query, candidateArray, { topK: perShardTop, retrieveK: perShardTop })
            : keywordSearch(query, candidateArray, { topK: perShardTop });

        const reranked = [];
        for (let i = 0; i < baseResults.length; i++) {
            const item = baseResults[i];
            if (!item?.chunk?.id) continue;
            const expansionScore = lexicalRrf(lexicalResults, item.chunk.id);
            const fieldScore = fieldRelevance(query, item.chunk);
            const baseScore = Number(item.score ?? item.similarity ?? 0);
            // Final shard-local reranking. Hybrid remains the strongest signal;
            // expansion and metadata/entity matching resolve ambiguous results.
            const score = (baseScore * 0.70) + (Math.min(0.10, expansionScore) * 1.5) + (fieldScore * 0.15);
            reranked.push({ ...item, score, expansionScore, fieldScore, shard: shardName });
        }
        reranked.sort((a, b) => b.score - a.score);
        return reranked.slice(0, perShardTop);
    } finally {
        if (shard?.store) try { await shard.store.close(); } catch { /* ignore */ }
    }
}

export async function retrieveFromShards(query, datasetSelection, topK = 10, queryEmbedding = null) {
    if (!manifest) throw new Error('Sharded RAG is not initialized. Call ensureIndex() first.');

    const shardNames = selectedShards(datasetSelection);
    const selectedSet = selectedDatasets(datasetSelection);
    const queryVariants = expandQuery(query);
    const effectiveTopK = Math.min(25, Math.max(1, Number(topK) || 10));

    console.log('[ShardedRAG] Phase 1 query variants:', queryVariants.join(' | '));
    console.log('[ShardedRAG] Hierarchical retrieval across ' + shardNames.length + ' selected shard(s)');

    // Stage 1: each shard independently retrieves and reranks candidates.
    const shardResults = [];
    for (const shardName of shardNames) {
        try {
            const results = await retrieveWithinShard(shardName, query, queryVariants, selectedSet, effectiveTopK, queryEmbedding);
            if (results.length) shardResults.push(...results);
        } catch (error) {
            // A malformed/unrelated shard should not destroy retrieval from all
            // other categories. This also makes old manifests safer to deploy.
            console.warn('[ShardedRAG] Skipping shard ' + shardName + ': ' + error.message);
        }
    }

    if (!shardResults.length) return [];

    // Stage 2: global reranking across shard-local winners. RRF prevents a
    // large shard from dominating merely because it produced more candidates.
    const grouped = new Map();
    for (const item of shardResults) {
        const id = item?.chunk?.id;
        if (!id) continue;
        const existing = grouped.get(id);
        if (!existing) grouped.set(id, { ...item, shardScore: Number(item.score) || 0, shardRanks: 1 });
        else {
            existing.shardScore = Math.max(existing.shardScore, Number(item.score) || 0);
            existing.shardRanks += 1;
        }
    }

    const finalResults = [...grouped.values()];
    finalResults.sort((a, b) => {
        const scoreA = (a.shardScore * 0.80) + (Math.min(1, a.shardRanks / 3) * 0.20);
        const scoreB = (b.shardScore * 0.80) + (Math.min(1, b.shardRanks / 3) * 0.20);
        return scoreB - scoreA;
    });

    const limited = finalResults.slice(0, effectiveTopK);
    console.log('[ShardedRAG] Phase 1 retrieval complete: ' + limited.length + ' results');
    return limited;
}
