import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const INDEX_FILE = path.resolve(process.cwd(), 'server', 'rag_index.json');

let vectorIndex = null;
let vectorIndexBuildPromise = null;

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const x = Number(a[i]) || 0;
        const y = Number(b[i]) || 0;
        dot += x * y;
        magA += x * x;
        magB += y * y;
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function normalizeText(text) {
    return String(text || '').trim();
}

function buildInMemoryIndex(indexData) {
    const chunks = Array.isArray(indexData?.chunks) ? indexData.chunks : [];

    // Pre-split into arrays for fast scoring.
    // Each item: { chunk, embedding }
    return chunks
        .filter((c) => Array.isArray(c?.embedding) && c.embedding.length > 0)
        .map((c) => ({ chunk: c, embedding: c.embedding.map(Number) }));
}

async function loadRagIndex() {
    if (!existsSync(INDEX_FILE)) {
        throw new Error(`Missing rag index file: ${INDEX_FILE}. Run/boot RAG index builder first.`);
    }
    const raw = await fs.readFile(INDEX_FILE, 'utf8');
    return JSON.parse(raw);
}

export async function getVectorIndex() {
    if (vectorIndex) return vectorIndex;
    if (vectorIndexBuildPromise) return vectorIndexBuildPromise;

    vectorIndexBuildPromise = (async () => {
        const indexData = await loadRagIndex();
        vectorIndex = buildInMemoryIndex(indexData);
        return vectorIndex;
    })();

    return vectorIndexBuildPromise;
}

// Embeddings are already precomputed into rag_index.json by rag_routes.js.
// This file only builds an in-memory index for fast cosine similarity retrieval.
export async function retrieveTopKByCosine(queryEmbedding, { topK = 10, selectedDataset = '__ALL__' } = {}) {
    const index = await getVectorIndex();

    const filtered = (selectedDataset && selectedDataset !== '__ALL__')
        ? index.filter((item) => item.chunk?.dataset === selectedDataset)
        : index;

    const scored = filtered
        .map((item) => ({ item, similarity: cosineSimilarity(queryEmbedding, item.embedding) }))
        .filter((x) => x.similarity > 0)
        .sort((a, b) => b.similarity - a.similarity);

    const unique = new Set();
    const results = [];
    for (const s of scored) {
        const id = s.item.chunk?.id;
        if (!id || unique.has(id)) continue;
        unique.add(id);
        results.push({ chunk: s.item.chunk, similarity: s.similarity });
        if (results.length >= topK) break;
    }

    return results;
}

export function ensureVectorIndexLoadedSync() {
    if (!vectorIndex) {
        throw new Error('Vector index not loaded yet. Call getVectorIndex() first.');
    }
    return vectorIndex;
}

export function vectorIndexStats() {
    return {
        loaded: !!vectorIndex,
        size: vectorIndex?.length ?? 0
    };
}

