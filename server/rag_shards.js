/**
 * Dataset-partitioned RAG shard manager.
 *
 * This module is intentionally additive: the existing rag_index.json and
 * rag_embeddings.bin remain untouched. A migration creates a parallel
 * server/rag/ tree which can be activated after validation.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorStore } from './vector_store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHARD_ROOT = path.resolve(__dirname, 'rag');
export const MANIFEST_FILE = path.join(SHARD_ROOT, 'manifest.json');

const CATEGORY_RULES = [
    ['veerashaiva', /veer|vīra|lingayat|lingāyat|sharana|sharan|basava|allama|akka|channabasava/i],
    ['vachana', /vachana|vacana/i],
    ['agama', /agama|āgama|siddhanta|siddhānta/i],
    ['purana', /purana|purāṇa|itihasa|itihāsa/i]
];

export function classifyDataset(dataset = '', source = '', filename = '') {
    const value = `${dataset} ${source} ${filename}`.toLowerCase();
    for (const [category, pattern] of CATEGORY_RULES) {
        if (pattern.test(value)) return category;
    }
    return 'other';
}

async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

function vectorToBuffer(vector) {
    const out = Buffer.allocUnsafe(vector.length * 4);
    for (let i = 0; i < vector.length; i++) out.writeFloatLE(Number(vector[i]) || 0, i * 4);
    return out;
}

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
    const groups = new Map();
    for (const chunk of index.chunks) {
        const category = classifyDataset(chunk.dataset, chunk.source, chunk.filename);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(chunk);
    }

    const sourceStat = await fs.stat(indexFile);
    const embedStat = await fs.stat(embeddingsFile);
    const manifest = {
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        source: {
            indexSize: sourceStat.size,
            embeddingsSize: embedStat.size,
            chunkCount: index.chunks.length,
            vectorDimension: index.embeddingDimension || 768,
            embeddingModel: index.embeddingModel || null,
            vectorCacheVersion: index.vectorCacheVersion ?? null
        },
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
                formatVersion: 1,
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
        if (manifest.formatVersion !== 1 || !manifest.shards) return false;
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
    const dir = path.join(root, category);
    const index = await readJson(path.join(dir, 'index.json'));
    const embeddings = await VectorStore.open(path.join(dir, 'embeddings.bin'));
    return { ...index, embeddings, category };
}
