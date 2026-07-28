/**
 * Index Manager — Batch processing pipeline.
 *
 * Builds and maintains the RAG index with SEPARATE metadata and embedding storage.
 *
 * ARCHITECTURE:
 *   rag_index.json          → Chunk metadata ONLY (no embeddings)
 *   rag_embeddings.bin      → Float32 binary vectors (indexed by position)
 *
 * DESIGN PRINCIPLES:
 *   - Metadata and embeddings are NEVER stored in the same file
 *   - Embeddings are NEVER loaded into RAM at startup
 *   - Streaming writes with buffered WriteStream (no appendFile per chunk)
 *   - Streaming incremental update (never holds remaining+new+all simultaneously)
 *   - Reusable zero vector (no new Array(768).fill(0) per chunk)
 *   - Error recovery: preserve previous working index on failure
 *   - Abstract storage layer (vector_store.js) for future LanceDB/SQLite swap
 */

import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VectorStore, logMemorySnapshot, ensureZeroVector, ZERO_VECTOR } from './vector_store.js';
import { chunkDatasetFile, chunkAuthorFile } from './chunker.js';

// ─── Debug flag ────────────────────────────────────────────────────────────
const DEBUG = false;

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var INDEX_FILE = path.resolve(__dirname, 'rag_index.json');
var EMBEDDINGS_FILE = path.resolve(__dirname, 'rag_embeddings.bin');
var VECTOR_CACHE_VERSION = 4;
var EMBEDDING_MODEL = 'text-embedding-004';
var EMBEDDING_DIMENSION = 768;
var EMBEDDING_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents';
var EMBEDDING_TIMEOUT = 30000;

var JSON_WRITE_BUFFER_SIZE = 1024 * 1024;

var currentIndex = null;
var currentEmbeddingStore = null;
var indexBuildPromise = null;
var _gcEnabled = typeof global.gc === 'function';

function gcIf() {
    if (_gcEnabled) global.gc();
}

function getMemoryUsageMB() {
    if (!DEBUG) return 0;
    try {
        var usage = process.memoryUsage();
        return Math.round(usage.heapUsed / 1024 / 1024);
    } catch (e) {
        return -1;
    }
}

async function scanJsonFiles(directory) {
    try {
        var entries = await fs.readdir(directory, { withFileTypes: true });
        var out = [];
        for (var ei = 0; ei < entries.length; ei++) {
            var entry = entries[ei];
            var fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                var sub = await scanJsonFiles(fullPath);
                for (var si = 0; si < sub.length; si++) out.push(sub[si]);
                continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
                out.push(fullPath);
            }
        }
        return out;
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}
function buildMetadata(sourceFiles) {
    var datasetNames = [];
    for (var i = 0; i < sourceFiles.length; i++) {
        datasetNames.push(sourceFiles[i].path);
    }
    datasetNames.sort();
    return {
        sourceFiles: sourceFiles,
        datasetNames: datasetNames
    };
}
async function getSourceFiles(dataRoot) {
    var datasetRoot = path.join(dataRoot, 'datasets');
    var authorRoot = path.join(dataRoot, 'authors');
    var datasetFiles = await scanJsonFiles(datasetRoot);
    var authorFiles = await scanJsonFiles(authorRoot);
    var sourceFiles = [];

    var allFiles = [];
    for (var di = 0; di < datasetFiles.length; di++) allFiles.push(datasetFiles[di]);
    for (var ai = 0; ai < authorFiles.length; ai++) allFiles.push(authorFiles[ai]);

    for (var fi = 0; fi < allFiles.length; fi++) {
        var filePath = allFiles[fi];
        try {
            var stat = await fs.stat(filePath);
            var relPath = path.relative(dataRoot, filePath).split(path.sep).join('/');
            sourceFiles.push({ path: relPath, size: stat.size, mtime: stat.mtimeMs });
        } catch (e) { /* skip */ }
    }

    return sourceFiles;
}

function getIndexDiff(indexMeta, currentSources) {
    if (!indexMeta || !Array.isArray(indexMeta.sourceFiles)) {
        var paths = [];
        for (var si = 0; si < currentSources.length; si++) paths.push(currentSources[si].path);
        return { needsFullRebuild: true, toAddOrUpdate: paths, toRemove: [], unchanged: [] };
    }

    var embeddingChanged =
        indexMeta.vectorCacheVersion !== VECTOR_CACHE_VERSION ||
        indexMeta.embeddingModel !== EMBEDDING_MODEL;

    if (!Array.isArray(indexMeta.chunks) || indexMeta.chunks.length === 0) {
        var paths = [];
        for (var si2 = 0; si2 < currentSources.length; si2++) paths.push(currentSources[si2].path);
        return { needsFullRebuild: true, toAddOrUpdate: paths, toRemove: [], unchanged: [] };
    }

    if (embeddingChanged) {
        var paths = [];
        for (var si3 = 0; si3 < currentSources.length; si3++) paths.push(currentSources[si3].path);
        return { needsFullRebuild: true, toAddOrUpdate: paths, toRemove: [], unchanged: [] };
    }

    var indexMap = new Map();
    for (var imi = 0; imi < indexMeta.sourceFiles.length; imi++) {
        indexMap.set(indexMeta.sourceFiles[imi].path, indexMeta.sourceFiles[imi]);
    }
    var currentMap = new Map();
    for (var cmi = 0; cmi < currentSources.length; cmi++) {
        currentMap.set(currentSources[cmi].path, currentSources[cmi]);
    }

    var toAddOrUpdate = [];
    var unchanged = [];
    for (var ei = 0; ei < currentSources.length; ei++) {
        var entry = currentSources[ei];
        var existing = indexMap.get(entry.path);
        if (!existing) { toAddOrUpdate.push(entry.path); continue; }
        if (existing.size !== entry.size || existing.mtime !== entry.mtime) { toAddOrUpdate.push(entry.path); continue; }
        unchanged.push(entry.path);
    }

    var toRemove = [];
    for (var ri = 0; ri < indexMeta.sourceFiles.length; ri++) {
        if (!currentMap.has(indexMeta.sourceFiles[ri].path)) toRemove.push(indexMeta.sourceFiles[ri].path);
    }

    return { needsFullRebuild: false, toAddOrUpdate: toAddOrUpdate, toRemove: toRemove, unchanged: unchanged };
}

async function embedBatch(texts, apiKey) {
    if (!texts || texts.length === 0) return [];

    var requests = [];
    for (var ti = 0; ti < texts.length; ti++) {
        var t = String(texts[ti] || '').slice(0, 6000);
        requests.push({
            model: 'models/text-embedding-004',
            content: { parts: [{ text: t }] }
        });
    }

    var url = EMBEDDING_API_URL + '?key=' + encodeURIComponent(apiKey);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, EMBEDDING_TIMEOUT);

    try {
        var response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: requests }),
            signal: controller.signal
        });

        if (!response.ok) {
            var errorText = await response.text().catch(function () { return ''; });
            throw new Error('Embedding API error ' + response.status + ': ' + errorText.slice(0, 200));
        }

        var data = await response.json();
        if (!data || !Array.isArray(data.embeddings)) {
            throw new Error('Embedding response missing embeddings array');
        }

        var result = [];
        for (var ei = 0; ei < data.embeddings.length; ei++) {
            var emb = data.embeddings[ei];
            if (emb && Array.isArray(emb.values)) {
                result.push(emb.values.map(Number));
            } else {
                result.push([]);
            }
        }

        return result;
    } catch (e) {
        if (controller.signal.aborted) {
            throw new Error('Embedding API timed out after ' + EMBEDDING_TIMEOUT + 'ms');
        }
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}
async function embedLargeBatch(texts, apiKey) {
    var all = [];
    for (var i = 0; i < texts.length; i += 100) {
        var part = texts.slice(i, i + 100);
        var result = await embedBatch(part, apiKey);
        for (var j = 0; j < result.length; j++) all.push(result[j]);
    }
    return all;
}
function isValidApiKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim();
    if (key.length === 0) return false;
    // if (!key.startsWith('AIza')) {
    //     console.warn('[IndexManager] WARNING: GEMINI_API_KEY format looks invalid. Google keys start with "AIza".');
    //     console.warn('[IndexManager] Embeddings will be disabled. Set a valid GEMINI_API_KEY for vector search.');
    //     return false;
    // }
    return true;
}

function chunkFile(relPath, parsed) {
    var result = [];
    if (relPath.startsWith('datasets/')) {
        var ds = chunkDatasetFile(relPath, parsed);
        for (var di = 0; di < ds.length; di++) result.push(ds[di]);
    } else if (relPath.startsWith('authors/')) {
        var au = chunkAuthorFile(relPath, parsed);
        for (var ai = 0; ai < au.length; ai++) result.push(au[ai]);
    }
    return result;
}

function createJsonWriter(filePath) {
    var stream = fsc.createWriteStream(filePath, {
        flags: 'w',
        highWaterMark: JSON_WRITE_BUFFER_SIZE,
        encoding: 'utf8'
    });

    var readyPromise = new Promise(function (resolve, reject) {
        stream.once('open', resolve);
        stream.once('error', reject);
    });

    var writeError = null;
    stream.on('error', function (err) { writeError = err; });

    return {
        ready: readyPromise,
        write: function (text) {
            if (writeError) throw writeError;
            return new Promise(function (resolve, reject) {
                var ok = stream.write(text, 'utf8');
                if (writeError) { reject(writeError); return; }
                if (!ok) {
                    stream.once('drain', resolve);
                } else {
                    resolve();
                }
            });
        },
        close: function () {
            return new Promise(function (resolve, reject) {
                stream.once('finish', function () {
                    if (writeError) { reject(writeError); return; }
                    resolve();
                }).once('error', reject);
                stream.end();
            });
        },
        bytesWritten: function () { return stream.bytesWritten; }
    };
}

/**
 * Build index from scratch using streaming writes to avoid OOM.
 * After build, loads the saved index file into currentIndex.
 */
async function buildIndex(dataRoot) {
    var startTime = Date.now();
    var apiKey = process.env.GEMINI_API_KEY;
    var hasApiKey = isValidApiKey(apiKey);

    // Ensure zero vector exists at proper dimension
    ensureZeroVector(EMBEDDING_DIMENSION);

    console.log('');
    console.log('[IndexManager] ====== BUILDING INDEX ======');
    console.log('[IndexManager] Embeddings: ' + (hasApiKey ? 'ENABLED (Google text-embedding-004)' : 'DISABLED (no GEMINI_API_KEY)'));
    logMemorySnapshot('[IndexManager] Before scan');

    var sourceFiles = await getSourceFiles(dataRoot);
    var filePaths = [];
    for (var si = 0; si < sourceFiles.length; si++) filePaths.push(sourceFiles[si].path);
    var totalFiles = filePaths.length;

    logMemorySnapshot('[IndexManager] After scan');
    console.log('[IndexManager] Found ' + totalFiles + ' source files');

    if (totalFiles === 0) {
        throw new Error('No source files found in data directories');
    }

    var datasetNames = filePaths.slice().sort();
    console.log('[IndexManager] Files: ' + datasetNames.length + ', building index');
    console.log('');

    var tmpIndexFile = INDEX_FILE + '.tmp.' + Date.now();
    var tmpEmbedFile = EMBEDDINGS_FILE + '.tmp.' + Date.now();

    var totalChunksWritten = 0;
    var fileNumber = 0;

    try {
        var embedStore;
        try {
            embedStore = await VectorStore.create(tmpEmbedFile, EMBEDDING_DIMENSION);
            await embedStore.beginWrite();
        } catch (e) {
            console.warn('[IndexManager] Failed to create embedding store:', e.message);
            embedStore = null;
        }

        logMemorySnapshot('[IndexManager] After vector store init');

        var jsonWriter = createJsonWriter(tmpIndexFile);
        await jsonWriter.ready;

        // Write JSON header
        await jsonWriter.write('{\n');
        await jsonWriter.write('  "vectorCacheVersion": ' + VECTOR_CACHE_VERSION + ',\n');
        await jsonWriter.write('  "embeddingModel": ' + JSON.stringify(EMBEDDING_MODEL) + ',\n');
        await jsonWriter.write('  "embeddingDimension": ' + EMBEDDING_DIMENSION + ',\n');
        await jsonWriter.write('  "createdAt": ' + JSON.stringify(new Date().toISOString()) + ',\n');
        await jsonWriter.write('  "sourceFiles": ' + JSON.stringify(sourceFiles) + ',\n');
        await jsonWriter.write('  "datasetNames": ' + JSON.stringify(datasetNames) + ',\n');
        await jsonWriter.write('  "embeddingFile": ' + JSON.stringify(path.basename(EMBEDDINGS_FILE)) + ',\n');
        await jsonWriter.write('  "chunks": [\n');

        sourceFiles = null;
        datasetNames = null;

        logMemorySnapshot('[IndexManager] Starting chunk processing');

        for (var fi2 = 0; fi2 < filePaths.length; fi2++) {
            var relPath2 = filePaths[fi2];
            var fullPath2 = path.join(dataRoot, relPath2);

            try {
                var content2 = await fs.readFile(fullPath2, 'utf8');
                var parsed2 = JSON.parse(content2);
                fileNumber++;

                var fileChunks = chunkFile(relPath2, parsed2);
                parsed2 = null;
                content2 = null;

                var chunkCount = fileChunks.length;

                if (chunkCount === 0) {
                    console.log('[IndexManager] File ' + fileNumber + '/' + totalFiles + ': ' + relPath2 + ' (0 chunks)');
                    continue;
                }

                console.log('[IndexManager] File ' + fileNumber + '/' + totalFiles + ': ' + relPath2 + ' (' + chunkCount + ' chunks)');

                var fileTexts = [];
                for (var ci = 0; ci < chunkCount; ci++) {
                    fileTexts.push(fileChunks[ci].text);
                }

                var embeddings = null;
                if (hasApiKey && embedStore) {
                    try {
                        embeddings = await embedLargeBatch(fileTexts, apiKey);
                    } catch (e) {
                        console.warn('  -> Embedding failed: ' + e.message + '. Using empty placeholder.');
                        embeddings = null;
                    }
                }

                var firstChunkInFile = true;
                for (var ci2 = 0; ci2 < chunkCount; ci2++) {
                    var ch = fileChunks[ci2];

                    var embeddingIndex = -1;
                    if (embedStore) {
                        if (embeddings && ci2 < embeddings.length && Array.isArray(embeddings[ci2]) && embeddings[ci2].length > 0) {
                            await embedStore.append(embeddings[ci2]);
                            embeddingIndex = totalChunksWritten;
                        } else {
                            // Use reusable ZERO_VECTOR instead of new Array(768).fill(0)
                            await embedStore.append(ZERO_VECTOR);
                            embeddingIndex = totalChunksWritten;
                        }
                    }

                    var jsonChunk = {
                        id: ch.id,
                        dataset: ch.dataset,
                        page: ch.page,
                        vachanaNumber: ch.vachanaNumber,
                        author: ch.author,
                        title: ch.title,
                        language: ch.language,
                        chunkIndex: ch.chunkIndex,
                        totalChunks: ch.totalChunks,
                        tokenCount: ch.tokenCount,
                        text: ch.text,
                        embeddingIndex: embeddingIndex
                    };

                    var prefix = (totalChunksWritten > 0) ? ',\n    ' : '\n    ';
                    await jsonWriter.write(prefix + JSON.stringify(jsonChunk));

                    totalChunksWritten++;
                }

                fileChunks = null;
                fileTexts = null;
                embeddings = null;

                gcIf();

                if (fileNumber % 10 === 0 || fileNumber === totalFiles) {
                    console.log('[IndexManager] Written ' + totalChunksWritten + ' chunks total');
                }

            } catch (e) {
                console.warn('[IndexManager] Failed to process ' + relPath2 + ': ' + (e ? e.message : String(e)));
            }
        }

        logMemorySnapshot('[IndexManager] After chunk processing');

        await jsonWriter.write('\n  ]\n}\n');
        await jsonWriter.close();

        if (embedStore) {
            await embedStore.finalize();
            var embedFileSize = await embedStore.getFileSize();
            await embedStore.close();
            console.log('[IndexManager] Embedding store finalized: ' + embedFileSize + ' bytes (' + totalChunksWritten + ' vectors)');
        }

        logMemorySnapshot('[IndexManager] After file finalization');

        console.log('[IndexManager] Renaming temp files...');

        if (existsSync(INDEX_FILE)) {
            await fs.unlink(INDEX_FILE);
        }
        if (existsSync(EMBEDDINGS_FILE)) {
            await fs.unlink(EMBEDDINGS_FILE);
        }

        await fs.rename(tmpIndexFile, INDEX_FILE);
        console.log('[IndexManager] Index saved: ' + INDEX_FILE);

        if (existsSync(tmpEmbedFile)) {
            await fs.rename(tmpEmbedFile, EMBEDDINGS_FILE);
            console.log('[IndexManager] Embeddings saved: ' + EMBEDDINGS_FILE);
        }

        await cleanupTempFiles();

        // Load the saved index into memory
        try {
            var savedRaw = await fs.readFile(INDEX_FILE, 'utf8');
            currentIndex = JSON.parse(savedRaw);
        } catch (loadErr) {
            console.warn('[IndexManager] Could not reload saved index, building minimal fallback:', loadErr.message);
            currentIndex = {
                vectorCacheVersion: VECTOR_CACHE_VERSION,
                embeddingModel: EMBEDDING_MODEL,
                embeddingDimension: EMBEDDING_DIMENSION,
                createdAt: new Date().toISOString(),
                sourceFiles: filePaths.map(function (p) { return { path: p }; }),
                datasetNames: filePaths.slice().sort(),
                embeddingFile: path.basename(EMBEDDINGS_FILE),
                chunks: []
            };
        }

        var elapsed = Date.now() - startTime;
        var indexFileSize = existsSync(INDEX_FILE) ? (await fs.stat(INDEX_FILE)).size : 0;
        var embedFileSize2 = existsSync(EMBEDDINGS_FILE) ? (await fs.stat(EMBEDDINGS_FILE)).size : 0;

        console.log('');
        console.log('[IndexManager] ====== BUILD COMPLETE ======');
        console.log('  Chunks: ' + totalChunksWritten);
        console.log('  Datasets: ' + filePaths.length);
        console.log('  Index file: ' + Math.round(indexFileSize / 1024) + ' KB');
        console.log('  Embedding file: ' + Math.round(embedFileSize2 / 1024 / 1024 * 100) / 100 + ' MB');
        console.log('  Time: ' + elapsed + 'ms (' + Math.round(elapsed / 1000) + 's)');
        console.log('  Memory: ' + getMemoryUsageMB() + ' MB');
        logMemorySnapshot('[IndexManager] Final');
        console.log('[IndexManager] ===========================');
        console.log('');

        gcIf();
        return currentIndex;

    } catch (e) {
        console.error('[IndexManager] Build failed:', e.message);
        console.log('[IndexManager] Cleaning up temporary files...');

        try { await fs.unlink(tmpIndexFile); } catch (e2) { /* ignore */ }
        try { await fs.unlink(tmpEmbedFile); } catch (e2) { /* ignore */ }
        try { await VectorStore.destroy(tmpEmbedFile); } catch (e2) { /* ignore */ }

        if (!currentIndex && existsSync(INDEX_FILE)) {
            try {
                console.log('[IndexManager] Attempting to reload previous index...');
                var raw = await fs.readFile(INDEX_FILE, 'utf8');
                currentIndex = JSON.parse(raw);
                console.log('[IndexManager] Previous index restored (' + (currentIndex.chunks ? currentIndex.chunks.length : 0) + ' chunks)');
            } catch (e3) {
                console.warn('[IndexManager] Could not restore previous index:', e3.message);
            }
        }

        console.log('[IndexManager] Error recovery complete');
        throw e;
    }
}

/**
 * Streaming incremental update.
 * Copies unchanged chunks from the old index to the new index one at a time,
 * then appends new chunks. Never holds remainingChunks + newChunks simultaneously.
 */
async function incrementalUpdate(dataRoot, existing, diff) {
    var startTime = Date.now();
    var apiKey = process.env.GEMINI_API_KEY;
    var hasApiKey = isValidApiKey(apiKey);
    var currentSourceFiles = await getSourceFiles(dataRoot);
    var metadata = buildMetadata(currentSourceFiles);

    // Ensure zero vector exists at proper dimension
    ensureZeroVector(EMBEDDING_DIMENSION);

    console.log('');
    console.log('[IndexManager] ====== INCREMENTAL UPDATE ======');
    console.log('[IndexManager] Add/Update: ' + diff.toAddOrUpdate.length + ' files');
    console.log('[IndexManager] Remove: ' + diff.toRemove.length + ' files');
    console.log('[IndexManager] Unchanged: ' + diff.unchanged.length + ' files');
    logMemorySnapshot('[IndexManager] Before incremental');

    var removedPaths = new Set();
    for (var ri = 0; ri < diff.toRemove.length; ri++) removedPaths.add(diff.toRemove[ri]);
    for (var ai = 0; ai < diff.toAddOrUpdate.length; ai++) removedPaths.add(diff.toAddOrUpdate[ai]);

    var tmpIndexFile = INDEX_FILE + '.tmp.inc.' + Date.now();
    var tmpEmbedFile = EMBEDDINGS_FILE + '.tmp.inc.' + Date.now();

    try {
        // Open existing embedding store for reading (batched copy)
        var existingEmbedStore = null;
        try {
            if (await VectorStore.fileExists(EMBEDDINGS_FILE)) {
                existingEmbedStore = await VectorStore.open(EMBEDDINGS_FILE);
            }
        } catch (e) {
            console.warn('[IndexManager] Could not open existing embeddings:', e.message);
            existingEmbedStore = null;
        }

        // Create new stores
        var newEmbedStore = await VectorStore.create(tmpEmbedFile, EMBEDDING_DIMENSION);
        await newEmbedStore.beginWrite();

        logMemorySnapshot('[IndexManager] After opening stores');

        // Open old index as a streaming reader — avoid loading all chunks
        var jsonWriter = createJsonWriter(tmpIndexFile);
        await jsonWriter.ready;

        // Write JSON header
        await jsonWriter.write('{\n');
        await jsonWriter.write('  "vectorCacheVersion": ' + VECTOR_CACHE_VERSION + ',\n');
        await jsonWriter.write('  "embeddingModel": ' + JSON.stringify(EMBEDDING_MODEL) + ',\n');
        await jsonWriter.write('  "embeddingDimension": ' + EMBEDDING_DIMENSION + ',\n');
        await jsonWriter.write('  "createdAt": ' + JSON.stringify(existing.createdAt || new Date().toISOString()) + ',\n');
        await jsonWriter.write('  "sourceFiles": ' + JSON.stringify(metadata.sourceFiles) + ',\n');
        await jsonWriter.write('  "datasetNames": ' + JSON.stringify(metadata.datasetNames) + ',\n');
        await jsonWriter.write('  "embeddingFile": ' + JSON.stringify(path.basename(EMBEDDINGS_FILE)) + ',\n');
        await jsonWriter.write('  "chunks": [\n');

        var newEmbeddingIndex = 0;
        var firstChunkInArray = true;

        // Phase 1: Stream unchanged chunks from the old index (skip removed/changed datasets)
        var streamedCount = 0;
        var skippedCount = 0;

        for (var ci = 0; ci < existing.chunks.length; ci++) {
            var chunk = existing.chunks[ci];

            if (removedPaths.has(chunk.dataset)) {
                skippedCount++;
                continue;
            }

            // Copy embedding if available
            if (existingEmbedStore && chunk.embeddingIndex >= 0 && chunk.embeddingIndex < existingEmbedStore.size()) {
                try {
                    var emb = await existingEmbedStore.get(chunk.embeddingIndex);
                    await newEmbedStore.append(emb);
                } catch (e) {
                    await newEmbedStore.append(ZERO_VECTOR);
                }
            } else {
                await newEmbedStore.append(ZERO_VECTOR);
            }

            chunk.embeddingIndex = newEmbeddingIndex;
            newEmbeddingIndex++;

            var prefix = firstChunkInArray ? '\n    ' : ',\n    ';
            await jsonWriter.write(prefix + JSON.stringify(chunk));
            firstChunkInArray = false;
            streamedCount++;
        }

        logMemorySnapshot('[IndexManager] After copying unchanged chunks');
        console.log('[IndexManager] Streamed ' + streamedCount + ' unchanged chunks, skipped ' + skippedCount);

        // Close existing embed store to free resources
        if (existingEmbedStore) {
            await existingEmbedStore.unload();
            await existingEmbedStore.close();
            existingEmbedStore = null;
        }

        // Phase 2: Process new/updated files and append their chunks
        var newChunksProcessed = 0;
        for (var fi = 0; fi < diff.toAddOrUpdate.length; fi++) {
            var relPath = diff.toAddOrUpdate[fi];
            var fullPath = path.join(dataRoot, relPath);

            try {
                var content = await fs.readFile(fullPath, 'utf8');
                var parsed = JSON.parse(content);
                var fileChunks = chunkFile(relPath, parsed);
                parsed = null;
                content = null;

                if (fileChunks.length === 0) continue;

                var fileTexts = [];
                for (var ci2 = 0; ci2 < fileChunks.length; ci2++) {
                    fileTexts.push(fileChunks[ci2].text);
                }

                var batchEmbeddings = null;
                if (hasApiKey) {
                    try {
                        batchEmbeddings = await embedLargeBatch(fileTexts, apiKey);
                    } catch (e) {
                        console.warn('  -> Embedding failed: ' + e.message);
                    }
                }

                for (var ci3 = 0; ci3 < fileChunks.length; ci3++) {
                    var ch2 = fileChunks[ci3];

                    // Use ZERO_VECTOR singleton instead of new Array(dim).fill(0)
                    var embedding = (batchEmbeddings && ci3 < batchEmbeddings.length && Array.isArray(batchEmbeddings[ci3]) && batchEmbeddings[ci3].length > 0)
                        ? batchEmbeddings[ci3]
                        : ZERO_VECTOR;

                    await newEmbedStore.append(embedding);

                    var jsonChunk2 = {
                        id: ch2.id,
                        dataset: ch2.dataset,
                        page: ch2.page,
                        vachanaNumber: ch2.vachanaNumber,
                        author: ch2.author,
                        title: ch2.title,
                        language: ch2.language,
                        chunkIndex: ch2.chunkIndex,
                        totalChunks: ch2.totalChunks,
                        tokenCount: ch2.tokenCount,
                        text: ch2.text,
                        embeddingIndex: newEmbeddingIndex
                    };

                    newEmbeddingIndex++;
                    newChunksProcessed++;

                    var prefix2 = firstChunkInArray ? '\n    ' : ',\n    ';
                    await jsonWriter.write(prefix2 + JSON.stringify(jsonChunk2));
                    firstChunkInArray = false;
                }

                fileChunks = null;
                fileTexts = null;
                batchEmbeddings = null;
                gcIf();

            } catch (e) {
                console.warn('[IndexManager] Failed to process ' + relPath + ': ' + (e ? e.message : String(e)));
            }
        }

        await jsonWriter.write('\n  ]\n}\n');
        await jsonWriter.close();

        await newEmbedStore.finalize();
        await newEmbedStore.close();

        logMemorySnapshot('[IndexManager] After processing changed files');
        console.log('[IndexManager] Added/updated ' + newChunksProcessed + ' new chunks');

        var oldIndexExists = existsSync(INDEX_FILE);
        var oldEmbedExists = existsSync(EMBEDDINGS_FILE);

        if (oldIndexExists) await fs.unlink(INDEX_FILE);
        if (oldEmbedExists) await fs.unlink(EMBEDDINGS_FILE);

        await fs.rename(tmpIndexFile, INDEX_FILE);
        await fs.rename(tmpEmbedFile, EMBEDDINGS_FILE);

        // Reload the new index
        try {
            var raw = await fs.readFile(INDEX_FILE, 'utf8');
            currentIndex = JSON.parse(raw);
            currentIndex.sourceFiles = metadata.sourceFiles;
            currentIndex.datasetNames = metadata.datasetNames;
        } catch (loadErr) {
            console.warn('[IndexManager] Could not reload after incremental update:', loadErr.message);
            currentIndex = existing;
        }

        await cleanupTempFiles();

        var elapsed = Date.now() - startTime;
        console.log('[IndexManager] Incremental update complete (' + elapsed + 'ms)');
        logMemorySnapshot('[IndexManager] Final');
        console.log('[IndexManager] ===========================');
        console.log('');

        gcIf();
        return currentIndex;

    } catch (e) {
        console.error('[IndexManager] Incremental update failed:', e.message);
        try { await fs.unlink(tmpIndexFile); } catch (e2) { /* ignore */ }
        try { await fs.unlink(tmpEmbedFile); } catch (e2) { /* ignore */ }
        try { await VectorStore.destroy(tmpEmbedFile); } catch (e2) { /* ignore */ }
        throw e;
    }
}

async function cleanupTempFiles() {
    var dir = path.dirname(INDEX_FILE);
    try {
        var files = await fs.readdir(dir);
        for (var fi = 0; fi < files.length; fi++) {
            var f = files[fi];
            if (f.includes('.tmp.') || f.includes('.tmp.inc.')) {
                try {
                    await fs.unlink(path.join(dir, f));
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
}

export async function ensureIndex(dataRoot) {
    if (indexBuildPromise) return indexBuildPromise;

    indexBuildPromise = (async function () {
        var startTime = Date.now();
        console.log('[IndexManager] Ensuring index...');
        logMemorySnapshot('[IndexManager] Start');

        var existing = await loadSavedIndex();
        var sourceFiles = await getSourceFiles(dataRoot);

        if (!existing) {
            console.log('[IndexManager] No existing index found. Building from scratch...');
            logMemorySnapshot('[IndexManager] Before build');
            currentIndex = await buildIndex(dataRoot);
            var elapsed = Date.now() - startTime;
            console.log('[IndexManager] Index ready (' + elapsed + 'ms)');
            return currentIndex;
        }

        var diff = getIndexDiff(existing, sourceFiles);

        if (diff.needsFullRebuild) {
            console.log('[IndexManager] Full rebuild needed (version/model changed).');
            logMemorySnapshot('[IndexManager] Before rebuild');
            currentIndex = await buildIndex(dataRoot);
            var elapsed = Date.now() - startTime;
            console.log('[IndexManager] Index ready (' + elapsed + 'ms)');
            return currentIndex;
        }

        if (diff.toRemove.length === 0 && diff.toAddOrUpdate.length === 0) {
            var chunkCount = Array.isArray(existing.chunks) ? existing.chunks.length : 0;
            console.log('[IndexManager] Index is up to date: ' + chunkCount + ' chunks, ' + (existing.datasetNames ? existing.datasetNames.length : 0) + ' datasets');
            currentIndex = existing;
            logMemorySnapshot('[IndexManager] Final (no changes)');
            return currentIndex;
        }

        logMemorySnapshot('[IndexManager] Before incremental');
        currentIndex = await incrementalUpdate(dataRoot, existing, diff);
        var elapsed = Date.now() - startTime;
        console.log('[IndexManager] Index ready (' + elapsed + 'ms)');
        return currentIndex;
    })();

    return indexBuildPromise;
}

async function loadSavedIndex() {
    if (!existsSync(INDEX_FILE)) return null;
    try {
        var raw = await fs.readFile(INDEX_FILE, 'utf8');
        var parsed = JSON.parse(raw);

        if (!parsed || typeof parsed !== 'object') return null;
        if (!Array.isArray(parsed.chunks)) return null;

        var hasInlineEmbeddings = parsed.chunks.length > 0 && Array.isArray(parsed.chunks[0].embedding);
        if (hasInlineEmbeddings) {
            console.log('[IndexManager] Detected legacy index with inline embeddings. Rebuild required.');
            console.log('[IndexManager] The new format stores embeddings separately in rag_embeddings.bin');
            return null;
        }

        if (parsed.chunks.length > 0 && parsed.chunks[0].embeddingIndex === undefined) {
            console.log('[IndexManager] Index missing embeddingIndex field. Rebuild required.');
            return null;
        }

        console.log('[IndexManager] Loaded saved index: ' + parsed.chunks.length + ' chunks, ' +
            (parsed.datasetNames ? parsed.datasetNames.length : 0) + ' datasets');
        return parsed;
    } catch (e) {
        console.warn('[IndexManager] Failed to parse existing index:', e.message);
        return null;
    }
}

export function getCurrentIndex() {
    return currentIndex;
}

export function getIndexFilePath() {
    return INDEX_FILE;
}

export function getEmbeddingFilePath() {
    return EMBEDDINGS_FILE;
}

export function getEmbeddingModelName() {
    return EMBEDDING_MODEL;
}

export function getEmbeddingDimension() {
    return EMBEDDING_DIMENSION;
}

export function getCurrentEmbeddingStore() {
    return currentEmbeddingStore;
}

export function setCurrentEmbeddingStore(store) {
    currentEmbeddingStore = store;
}
