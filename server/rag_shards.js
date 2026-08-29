/**
 * Dataset-partitioned RAG shard manager.
 *
 * Shards mirror the public/data taxonomy while living in a separate top-level
 * public/rag tree. Category assignment is structural, never semantic: a file
 * is placed in the same category as its source file. This prevents names such
 * as "Siddhanta" from incorrectly moving a Veershaiv Grantha into Agamas.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorStore } from './vector_store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHARD_ROOT = path.resolve(__dirname, '../public/rag');
export const MANIFEST_FILE = path.join(SHARD_ROOT, 'manifest.json');

// These names intentionally match the public/data taxonomy exactly.
export const DATASET_CATEGORIES = [
    'Agamas',
    'Smritis',
    'Upanishadas',
    'Vachanas',
    'Veershaiv Granthas',
    'Other'
];

function normalizePath(value = '') {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function categoryFromPath(value = '') {
    const normalized = normalizePath(value);
    const marker = 'public/data/';
    const markerIndex = normalized.toLowerCase().indexOf(marker);
    if (markerIndex >= 0) {
        const remainder = normalized.slice(markerIndex + marker.length);
        const firstFolder = remainder.split('/')[0];
        const exact = DATASET_CATEGORIES.find((category) => category.toLowerCase() === firstFolder.toLowerCase());
        if (exact) return exact;
    }

    // Also support index metadata that already stores the source path relative
    // to public/data, e.g. "Veershaiv Granthas/book.txt".
    const firstFolder = normalized.split('/')[0];
    return DATASET_CATEGORIES.find((category) => category.toLowerCase() === firstFolder.toLowerCase()) || null;
}

/**
 * Resolve the shard strictly from the original source folder.
 *
 * IMPORTANT: do not classify using words contained in a dataset title or
 * filename. For example, "A_Preamble_To_The_Study_Of_Sri_SiddhantaShikhamani"
 * remains in "Veershaiv Granthas" if that is where the source file lives.
 */
export function classifyDataset(dataset = '', source = '', filename = '') {
    const explicitCategory = [dataset, source, filename]
        .map(categoryFromPath)
        .find(Boolean);
    return explicitCategory || 'Other';
}

async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

/**
 * Build shards from the existing monolithic index. This never modifies the
 * source index or embedding file. Each shard gets its own contiguous binary
 * vector file and local embeddingIndex values.
 */
export async function buildShards({ indexFile, embeddingsFile, outputRoot = SHARD_ROOT } = {}) {
    if (!indexFile || !embeddingsFile) throw new Error('indexFile and embeddingsFile are required');
    const index = await readJson(indexFile);
    if (!Array.isArray(index.chunks)) throw new Error('Invalid monolithic RAG index: chunks[] missing');

    await ensureDir(outputRoot);
    const groups = new Map(DATASET_CATEGORIES.map((category) => [category, []]));
    for (const chunk of index.chunks) {
        const category = classifyDataset(chunk.dataset, chunk.source, chunk.filename);
        groups.get(category).push(chunk);
    }

    const sourceStat = await fs.stat(indexFile);
    const embedStat = await fs.stat(embeddingsFile);
    const manifest = {
        formatVersion: 2,
        createdAt: new Date().toISOString(),
        layout: 'public/rag',
        source: {
            indexSize: sourceStat.size,
            embeddingsSize: embedStat.size,
            chunkCount: index.chunks.length,
            vectorDimension: index.embeddingDimension || 768,
            embeddingModel: index.embeddingModel || null,
            vectorCacheVersion: index.vectorCacheVersion ?? null
        },
        categories: DATASET_CATEGORIES,
        shards: {}
    };

    const sourceEmbedding = await VectorStore.open(embeddingsFile);
    try {
        for (const [category, chunks] of groups) {
            const dir = path.join(outputRoot, category);
            await ensureDir(dir);
            const tmpIndex = path.join(dir, 'index.json.tmp');
            const tmpEmbed = path.join(dir, 'embeddings.bin.tmp');
            const finalIndex = path.join(dir, 'index.json');
            const finalEmbed = path.join(dir, 'embeddings.bin');

            const shardEmbed = await VectorStore.create(tmpEmbed, sourceEmbedding.dimension());
            await shardEmbed.beginWrite();
            const shardChunks = [];
            let localIndex = 0;

            for (const chunk of chunks) {
                const copy = { ...chunk, embeddingIndex: -1 };
                const sourceIndex = Number(chunk.embeddingIndex);
                if (Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sourceEmbedding.size()) {
                    const vector = await sourceEmbedding.get(sourceIndex);
                    await shardEmbed.append(vector);
                    copy.embeddingIndex = localIndex++;
                }
                shardChunks.push(copy);
            }

            await shardEmbed.finalize();
            await shardEmbed.close();

            const shardIndex = {
                formatVersion: 2,
                category,
                createdAt: manifest.createdAt,
                embeddingModel: index.embeddingModel,
                embeddingDimension: index.embeddingDimension,
                chunks: shardChunks
            };
            await fs.writeFile(tmpIndex, JSON.stringify(shardIndex));
            await fs.rm(finalIndex, { force: true });
            await fs.rm(finalEmbed, { force: true });
            await fs.rename(tmpIndex, finalIndex);
            await fs.rename(tmpEmbed, finalEmbed);

            manifest.shards[category] = {
                path: category,
                chunks: shardChunks.length,
                vectors: localIndex
            };
        }
    } finally {
        await sourceEmbedding.close();
    }

    const tmpManifest = `${MANIFEST_FILE}.tmp`;
    await fs.writeFile(tmpManifest, JSON.stringify(manifest, null, 2));
    await fs.rename(tmpManifest, MANIFEST_FILE);
    return manifest;
}

export async function hasValidShardManifest(root = SHARD_ROOT) {
    try {
        const manifest = await readJson(path.join(root, 'manifest.json'));
        if (![1, 2].includes(manifest.formatVersion) || !manifest.shards) return false;
        for (const category of Object.keys(manifest.shards)) {
            const dir = path.join(root, category);
            const index = path.join(dir, 'index.json');
            const embeddings = path.join(dir, 'embeddings.bin');
            if (!fsSync.existsSync(index) || !fsSync.existsSync(embeddings)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

export async function loadShard(category, root = SHARD_ROOT) {
    if (!DATASET_CATEGORIES.includes(category)) throw new Error(`Unknown RAG shard category: ${category}`);
    const dir = path.join(root, category);
    const index = await readJson(path.join(dir, 'index.json'));
    const embeddings = await VectorStore.open(path.join(dir, 'embeddings.bin'));
    return { ...index, embeddings, category };
}
