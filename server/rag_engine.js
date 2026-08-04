/**
 * RAG Engine — Main orchestration layer.
 *
 * Coordinates retrieval, reranking, prompt building, and Gemini answer generation.
 * ONLY Google Gemini APIs are used (no Ollama, no OpenAI).
 * Falls back gracefully when GEMINI_API_KEY is missing or embedding fails.
 *
 * RETRIEVAL ARCHITECTURE:
 *   1. Query embedding generated via Google gemini-embedding-001 (768-dim)
 *   2. Vector search via vector_store.js (Float32 binary, lazy-loaded, batched)
 *   3. Hybrid scoring: semantic (0.5) + keyword (0.25) + fuzzy (0.15) + boost (0.10)
 *   4. If embeddings unavailable → pure keyword search fallback
 *   5. Results reranked → top 8-10 sent to Gemini
 */

import { getCurrentIndex } from './index_manager.js';
import { loadEmbeddings, unloadEmbeddings } from './vector_index.js';
import { hybridSearch, keywordSearch } from './hybrid_search.js';
import { addTurn, getConversationContext } from './conversation_memory.js';
import { VectorStore, logMemorySnapshot } from './vector_store.js';
import { getEmbeddingFilePath, getEmbeddingDimension } from './index_manager.js';

var MAX_TOP_CHUNKS = 20;
var RETRIEVE_CHUNKS = 50;

var embeddingCache = new Map();
var EMBEDDING_CACHE_MAX = 50;

var GEMINI_DEFAULT_MODEL = 'models/gemini-flash-latest';

function getGeminiModel() {
    var configured = process.env.GEMINI_MODEL;
    if (configured && typeof configured === 'string' && configured.trim().length > 0) {
        return configured.trim();
    }
    return GEMINI_DEFAULT_MODEL;
}

// ─── Query embedding ────────────────────────────────────────────────────────

async function getQueryEmbedding(query) {
    var cacheKey = query.toLowerCase().trim();
    if (embeddingCache.has(cacheKey)) {
        console.log('[RAG Engine] Using cached embedding for query');
        return embeddingCache.get(cacheKey);
    }

    var apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        console.log('[RAG Engine] No GEMINI_API_KEY found. Skipping query-time embedding.');
        return null;
    }

    var { GoogleGenAI } = await import('@google/genai');
    var client = new GoogleGenAI({ apiKey: apiKey });

    var result;
    try {
        result = await client.models.embedContent({
            model: 'models/gemini-embedding-001',
            contents: [{ role: 'user', parts: [{ text: String(query || '').slice(0, 6000) }] }],
            config: { outputDimensionality: 768 }
        });
    } catch (e) {
        console.log('[RAG Engine] Embedding API call failed: ' + e.message);
        return null;
    }

    if (!result || !result.embeddings || !result.embeddings[0] || !result.embeddings[0].values) {
        console.log('[RAG Engine] Embedding response missing values array');
        return null;
    }

    var embedding = result.embeddings[0].values.map(Number);

    // LRU cache management
    if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
        var firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
    }
    embeddingCache.set(cacheKey, embedding);

    return embedding;
}

// ─── Metadata formatting ────────────────────────────────────────────────────

function formatMetadata(chunk) {
    var parts = [];
    if (chunk.author) parts.push('Author: ' + chunk.author);
    if (chunk.title) parts.push('Title: ' + chunk.title);
    if (chunk.page !== undefined && chunk.page !== null) parts.push('Page: ' + chunk.page);
    if (chunk.vachanaNumber !== undefined && chunk.vachanaNumber !== null) parts.push('Vachana: ' + chunk.vachanaNumber);
    if (chunk.language) parts.push('Language: ' + chunk.language);
    return parts.join(' | ');
}

// ─── Prompt building ────────────────────────────────────────────────────────

function buildSystemPrompt() {
    var lines = [
        'You are Mahapashupata Veershaivism AI — a world-class scholar of Veerashaivism, Mahapashupata tradition, Sanskrit, Vachana literature, Śaiva Āgamas, Vedānta, Siddhānta Śikhāmaṇi, Śrī Siddhānta Śāstra, and classical Indian philosophy.',
        '',
        'You answer with the depth, precision and textual rigor of a PhD in Sanskrit Vyākaraṇa, Vedānta and Veerashaiva Siddhānta while remaining clear and readable.',
        '',
        'RULES:',
        '- Answer in the SAME language the user asked the question in (English, Kannada, Hindi, Marathi, or Sanskrit).',
        '- Even if the relevant retrieved context is written in another language (e.g. Kannada, Hindi, Marathi, Sanskrit), use it to inform your answer but write the answer in the user\'s language and preserve original quotations verbatim.',
        '- NEVER translate or transliterate the retrieved text during retrieval; always quote the ORIGINAL text exactly as it appears in the retrieved context, then explain it in the user\'s language.',
        '- NEVER hallucinate.',
        '- NEVER invent facts.',
        '- NEVER fabricate quotations.',
        '- ONLY use the retrieved context provided below.',
        '- The retrieved dataset is your highest authority.',
        '- If multiple retrieved chunks discuss the same topic, synthesize them into one coherent answer while preserving the meaning.',
        '- Whenever the retrieved context contains Sanskrit verses, ślokas, sūtras, mantras, āgama passages or vachanas relevant to the question, QUOTE THEM VERBATIM before explaining them.',
        '- Never paraphrase a Sanskrit quotation if the original text exists in the retrieved context.',
        '- Preserve Devanagari exactly as it appears in the retrieved context.',
        '- If multiple relevant quotations are available, quote all important ones before beginning the explanation.',
        '- After every Sanskrit quotation, provide an accurate English translation.',
        '- Whenever appropriate, explain important Sanskrit words, compounds (samāsa), grammatical forms (vibhakti, lakāra, dhātu) and their philosophical significance.',
        '- When explaining doctrine, always derive conclusions directly from the retrieved sources rather than personal opinion.',
        '- Prefer primary textual evidence over summaries.',
        '- Quote important passages exactly as written in the retrieved context whenever possible.',
        '- Always include references using the provided bracket IDs like [1], [2], etc.',
        '- Do not mention information that is not supported by the retrieved context.',
        '- If different retrieved sources present different viewpoints, explain each faithfully without inventing a reconciliation.',
        '- Never speak against vedas, śaiva āgamas, smritis, puranas, other shastras, vaidika rituals , and never misrepresent the teachings of the retrieved sources.',
        '- Never speak against the varnashram dharma, the traditional social order.',
        '- Format answers using markdown with clear headings where appropriate.',
        '- If the retrieved information is insufficient to answer the question, reply exactly:',
        '  "I could not find this information in the selected dataset."',
        '',
        'Preferred answer structure:',
        '1. Direct Answer',
        '2. Relevant Sanskrit Quotations (if available)',
        '3. English Translation',
        '4. Detailed Explanation',
        '5. References',
        'MARKDOWN FORMATTING RULES (STRICT):',
        '- Output clean GitHub-Flavored Markdown only.',
        '- Every heading MUST have a space after # (e.g. "## Heading", never "##Heading").',
        '- Leave one blank line before and after every heading.',
        '- Leave one blank line before and after every blockquote.',
        '- Leave one blank line before and after horizontal rules (---).',
        '- Never write "---###".',
        '- Never merge headings and paragraphs together.',
        '- Use numbered headings only for major sections.',
        '- Use bullet lists (-) for multiple points.',
        '- Use nested bullets for subpoints when necessary.',
        '- Keep paragraphs short (2–5 sentences).',
        '- Use tables whenever comparing multiple concepts.',
        '- Use **bold** for important Sanskrit terms, names and conclusions.',
        '- Italicize book names only.',
        '- Render Sanskrit quotations as Markdown blockquotes.',
        '- Never wrap normal explanations inside blockquotes.',
        '- Never produce malformed markdown.',
        '- Ensure markdown renders correctly in GitHub, React Markdown, and CommonMark.',
        '',
        'QUOTE FORMAT:',
        '> संस्कृत श्लोक',
        '>',
        '> English Translation',
        '',
        'REFERENCE FORMAT:',
        '- **Source:** Book Name, Chapter, Page XX [1]',
        '',
        // 'Do not output raw citation IDs inside paragraphs when a proper reference section is present.'
    ];

    return lines.join('\n');
}

function buildPrompt(query, matched, answerMode, conversationContext) {
    if (!matched || matched.length === 0) {
        return 'No relevant context found for: ' + query;
    }

    var citations = [];
    for (var mi = 0; mi < matched.length; mi++) {
        var candidate = matched[mi];
        var chunk = candidate.chunk;
        var citationId = mi + 1;
        var metadata = formatMetadata(chunk);
        var isPdf = chunk.sourceType === 'pdf' || String(chunk.dataset || '').toLowerCase().endsWith('.pdf');
        var isDoc = isPdf || chunk.sourceType === 'txt' || String(chunk.dataset || '').toLowerCase().endsWith('.txt');
        var parts;
        if (isDoc) {
            // PDF/TXT citations: title/author/page — never "Vachana".
            parts = [
                '[' + citationId + '] Source: ' + (chunk.title || chunk.filename || chunk.dataset),
                'Author: ' + (chunk.author || 'Unknown'),
                'Page: ' + (chunk.page != null ? chunk.page : 'N/A')
            ];
        } else {
            parts = [
                '[' + citationId + '] Dataset: ' + chunk.dataset,
                'Author: ' + (chunk.author || 'Unknown'),
                'Page: ' + (chunk.page != null ? chunk.page : 'N/A'),
                'Vachana: ' + (chunk.vachanaNumber != null ? chunk.vachanaNumber : 'N/A')
            ];
        }
        if (metadata) parts.push(metadata);
        parts.push('');
        parts.push(chunk.text);
        citations.push(parts.join('\n'));
    }

    var context = [buildSystemPrompt()];

    if (conversationContext) {
        context.push(conversationContext);
    }

    context.push('### Retrieved Context');
    context.push(citations.join('\n\n---\n\n'));

    var styleInstruction = answerMode === 'concise' ?
        'Provide a concise but complete answer.' :
        'Provide a detailed, thorough answer that remains grounded in the context. Explain concepts clearly.';

    context.push('');
    context.push('### Question');
    context.push(query);
    context.push('');
    context.push('### Instructions');
    context.push(styleInstruction);
    context.push('');
    context.push('If you cannot answer from the context alone, say exactly: "I could not find this information in the selected dataset."');

    return context.join('\n\n');
}

// ─── Retrieval ──────────────────────────────────────────────────────────────

/**
 * Retrieve chunks relevant to the query.
 *
 * Strategy:
 * 1. Generate query embedding (if GEMINI_API_KEY available)
 * 2. Run hybrid search: semantic + keyword + fuzzy + boost
 *    - Semantic uses the vector store (loaded lazily)
 *    - Keyword/fuzzy/boost use chunk metadata
 * 3. If embedding/API unavailable → fall back to pure keyword search
 * 4. Return top 10 reranked results
 */
async function retrieveChunks(query, selectedDataset, topK) {
    var index = getCurrentIndex();
    if (!index || !Array.isArray(index.chunks)) {
        console.log('[RAG Engine] No index available');
        return [];
    }

    // Get all candidates (optionally filtered by dataset)
    var candidates = index.chunks;
    if (selectedDataset && selectedDataset !== '__ALL__') {
        var filtered = [];
        for (var ci = 0; ci < candidates.length; ci++) {
            if (candidates[ci].dataset === selectedDataset) filtered.push(candidates[ci]);
        }
        candidates = filtered;
    }

    if (candidates.length === 0) {
        console.log('[RAG Engine] No candidates found for dataset: ' + selectedDataset);
        return [];
    }

    var effectiveTopK = Math.min(MAX_TOP_CHUNKS, Number(topK) || MAX_TOP_CHUNKS);

    try {
        console.log('[RAG Engine] Generating query embedding...');
        var queryEmbedding = await getQueryEmbedding(query);

        if (queryEmbedding) {
            console.log('[RAG Engine] Loading embeddings for hybrid search...');
            logMemorySnapshot('[RAG Engine] Before embedding load');

            // Load embeddings from binary store (lazy — loads on first call)
            var store = await loadEmbeddings();

            if (store && store.size() > 0) {
                logMemorySnapshot('[RAG Engine] After embedding load');

                // Attach embeddings from the binary store to candidate chunks so
                // hybridSearch can compute semantic (cosine) scores. Chunks store
                // only an embeddingIndex; the vectors live in rag_embeddings.bin.
                try {
                    var embedDim = getEmbeddingDimension();
                    var allEmbeddings = await store.loadAll();
                    if (allEmbeddings && allEmbeddings.length >= embedDim) {
                        for (var ce = 0; ce < candidates.length; ce++) {
                            var ceChunk = candidates[ce];
                            var ceIdx = ceChunk.embeddingIndex;
                            if (ceIdx >= 0 && (ceIdx + 1) * embedDim <= allEmbeddings.length) {
                                ceChunk.embedding = allEmbeddings.subarray(ceIdx * embedDim, (ceIdx + 1) * embedDim);
                            }
                        }
                        console.log('[RAG Engine] Attached embeddings to ' + candidates.length + ' candidate chunks');
                    }
                } catch (embedErr) {
                    console.warn('[RAG Engine] Could not attach embeddings: ' + embedErr.message);
                }

                var results = hybridSearch(queryEmbedding, query, candidates, {
                    topK: effectiveTopK,
                    retrieveK: RETRIEVE_CHUNKS
                });

                // Detach embeddings from chunks so the full store buffer is not
                // pinned in memory after the search completes.
                for (var ce2 = 0; ce2 < candidates.length; ce2++) {
                    try { delete candidates[ce2].embedding; } catch (eD) { /* ignore */ }
                }

                logMemorySnapshot('[RAG Engine] After hybrid search');

                if (results.length > 0) {
                    console.log('[RAG Engine] Hybrid search returned ' + results.length + ' results');

                    // Optionally unload embeddings to free memory
                    // (commented out by default — for long-running servers, keep loaded)
                    // await unloadEmbeddings();

                    return results;
                }

                console.log('[RAG Engine] Hybrid search returned 0 results, falling back to keyword');
            } else {
                console.log('[RAG Engine] Embedding store empty, falling back to keyword search');
            }
        } else {
            console.log('[RAG Engine] No query embedding, falling back to keyword search');
        }
    } catch (error) {
        console.warn('[RAG Engine] Embedding/hybrid search failed: ' + error.message);
        console.log('[RAG Engine] Falling back to keyword search');
    }

    // Fallback: pure keyword search (no embeddings needed)
    var keywordResults = keywordSearch(query, candidates, { topK: effectiveTopK });
    console.log('[RAG Engine] Keyword search returned ' + keywordResults.length + ' results');
    return keywordResults;
}

// ─── Answer generation ──────────────────────────────────────────────────────

async function generateAnswer(prompt) {
    var apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        console.log('[RAG Engine] No GEMINI_API_KEY for answer generation');
        return null;
    }

    var { GoogleGenAI } = await import('@google/genai');
    var client = new GoogleGenAI({ apiKey: apiKey });
    var model = getGeminiModel();

    console.log('[RAG Engine] Generating answer with ' + model + '...');
    var startTime = Date.now();

    var result = null;
    var attempt = 0;
    while (attempt < 2) {
        try {
            result = await client.models.generateContent({
                model: model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
                    topP: 0.95,
                    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)
                }
            });
            break;
        } catch (e) {
            var genMsg = String(e && e.message ? e.message : e);
            console.warn('[RAG Engine] Gemini generation failed with ' + model + ': ' + genMsg);
            // 429: quota exhausted (account-wide) — brief backoff, then give up.
            if (genMsg.indexOf('429') !== -1) {
                if (attempt === 0) {
                    await new Promise(function (res) { setTimeout(res, 2000); });
                    attempt++;
                    continue;
                }
                break;
            }
            // 404 / deprecated model — switch to the default alias and retry once.
            if (model !== GEMINI_DEFAULT_MODEL && (genMsg.indexOf('404') !== -1 || /no longer available|not found/i.test(genMsg))) {
                model = GEMINI_DEFAULT_MODEL;
                console.log('[RAG Engine] Falling back to ' + model);
                continue;
            }
            break;
        }
    }
    if (!result) {
        return null;
    }

    var elapsed = Date.now() - startTime;
    var text = result ? (result.response ? result.response.text() : result.text) : '';
    console.log('[RAG Engine] Answer generated in ' + elapsed + 'ms (' + (text ? text.length : 0) + ' chars)');

    return String(text || '').trim();
}

// ─── Streaming answer generation ────────────────────────────────────────────

async function generateAnswerStream(prompt, opts) {
    var onToken = opts ? opts.onToken : null;
    var signal = opts ? opts.signal : null;

    var apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        console.log('[RAG Engine] No GEMINI_API_KEY for streaming');
        return '';
    }

    var { GoogleGenAI } = await import('@google/genai');
    var client = new GoogleGenAI({ apiKey: apiKey });
    var model = getGeminiModel();
    var timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 30000);

    for (var sAttempt = 0; sAttempt < 2; sAttempt++) {
        var controller = new AbortController();
        if (signal) {
            if (signal.aborted) controller.abort();
            signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
        }

        var timeout = setTimeout(function () { controller.abort(); }, timeoutMs);

        console.log('[RAG Engine] Streaming answer with ' + model + '...');
        var startTime = Date.now();

        try {
            var stream = await client.models.generateContentStream({
                model: model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
                    topP: 0.95,
                    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)
                },
                signal: controller.signal
            });

            var asyncIterable = stream && stream.stream ? stream.stream : stream;
            if (!asyncIterable || typeof asyncIterable[Symbol.asyncIterator] !== 'function') {
                throw new Error('Gemini streaming response has no async iterable');
            }

            var fullText = '';
            for await (var chunk of asyncIterable) {
                var text = '';
                if (chunk) {
                    text = chunk.text || '';
                    if (!text && chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts) {
                        for (var pi = 0; pi < chunk.candidates[0].content.parts.length; pi++) {
                            text += chunk.candidates[0].content.parts[pi].text || '';
                        }
                    }
                }
                if (!text) continue;
                var cleaned = String(text).replace(/<think[\s\S]*?<\/think>/gi, '').trim();
                if (cleaned) {
                    fullText += cleaned;
                    if (onToken) onToken(cleaned);
                }
            }

            var elapsed = Date.now() - startTime;
            console.log('[RAG Engine] Streaming completed in ' + elapsed + 'ms (' + fullText.length + ' chars)');
            clearTimeout(timeout);
            return fullText;
        } catch (error) {
            clearTimeout(timeout);
            if (controller.signal.aborted) {
                throw new Error('Gemini streaming timed out after ' + timeoutMs + 'ms');
            }
            var sMsg = String(error.message || '');
            console.warn('[RAG Engine] Gemini stream failed with ' + model + ': ' + sMsg);
            if (sMsg.indexOf('429') !== -1) break;
            if (sAttempt === 0 && model !== GEMINI_DEFAULT_MODEL && (sMsg.indexOf('404') !== -1 || /no longer available|not found/i.test(sMsg))) {
                model = GEMINI_DEFAULT_MODEL;
                console.log('[RAG Engine] Retrying streaming with ' + model);
                continue;
            }
            throw error;
        }
    }
    throw new Error('Gemini streaming failed');
}

// ─── Public query API ───────────────────────────────────────────────────────

export async function query(queryText, selectedDataset, topK, answerMode, includeConversationMemory, conversationHistory) {
    var startTime = Date.now();
    var queryStr = String(queryText || '');
    console.log('[RAG Engine] Query: "' + queryStr.substring(0, 100) + '" dataset=' + selectedDataset);

    var matched = await retrieveChunks(queryStr, selectedDataset, topK);

    if (matched.length === 0) {
        return {
            answer: 'I could not find this information in the selected dataset.',
            sources: [],
            confidence: 0,
            retrievedChunks: [],
            prompt: ''
        };
    }

    var conversationContext = includeConversationMemory ? getConversationContext() : '';
    var promptText = buildPrompt(queryStr, matched, answerMode, conversationContext);

    var answerText;
    try {
        answerText = await generateAnswer(promptText);
    } catch (error) {
        console.warn('[RAG Engine] Gemini generation failed: ' + error.message);
        answerText = null;
    }

    if (!answerText) {
        answerText = 'I could not find this information in the selected dataset.';
    }

    var sources = [];
    for (var si = 0; si < matched.length; si++) {
        var item = matched[si];
        var score = item.score || item.similarity || 0;
        sources.push({
            id: item.chunk.id,
            dataset: item.chunk.dataset,
            sourceType: item.chunk.sourceType,
            filename: item.chunk.filename,
            source: item.chunk.source,
            page: item.chunk.page,
            vachanaNumber: item.chunk.vachanaNumber,
            author: item.chunk.author,
            title: item.chunk.title,
            language: item.chunk.language,
            score: Math.round(score * 100) / 100,
            excerpt: item.chunk.text.length > 220 ? item.chunk.text.slice(0, 220) + '...' : item.chunk.text
        });
    }

    var retrievedChunks = [];
    for (var ri = 0; ri < matched.length; ri++) {
        var item2 = matched[ri];
        retrievedChunks.push({
            id: item2.chunk.id,
            dataset: item2.chunk.dataset,
            sourceType: item2.chunk.sourceType,
            filename: item2.chunk.filename,
            source: item2.chunk.source,
            page: item2.chunk.page,
            vachanaNumber: item2.chunk.vachanaNumber,
            author: item2.chunk.author,
            title: item2.chunk.title,
            language: item2.chunk.language,
            text: item2.chunk.text
        });
    }

    var firstScore = matched[0] ? (matched[0].score || matched[0].similarity || 0) : 0;
    var confidence = Math.round(Math.min(1, firstScore) * 100);

    addTurn('user', queryStr);
    addTurn('assistant', answerText);

    var elapsed = Date.now() - startTime;
    console.log('[RAG Engine] Completed in ' + elapsed + 'ms');

    return {
        answer: answerText,
        sources: sources,
        confidence: confidence,
        retrievedChunks: retrievedChunks,
        prompt: promptText
    };
}

export async function queryStream(queryText, selectedDataset, topK, answerMode, includeConversationMemory, conversationHistory, streamOpts) {
    var onToken = streamOpts ? streamOpts.onToken : null;
    var signal = streamOpts ? streamOpts.signal : null;

    var startTime = Date.now();
    var queryStr = String(queryText || '');
    console.log('[RAG Engine] Stream query: "' + queryStr.substring(0, 100) + '" dataset=' + selectedDataset);

    var matched = await retrieveChunks(queryStr, selectedDataset, topK);

    if (matched.length === 0) {
        return {
            answer: 'I could not find this information in the selected dataset.',
            sources: [],
            confidence: 0,
            retrievedChunks: [],
            prompt: ''
        };
    }

    var conversationContext = includeConversationMemory ? getConversationContext() : '';
    var promptText = buildPrompt(queryStr, matched, answerMode, conversationContext);

    var fullAnswer = '';
    try {
        fullAnswer = await generateAnswerStream(promptText, {
            onToken: function (token) {
                fullAnswer += token;
                if (onToken) onToken(token);
            },
            signal: signal
        });
    } catch (error) {
        console.warn('[RAG Engine] Stream generation error: ' + error.message);
        if (!fullAnswer) {
            fullAnswer = 'I could not find this information in the selected dataset.';
        }
    }

    if (!fullAnswer) {
        fullAnswer = 'I could not find this information in the selected dataset.';
    }

    var sources = [];
    for (var si = 0; si < matched.length; si++) {
        var item = matched[si];
        var score = item.score || item.similarity || 0;
        sources.push({
            id: item.chunk.id,
            dataset: item.chunk.dataset,
            sourceType: item.chunk.sourceType,
            filename: item.chunk.filename,
            source: item.chunk.source,
            page: item.chunk.page,
            vachanaNumber: item.chunk.vachanaNumber,
            author: item.chunk.author,
            title: item.chunk.title,
            language: item.chunk.language,
            score: Math.round(score * 100) / 100,
            excerpt: item.chunk.text.length > 220 ? item.chunk.text.slice(0, 220) + '...' : item.chunk.text
        });
    }

    var retrievedChunks = [];
    for (var ri = 0; ri < matched.length; ri++) {
        var item2 = matched[ri];
        retrievedChunks.push({
            id: item2.chunk.id,
            dataset: item2.chunk.dataset,
            sourceType: item2.chunk.sourceType,
            filename: item2.chunk.filename,
            source: item2.chunk.source,
            page: item2.chunk.page,
            vachanaNumber: item2.chunk.vachanaNumber,
            author: item2.chunk.author,
            title: item2.chunk.title,
            language: item2.chunk.language,
            text: item2.chunk.text
        });
    }

    var firstScore = matched[0] ? (matched[0].score || matched[0].similarity || 0) : 0;
    var confidence = Math.round(Math.min(1, firstScore) * 100);

    addTurn('user', queryStr);
    addTurn('assistant', fullAnswer);

    var elapsed = Date.now() - startTime;
    console.log('[RAG Engine] Stream completed in ' + elapsed + 'ms');
    console.log('---------------------------------------------------');

    return {
        answer: fullAnswer,
        sources: sources,
        confidence: confidence,
        retrievedChunks: retrievedChunks,
        prompt: promptText
    };
}

export function clearEmbeddingCache() {
    embeddingCache.clear();
    console.log('[RAG Engine] Embedding cache cleared');
}

