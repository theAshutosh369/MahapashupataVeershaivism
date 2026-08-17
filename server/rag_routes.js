import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const INDEX_FILE = path.resolve(process.cwd(), 'server', 'rag_index.json');
const VECTOR_CACHE_VERSION = 2;
const DEFAULT_LOCAL_MODEL = process.env.LOCAL_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const OLLAMA_EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
const EMBEDDING_MODE = process.env.EMBEDDING_MODE || 'ollama';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama';
const LLM_API_URL = process.env.LLM_API_URL;
const EMBEDDING_TEXT_LIMIT = Number(process.env.EMBEDDING_TEXT_LIMIT || 6000);
const OLLAMA_EMBED_BATCH_SIZE = Number(process.env.OLLAMA_EMBED_BATCH_SIZE || 128);
const MAX_TOP_CHUNKS = 10;
const SOURCE_FIELDS = ['translation', 'english', 'kannada', 'transliteration', 'hindi', 'sanskrit', 'tamil', 'telugu'];
const METADATA_TAGS = ['author', 'title', 'page', 'language'];

let currentIndex = null;
let indexBuildPromise = null;
let embeddingProvider = null;

function safeString(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function formatMetadata(chunk) {
    const parts = [];
    if (chunk.author) parts.push(`Author: ${chunk.author}`);
    if (chunk.title) parts.push(`Title: ${chunk.title}`);
    if (chunk.page !== undefined && chunk.page !== null) parts.push(`Page: ${chunk.page}`);
    if (chunk.vachanaNumber !== undefined && chunk.vachanaNumber !== null) parts.push(`Vachana: ${chunk.vachanaNumber}`);
    if (chunk.language) parts.push(`Language: ${chunk.language}`);
    return parts.join(' | ');
}

function buildChunkText(row, metadata) {
    const pieces = [];
    if (metadata.title) pieces.push(`Title: ${metadata.title}`);
    if (metadata.author) pieces.push(`Author: ${metadata.author}`);
    if (metadata.page !== undefined && metadata.page !== null) pieces.push(`Page: ${metadata.page}`);

    for (const field of SOURCE_FIELDS) {
        const value = row?.[field];
        if (value === null || value === undefined || String(value).trim() === '') continue;
        pieces.push(`${field}: ${String(value).trim()}`);
    }

    if (pieces.length === 0) {
        return Object.entries(row || {})
            .filter(([_, value]) => value !== null && value !== undefined && String(value).trim() !== '')
            .map(([key, value]) => `${key}: ${String(value).trim()}`)
            .join(' | ') || 'No indexed text available.';
    }

    return pieces.join('\n');
}

function chunkDatasetFile(relPath, json) {
    const chunks = [];
    if (!json || typeof json !== 'object') return chunks;
    const items = Array.isArray(json.data) ? json.data : [];
    const datasetName = relPath;
    const title = safeString(json.name) || path.basename(relPath);

    for (let i = 0; i < items.length; i += 1) {
        const row = items[i] ?? {};
        const page = Number(row.page) || null;
        const vachanaNumber = row.number ?? row.page ?? i + 1;
        const author = safeString(row.author) || title;
        const language = SOURCE_FIELDS.find((field) => row[field] !== undefined && row[field] !== null && String(row[field]).trim() !== '') || 'unknown';

        const chunk = {
            id: `${datasetName}#${page ?? i + 1}#${vachanaNumber}`,
            dataset: datasetName,
            page,
            vachanaNumber,
            author,
            title,
            language,
            text: buildChunkText(row, { title, author, page, language })
        };

        chunks.push(chunk);
    }

    return chunks;
}

function chunkAuthorFile(relPath, json) {
    const chunks = [];
    if (!json || typeof json !== 'object') return chunks;
    const vachanas = Array.isArray(json.vachanas) ? json.vachanas : [];
    const authorName = safeString(json.name) || path.basename(relPath);

    for (let i = 0; i < vachanas.length; i += 1) {
        const record = vachanas[i] ?? {};
        const page = Number(record.page || record.number) || null;
        const vachanaNumber = record.number ?? record.page ?? i + 1;
        const title = authorName;
        const language = SOURCE_FIELDS.find((field) => record[field] !== undefined && record[field] !== null && String(record[field]).trim() !== '') || 'unknown';

        const chunk = {
            id: `${relPath}#${page ?? i + 1}#${vachanaNumber}`,
            dataset: relPath,
            page,
            vachanaNumber,
            author: authorName,
            title,
            language,
            text: buildChunkText(record, { title, author: authorName, page, language })
        };

        chunks.push(chunk);
    }

    return chunks;
}

function scanJsonFiles(directory) {
    return fs.readdir(directory, { withFileTypes: true }).then(async (entries) => {
        const out = [];
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                out.push(...(await scanJsonFiles(fullPath)));
                continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
                out.push(fullPath);
            }
        }
        return out;
    }).catch((err) => {
        if (err.code === 'ENOENT') {
            console.log(`Directory does not exist: ${directory}`);
            return [];
        }
        throw err;
    });
}

function getIndexDiff(indexMeta, currentSources) {
    // Returns which files need embedding refresh, which should be removed, and which are unchanged.
    if (!indexMeta || !Array.isArray(indexMeta.sourceFiles)) {
        return {
            needsFullRebuild: true,
            toAddOrUpdate: currentSources.map((s) => s.path),
            toRemove: [],
            unchanged: []
        };
    }

    // If embedding settings changed, we cannot safely reuse vectors.
    const embeddingChanged =
        indexMeta.vectorCacheVersion !== VECTOR_CACHE_VERSION ||
        indexMeta.embeddingMode !== EMBEDDING_MODE ||
        indexMeta.embeddingModel !== getEmbeddingModelName();

    if (!Array.isArray(indexMeta.chunks) || indexMeta.chunks.length === 0) {
        return { needsFullRebuild: true, toAddOrUpdate: currentSources.map((s) => s.path), toRemove: [], unchanged: [] };
    }

    if (embeddingChanged) {
        return {
            needsFullRebuild: true,
            toAddOrUpdate: currentSources.map((s) => s.path),
            toRemove: [],
            unchanged: []
        };
    }

    const indexMap = new Map(indexMeta.sourceFiles.map((e) => [e.path, e]));
    const currentMap = new Map(currentSources.map((e) => [e.path, e]));

    const toAddOrUpdate = [];
    const unchanged = [];
    for (const entry of currentSources) {
        const existing = indexMap.get(entry.path);
        if (!existing) {
            toAddOrUpdate.push(entry.path);
            continue;
        }
        if (existing.size !== entry.size || existing.mtime !== entry.mtime) {
            toAddOrUpdate.push(entry.path);
            continue;
        }
        unchanged.push(entry.path);
    }

    const toRemove = [];
    for (const indexEntry of indexMeta.sourceFiles) {
        if (!currentMap.has(indexEntry.path)) {
            toRemove.push(indexEntry.path);
        }
    }

    return { needsFullRebuild: false, toAddOrUpdate, toRemove, unchanged };
}

function mergeIndexChunks(existingIndex, newChunks) {
    const byId = new Map();
    for (const c of existingIndex.chunks || []) byId.set(c.id, c);
    for (const c of newChunks) byId.set(c.id, c);
    existingIndex.chunks = Array.from(byId.values());
    existingIndex.datasetNames = Array.from(new Set(existingIndex.chunks.map((c) => c.dataset))).sort();
}

function filterChunksByRemovedSources(existingIndex, removedSourcePaths) {
    if (!removedSourcePaths.length) return;
    const removedSet = new Set(removedSourcePaths);
    // We store chunk.dataset as the relPath for authors and datasets.
    existingIndex.chunks = (existingIndex.chunks || []).filter((chunk) => !removedSet.has(chunk.dataset));
}



async function loadSavedIndex() {
    if (!existsSync(INDEX_FILE)) return null;
    try {
        const raw = await fs.readFile(INDEX_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function getEmbeddingModelName() {
    if (EMBEDDING_MODE === 'ollama') return OLLAMA_EMBEDDING_MODEL;
    if (EMBEDDING_MODE === 'openai') return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    return DEFAULT_LOCAL_MODEL;
}

function validateEmbeddingVector(vector, label) {
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(Number(value)))) {
        throw new Error(`${label} returned an invalid embedding vector.`);
    }
    return vector.map(Number);
}

function textForEmbedding(text) {
    return String(text || '').slice(0, EMBEDDING_TEXT_LIMIT);
}

async function createLocalEmbeddingProvider() {
    try {
        const module = await import('@xenova/transformers');
        const { pipeline } = module;
        const modelId = DEFAULT_LOCAL_MODEL;
        const pipelineInstance = await pipeline('feature-extraction', modelId, { progress_callback: () => { }, useCache: true });

        return async (text) => {
            const result = await pipelineInstance(text, { pooling: 'mean' });
            if (Array.isArray(result)) {
                return Array.isArray(result[0]) ? result.flat(10).map(Number) : result.map(Number);
            }
            if (result?.data) {
                return Array.from(result.data).map(Number);
            }
            return [];
        };
    } catch (error) {
        console.warn('Local embedding provider could not be initialized.', error?.message ?? error);
        return null;
    }
}

async function createOllamaEmbeddingProvider() {
    // Use Ollama's /api/embed with batching for performance.
    // computeEmbeddings() already batches; embedOllamaBatch adds another safety layer.
    return async (text) => {
        const embeddings = await embedOllamaBatch([textForEmbedding(text)]);
        return embeddings[0];
    };
}


async function embedOllamaBatch(texts) {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OLLAMA_EMBEDDING_MODEL,
            input: texts.map(textForEmbedding)
        })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(data?.embeddings)) {
        const message = data?.error || `Ollama embedding request failed with status ${response.status}`;
        throw new Error(`${message}. Make sure Ollama is running and run: ollama pull ${OLLAMA_EMBEDDING_MODEL}`);
    }

    if (data.embeddings.length !== texts.length) {
        throw new Error(`Ollama returned ${data.embeddings.length} embeddings for ${texts.length} inputs.`);
    }

    return data.embeddings.map((embedding) => validateEmbeddingVector(embedding, `Ollama model ${OLLAMA_EMBEDDING_MODEL}`));
}

async function embedOllamaLegacy(text) {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OLLAMA_EMBEDDING_MODEL,
            prompt: textForEmbedding(text)
        })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(data?.embedding)) {
        const message = data?.error || `Ollama embedding request failed with status ${response.status}`;
        throw new Error(`${message}. Make sure Ollama is running and run: ollama pull ${OLLAMA_EMBEDDING_MODEL}`);
    }

    return validateEmbeddingVector(data.embedding, `Ollama model ${OLLAMA_EMBEDDING_MODEL}`);
}

function createOpenAIEmbeddingProvider() {
    if (!OPENAI_API_KEY) return null;
    return async (text) => {
        const response = await fetch(`${OPENAI_API_URL}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({ model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', input: text })
        });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data?.data) || !data.data[0]?.embedding) {
            throw new Error(data?.error?.message || 'OpenAI embedding request failed');
        }
        return data.data[0].embedding.map(Number);
    };
}

async function getEmbeddingProvider() {
    if (embeddingProvider) return embeddingProvider;

    if (EMBEDDING_MODE === 'ollama') {
        embeddingProvider = await createOllamaEmbeddingProvider();
    }

    if (!embeddingProvider && EMBEDDING_MODE === 'local') {
        embeddingProvider = await createLocalEmbeddingProvider();
    }

    if (!embeddingProvider && (EMBEDDING_MODE === 'openai' || OPENAI_API_KEY)) {
        embeddingProvider = createOpenAIEmbeddingProvider();
    }

    if (!embeddingProvider || typeof embeddingProvider !== 'function') {
        const localModeError = EMBEDDING_MODE === 'local'
            ? 'Local embedding failed to initialize.'
            : EMBEDDING_MODE === 'ollama'
                ? `Ollama embedding provider is selected. Start Ollama and pull ${OLLAMA_EMBEDDING_MODEL}.`
                : `Local embedding disabled (EMBEDDING_MODE=${EMBEDDING_MODE}).`;
        const openaiHint = OPENAI_API_KEY ? 'OpenAI embedding provider was not created.' : 'Set OPENAI_API_KEY to use OpenAI embeddings.';
        throw new Error(`No valid embedding provider. ${localModeError} ${openaiHint}`);
    }

    return embeddingProvider;
}


async function computeEmbeddings(texts) {
    const vectors = [];

    // For Ollama, avoid per-chunk HTTP calls: batch using /api/embed.
    if (EMBEDDING_MODE === 'ollama') {
        const batchSize = Math.max(1, Number(process.env.OLLAMA_EMBED_BATCH_SIZE || OLLAMA_EMBED_BATCH_SIZE) || 128);

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const progress = Math.round((i / texts.length) * 100);
            console.log(`Computing embeddings (ollama batch): ${progress}% (${i}/${texts.length})`);

            const toEmbed = batch.map((t) => textForEmbedding(t));
            const embeddings = await embedOllamaBatch(toEmbed);

            for (let j = 0; j < embeddings.length; j += 1) {
                vectors.push(validateEmbeddingVector(embeddings[j], `Ollama model ${OLLAMA_EMBEDDING_MODEL}`));
            }
        }

        console.log(`Completed all ${vectors.length} embeddings`);
        return vectors;
    }

    // Other providers: keep the existing per-item embedding behavior.
    const provider = await getEmbeddingProvider();
    const batchSize = 32; // Process in batches for better performance

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const progress = Math.round((i / texts.length) * 100);
        console.log(`Computing embeddings: ${progress}% (${i}/${texts.length})`);

        for (const text of batch) {
            try {
                vectors.push(validateEmbeddingVector(await provider(textForEmbedding(text)), 'Embedding provider'));
            } catch (error) {
                throw new Error(`Error embedding chunk ${vectors.length + 1}/${texts.length}: ${error?.message || error}`);
            }
        }
    }

    console.log(`Completed all ${vectors.length} embeddings`);
    return vectors;
}


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

function normalizeSearchText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

function tokenizeForHybrid(text) {
    return normalizeSearchText(text)
        .split(/\s+/)
        .filter(Boolean);
}

function searchableChunkText(chunk) {
    return [
        chunk.dataset,
        chunk.author,
        chunk.title,
        chunk.language,
        chunk.page,
        chunk.vachanaNumber,
        chunk.text
    ].filter((value) => value !== null && value !== undefined).join(' ');
}

function hybridScore(query, chunk, similarity) {
    const queryTokens = tokenizeForHybrid(query);
    if (queryTokens.length === 0) return similarity;
    const text = tokenizeForHybrid(searchableChunkText(chunk)).join(' ');
    let overlap = 0;
    for (const token of queryTokens) {
        if (text.includes(token)) overlap += 1;
    }
    return similarity + Math.min(0.3, overlap / Math.max(10, queryTokens.length)) * 0.5;
}

function getChunkKeywordScore(query, chunk) {
    const queryTokens = tokenizeForHybrid(query);
    if (queryTokens.length === 0) return 0;
    const chunkText = tokenizeForHybrid(searchableChunkText(chunk)).join(' ');
    let matches = 0;
    for (const token of new Set(queryTokens)) {
        if (chunkText.includes(token)) matches += 1;
    }
    return matches / Math.max(1, new Set(queryTokens).size);
}

function metadataBoost(query, chunk) {
    const queryTokens = new Set(tokenizeForHybrid(query).filter((token) => token.length > 3));
    if (queryTokens.size === 0) return 0;

    const metadataTokens = new Set(tokenizeForHybrid([
        chunk.dataset,
        chunk.author,
        chunk.title
    ].filter(Boolean).join(' ')));

    let matches = 0;
    for (const token of queryTokens) {
        if (metadataTokens.has(token)) matches += 1;
    }

    return Math.min(0.25, matches * 0.15);
}

async function buildIndex(dataRoot) {
    try {
        const datasetRoot = path.join(dataRoot, 'datasets');
        const authorRoot = path.join(dataRoot, 'authors');
        console.log('Building RAG index from:', { dataRoot, datasetRoot, authorRoot });
        const datasetFiles = await scanJsonFiles(datasetRoot).catch((err) => {
            console.warn(`Failed to scan dataset root (${datasetRoot}):`, err?.message);
            return [];
        });
        const authorFiles = await scanJsonFiles(authorRoot).catch((err) => {
            console.warn(`Failed to scan author root (${authorRoot}):`, err?.message);
            return [];
        });
        console.log(`Found ${datasetFiles.length} dataset files and ${authorFiles.length} author files`);

        const sourceFiles = [];
        const chunkCandidates = [];

        for (const filePath of [...datasetFiles, ...authorFiles]) {
            try {
                const stat = await fs.stat(filePath);
                const relPath = path.relative(dataRoot, filePath).split(path.sep).join('/');
                sourceFiles.push({ path: relPath, size: stat.size, mtime: stat.mtimeMs });

                const content = await fs.readFile(filePath, 'utf8');
                const parsed = JSON.parse(content);
                if (relPath.startsWith('datasets/')) {
                    chunkCandidates.push(...chunkDatasetFile(relPath, parsed));
                } else if (relPath.startsWith('authors/')) {
                    chunkCandidates.push(...chunkAuthorFile(relPath, parsed));
                }
            } catch (error) {
                console.warn(`Error processing ${filePath}:`, error?.message);
            }
        }

        console.log(`Created ${chunkCandidates.length} chunks from dataset files`);
        if (chunkCandidates.length === 0) {
            console.warn('WARNING: No chunks found. Check if datasets directory exists and contains JSON files.');
        }

        const texts = chunkCandidates.map((chunk) => chunk.text);
        console.log('Starting embedding computation for', texts.length, 'chunks...');
        const embeddings = await computeEmbeddings(texts);

        const chunks = chunkCandidates.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] }));
        const datasets = Array.from(new Set(chunks.map((chunk) => chunk.dataset))).sort();
        const indexData = {
            vectorCacheVersion: VECTOR_CACHE_VERSION,
            embeddingMode: EMBEDDING_MODE,
            embeddingModel: getEmbeddingModelName(),
            embeddingDimension: embeddings[0]?.length ?? 0,
            createdAt: new Date().toISOString(),
            sourceFiles,
            datasetNames: datasets,
            chunks
        };


        console.log(`RAG index built: ${indexData.chunks.length} total chunks from ${indexData.datasetNames.length} datasets`);
        await fs.writeFile(INDEX_FILE, JSON.stringify(indexData, null, 2) + '\n', 'utf8');
        console.log('Index saved to:', INDEX_FILE);
        return indexData;
    } catch (error) {
        console.error('FATAL: Error building index:', error);
        throw error;
    }
}

async function ensureIndex(dataRoot) {
    if (indexBuildPromise) return indexBuildPromise;
    indexBuildPromise = (async () => {
        console.log('Ensuring RAG index for dataRoot:', dataRoot);
        let existing = await loadSavedIndex();
        const sourceFiles = [];
        const datasetRoot = path.join(dataRoot, 'datasets');
        const authorRoot = path.join(dataRoot, 'authors');

        console.log('Scanning directories for JSON files...');
        const datasetFiles = await scanJsonFiles(datasetRoot).catch(() => []);
        const authorFiles = await scanJsonFiles(authorRoot).catch(() => []);

        for (const filePath of [...datasetFiles, ...authorFiles]) {
            const stat = await fs.stat(filePath);
            const relPath = path.relative(dataRoot, filePath).split(path.sep).join('/');
            sourceFiles.push({ path: relPath, size: stat.size, mtime: stat.mtimeMs });
        }

        if (!existing) {
            console.log('No saved index found. Building new index...');
            existing = await buildIndex(dataRoot);
            currentIndex = existing;
            return currentIndex;
        }

        const diff = getIndexDiff(existing, sourceFiles);
        if (diff.needsFullRebuild) {
            console.log('[RAG] Index rebuild needed. Building new index...');
            existing = await buildIndex(dataRoot);
            currentIndex = existing;
            return currentIndex;
        }

        // Incremental update: only embed chunks from changed/new files.
        console.log(`[RAG] Incremental index update: ${diff.toAddOrUpdate.length} files to add/update, ${diff.toRemove.length} files to remove`);

        // Remove chunks belonging to deleted sources.
        filterChunksByRemovedSources(existing, diff.toRemove);

        if (diff.toAddOrUpdate.length === 0) {
            console.log('Loaded cached RAG index with', existing.chunks?.length || 0, 'chunks');
            currentIndex = existing;
            return currentIndex;
        }

        // Re-chunk + embed only the changed/new source files.
        const newChunks = [];
        for (const relPath of diff.toAddOrUpdate) {
            const fullPath = path.join(dataRoot, relPath);
            try {
                const content = await fs.readFile(fullPath, 'utf8');
                const parsed = JSON.parse(content);
                if (relPath.startsWith('datasets/')) {
                    newChunks.push(...chunkDatasetFile(relPath, parsed));
                } else if (relPath.startsWith('authors/')) {
                    newChunks.push(...chunkAuthorFile(relPath, parsed));
                }
            } catch (e) {
                console.warn(`[RAG] Failed to process changed source file ${relPath}:`, e?.message ?? e);
            }
        }

        const texts = newChunks.map((c) => c.text);
        if (texts.length) {
            console.log(`[RAG] Embedding ${texts.length} new/updated chunks...`);
            const embeddings = await computeEmbeddings(texts);
            const embeddedNewChunks = newChunks.map((chunk, idx) => ({ ...chunk, embedding: embeddings[idx] }));
            mergeIndexChunks(existing, embeddedNewChunks);
        } else {
            console.log('[RAG] No new chunks produced from changed sources. Skipping embedding.');
        }

        // Refresh sourceFiles + datasetNames metadata for the updated index.
        existing.sourceFiles = sourceFiles;
        existing.vectorCacheVersion = VECTOR_CACHE_VERSION;
        existing.embeddingMode = EMBEDDING_MODE;
        existing.embeddingModel = getEmbeddingModelName();

        await fs.writeFile(INDEX_FILE, JSON.stringify(existing, null, 2) + '\n', 'utf8');
        console.log('Incremental index saved to:', INDEX_FILE);

        currentIndex = existing;
        return currentIndex;
    })();
    return indexBuildPromise;
}

async function selectTopChunksByEmbedding(query, queryEmbedding, selectedDataset, topK) {
    // Use embedding-based cosine similarity only (no keyword/hybrid scoring).
    const { retrieveTopKByCosine } = await import('./vector_index.js');
    const results = await retrieveTopKByCosine(queryEmbedding, { topK, selectedDataset });

    // Keep return shape compatible with existing downstream code:
    // { chunk, similarity, score }
    return results.map((r) => ({
        chunk: r.chunk,
        similarity: r.similarity,
        score: r.similarity
    }));
}

// Backward-compatible alias because other parts of the router still call selectTopChunks.
async function selectTopChunks(query, queryEmbedding, selectedDataset, topK) {
    return selectTopChunksByEmbedding(query, queryEmbedding, selectedDataset, topK);
}



function textLinesForAnswer(text) {
    return String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^(title|author|page|vachana|language):/i.test(line));
}

function cleanAnswerLine(line) {
    return String(line || '')
        .replace(/^(translation|english|kannada|transliteration|hindi|sanskrit|tamil|telugu):\s*/i, '')
        .trim();
}

function buildExtractiveAnswer(query, matched) {
    if (!matched.length) return 'The information is not available in the selected dataset.';

    const queryTokens = new Set(tokenizeForHybrid(query).filter((token) => token.length > 2));
    const bestLines = [];

    for (const item of matched.slice(0, 3)) {
        const lines = textLinesForAnswer(item.chunk.text);
        const scoredLines = lines
            .map((line) => {
                const lineTokens = tokenizeForHybrid(line);
                const overlap = lineTokens.filter((token) => queryTokens.has(token)).length;
                return { line, overlap };
            })
            .sort((a, b) => b.overlap - a.overlap);

        const selected = cleanAnswerLine((scoredLines.find((line) => line.overlap > 0) || scoredLines[0])?.line);
        if (selected) bestLines.push(`${selected} [${bestLines.length + 1}]`);
    }

    if (bestLines.length === 0) return 'The information is not available in the selected dataset.';

    return [
        'From the selected dataset context:',
        '',
        bestLines.join('\n\n'),
        '',
        'References',
        ...matched.slice(0, bestLines.length).map((item, index) => {
            const page = item.chunk.page ?? 'N/A';
            const vachana = item.chunk.vachanaNumber ?? 'N/A';
            return `[${index + 1}] ${item.chunk.dataset}, Page ${page}, Vachana ${vachana}`;
        })
    ].join('\n');
}

function buildPrompt(query, chunks, answerMode) {
    const citations = chunks
        .map((candidate, index) => {
            const chunk = candidate.chunk;
            const citationId = index + 1;
            const metadata = formatMetadata(chunk);
            return [`[${citationId}] Dataset: ${chunk.dataset}`, `Page: ${chunk.page ?? 'N/A'}`, `Vachana: ${chunk.vachanaNumber ?? 'N/A'}`, `Author: ${chunk.author ?? 'Unknown'}`, metadata ? `${metadata}` : '', '', chunk.text].filter(Boolean).join('\n');
        })
        .join('\n\n---\n\n');

    const topInstructions = [
        'You are VeerShaivAI.',
        'Answer ONLY from the supplied context.',
        'Never use outside knowledge.',
        'Never hallucinate.',
        "If answer is unavailable reply exactly: \"I could not find this information in the selected dataset.\"",
        'Write naturally like ChatGPT.',
        'Explain concepts clearly.',
        'Quote verses when appropriate.',
        'Always provide references (use the provided bracket ids like [1], [2], etc).',
        'Return markdown.'
    ].join(' ');


    const answerStyle = answerMode === 'concise' ? 'Use a concise answer.' : 'Use a detailed answer that remains grounded in the context.';

    return `${topInstructions}

CONTEXT:
${citations}

QUESTION:
${query}

${answerStyle}

If you cannot answer from the context, say exactly: The information is not available in the selected dataset.`;
}

async function generateAnswerFromLLM(prompt) {
    // Only replace the *answer generation* step.
    // Retrieval + context building remain unchanged.
    const { generateGeminiMarkdown } = await import('./gemini_service.js');
    const markdown = await generateGeminiMarkdown({
        prompt,
        model: process.env.GEMINI_MODEL || 'models/gemini-flash-latest'
    });

    return String(markdown || '').trim();
}



export function attachRagRoutes(app, { publicRoot }) {
    const dataRoot = path.join(publicRoot, 'data');
    console.log('RAG routes initialized with publicRoot:', publicRoot);
    console.log('Data root path:', dataRoot);

    app.get('/api/rag/status', async (_req, res) => {
        try {
            await ensureIndex(dataRoot);
            res.json({
                ok: true,
                ready: true,
                datasetCount: currentIndex.datasetNames.length,
                chunkCount: currentIndex.chunks.length,
                embeddingMode: currentIndex.embeddingMode,
                embeddingModel: currentIndex.embeddingModel,
                embeddingDimension: currentIndex.embeddingDimension,
                llmProvider: LLM_PROVIDER,
                llmModel: LLM_PROVIDER === 'ollama' ? OLLAMA_MODEL : OPENAI_MODEL
            });
        } catch (error) {
            res.status(500).json({ ok: false, error: String(error) });
        }
    });

    app.get('/api/rag/datasets', async (_req, res) => {
        try {
            await ensureIndex(dataRoot);
            res.json({ ok: true, datasets: currentIndex.datasetNames });
        } catch (error) {
            res.status(500).json({ ok: false, error: String(error) });
        }
    });

    app.post('/api/rag/query/stream', async (req, res) => {
        try {
            await ensureIndex(dataRoot);
            const { query, selectedDataset = '__ALL__', topK = 10, answerMode = 'detailed', includeConversationMemory = false, conversationHistory = [] } = req.body ?? {};

            if (!query || typeof query !== 'string') {
                return res.status(400).json({ ok: false, error: 'Query text is required.' });
            }

            const queryText = String(query).trim();
            if (queryText.length === 0) {
                return res.status(400).json({ ok: false, error: 'Query text cannot be empty.' });
            }

            const provider = await getEmbeddingProvider();
            const queryEmbedding = await provider(queryText);

            const matched = await selectTopChunks(queryText, queryEmbedding, selectedDataset, Math.min(MAX_TOP_CHUNKS, Number(topK) || MAX_TOP_CHUNKS));

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive'
            });

            const send = (event, data) => {
                if (event) res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            if (matched.length === 0) {
                send('token', '');
                send('done', {
                    answer: 'The information is not available in the selected dataset.',
                    sources: [],
                    confidence: 0,
                    retrievedChunks: [],
                    prompt: ''
                });
                return res.end();
            }

            const prompt = buildPrompt(queryText, matched, answerMode);
            const sources = matched.map((item) => ({
                id: item.chunk.id,
                dataset: item.chunk.dataset,
                page: item.chunk.page,
                vachanaNumber: item.chunk.vachanaNumber,
                author: item.chunk.author,
                title: item.chunk.title,
                language: item.chunk.language,
                score: Math.round(item.score * 100) / 100,
                excerpt: item.chunk.text.length > 220 ? `${item.chunk.text.slice(0, 220)}…` : item.chunk.text
            }));

            const confidence = Math.round(Math.min(1, matched[0].score) * 100);
            const controller = new AbortController();

            req.on('close', () => {
                try {
                    controller.abort();
                } catch {
                    // ignore
                }
            });

            let fullAnswer = '';

            console.log('[RAG/stream] Before import streamGeminiMarkdown');
            const { streamGeminiMarkdown } = await import('./gemini_service.js');
            console.log('[RAG/stream] Imported streamGeminiMarkdown. Starting Gemini stream... prompt length:', String(prompt).length);

            try {
                await streamGeminiMarkdown({
                    prompt,
                    model: process.env.GEMINI_MODEL || 'models/gemini-flash-latest',
                    signal: controller.signal,
                    onToken: (token) => {
                        if (!token) return;
                        if (fullAnswer.length === 0) console.log('[RAG/stream] First token received');
                        fullAnswer += token;
                        send('token', token);
                    }
                });
                console.log('[RAG/stream] Gemini stream finished. fullAnswer length:', fullAnswer.length);

                send('done', {
                    ok: true,
                    answer: fullAnswer.trim(),
                    sources,
                    confidence,
                    retrievedChunks: matched.map((item) => ({
                        id: item.chunk.id,
                        dataset: item.chunk.dataset,
                        page: item.chunk.page,
                        vachanaNumber: item.chunk.vachanaNumber,
                        author: item.chunk.author,
                        title: item.chunk.title,
                        language: item.chunk.language,
                        text: item.chunk.text
                    })),
                    prompt
                });
            } catch (e) {
                // Make sure the SSE request is not left pending forever.
                const message = e?.message ?? String(e);
                const errObj = (() => {
                    try {
                        return JSON.parse(message);
                    } catch {
                        return null;
                    }
                })();

                console.error('[RAG/stream] Gemini stream failed:', message);
                if (errObj?.code || errObj?.status) {
                    console.error('[RAG/stream] Gemini error meta:', {
                        code: errObj?.code,
                        status: errObj?.status,
                        errorMessage: errObj?.error?.message
                    });
                }

                try {
                    send('error', message);
                } catch {
                    // ignore
                }

                // Also send done with partial answer (best-effort) so the client can recover.
                try {
                    send('done', {
                        ok: false,
                        answer: fullAnswer.trim(),
                        sources,
                        confidence,
                        retrievedChunks: matched.map((item) => ({
                            id: item.chunk.id,
                            dataset: item.chunk.dataset,
                            page: item.chunk.page,
                            vachanaNumber: item.chunk.vachanaNumber,
                            author: item.chunk.author,
                            title: item.chunk.title,
                            language: item.chunk.language,
                            text: item.chunk.text
                        })),
                        prompt,
                        error: message
                    });
                } catch {
                    // ignore
                }
            } finally {
                console.log('[RAG/stream] About to res.end() (fullAnswer length:', fullAnswer.length, ')');
            }


            res.end();
        } catch (error) {
            // If streaming already started, try to emit SSE error events and ensure the response ends.
            try {
                if (res.headersSent) {
                    try {
                        res.write(`event: error\n`);
                        res.write(`data: ${JSON.stringify(String(error))}\n\n`);
                    } catch {
                        // ignore
                    }

                    try {
                        res.write(`event: done\n`);
                        res.write(`data: ${JSON.stringify({ ok: false, answer: '', error: String(error) })}\n\n`);
                    } catch {
                        // ignore
                    }

                    try {
                        res.end();
                    } catch {
                        // ignore
                    }
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: String(error) }));
                }
            } catch {
                // ignore
            }
        }
    });

    app.post('/api/rag/query', async (req, res) => {
        try {
            await ensureIndex(dataRoot);
            const { query, selectedDataset = '__ALL__', topK = 10, answerMode = 'detailed', includeConversationMemory = false, conversationHistory = [] } = req.body ?? {};


            if (!query || typeof query !== 'string') {
                return res.status(400).json({ ok: false, error: 'Query text is required.' });
            }

            const queryText = String(query).trim();
            if (queryText.length === 0) {
                return res.status(400).json({ ok: false, error: 'Query text cannot be empty.' });
            }

            const provider = await getEmbeddingProvider();
            const queryEmbedding = await provider(queryText);

            const matched = await selectTopChunks(queryText, queryEmbedding, selectedDataset, Math.min(MAX_TOP_CHUNKS, Number(topK) || MAX_TOP_CHUNKS));

            // Build prompt + answer (non-streaming) remains as-is for compatibility.


            if (matched.length === 0) {
                return res.json({
                    ok: true,
                    answer: 'The information is not available in the selected dataset.',
                    sources: [],
                    confidence: 0,
                    retrievedChunks: [],
                    prompt: ''
                });
            }

            const prompt = buildPrompt(queryText, matched, answerMode);
            let answerText = '';
            try {
                answerText = await generateAnswerFromLLM(prompt);
            } catch (llmError) {
                console.warn('Gemini answer generation failed; falling back to extractive answer:', llmError?.message ?? llmError);
            }
            if (!answerText) {
                answerText = buildExtractiveAnswer(queryText, matched);
            }


            const sources = matched.map((item, index) => ({
                id: item.chunk.id,
                dataset: item.chunk.dataset,
                page: item.chunk.page,
                vachanaNumber: item.chunk.vachanaNumber,
                author: item.chunk.author,
                title: item.chunk.title,
                language: item.chunk.language,
                score: Math.round(item.score * 100) / 100,
                excerpt: item.chunk.text.length > 220 ? `${item.chunk.text.slice(0, 220)}…` : item.chunk.text
            }));

            const confidence = Math.round(Math.min(1, matched[0].score) * 100);

            return res.json({
                ok: true, answer: answerText, sources, confidence, retrievedChunks: matched.map((item) => ({
                    id: item.chunk.id,
                    dataset: item.chunk.dataset,
                    page: item.chunk.page,
                    vachanaNumber: item.chunk.vachanaNumber,
                    author: item.chunk.author,
                    title: item.chunk.title,
                    language: item.chunk.language,
                    text: item.chunk.text
                })), prompt
            });
        } catch (error) {
            res.status(500).json({ ok: false, error: String(error) });
        }
    });

    ensureIndex(dataRoot).catch((error) => {
        console.warn('RAG index could not be loaded at startup.', error?.message ?? error);
    });
}
