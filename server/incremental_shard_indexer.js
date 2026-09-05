import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chunkDatasetFile, chunkAuthorFile, chunkPdfFile, chunkTxtFile } from './chunker.js';
import { extractPdf } from './pdf_extractor.js';
import { VectorStore, ensureZeroVector, ZERO_VECTOR } from './vector_store.js';
import { GeminiProvider } from './llm/gemini_provider.js';

const DIMENSION = 768;
const MODEL = 'gemini-embedding-001';
const BATCH_SIZE = 100;
const IGNORED_CATEGORIES = new Set(['other']);
const IGNORED_BASENAMES = new Set(['authors.json']);

function normalize(value) { return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }
function categoryFor(relPath) { const p = normalize(relPath); return p.includes('/') ? p.split('/')[0] : 'root'; }
function safeShardName(category) { const value = normalize(category); if (!value || value === '.' || value === '..' || value.includes('..') || IGNORED_CATEGORIES.has(value.toLowerCase())) return null; return value; }
function isIgnoredSource(relPath) { return IGNORED_BASENAMES.has(path.posix.basename(normalize(relPath)).toLowerCase()); }
function sha1(buffer) { return crypto.createHash('sha1').update(buffer).digest('hex'); }
function shardDir(ragRoot, category) { const shard = safeShardName(category); return shard ? path.join(ragRoot, shard) : null; }
async function readJson(filePath, fallback = null) { try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return fallback; } }

function chunkJson(relPath, parsed) {
    if (!parsed || typeof parsed !== 'object') return [];
    if (Array.isArray(parsed.vachanas) && parsed.vachanas.length) return chunkAuthorFile(relPath, parsed);
    if (Array.isArray(parsed.data) && parsed.data.length) return chunkDatasetFile(relPath, parsed);
    return chunkDatasetFile(relPath, { data: [parsed], name: parsed.name || parsed.title || path.basename(relPath) });
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
    if (!provider.isConfigured()) return chunks.map(() => ZERO_VECTOR);
    const vectors = [];
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
    for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
        const texts = chunks.slice(start, start + BATCH_SIZE).map((chunk) => String(chunk.text || '').slice(0, 6000));
        const batchNo = Math.floor(start / BATCH_SIZE) + 1;
        console.log(`[IncrementalRAG] Embedding batch ${batchNo}/${totalBatches} (${texts.length} chunks)`);
        try {
            const batch = await provider.embed({ texts });
            for (let i = 0; i < texts.length; i++) vectors.push(Array.isArray(batch?.[i]) && batch[i].length === DIMENSION ? batch[i] : ZERO_VECTOR);
        } catch (error) {
            console.warn(`[IncrementalRAG] Embedding batch ${batchNo} failed: ${error.message}`);
            for (let i = 0; i < texts.length; i++) vectors.push(ZERO_VECTOR);
        }
    }
    return vectors;
}

function sourcePathForChunk(chunk) { return normalize(chunk?.dataset || chunk?.filename || chunk?.source); }

async function writeIndexAtomic(indexPath, value) {
    const tempPath = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(value), 'utf8');
    await fs.rename(tempPath, indexPath);
}

async function appendNewFile({ dataRoot, ragRoot, relPath }) {
    const normalized = normalize(relPath);
    if (isIgnoredSource(normalized)) return { status: 'ignored', path: normalized, reason: 'authors.json' };
    const category = categoryFor(normalized);
    const shardName = safeShardName(category);
    if (!shardName) return { status: 'ignored', path: normalized };
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
    const sourceEntry = index?.sourceFiles?.find((entry) => normalize(entry.path) === normalized);
    if (sourceEntry && sourceEntry.hash === fileHash) return { status: 'unchanged', path: normalized, shard: shardName, chunks: 0 };
    if (!sourceEntry && Array.isArray(index?.chunks) && index.chunks.some((chunk) => sourcePathForChunk(chunk) === normalized)) return { status: 'already-indexed', path: normalized, shard: shardName, chunks: 0 };

    const isUpdate = Boolean(sourceEntry);
    console.log(`[IncrementalRAG] ${isUpdate ? 'Updated' : 'New'} file detected: ${normalized}`);
    console.log(`[IncrementalRAG] Chunking only ${normalized}`);
    const chunks = await chunkSourceFile(normalized, fullPath);
    if (!chunks.length) return { status: 'empty', path: normalized, shard: shardName, chunks: 0 };
    console.log(`[IncrementalRAG] Created ${chunks.length} chunks for ${normalized}`);
    const vectors = await embedChunks(chunks);
    let store;
    const previousChunks = Array.isArray(index?.chunks) ? index.chunks : [];
    const retainedChunks = isUpdate ? previousChunks.filter((chunk) => sourcePathForChunk(chunk) !== normalized) : previousChunks;
    const existingCount = retainedChunks.length;
    if (await VectorStore.fileExists(embeddingPath)) store = await VectorStore.open(embeddingPath);
    else store = await VectorStore.create(embeddingPath, DIMENSION);
    if (store.dimension() !== DIMENSION) { await store.close(); throw new Error(`Embedding dimension mismatch in ${shardName}`); }
    try {
        await store.beginWrite();
        const newChunks = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const embeddingIndex = store.size();
            await store.append(vectors[i] || ZERO_VECTOR);
            newChunks.push({ ...chunk, embeddingIndex });
        }
        await store.finalize();
        const previousSourceFiles = Array.isArray(index?.sourceFiles) ? index.sourceFiles : [];
        const sourceFiles = previousSourceFiles.filter((entry) => normalize(entry.path) !== normalized);
        sourceFiles.push({ path: normalized, size: stat.size, mtime: stat.mtimeMs, hash: fileHash });
        const mergedChunks = [...retainedChunks, ...newChunks];
        const updated = { vectorCacheVersion: Number(index?.vectorCacheVersion) || 5, embeddingModel: MODEL, embeddingDimension: DIMENSION, createdAt: index?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), sourceFiles: sourceFiles.sort((a, b) => a.path.localeCompare(b.path)), datasetNames: [...new Set(mergedChunks.map((chunk) => chunk.dataset).filter(Boolean))].sort(), embeddingFile: 'embeddings.bin', chunkCount: mergedChunks.length, chunks: mergedChunks };
        await writeIndexAtomic(indexPath, updated);
        console.log(`[IncrementalRAG] Updated shard ${shardName}: ${previousChunks.length} -> ${mergedChunks.length} chunks`);
        return { status: 'indexed', path: normalized, shard: shardName, chunks: newChunks.length, embeddings: vectors.length, previousChunks: previousChunks.length, totalChunks: mergedChunks.length, replaced: isUpdate };
    } finally { await store.close().catch(() => {}); }
}

export async function updateNewSourceFile({ dataRoot, ragRoot, relPath }) { return appendNewFile({ dataRoot, ragRoot, relPath }); }

export async function scanAndIncrementallyIndex({ dataRoot, ragRoot }) {
    const results = [];
    const shardIndexes = new Map();
    const knownSourcePaths = new Map();

    let shardEntries = [];
    try { shardEntries = await fs.readdir(ragRoot, { withFileTypes: true }); } catch { shardEntries = []; }
    for (const entry of shardEntries) {
        if (!entry.isDirectory() || !safeShardName(entry.name)) continue;
        const index = await readJson(path.join(ragRoot, entry.name, 'index.json'), null);
        if (!index) continue;
        const paths = new Set((index.sourceFiles || []).map((item) => normalize(item.path)));
        if (!paths.size && Array.isArray(index.chunks)) {
            for (const chunk of index.chunks) { const source = sourcePathForChunk(chunk); if (source) paths.add(source); }
        }
        shardIndexes.set(entry.name.toLowerCase(), index);
        knownSourcePaths.set(entry.name.toLowerCase(), paths);
    }

    async function walk(dir, relative = '') {
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { await walk(full, rel); continue; }
            if (!entry.isFile() || !/\.(json|pdf|txt)$/i.test(entry.name)) continue;
            const normalized = normalize(rel);
            if (isIgnoredSource(normalized)) {
                console.log(`[IncrementalRAG] Ignoring ${normalized} (authors.json is never indexed)`);
                continue;
            }
            const category = categoryFor(normalized);
            if (!safeShardName(category)) continue;
            const key = category.toLowerCase();
            const idx = shardIndexes.get(key);
            const known = knownSourcePaths.get(key) || new Set();
            const stat = await fs.stat(full);
            const sourceEntry = idx?.sourceFiles?.find((item) => normalize(item.path) === normalized);

            // Existing source with identical size+mtime is the common fast path.
            if (sourceEntry && sourceEntry.size === stat.size && sourceEntry.mtime === stat.mtimeMs) continue;
            // Legacy/prebuilt index: if chunk metadata already contains this file,
            // don't re-embed it merely because the copied file has a different mtime.
            if (!sourceEntry && known.has(normalized)) continue;

            if (sourceEntry) {
                // Metadata can change when a repository is copied/checked out.
                // Hash the file before deciding that content actually changed.
                const raw = await fs.readFile(full);
                const currentHash = sha1(raw);
                if (sourceEntry.hash && sourceEntry.hash === currentHash) {
                    // Content is unchanged. Persist the new filesystem metadata so
                    // future startups can use the cheap size+mtime fast path.
                    const refreshed = { ...idx, sourceFiles: (idx.sourceFiles || []).map((item) => normalize(item.path) === normalized ? { ...item, size: stat.size, mtime: stat.mtimeMs } : item), updatedAt: new Date().toISOString() };
                    await writeIndexAtomic(path.join(ragRoot, category, 'index.json'), refreshed);
                    shardIndexes.set(key, refreshed);
                    console.log(`[IncrementalRAG] Unchanged content; refreshed metadata only: ${normalized}`);
                    continue;
                }
            }
            results.push(await appendNewFile({ dataRoot, ragRoot, relPath: normalized }));
        }
    }

    console.log('[IncrementalRAG] One-time startup scan: ' + dataRoot);
    const started = Date.now();
    await walk(dataRoot);
    console.log(`[IncrementalRAG] Startup scan complete in ${((Date.now() - started) / 1000).toFixed(1)}s: ${results.length} source change(s) processed.`);
    return results;
}

// Compatibility only. Deliberately does nothing: development indexing is
// performed exactly once during startup. No filesystem watcher is installed.
export function startIncrementalWatcher() { return () => {}; }