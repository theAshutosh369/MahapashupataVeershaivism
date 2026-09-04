/**
 * RAG Routes - Thin route handlers only.
 * All business logic is delegated to rag_engine.js and index_manager.js.
 * ONLY Google Gemini is used (no Ollama, no OpenAI).
 */

import path from 'node:path';
import { ensureIndex, getCurrentIndex, getEmbeddingModelName, getEmbeddingDimension, getEmbeddingFilePath } from './index_manager.js';
import { query, queryStream, clearEmbeddingCache } from './rag_engine.js';
import { getCurrentEmbeddingStore } from './index_manager.js';

const DEBUG = process.env.RAG_DEBUG === '1';

function debugLog(...args) {
    if (DEBUG) console.log('[RAG/DEBUG]', ...args);
}

export function attachRagRoutes(app, { publicRoot }) {
    const dataRoot = path.join(publicRoot, 'data');
    console.log('[RAG Routes] Initialized. Data root:', dataRoot);
    console.log('[RAG Routes] Embedding: Google gemini-embedding-001 (768-dim) | LLM: Google gemini-flash-latest');

    /**
     * GET /api/rag/status - Health check and index status
     */
    app.get('/api/rag/status', async (_req, res) => {
        try {
            await ensureIndex(dataRoot);
            const index = getCurrentIndex();
            res.json({
                ok: true,
                ready: true,
                datasetCount: index?.datasetNames?.length || 0,
                chunkCount: index?.chunks?.length || 0,
                embeddingModel: getEmbeddingModelName(),
                embeddingDimension: getEmbeddingDimension(),
                llmProvider: 'gemini',
                llmModel: process.env.GEMINI_MODEL || 'models/gemini-flash-latest',
                embeddingStorage: 'Float32 binary',
                embeddingFilePath: getEmbeddingFilePath(),
                embeddingsLoaded: getCurrentEmbeddingStore() ? getCurrentEmbeddingStore().isLoaded() : false,
                embedStorageBytes: getCurrentEmbeddingStore() ? getCurrentEmbeddingStore().getMemoryBytes() : 0,
                debugMode: DEBUG
            });
        } catch (error) {
            res.status(500).json({ ok: false, error: String(error) });
        }
    });

    /**
     * GET /api/rag/datasets - List available datasets
     */
    app.get('/api/rag/datasets', async (_req, res) => {
        try {
            await ensureIndex(dataRoot);
            const index = getCurrentIndex();
            res.json({ ok: true, datasets: index?.datasetNames || [] });
        } catch (error) {
            // Fallback: scan filesystem for datasets (JSON + PDF)
            try {
                const fs = await import('node:fs/promises');
                const pathMod = await import('node:path');
                const datasets = [];

                // Recursively scan a directory for files with a given extension,
                // returning them relative to `base` (prefixed for the UI).
                async function scanDirFor(base, dir, ext) {
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    } catch { /* ignore missing dir */ return; }
                    for (const entry of entries) {
                        const full = pathMod.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            await scanDirFor(base, full, ext);
                        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
                            datasets.push(pathMod.relative(base, full).split(pathMod.sep).join('/'));
                        }
                    }
                }

                await scanDirFor(dataRoot, path.join(dataRoot, 'datasets'), '.json');
                await scanDirFor(dataRoot, path.join(dataRoot, 'authors'), '.json');
                await scanDirFor(dataRoot, dataRoot, '.pdf');
                await scanDirFor(dataRoot, dataRoot, '.txt');

                res.json({ ok: true, datasets: datasets.sort() });
            } catch {
                res.status(500).json({ ok: false, error: String(error) });
            }
        }
    });

    /**
     * POST /api/rag/query/stream - Streaming query endpoint (SSE)
     */
    app.post('/api/rag/query/stream', async (req, res) => {
        try {
            await ensureIndex(dataRoot);
            const {
                query: queryText,
                selectedDataset = '__ALL__',
                topK = 10,
                answerMode = 'detailed',
                includeConversationMemory = false,
                conversationHistory = []
            } = req.body ?? {};

            if (!queryText || typeof queryText !== 'string') {
                return res.status(400).json({ ok: false, error: 'Query text is required.' });
            }

            const trimmedQuery = queryText.trim();
            if (trimmedQuery.length === 0) {
                return res.status(400).json({ ok: false, error: 'Query text cannot be empty.' });
            }

            debugLog('Query:', trimmedQuery.substring(0, 200));
            debugLog('Dataset:', selectedDataset, 'topK:', topK, 'mode:', answerMode);

            // Set up SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive'
            });

            const send = (event, data) => {
                try {
                    if (event) res.write('event: ' + event + '\n');
                    res.write('data: ' + JSON.stringify(data) + '\n\n');
                } catch { /* ignore if client disconnected */ }
            };

            const controller = new AbortController();
            req.on('close', () => {
                try { controller.abort(); } catch { /* ignore */ }
            });

            const startTime = Date.now();

            let fullAnswer = '';
            let result;

            try {
                result = await queryStream(
                    trimmedQuery,
                    selectedDataset,
                    Math.min(25, Number(topK) || 10),
                    answerMode,
                    includeConversationMemory,
                    conversationHistory,
                    {
                        onToken: (token) => {
                            if (!token) return;
                            fullAnswer += token;
                            send('token', token);
                        },
                        signal: controller.signal
                    }
                );

                const elapsed = Date.now() - startTime;
                debugLog('Stream completed in ' + elapsed + 'ms');
                debugLog('Answer length: ' + fullAnswer.length + ', Sources: ' + (result.sources?.length || 0));

                if (controller.signal.aborted) {
                    debugLog('Stream was aborted by client');
                    return;
                }

                send('done', {
                    ok: true,
                    answer: (result?.answer || fullAnswer || '').trim(),
                    sources: result?.sources || [],
                    confidence: result?.confidence || 0,
                    retrievedChunks: result?.retrievedChunks || [],
                    prompt: result?.prompt || ''
                });
            } catch (error) {
                console.error('[RAG Routes] Stream error:', error.message);
                try {
                    send('error', error.message);
                    send('done', {
                        ok: false,
                        answer: fullAnswer.trim() || 'I could not find this information in the selected dataset.',
                        sources: result?.sources || [],
                        confidence: 0,
                        retrievedChunks: result?.retrievedChunks || [],
                        prompt: result?.prompt || '',
                        error: error.message
                    });
                } catch { /* ignore */ }
            } finally {
                try { res.end(); } catch { /* ignore */ }
            }
        } catch (error) {
            try {
                if (res.headersSent) {
                    try {
                        res.write('event: error\ndata: ' + JSON.stringify(String(error)) + '\n\n');
                        res.write('event: done\ndata: ' + JSON.stringify({ ok: false, answer: '', error: String(error) }) + '\n\n');
                    } catch { /* ignore */ }
                    try { res.end(); } catch { /* ignore */ }
                } else {
                    res.status(500).json({ ok: false, error: String(error) });
                }
            } catch { /* ignore */ }
        }
    });

    /**
     * POST /api/rag/query - Non-streaming query endpoint
     */
    app.post('/api/rag/query', async (req, res) => {
        try {
            await ensureIndex(dataRoot);
            const {
                query: queryText,
                selectedDataset = '__ALL__',
                topK = 10,
                answerMode = 'detailed',
                includeConversationMemory = false,
                conversationHistory = []
            } = req.body ?? {};

            if (!queryText || typeof queryText !== 'string') {
                return res.status(400).json({ ok: false, error: 'Query text is required.' });
            }

            const trimmedQuery = queryText.trim();
            if (trimmedQuery.length === 0) {
                return res.status(400).json({ ok: false, error: 'Query text cannot be empty.' });
            }

            debugLog('Query:', trimmedQuery.substring(0, 200));

            const startTime = Date.now();
            const result = await query(
                trimmedQuery,
                selectedDataset,
                Math.min(25, Number(topK) || 10),
                answerMode,
                includeConversationMemory,
                conversationHistory
            );

            const elapsed = Date.now() - startTime;
            debugLog('Non-stream query completed in ' + elapsed + 'ms');

            return res.json({
                ok: true,
                answer: result.answer,
                sources: result.sources,
                confidence: result.confidence,
                retrievedChunks: result.retrievedChunks,
                prompt: result.prompt
            });
        } catch (error) {
            res.status(500).json({ ok: false, error: String(error) });
        }
    });

    /**
     * POST /api/rag/clear-cache - Admin: clear embedding cache
     */
    app.post('/api/rag/clear-cache', async (_req, res) => {
        try {
            clearEmbeddingCache();
            res.json({ ok: true, message: 'Embedding cache cleared' });
        } catch (error) {
            res.status(500).json({ ok: false, error: String(error) });
        }
    });

    // Warm index on startup if RAG_WARM_INDEX=1
    if (process.env.RAG_WARM_INDEX === '1') {
        console.log('[RAG Routes] Warming index on startup...');
        ensureIndex(dataRoot).then(() => {
            const index = getCurrentIndex();
            console.log('[RAG Routes] Index warmed: ' + (index?.chunks?.length || 0) + ' chunks');
        }).catch(error => {
            console.warn('[RAG Routes] Index warmup failed:', error.message);
        });
    } else {
        console.log('[RAG Routes] Startup index warmup skipped (set RAG_WARM_INDEX=1 to enable). Index will be built on first query.');
    }
}
