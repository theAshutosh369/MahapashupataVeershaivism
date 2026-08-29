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
            for (const chunk of index.chunks) {
                chunks.push({ ...chunk, shard: name });
                if (chunk.embeddingOffset != null && chunk.embeddingLength != null) {
                    vectorMap.set(chunks.length - 1, {
                        shard: name,
                        offset: Number(chunk.embeddingOffset),
                        length: Number(chunk.embeddingLength),
                        globalIndex: globalVector++
                    });
                }
            }
        }

        compatIndex = {
            chunks,
            vectorMap,
            count: chunks.length,
            datasets: manifest?.datasets || []
        };
        return compatIndex;
    })();
    return compatPromise;
}

export async function getIndex() {
    return ensureCompat();
}

export async function ensureIndex() {
    return ensureCompat();
}

export function getCurrentIndex() {
    return compatIndex;
}

export function resetIndex() {
    compatPromise = null;
    compatIndex = null;
    for (const fd of syncFds.values()) {
        try { fsc.closeSync(fd); } catch (_) {}
    }
    syncFds.clear();
    stores.clear();
}

export function getRagRoot() {
    return RAG_ROOT;
}

export { DIMENSION, HEADER_SIZE };
