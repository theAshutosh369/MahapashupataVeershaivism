import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorStore } from './vector_store.js';
import { ensureIndex as ensureShardedIndex, getCurrentIndex as getShardedManifest } from './sharded_index_manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAG_ROOT = path.resolve(__dirname, '..', 'public', 'rag');
const DIMENSION = 768;
const HEADER_SIZE = 16;

let compatPromise = null;
let compatIndex = null;
let stores = new Map();
let syncFds = new Map();

function normalize(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\\/+|\\/+$/g, '');
}

function safeShardPath(name) {
    const normalized = normalize(name);
    const root = path.resolve(RAG_ROOT);
    const full = path.resolve(root, normalized);
    if (!normalized || normalized.includes('..') || (full !== root && !full.startsWith(root + path.sep))) {
        throw new Error('Invalid RAG shard path: ' + name);
    }
    return full;
}

async function readShardIndex(name) {
    const dir = safeShardPath(name);
    const raw = await fs.readFile(path.join(dir, 'index.json'), 'utf8');
    const index = JSON.parse(raw);
    if (!Array.isArray(index?.chunks)) throw new Error('Invalid shard index: ' + name);
    return index;
}

async function ensureCompat() {
    if (compatPromise) return compatPromise;
    compatPromise = (async () => {
        await ensureShardedIndex();
        const manifest = getShardedManifest();
        const chunks = [];
        const vectorMap = new Map();
        let globalVector = 0;

        for (const shard of (manifest?.shards || [])) {
            const name = shard.name || shard.path;
            const index = await readShardIndex(name);
            for (const sourceChunk of index.chunks) {
                const chunk = { ...sourceChunk };
                const local = Number.isInteger(sourceChunk.embeddingIndex) ? sourceChunk.embeddingIndex : -1;
                if (local >= 0) {
                    chunk.embeddingIndex = globalVector;
                    vectorMap.set(globalVector, { shard: name, localIndex: local });
                    globalVector += 1;
                } else {
                    chunk.embeddingIndex = -1;
                }
                chunks.push(chunk);
            }
        }

        compatIndex = {
            sharded: true,
            chunks,
            datasetNames: manifest?.datasetNames || [],
            chunkCount: chunks.length,
            embeddingCount: globalVector,
            embeddingDimension: DIMENSION,
            vectorMap
        };
        console.log('[ShardedCompat] Loaded ' + chunks.length + ' metadata chunks across ' + (manifest?.shards?.length || 0) + ' shards; embeddings are lazy.');
        return compatIndex;
    })();

    try {
        return await compatPromise;
    } catch (error) {
        compatPromise = null;
        compatIndex = null;
        throw error;
    }
}

function openSyncFd(shardName) {
    let fd = syncFds.get(shardName);
    if (fd !== undefined) return fd;
    const filePath = path.join(safeShardPath(shardName), 'embeddings.bin');
    fd = fsc.openSync(filePath, 'r');
    syncFds.set(shardName, fd);
    return fd;
}

function readVectorSync(shardName, localIndex) {
    const fd = openSyncFd(shardName);
    const byteLength = DIMENSION * 4;
    const buffer = Buffer.allocUnsafe(byteLength);
    const position = HEADER_SIZE + Number(localIndex) * byteLength;
    const bytes = fsc.readSync(fd, buffer, 0, byteLength, position);
    if (bytes !== byteLength) return null;
    const out = new Float32Array(DIMENSION);
    for (let i = 0; i < DIMENSION; i++) out[i] = buffer.readFloatLE(i * 4);
    return out;
}

async function getStore(shardName) {
    let store = stores.get(shardName);
    if (store) return store;
    store = await VectorStore.open(path.join(safeShardPath(shardName), 'embeddings.bin'));
    if (store.dimension() !== DIMENSION) {
        await store.close();
        throw new Error('Embedding dimension mismatch in ' + shardName + ': ' + store.dimension());
    }
    stores.set(shardName, store);
    return store;
}

async function getVector(globalIndex) {
    const index = await ensureCompat();
    const mapping = index.vectorMap.get(Number(globalIndex));
    if (!mapping) return null;
    return readVectorSync(mapping.shard, mapping.localIndex);
}

class VirtualEmbeddingArray {
    constructor(length) {
        this.length = length;
    }

    subarray(start, end) {
        const globalIndex = Math.floor(Number(start) / DIMENSION);
        const vector = compatIndex?.vectorMap?.has(globalIndex)
            ? readVectorSync(compatIndex.vectorMap.get(globalIndex).shard, compatIndex.vectorMap.get(globalIndex).localIndex)
            : null;
        return vector || new Float32Array(Math.max(0, Number(end) - Number(start)));
    }
}

export async function getCompatIndex() {
    return ensureCompat();
}

export async function loadVirtualEmbeddings() {
    const index = await ensureCompat();
    const array = new VirtualEmbeddingArray(index.embeddingCount * DIMENSION);

    return {
        size: () => index.embeddingCount,
        dimension: () => DIMENSION,
        loadAll: async () => array,
        get: (i) => getVector(i),
        searchBatched: async (query, topK = 10) => {
            const scored = [];
            for (const [globalIndex, mapping] of index.vectorMap) {
                const vector = readVectorSync(mapping.shard, mapping.localIndex);
                if (!vector) continue;
                let dot = 0, qa = 0, va = 0;
                for (let i = 0; i < DIMENSION; i++) {
                    const q = Number(query[i]) || 0;
                    const v = Number(vector[i]) || 0;
                    dot += q * v; qa += q * q; va += v * v;
                }
                const score = qa && va ? dot / (Math.sqrt(qa) * Math.sqrt(va)) : 0;
                scored.push({ index: globalIndex, score });
            }
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, topK);
        },
        isLoaded: () => false,
        getMemoryBytes: () => 0,
        close: async () => {},
        unload: async () => {}
    };
}

export async function closeVirtualEmbeddings() {
    for (const store of stores.values()) {
        try { await store.close(); } catch {}
    }
    stores.clear();
    for (const fd of syncFds.values()) {
        try { fsc.closeSync(fd); } catch {}
    }
    syncFds.clear();
}

export function resetCompat() {
    compatPromise = null;
    compatIndex = null;
}
