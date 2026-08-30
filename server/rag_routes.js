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
import { validateGrounding, extractCitedSources } from './accuracy_guard.js';
import { makeAnswerCacheKey, getCachedAnswer, setCachedAnswer, clearAnswerCache, getPerformanceCacheStats } from './performance_cache.js';

const DEBUG = process.env.RAG_DEBUG === '1';
function debugLog(...args) { if (DEBUG) console.log('[RAG/DEBUG]', ...args); }

const NO_DATASET_ANSWER = 'I could not find this information in the selected dataset.';

function applyAccuracy(answer, retrievedChunks, retrievalConfidence) {
    const matched = Array.isArray(retrievedChunks) ? retrievedChunks.map(chunk => ({ chunk })) : [];
    const validation = validateGrounding(answer, matched);
    const retrieval = Math.max(0, Math.min(100, Number(retrievalConfidence) || 0));
    const grounding = Math.max(0, Math.min(100, Number(validation.confidence) || 0));
    const confidence = Math.round(retrieval * 0.45 + grounding * 0.55);
    const citedSources = extractCitedSources(answer, matched);

    return {
        ...validation,
        confidence,
        citedSources,
        citationCount: citedSources.length
    };
}

function cacheKeyForRequest({ queryText, selectedDataset, datasetSelection, topK, answerMode, includeConversationMemory }) {
    return makeAnswerCacheKey({
        query: queryText,
        selectedDataset,
        datasetSelection,
        topK,
        answerMode,
        includeConversationMemory
    });
}

function sendCachedStream(send, cached, requestLogId) {
    const answer = String(cached?.answer || '');
    // Emit the cached answer in small chunks so the existing chat UI receives
    // exactly the same token events it expects from a live stream.
    const chunkSize = 256;
    for (let i = 0; i < answer.length; i += chunkSize) {
        send('token', answer.slice(i, i + chunkSize));
    }
    send('accuracy', { requestLogId, ...(cached.accuracy || {}) });
    send('done', { ...(cached.done || {}), requestLogId, cacheHit: true });
}

export function attachRagRoutes(app, { publicRoot }) {
    const dataRoot = path.join(publicRoot, 'data');
    console.log('[RAG Routes] Initialized. Data root:', dataRoot);
    console.log('[RAG Routes] Embedding: Google gemini-embedding-001 (768-dim)');
    console.log('[RAG Routes] Phase 3: bounded answer cache + existing query-embedding cache + lazy shard retrieval');
    validateLLMConfig();
    const llmInfo = getLLMInfo();
    console.log('[RAG Routes] LLM provider mode: ' + llmInfo.mode + ' | primary: ' + llmInfo.primaryProvider + ' | model: ' + llmInfo.primaryModel);

    app.get('/api/rag/status', async (_req, res) => {
        try {
            await ensureIndex(dataRoot);
            const index = getCurrentIndex(); const llm = getLLMInfo();
            res.json({ ok: true, ready: true, datasetCount: index?.datasetNames?.length || 0, chunkCount: index?.chunks?.length || index?.chunkCount || 0,
                embeddingModel: getEmbeddingModelName(), embeddingDimension: getEmbeddingDimension(), llmProvider: llm.primaryProvider || 'none',
                llmModel: llm.primaryModel, llmMode: llm.mode, llmChain: llm.chain, embeddingStorage: 'Float32 binary',
                embeddingFilePath: getEmbeddingFilePath(), embeddingsLoaded: getCurrentEmbeddingStore() ? getCurrentEmbeddingStore().isLoaded() : false,
                embedStorageBytes: getCurrentEmbeddingStore() ? getCurrentEmbeddingStore().getMemoryBytes() : 0, debugMode: DEBUG,
                performanceCache: getPerformanceCacheStats() });
        } catch (error) { res.status(500).json({ ok: false, error: String(error) }); }
    });

    app.get('/api/rag/datasets', async (_req, res) => {
        // Dataset discovery must not wait for the RAG index. On a deployment,
        // the public/data tree can be readable even when the prebuilt index is
        // still loading, unavailable, or being rebuilt. Scan the source tree
        // first and return immediately when files are found.
        try {
            const fs = await import('node:fs/promises');
            const pathMod = await import('node:path');
            const found = [];

            async function scanDir(dir) {
                let entries;
                try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    const full = pathMod.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await scanDir(full);
                    } else if (entry.isFile()) {
                        const lower = entry.name.toLowerCase();
                        if (lower.endsWith('.json') || lower.endsWith('.pdf') || lower.endsWith('.txt')) {
                            const relative = pathMod.relative(dataRoot, full).split(pathMod.sep).join('/');
                            if (relative && relative !== 'authors.json') found.push(relative);
                        }
                    }
                }
            }

            await scanDir(dataRoot);
            const fresh = found.filter(Boolean).sort((a, b) => a.localeCompare(b));
            if (fresh.length > 0) {
                return res.json({ ok: true, datasets: fresh, source: 'public/data' });
            }

            // Only fall back to the index when the source tree is genuinely
            // empty. This keeps the endpoint useful for unusual deployments
            // where the dataset files are supplied exclusively by the index.
            await ensureIndex(dataRoot);
            const index = getCurrentIndex();
            return res.json({ ok: true, datasets: index?.datasetNames || [], source: 'index' });
        } catch (error) {
            // A catalog request should remain usable even if index initialization
            // fails. Make one final best-effort source scan before returning 500.
            try {
                const fs = await import('node:fs/promises');
                const pathMod = await import('node:path');
                const datasets = [];
                async function scanDirFor(dir) {
                    let entries;
                    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
                    for (const entry of entries) {
                        const full = pathMod.join(dir, entry.name);
                        if (entry.isDirectory()) await scanDirFor(full);
                        else if (entry.isFile()) {
                            const lower = entry.name.toLowerCase();
                            if (lower.endsWith('.json') || lower.endsWith('.pdf') || lower.endsWith('.txt')) {
                                const relative = pathMod.relative(dataRoot, full).split(pathMod.sep).join('/');
                                if (relative && relative !== 'authors.json') datasets.push(relative);
                            }
                        }
                    }
                }
                await scanDirFor(dataRoot);
                return res.json({ ok: true, datasets: datasets.sort((a, b) => a.localeCompare(b)), source: 'public/data-fallback' });
            } catch {
                return res.status(500).json({ ok: false, error: String(error) });
            }
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
            const cacheKey = cacheKeyForRequest({ queryText: trimmedQuery, selectedDataset, datasetSelection, topK: Math.min(25, Number(topK) || 10), answerMode, includeConversationMemory });

            if (cacheKey) {
                const cached = getCachedAnswer(cacheKey);
                if (cached) {
                    console.log('[Performance] Answer cache HIT for query:', trimmedQuery.substring(0, 100));
                    send('log', { requestLogId, timestamp: new Date().toISOString(), level: 'LOG', message: 'Answer cache hit; Gemini generation and retrieval skipped.' });
                    if (!controller.signal.aborted) sendCachedStream(send, cached, requestLogId);
                    return;
                }
                console.log('[Performance] Answer cache MISS for query:', trimmedQuery.substring(0, 100));
            }

            const execution = await withRequestLogs(requestLogId, async () => {
                console.log('[RAG Request] Question:', trimmedQuery);
                console.log('[RAG Request] Dataset:', datasetSelection || selectedDataset, '| topK:', topK, '| answerMode:', answerMode);
                return queryStream(trimmedQuery, selectedDataset, Math.min(25, Number(topK) || 10), answerMode, includeConversationMemory, conversationHistory,
                    { onToken: (token) => { if (!token) return; fullAnswer += token; send('token', token); }, signal: controller.signal }, datasetSelection);
            }, {
                onLog: (entry) => send?.('log', { requestLogId, ...entry })
            });
            result = execution.result; capturedLogs = getRequestLogs(execution.state);
            debugLog('Stream completed in ' + (Date.now() - startTime) + 'ms');
            debugLog('Answer length: ' + fullAnswer.length + ', Sources: ' + (result.sources?.length || 0));
            if (controller.signal.aborted) return;

            const retrievedChunks = result?.retrievedChunks || [];
            const accuracy = applyAccuracy(result?.answer || fullAnswer || '', retrievedChunks, result?.confidence || 0);
            console.log('[RAG Accuracy] Grounded:', accuracy.grounded, '| confidence:', accuracy.confidence + '%', '| citations:', accuracy.citationCount);
            if (accuracy.reasons?.length) console.warn('[RAG Accuracy] ' + accuracy.reasons.join(' | '));
            send('accuracy', { requestLogId, grounded: accuracy.grounded, confidence: accuracy.confidence, citations: accuracy.citations,
                invalidCitations: accuracy.invalidCitations, evidence: accuracy.evidence, paragraphEvidence: accuracy.paragraphEvidence,
                citedSources: accuracy.citedSources, reasons: accuracy.reasons });

            const donePayload = { ok: true, answer: (result?.answer || fullAnswer || '').trim(), sources: result?.sources || [],
                confidence: accuracy.confidence, retrievedChunks, prompt: result?.prompt || '', requestLogId, logs: capturedLogs,
                grounded: accuracy.grounded, citations: accuracy.citations, citedSources: accuracy.citedSources,
                evidence: accuracy.evidence, paragraphEvidence: accuracy.paragraphEvidence, accuracyReasons: accuracy.reasons };

            if (cacheKey && donePayload.answer && donePayload.answer !== NO_DATASET_ANSWER) {
                setCachedAnswer(cacheKey, {
                    answer: donePayload.answer,
                    accuracy: { grounded: accuracy.grounded, confidence: accuracy.confidence, citations: accuracy.citations,
                        invalidCitations: accuracy.invalidCitations, evidence: accuracy.evidence, paragraphEvidence: accuracy.paragraphEvidence,
                        citedSources: accuracy.citedSources, reasons: accuracy.reasons, citationCount: accuracy.citationCount },
                    done: { ...donePayload, requestLogId: undefined, logs: [] }
                });
                console.log('[Performance] Answer cached for future identical requests.');
            }
            send('done', donePayload);
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
            const cacheKey = cacheKeyForRequest({ queryText: trimmedQuery, selectedDataset, datasetSelection, topK: Math.min(25, Number(topK) || 10), answerMode, includeConversationMemory });
            if (cacheKey) {
                const cached = getCachedAnswer(cacheKey);
                if (cached) {
                    console.log('[Performance] Non-stream answer cache HIT for query:', trimmedQuery.substring(0, 100));
                    return res.json({ ok: true, ...(cached.done || {}), requestLogId: undefined, cacheHit: true });
                }
            }

            const result = await query(trimmedQuery, selectedDataset, Math.min(25, Number(topK) || 10), answerMode, includeConversationMemory, conversationHistory, datasetSelection);
            const retrievedChunks = result?.retrievedChunks || [];
            const accuracy = applyAccuracy(result?.answer || '', retrievedChunks, result?.confidence || 0);
            let answer = result?.answer || NO_DATASET_ANSWER;

            if (!accuracy.grounded && accuracy.supportRatio < 0.20 && accuracy.citations.length === 0) answer = NO_DATASET_ANSWER;

            console.log('[RAG Accuracy] Grounded:', accuracy.grounded, '| confidence:', accuracy.confidence + '%', '| citations:', accuracy.citationCount);
            if (accuracy.reasons?.length) console.warn('[RAG Accuracy] ' + accuracy.reasons.join(' | '));

            const payload = { ok: true, answer, sources: result.sources, confidence: accuracy.confidence, retrievedChunks,
                prompt: result.prompt, grounded: accuracy.grounded, citations: accuracy.citations, citedSources: accuracy.citedSources,
                evidence: accuracy.evidence, paragraphEvidence: accuracy.paragraphEvidence, accuracyReasons: accuracy.reasons };
            if (cacheKey && answer && answer !== NO_DATASET_ANSWER) setCachedAnswer(cacheKey, { answer, accuracy, done: payload });
            return res.json(payload);
        } catch (error) { res.status(500).json({ ok: false, error: String(error) }); }
    });

    app.post('/api/rag/clear-cache', async (_req, res) => {
        try { clearEmbeddingCache(); clearAnswerCache(); res.json({ ok: true, message: 'Embedding and answer caches cleared', performanceCache: getPerformanceCacheStats() }); }
        catch (error) { res.status(500).json({ ok: false, error: String(error) }); }
    });

    app.post('/api/rag/index/upload', async (_req, res) => {
        try { const result = await uploadIndexFiles(); if (result.ok) return res.json({ ok: true, message: 'Index uploaded to Supabase Storage', bucket: result.bucket, prefix: result.prefix || '(root)', details: result.results });
            res.status(result.reason === 'supabase_disabled' ? 400 : 500).json({ ok: false, error: result.reason || 'Upload failed', details: result });
        } catch (error) { res.status(500).json({ ok: false, error: String(error) }); }
    });

    if (process.env.RAG_WARM_INDEX === '1') ensureIndex(dataRoot).then(() => console.log('[RAG Routes] Index warmed: ' + (getCurrentIndex()?.chunks?.length || getCurrentIndex()?.chunkCount || 0) + ' chunks')).catch(error => console.warn('[RAG Routes] Index warmup failed:', error.message));
    else console.log('[RAG Routes] Startup index warmup skipped (set RAG_WARM_INDEX=1 to enable). Index will be built on first query.');
}
