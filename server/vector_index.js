import { getCompatIndex, loadVirtualEmbeddings, closeVirtualEmbeddings } from './sharded_compat.js';

let vectorIndex = null;

export async function getVectorIndex() {
    if (vectorIndex) return vectorIndex;
    const index = await getCompatIndex();
    vectorIndex = index.chunks.map(chunk => ({ chunk, embeddingIndex: chunk.embeddingIndex }));
    return vectorIndex;
}

export async function loadEmbeddings() {
    return loadVirtualEmbeddings();
}

export async function unloadEmbeddings() {
    await closeVirtualEmbeddings();
}

export async function retrieveTopKByCosine(queryEmbedding, { topK = 10, selectedDataset = '__ALL__' } = {}) {
    const index = await getVectorIndex();
    const filtered = selectedDataset && selectedDataset !== '__ALL__'
        ? index.filter(item => item.chunk?.dataset === selectedDataset)
        : index;
    if (!filtered.length) return [];

    const store = await loadEmbeddings();
    const hits = await store.searchBatched(queryEmbedding, Math.max(topK * 4, topK), 500);
    const byIndex = new Map(filtered.map(item => [item.embeddingIndex, item.chunk]));
    return hits.filter(hit => byIndex.has(hit.index)).slice(0, topK).map(hit => ({
        chunk: byIndex.get(hit.index),
        similarity: hit.score
    }));
}

export function ensureVectorIndexLoadedSync() {
    if (!vectorIndex) throw new Error('Vector index not loaded yet. Call getVectorIndex() first.');
    return vectorIndex;
}

export function vectorIndexStats() {
    return {
        loaded: !!vectorIndex,
        size: vectorIndex?.length ?? 0,
        embeddingsOpened: false,
        embeddingMemoryBytes: 0,
        embeddingFile: 'public/rag/**/embeddings.bin'
    };
}
