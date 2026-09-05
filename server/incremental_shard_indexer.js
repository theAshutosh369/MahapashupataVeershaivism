import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chunkDatasetFile, chunkAuthorFile, chunkPdfFile, chunkTxtFile } from './chunker.js';
import { extractPdf } from './pdf_extractor.js';
import { VectorStore, ensureZeroVector, ZERO_VECTOR } from './vector_store.js';
import { GeminiProvider } from './llm/gemini_provider.js';

const DIMENSION = 768;
const MODEL = 'gemini-embedding-001';
const BATCH_SIZE = 100;
const IGNORED = new Set(['other']);

function normalize(value) { return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }
function categoryFor(relPath) { const p = normalize(relPath); return p.includes('/') ? p.split('/')[0] : 'root'; }
function safeShardName(category) { const value = normalize(category); if (!value || value === '.' || value === '..' || value.includes('..') || IGNORED.has(value.toLowerCase())) return null; return value; }
function sha1(buffer) { return crypto.createHash('sha1').update(buffer).digest('hex'); }

function chunkJson(relPath, parsed) {
    if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.vachanas) && parsed.vachanas.length) return chunkAuthorFile(relPath, parsed);
        if (Array.isArray(parsed.data) && parsed.data.length) return chunkDatasetFile(relPath, parsed);
        return chunkDatasetFile(relPath, { data: [parsed], name: parsed.name || parsed.title || path.basename(relPath) });
    }
    return [];
}
async function chunkSourceFile(relPath, fullPath) {
    const lower = relPath.toLowerCase();
    if (lower.endsWith('.txt')) return chunkTxtFile(relPath, await fs.readFile(fullPath, 'utf8'));
    if (lower.endsWith('.pdf')) return chunkPdfFile(relPath, await extractPdf(await fs.readFile(fullPath)));
    return chunkJson(relPath, JSON.parse(await fs.readFile(fullPath, 'utf8')));
}

async function embedChunks(chunks) {
    ensureZeroVector(DIMENSION);
    const provider = new GeminiProvider();
    if (!provider.isConfigured()) {
        console.warn('[IncrementalRAG] GEMINI_API_KEY unavailable; new vectors will use zero placeholders.');
        return chunks.map(() => ZERO_VECTOR);
    }
    const vectors = [];
    for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
        const texts = chunks.slice(start, start + BATCH_SIZE).map((chunk) => String(chunk.text || '').slice(0, 6000));
        try {
            const batch = await provider.embed({ texts });
            for (let i = 0; i < texts.length; i += 1) vectors.push(Array.isArray(batch?.[i]) && batch[i].length === DIMENSION ? batch[i] : ZERO_VECTOR);
        } catch (error) {
            console.warn(`[IncrementalRAG] Embedding batch failed: ${error.message}; using zero vectors for this batch.`);
            for (let i = 0; i < texts.length; i += 1) vectors.push(ZERO_VECTOR);
        }
    }
    return vectors;
}
async function readJson(filePath, fallback = null) { try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return fallback; } }
function shardDir(ragRoot, category) { return path.join(ragRoot, safeShardName(category)); }
function isIndexedDataset(index, normalized) {
    return Array.isArray(index?.chunks) && index.chunks.some((chunk) => normalize(chunk?.dataset || chunk?.filename) === normalized);
}

async function appendNewFile({ dataRoot, ragRoot, relPath }) {
    const normalized = normalize(relPath);
    const category = categoryFor(normalized);
    const shardName = safeShardName(category);
    if (!shardName || IGNORED.has(category.toLowerCase())) return { status: 'ignored', path: normalized };

    const fullPath = path.resolve(dataRoot, normalized);
    const root = path.resolve(dataRoot);
    if (fullPath !== root && !fullPath.startsWith(root + path.sep)) throw new Error('Unsafe source path: ' + normalized);
    const stat = await fs.stat(fullPath);
    const raw = await fs.readFile(fullPath);
    const fileHash = sha1(raw);

    const dir = shardDir(ragRoot, category);
    await fs.mkdir(dir, { recursive: true });
    const indexPath = path.join(dir, 'index.json');
    const embeddingPath = path.join(dir, 'embeddings.bin');
    const index = await readJson(indexPath, null);

    if (index?.sourceFiles?.some((entry) => entry.path === normalized && entry.hash === fileHash)) return { status: 'unchanged', path: normalized, shard: shardName, chunks: 0 };
    // Older prebuilt shards did not contain sourceFiles. Derive the existence
    // check from chunk.dataset so the first reconciliation never duplicates the
    // entire corpus into every shard.
    if (isIndexedDataset(index, normalized)) return { status: 'already-indexed', path: normalized, shard: shardName, chunks: 0 };

    console.log(`[IncrementalRAG] New file detected: ${normalized}`);
    console.log(`[IncrementalRAG] Chunking only ${normalized}`);
    const chunks = await chunkSourceFile(normalized, fullPath);
    if (!chunks.length) return { status: 'empty', path: normalized, shard: shardName, chunks: 0 };
    const vectors = await embedChunks(chunks);
    let store;
    const existingCount = index?.chunks?.length || 0;
    if (await VectorStore.fileExists(embeddingPath)) {
        store = await VectorStore.open(embeddingPath);
        if (store.dimension() !== DIMENSION) { await store.close(); throw new Error(`Embedding dimension mismatch in ${shardName}`); }
    } else {
        store = await VectorStore.create(embeddingPath, DIMENSION);
    }

    try {
        await store.beginWrite();
        const newChunks = [];
        for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            const embeddingIndex = store.size();
            await store.append(vectors[i] || ZERO_VECTOR);
            newChunks.push({ id: chunk.id, dataset: chunk.dataset, sourceType: chunk.sourceType, filename: chunk.filename, source: chunk.source, page: chunk.page, vachanaNumber: chunk.vachanaNumber, author: chunk.author, title: chunk.title, language: chunk.language, chunkIndex: chunk.chunkIndex, totalChunks: chunk.totalChunks, tokenCount: chunk.tokenCount, text: chunk.text, embeddingIndex });
        }
        await store.finalize();

        const sourceFiles = Array.isArray(index?.sourceFiles) ? [...index.sourceFiles] : [];
        const sourceEntry = { path: normalized, size: stat.size, mtime: stat.mtimeMs, hash: fileHash };
        const sourceAt = sourceFiles.findIndex((entry) => entry.path === normalized);
        if (sourceAt >= 0) sourceFiles[sourceAt] = sourceEntry; else sourceFiles.push(sourceEntry);
        const mergedChunks = [...(Array.isArray(index?.chunks) ? index.chunks : []), ...newChunks];
        const updated = { vectorCacheVersion: Number(index?.vectorCacheVersion) || 5, embeddingModel: MODEL, embeddingDimension: DIMENSION, createdAt: index?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), sourceFiles: sourceFiles.sort((a, b) => a.path.localeCompare(b.path)), datasetNames: [...new Set(mergedChunks.map((chunk) => chunk.dataset).filter(Boolean))].sort((a, b) => a.localeCompare(b)), embeddingFile: 'embeddings.bin', chunkCount: mergedChunks.length, chunks: mergedChunks };
        const tempPath = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
        await fs.writeFile(tempPath, JSON.stringify(updated), 'utf8');
        await fs.rename(tempPath, indexPath);
        console.log(`[IncrementalRAG] Generated ${newChunks.length} embeddings for ${normalized}`);
        console.log(`[IncrementalRAG] Updated shard ${shardName}: ${existingCount} -> ${mergedChunks.length} chunks`);
        return { status: 'indexed', path: normalized, shard: shardName, chunks: newChunks.length, embeddings: vectors.length, previousChunks: existingCount, totalChunks: mergedChunks.length };
    } finally {
        await store.close().catch(() => {});
    }
}

export async function updateNewSourceFile({ dataRoot, ragRoot, relPath }) { return appendNewFile({ dataRoot, ragRoot, relPath }); }

export async function scanAndIncrementallyIndex({ dataRoot, ragRoot }) {
    const results = [];
    async function walk(dir, relative = '') {
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { await walk(full, rel); continue; }
            if (!entry.isFile() || !/\.(json|pdf|txt)$/i.test(entry.name)) continue;
            try {
                const normalized = normalize(rel);
                const category = categoryFor(normalized);
                const idx = await readJson(path.join(shardDir(ragRoot, category), 'index.json'), null);
                // A prebuilt shard may predate sourceFiles metadata. In that case
                // the chunk dataset itself is the authoritative existence marker.
                if (isIndexedDataset(idx, normalized)) continue;
                const stat = await fs.stat(full);
                const sourceEntry = idx?.sourceFiles?.find((source) => source.path === normalized);
                if (sourceEntry && sourceEntry.size === stat.size && sourceEntry.mtime === stat.mtimeMs) continue;
                results.push(await appendNewFile({ dataRoot, ragRoot, relPath: normalized }));
            } catch (error) {
                results.push({ status: 'error', path: normalize(rel), error: error.message });
            }
        }
    }
    await walk(dataRoot);
    return results;
}

export function startIncrementalWatcher({ dataRoot, ragRoot, onUpdate }) {
    let timer = null;
    let running = false;
    const pendingPaths = new Set();
    const processPending = async () => {
        if (running || pendingPaths.size === 0) return;
        running = true;
        const paths = [...pendingPaths];
        pendingPaths.clear();
        try {
            for (const changedPath of paths) {
                try {
                    const result = await appendNewFile({ dataRoot, ragRoot, relPath: changedPath });
                    onUpdate?.(result);
                } catch (error) {
                    console.warn('[IncrementalRAG] Update failed:', error.message);
                    onUpdate?.({ status: 'error', path: changedPath, error: error.message });
                }
            }
        } finally {
            running = false;
            if (pendingPaths.size) processPending();
        }
    };
    const trigger = (changedPath) => {
        if (!changedPath || !/\.(json|pdf|txt)$/i.test(changedPath)) return;
        pendingPaths.add(normalize(changedPath));
        clearTimeout(timer);
        timer = setTimeout(processPending, 700);
    };
    let watcher;
    try {
        watcher = fsc.watch(dataRoot, { recursive: true }, (_eventType, filename) => { if (filename) trigger(String(filename)); });
        watcher.on('error', (error) => console.warn('[IncrementalRAG] File watcher error:', error.message));
        console.log('[IncrementalRAG] Watching source tree:', dataRoot);
    } catch (error) {
        console.warn('[IncrementalRAG] Recursive file watcher unavailable:', error.message);
    }
    return () => { clearTimeout(timer); try { watcher?.close(); } catch {} };
}
