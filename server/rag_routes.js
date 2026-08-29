/**
 * RAG Routes - Thin route handlers only.
 * All business logic is delegated to rag_engine.js and index_manager.js.
 */

import path from 'node:path';
import { ensureIndex, getCurrentIndex, getEmbeddingModelName, getEmbeddingDimension, getEmbeddingFilePath } from './index_manager.js';
import { query, queryStream, clearEmbeddingCache } from './rag_engine.js';
import { getCurrentEmbeddingStore } from './index_manager.js';
import { uploadIndexFiles } from './supabase_storage.js';
import { getLLMInfo, validateLLMConfig } from './llm/index.js';
import { withRequestLogs, getRequestLogs, createRequestLogId } from './request_logs.js';

const DEBUG = process.env.RAG_DEBUG === '1';
function debugLog(...args) { if (DEBUG) console.log('[RAG/DEBUG]', ...args); }

export function attachRagRoutes(app, { publicRoot }) {
    const dataRoot = path.join(publicRoot, 'data');
    console.log('[RAG Routes] Initialized. Data root:', dataRoot);
    console.log('[RAG Routes] Embedding: Google gemini-embedding-001 (768-dim)');
    validateLLMConfig();
    const llmInfo = getLLMInfo();
    console.log('[RAG Routes] LLM provider mode: ' + llmInfo.mode + ' | primary: ' + llmInfo.primaryProvider + ' | model: ' + llmInfo.primaryModel);

    app.get('/api/rag/status', async (_req, res) => {
        try {
            await ensureIndex(dataRoot);
            const index = getCurrentIndex(); const llm = getLLMInfo();
            res.json({ ok: true, ready: true, datasetCount: index?.datasetNames?.length || 0, chunkCount: index?.chunks?.length || 0,
                embeddingModel: getEmbeddingModelName(), embeddingDimension: getEmbeddingDimension(), llmProvider: llm.primaryProvider || 'none',
                llmModel: llm.primaryModel, llmMode: llm.mode, llmChain: llm.chain, embeddingStorage: 'Float32 binary',
                embeddingFilePath: getEmbeddingFilePath(), embeddingsLoaded: getCurrentEmbeddingStore() ? getCurrentEmbeddingStore().isLoaded() : false,
                embedStorageBytes: getCurrentEmbeddingStore() ? getCurrentEmbeddingStore().getMemoryBytes() : 0, debugMode: DEBUG });
        } catch (error) { res.status(500).json({ ok: false, error: String(error) }); }
    });

    app.get('/api/rag/datasets', async (_req, res) => {
        try {
            await ensureIndex(dataRoot); const index = getCurrentIndex(); const datasets = index?.datasetNames || [];
            try {
                const fs = await import('node:fs/promises'); const pathMod = await import('node:path'); const found = [];
                async function scanDir(dir) { let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
                    for (const entry of entries) { const full = pathMod.join(dir, entry.name); if (entry.isDirectory()) await scanDir(full); else if (entry.isFile()) {
                        const lower = entry.name.toLowerCase(); if (lower.endsWith('.json') || lower.endsWith('.pdf') || lower.endsWith('.txt')) found.push(pathMod.relative(dataRoot, full).split(pathMod.sep).join('/'));
                    }} }
                await scanDir(dataRoot); const fresh = found.filter(Boolean).sort(); if (fresh.length > 0) return res.json({ ok: true, datasets: fresh });
            } catch { /* cached list */ }
            res.json({ ok: true, datasets: datasets || [] });
        } catch (error) {
            try {
                const fs = await import('node:fs/promises'); const pathMod = await import('node:path'); const datasets = [];
                async function scanDirFor(base, dir, ext) { let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
                    for (const entry of entries) { const full = pathMod.join(dir, entry.name); if (entry.isDirectory()) await scanDirFor(base, full, ext); else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) datasets.push(pathMod.relative(base, full).split(pathMod.sep).join('/')); }}
                await scanDirFor(dataRoot, dataRoot, '.json'); await scanDirFor(dataRoot, dataRoot, '.pdf'); await scanDirFor(dataRoot, dataRoot, '.txt');
                res.json({ ok: true, datasets: datasets.sort() });
            } catch { res.status(500).json({ ok: false, error: String(error) }); }
        }
    });

    app.post('/api/rag/query/stream', async (req, res) => {
        const requestLogId = createRequestLogId();
        let capturedLogs = [];
        let send = null;
        try {
            await ensureIndex(dataRoot);
            const { query: queryText, selectedDataset = '__ALL__', selectedDatasets, topK = 10, answerMode = 'detailed', includeConversationMemory = false, conversationHistory = [] } = req.body ?? {};
            if (!queryText || typeof queryText !== 'string') return res.status(400).json({ ok: false, error: 'Query text is required.' });
            const trimmedQuery = queryText.trim();
            if (!trimmedQuery) return res.status(400).json({ ok: false, error: 'Query text cannot be empty.' });
            const datasetSelection = Array.isArray(selectedDatasets) && selectedDatasets.length > 0 ? selectedDatasets.filter(p => p && typeof p === 'string').map(p => p.trim()) : null;

            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
            send = (event, data) => { try { if (event) res.write('event: ' + event + '\n'); res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch { /* disconnected */ } };
            const controller = new AbortController(); req.on('close', () => { try { controller.abort(); } catch {} });
            const startTime = Date.now(); let fullAnswer = ''; let result;

            const execution = await withRequestLogs(requestLogId, async () => {
                console.log('[RAG Request] Question:', trimmedQuery);
                console.log('[RAG Request] Dataset:', datasetSelection || selectedDataset, '| topK:', topK, '| answerMode:', answerMode);
                return queryStream(trimmedQuery, selectedDataset, Math.min(25, Number(topK) || 10), answerMode, includeConversationMemory, conversationHistory,
                    { onToken: (token) => { if (!token) return; fullAnswer += token; send('token', token); }, signal: controller.signal }, datasetSelection);
            });
            result = execution.result; capturedLogs = getRequestLogs(execution.state);
            debugLog('Stream completed in ' + (Date.now() - startTime) + 'ms');
            debugLog('Answer length: ' + fullAnswer.length + ', Sources: ' + (result.sources?.length || 0));
            if (controller.signal.aborted) return;
            send('done', { ok: true, answer: (result?.answer || fullAnswer || '').trim(), sources: result?.sources || [], confidence: result?.confidence || 0,
                retrievedChunks: result?.retrievedChunks || [], prompt: result?.prompt || '', requestLogId, logs: capturedLogs });
        } catch (error) {
            capturedLogs = getRequestLogs(error?.requestLogState);
            const message = error instanceof Error ? error.message : String(error);
            console.error('[RAG Routes] Stream error:', message);
            if (send) {
                send('error', message);
                send('done', { ok: false, answer: '', sources: [], confidence: 0, retrievedChunks: [], prompt: '', error: message, requestLogId, logs: capturedLogs });
            } else if (!res.headersSent) res.status(500).json({ ok: false, error: message, requestLogId, logs: capturedLogs });
        } finally { try { res.end(); } catch {} }
    });

    app.post('/api/rag/query', async (req, res) => {
        try {
            await ensureIndex(dataRoot);
            const { query: queryText, selectedDataset = '__ALL__', selectedDatasets, topK = 10, answerMode = 'detailed', includeConversationMemory = false, conversationHistory = [] } = req.body ?? {};
            if (!queryText || typeof queryText !== 'string') return res.status(400).json({ ok: false, error: 'Query text is required.' });
            const trimmedQuery = queryText.trim(); if (!trimmedQuery) return res.status(400).json({ ok: false, error: 'Query text cannot be empty.' });
            const datasetSelection = Array.isArray(selectedDatasets) && selectedDatasets.length > 0 ? selectedDatasets.filter(p => p && typeof p === 'string').map(p => p.trim()) : null;
            const result = await query(trimmedQuery, selectedDataset, Math.min(25, Number(topK) || 10), answerMode, includeConversationMemory, conversationHistory, datasetSelection);
            return res.json({ ok: true, answer: result.answer, sources: result.sources, confidence: result.confidence, retrievedChunks: result.retrievedChunks, prompt: result.prompt });
        } catch (error) { res.status(500).json({ ok: false, error: String(error) }); }
    });

    app.post('/api/rag/clear-cache', async (_req, res) => { try { clearEmbeddingCache(); res.json({ ok: true, message: 'Embedding cache cleared' }); } catch (error) { res.status(500).json({ ok: false, error: String(error) }); } });
    app.post('/api/rag/index/upload', async (_req, res) => {
        try { const result = await uploadIndexFiles(); if (result.ok) return res.json({ ok: true, message: 'Index uploaded to Supabase Storage', bucket: result.bucket, prefix: result.prefix || '(root)', details: result.results });
            res.status(result.reason === 'supabase_disabled' ? 400 : 500).json({ ok: false, error: result.reason || 'Upload failed', details: result });
        } catch (error) { res.status(500).json({ ok: false, error: String(error) }); }
    });

    if (process.env.RAG_WARM_INDEX === '1') ensureIndex(dataRoot).then(() => console.log('[RAG Routes] Index warmed: ' + (getCurrentIndex()?.chunks?.length || 0) + ' chunks')).catch(error => console.warn('[RAG Routes] Index warmup failed:', error.message));
    else console.log('[RAG Routes] Startup index warmup skipped (set RAG_WARM_INDEX=1 to enable). Index will be built on first query.');
}
