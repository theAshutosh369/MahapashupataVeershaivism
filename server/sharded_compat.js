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
let virtualStore = null;
let syncFds = new Map();

function normalize(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
            if (!name) continue;
            const index = await readShardIndex(name);
            for (const sourceChunk of index.chunks) {
                const chunk = { ...sourceChunk, shard: name };
                if (chunk.embeddingIndex != null && Number.isInteger(Number(chunk.embeddingIndex))) {
                    const localIndex = Number(chunk.embeddingIndex);
                    chunk.embeddingIndex = globalVector;
                    vectorMap.set(chunks.length, { shard: name, localIndex, globalIndex: globalVector++ });
                }
                chunks.push(chunk);
            }
        }

        compatIndex = {
            chunks,
            vectorMap,
            count: chunks.length,
            datasets: manifest?.datasets || manifest?.datasetNames || []
        };
        return compatIndex;
    })();
    return compatPromise;
}

export async function getIndex() { return ensureCompat(); }
export async function getCompatIndex() { return ensureCompat(); }
export async function ensureIndex() { return ensureCompat(); }
export function getCurrentIndex() { return compatIndex; }

class VirtualEmbeddingStore {
    constructor(shardEntries) {
        this.shardEntries = shardEntries;
        this._size = shardEntries.reduce((sum, item) => sum + item.store.size(), 0);
    }
    size() { return this._size; }
    dimension() { return DIMENSION; }
    getMemoryBytes() { return this.shardEntries.reduce((sum, item) => sum + item.store.getMemoryBytes(), 0); }
    getFileSize() { return this.shardEntries.reduce((sum, item) => sum + item.store.getFileSize(), 0); }
    async searchBatched(query, topK = 10, batchSize = 500) {
        const results = [];
        let globalOffset = 0;
        for (const entry of this.shardEntries) {
            const hits = await entry.store.searchBatched(query, topK, batchSize);
            for (const hit of hits) results.push({ index: globalOffset + hit.index, score: hit.score });
            globalOffset += entry.store.size();
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }
    async get(globalIndex) {
        let offset = 0;
        for (const entry of this.shardEntries) {
            const count = entry.store.size();
            if (globalIndex >= offset && globalIndex < offset + count) return entry.store.get(globalIndex - offset);
            offset += count;
        }
        throw new Error('Embedding index out of range: ' + globalIndex);
    }
    async loadAll() { throw new Error('loadAll() is disabled for sharded RAG. Use searchBatched() instead.'); }
    async close() {
        for (const entry of this.shardEntries) {
            try { await entry.store.close(); } catch (_) {}
        }
    }
    async unload() { return this.close(); }
}

export async function loadVirtualEmbeddings() {
    await ensureCompat();
    if (virtualStore) return virtualStore;
    const manifest = getShardedManifest();
    const entries = [];
    for (const shard of (manifest?.shards || [])) {
        const name = shard.name || shard.path;
        if (!name) continue;
        if (stores.has(name)) {
            entries.push({ name, store: stores.get(name) });
            continue;
        }
        const dir = safeShardPath(name);
        const store = await VectorStore.open(path.join(dir, 'embeddings.bin'));
        if (store.dimension() !== DIMENSION) {
            await store.close();
            throw new Error(`Embedding dimension mismatch in ${name}: ${store.dimension()} != ${DIMENSION}`);
        }
        stores.set(name, store);
        entries.push({ name, store });
    }
    virtualStore = new VirtualEmbeddingStore(entries);
    return virtualStore;
}

export async function closeVirtualEmbeddings() {
    if (virtualStore) {
        try { await virtualStore.close(); } catch (_) {}
    }
    virtualStore = null;
    stores.clear();
}

export function resetIndex() {
    compatPromise = null;
    compatIndex = null;
    virtualStore = null;
    for (const fd of syncFds.values()) {
        try { fsc.closeSync(fd); } catch (_) {}
    }
    syncFds.clear();
    stores.clear();
}

export function getRagRoot() { return RAG_ROOT; }
export { DIMENSION, HEADER_SIZE };