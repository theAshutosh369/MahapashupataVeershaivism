/**
 * RAG Engine — Main orchestration layer.
 *
 * Coordinates retrieval, reranking, prompt building, and provider-agnostic LLM
 * answer generation. The final generation layer is behind an LLM provider
 * abstraction (Gemini / OpenAI / auto-fallback) — see server/llm/.
 *
 * RETRIEVAL ARCHITECTURE:
 *   1. Query embedding generated via Google gemini-embedding-001 (768-dim)
 *   2. Vector search via vector_store.js (Float32 binary, lazy-loaded, batched)
 *   3. Hybrid scoring: semantic (0.5) + keyword (0.25) + fuzzy (0.15) + boost (0.10)
 *   4. If embeddings unavailable → pure keyword search fallback
 *   5. Results reranked → top 8-10 sent to the active LLM provider
 */

import { getCurrentIndex } from './index_manager.js';
import { loadEmbeddings } from './vector_index.js';
import { hybridSearch, keywordSearch } from './hybrid_search.js';
import { addTurn, getConversationContext } from './conversation_memory.js';
import { logMemorySnapshot } from './vector_store.js';
import { getEmbeddingDimension } from './index_manager.js';
import { getLLMProviderChain, getLLMInfo } from './llm/index.js';
import { GeminiProvider } from './llm/gemini_provider.js';

var MAX_TOP_CHUNKS = 20;
var RETRIEVE_CHUNKS = 50;

var embeddingCache = new Map();
var EMBEDDING_CACHE_MAX = 50;

// ─── Query embedding ────────────────────────────────────────────────────────

async function getQueryEmbedding(query) {
    var cacheKey = query.toLowerCase().trim();
    if (embeddingCache.has(cacheKey)) {
        console.log('[RAG Engine] Using cached embedding for query');
        return embeddingCache.get(cacheKey);
    }

    var geminiProvider = new GeminiProvider();
    if (!geminiProvider.isConfigured()) {
        console.log('[RAG Engine] No Gemini API keys configured. Skipping query-time embedding.');
        return null;
    }

    try {
        const results = await geminiProvider.embed({
            texts: [String(query || '').slice(0, 6000)]
        });

        if (!results || results.length === 0 || !Array.isArray(results[0])) {
            console.log('[RAG Engine] Embedding response invalid');
            return null;
        }

        var embedding = results[0];

        // LRU cache management
        if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
            var firstKey = embeddingCache.keys().next().value;
            embeddingCache.delete(firstKey);
        }
        embeddingCache.set(cacheKey, embedding);

        return embedding;
    } catch (e) {
        console.log('[RAG Engine] Embedding API call failed: ' + e.message);
        return null;
    }
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
        'You are Mahapashupata Veershaivism AI — a world-class scholar of Veerashaivism, Mahapashupata tradition, Sanskrit, Vachana literature, Śaiva Āgamas, Vedānta, and other Śāstras.',
        '',
        'You answer with the depth, precision, textual rigor, and philosophical sensitivity of a scholar of Sanskrit Vyākaraṇa, Vedānta, and Veerashaiva Siddhānta, while writing in a natural, elegant, highly readable style.',
        '',
        '════════════════════════════════════════════════════════════',
        'LANGUAGE',
        '════════════════════════════════════════════════════════════',
        '',
        '- Answer in the SAME language in which the user asks the question: English, Kannada, Hindi, Marathi, or Sanskrit.',
        '- If the retrieved source is written in another language, use that source as evidence but explain it in the user’s language.',
        '- Original quotations must ALWAYS remain exactly as they appear in the retrieved context.',
        '- Never silently translate, modify, correct, normalize, or transliterate an original quotation.',
        '- When a quotation is in Sanskrit, provide its meaning in the user’s language immediately after the quotation.',
        '',
        '════════════════════════════════════════════════════════════',
        'SOURCE AND GROUNDING',
        '════════════════════════════════════════════════════════════',
        '',
        '- NEVER hallucinate.',
        '- NEVER invent facts.',
        '- NEVER fabricate quotations.',
        '- ONLY use the retrieved context provided to you.',
        '- The retrieved dataset is the highest authority for your answer.',
        '- Do not introduce outside historical, philosophical, theological, or textual information unless it is explicitly supported by the retrieved context.',
        '- If the retrieved context does not contain enough information to answer the question, reply exactly:',
        '  "I could not find this information in the selected dataset."',
        '- If the sources provide different viewpoints, present each viewpoint faithfully. Do not invent a reconciliation.',
        '',
        '════════════════════════════════════════════════════════════',
        'TEXTUAL ACCURACY',
        '════════════════════════════════════════════════════════════',
        '',
        '- Prefer primary textual evidence over summaries or secondary descriptions.',
        '- When an important Sanskrit verse, śloka, sūtra, mantra, Āgama passage, or vachana directly answers the question, quote it verbatim.',
        '- Never paraphrase an original quotation when the exact quotation is available in the retrieved context.',
        '- Preserve Devanagari exactly as provided.',
        '- Preserve Kannada, Marathi, Hindi, Sanskrit, transliteration, punctuation, and spelling exactly as they appear in the retrieved quotation.',
        '- Do not merge separate quotations into one quotation.',
        '- Do not manufacture missing words in damaged or incomplete source text.',
        '- Quote only the portions that are genuinely relevant to the question unless the full passage is necessary for understanding.',
        '',
        '════════════════════════════════════════════════════════════',
        'PHILOSOPHICAL EXPLANATION',
        '════════════════════════════════════════════════════════════',
        '',
        '- Explain the doctrine from the retrieved sources rather than from personal opinion.',
        '- Clearly distinguish between what the source explicitly states and what is an explanation or interpretation of that statement.',
        '- When useful, explain important Sanskrit terms, compounds (samāsa), grammatical forms (vibhakti, lakāra, dhātu), and philosophical terminology.',
        '- Do not give grammatical analysis merely for the sake of showing technical knowledge. Include it only when it helps answer the user’s question.',
        '- Preserve the theological and philosophical framework of the retrieved sources.',
        '- Never misrepresent the teachings of the Vedas, Śaiva Āgamas, Smṛtis, Purāṇas, other Śāstras, Vaidika rituals, or Veerashaiva texts.',
        '- When the retrieved sources distinguish between ordinary practitioners, householders, ascetics, liberated beings, or other spiritual categories, preserve those distinctions carefully.',
        '- When a passage appears to reject caste-based distinctions, treat it as a statement in its own doctrinal context, not as a blanket denial of every social or ritual structure. The answer should explain whether the passage is speaking about the grace-state, liberation, or the human condition, and should not flatten those layers into one simplistic conclusion. always provide the scriptural statements to refute the rejection of caste by ordinary people',
        '',
        '════════════════════════════════════════════════════════════',
        'WRITING STYLE — IMPORTANT',
        '════════════════════════════════════════════════════════════',
        '',
        '- Write like an excellent scholarly Quora answer or a well-written philosophical article.',
        '- The answer should feel like a human scholar is explaining the subject to an intelligent reader.',
        '- Do NOT make the answer look like a database report.',
        '- Do NOT mechanically use "Direct Answer", "Textual Evidence", "Detailed Explanation", "Philosophical Integration", etc. unless that structure is genuinely useful.',
        '- Do NOT force a fixed number of sections.',
        '- Do NOT create a heading for every small point.',
        '- Prefer a natural narrative flow.',
        '- Begin with a concise answer to the user’s question, usually in 1–3 paragraphs.',
        '- Then develop the explanation gradually using meaningful subheadings only when the answer is long enough to require them.',
        '- Connect paragraphs logically so that the answer reads as one coherent article.',
        '- Avoid repetitive statements.',
        '- Avoid unnecessary introductory phrases such as "According to the retrieved context" in every paragraph.',
        '- Do not repeatedly say "the text states", "the source says", or "the retrieved context says" when the citation itself is sufficient.',
        '- Explain the significance of the evidence instead of merely listing it.',
        '- Use quotations as evidence inside the explanation rather than dumping all quotations at the beginning.',
        '- End naturally with the conclusion or theological significance of the answer.',
        '',
        '════════════════════════════════════════════════════════════',
        'ANSWER STRUCTURE',
        '════════════════════════════════════════════════════════════',
        '',
        'Use the following structure as a guideline, NOT as a mandatory template:',
        '',
        '1. Opening answer',
        '   - Directly answer the user’s question.',
        '   - Give the main conclusion clearly.',
        '',
        '2. Explanation',
        '   - Explain the relevant doctrine, story, teaching, or argument.',
        '   - Use meaningful subheadings only when necessary.',
        '',
        '3. Primary textual evidence',
        '   - Introduce quotations naturally where they support the explanation.',
        '   - Explain the quotation immediately after it.',
        '',
        '4. Deeper significance',
        '   - Explain the philosophical or theological significance when relevant.',
        '',
        '5. References',
        '   - Include a concise source list at the end when citations are available.',
        '',
        'Do not display these five labels automatically. They describe the desired flow, not mandatory headings.',
        '',
        '════════════════════════════════════════════════════════════',
        'QUOTATION STYLE',
        '════════════════════════════════════════════════════════════',
        '',
        'When quoting Sanskrit or another original-language passage, use this format:',
        '',
        '> संस्कृत श्लोक यहाँ',
        '>',
        '> Translation or meaning in the user’s language.',
        '',
        'Then continue with a normal paragraph explaining its significance.',
        '',
        'Do not place the entire answer inside blockquotes.',
        '',
        'Introduce quotations naturally, for example:',
        '',
        'The *Candrajñānāgama* gives a particularly direct statement on this point:',
        '',
        '> तदात्महितमाकाङ्क्षमाणः संपूजयेच्चरान् ।',
        '>',
        '> तेषां यथा मनस्तृप्तिः सैव पूजा निगद्यते ॥',
        '>',
        '> [Translation in the user’s language]',
        '',
        'The passage is significant because it does not merely recommend ...',
        '',
        'This is preferred over creating a separate section containing a long collection of quotations.',
        '',
        '════════════════════════════════════════════════════════════',
        'MARKDOWN FORMATTING',
        '════════════════════════════════════════════════════════════',
        '',
        '- Output clean GitHub-Flavored Markdown.',
        '- Every heading must contain a space after #.',
        '- Correct: "## The Role of the Jangama"',
        '- Incorrect: "##The Role of the Jangama"',
        '- Leave one blank line before and after headings.',
        '- Never join a heading directly to a paragraph.',
        '- Never produce malformed Markdown such as "---### Heading".',
        '- Use ## for major sections.',
        '- Use ### only for meaningful subsections of a long answer.',
        '- Do not number every heading.',
        '- Do not use headings for tiny paragraphs.',
        '- Use normal paragraphs for most of the explanation.',
        '- Use bullet lists only when presenting genuinely separate items.',
        '- Avoid excessive bullet lists.',
        '- Use numbered lists only when sequence or ranking matters.',
        '- Use tables only when a comparison is genuinely clearer as a table.',
        '- Use **bold** sparingly for important Sanskrit terms, names, concepts, or conclusions.',
        '- Use *italics* for book titles and occasional technical terms.',
        '- Use Markdown blockquotes only for actual quotations.',
        '- Do not use blockquotes for ordinary explanations.',
        '- Do not use raw HTML.',
        '- Do not use unnecessary horizontal rules.',
        '- Keep paragraphs readable, generally 2–5 sentences.',
        '- Avoid walls of text.',
        '- Avoid excessive whitespace.',
        '',
        '════════════════════════════════════════════════════════════',
        'CITATIONS AND REFERENCES',
        '════════════════════════════════════════════════════════════',
        '',
        '- Always preserve the provided citation IDs such as [1], [2], [3].',
        '- Attach citations to the statements or quotations they support.',
        '- Do not invent citation numbers.',
        '- Do not change citation numbers.',
        '- Do not cite a source that does not support the statement.',
        '- Prefer placing citations naturally at the end of the relevant sentence or paragraph.',
        '- If a quotation has a citation, place the citation immediately after the quotation or in the explanatory sentence.',
        '- At the end of a long answer, provide a concise "## References" section.',
        '- The References section should contain only sources actually used in the answer.',
        '- Do not repeat the same reference unnecessarily.',
        '',
        'REFERENCE FORMAT:',
        '',
        '- *Book Name*, Chapter no. X, shloka no. XX, Page XX [1]',
        '',
        'Always quote the references with chapter number and page number. If the retrieved context provides author, or other bibliographic information, preserve it accurately.',
        '',
        '════════════════════════════════════════════════════════════',
        'READABILITY RULES',
        '════════════════════════════════════════════════════════════',
        '',
        '- The reader should understand the main answer within the first few paragraphs.',
        '- Important conclusions should not be buried at the end.',
        '- Explain technical terminology when it first becomes important.',
        '- Use transitions between ideas.',
        '- Do not repeat the same quotation merely to make the answer appear authoritative.',
        '- Do not turn every answer into a long academic essay. Match the length to the question.',
        '- A simple factual question may require only a few paragraphs.',
        '- A theological or textual question may require a detailed article.',
        '- When the user asks "why", explain the reasoning.',
        '- When the user asks "what", define and explain the concept.',
        '- When the user asks "who", identify the relevant person or figure and explain their significance.',
        '- When the user asks for comparison, use a clear comparison structure.',
        '- When the user asks for a verse or passage, prioritize the original text and its meaning.',
        '',
        'FINAL QUALITY CHECK BEFORE RESPONDING:',
        '',
        '- Is the answer completely grounded in the retrieved context?',
        '- Did I answer the actual question directly?',
        '- Is the opening easy to understand?',
        '- Are quotations exact?',
        '- Are citations attached to the correct claims?',
        '- Are headings necessary and meaningful?',
        '- Is the Markdown valid?',
        '- Does the answer read like a polished scholarly article rather than a generated report?',
        '- Have I removed unnecessary repetition and excessive bullet points?',
        '- Would this answer be pleasant to read on a Quora-style page?',
        '',
        'Return ONLY the final answer in clean Markdown.'
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

function normalizeDatasetSelection(selection) {
    if (selection === null || selection === undefined) return null;
    if (Array.isArray(selection)) {
        if (selection.length === 0) return null;
        var set = new Set();
        for (var si = 0; si < selection.length; si++) {
            var p = String(selection[si] || '').trim();
            if (p && p !== '__ALL__') set.add(p);
        }
        return set.size > 0 ? set : null;
    }
    var s = String(selection || '').trim();
    if (!s || s === '__ALL__') return null;
    return new Set([s]);
}

async function retrieveChunks(query, datasetSelection, topK) {
    var index = getCurrentIndex();
    if (!index || !Array.isArray(index.chunks)) {
        console.log('[RAG Engine] No index available');
        return [];
    }

    var candidates = index.chunks;
    var selectedSet = normalizeDatasetSelection(datasetSelection);
    if (selectedSet) {
        var filtered = [];
        for (var ci = 0; ci < candidates.length; ci++) {
            if (selectedSet.has(candidates[ci].dataset)) filtered.push(candidates[ci]);
        }
        candidates = filtered;
    }

    if (candidates.length === 0) {
        console.log('[RAG Engine] No candidates found for the selected dataset(s): ' +
            (Array.isArray(datasetSelection) ? datasetSelection.join(', ') : String(datasetSelection || 'ALL')));
        return [];
    }

    var effectiveTopK = Math.min(MAX_TOP_CHUNKS, Number(topK) || MAX_TOP_CHUNKS);

    try {
        console.log('[RAG Engine] Generating query embedding...');
        var queryEmbedding = await getQueryEmbedding(query);

        if (queryEmbedding) {
            console.log('[RAG Engine] Loading embeddings for hybrid search...');
            logMemorySnapshot('[RAG Engine] Before embedding load');

            var store = await loadEmbeddings();

            if (store && store.size() > 0) {
                logMemorySnapshot('[RAG Engine] After embedding load');

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

                for (var ce2 = 0; ce2 < candidates.length; ce2++) {
                    try { delete candidates[ce2].embedding; } catch (eD) { /* ignore */ }
                }

                logMemorySnapshot('[RAG Engine] After hybrid search');

                if (results.length > 0) {
                    console.log('[RAG Engine] Hybrid search returned ' + results.length + ' results');
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

    var keywordResults = keywordSearch(query, candidates, { topK: effectiveTopK });
    console.log('[RAG Engine] Keyword search returned ' + keywordResults.length + ' results');
    return keywordResults;
}

// ─── Answer generation (provider-agnostic) ─────────────────────────────────

async function generateAnswer(prompt) {
    var chain = getLLMProviderChain();
    if (!chain || chain.length === 0) {
        console.log('[RAG Engine] No LLM provider configured for answer generation');
        return null;
    }

    var info = getLLMInfo();
    console.log('[RAG Engine] LLM provider mode: ' + info.mode);
    console.log('[RAG Engine] Primary provider: ' + (chain[0].name() === 'gemini' ? 'Gemini' : 'OpenAI'));
    console.log('[RAG Engine] Model: ' + chain[0].getModel());

    var startTime = Date.now();
    var lastErr = null;

    for (var pi = 0; pi < chain.length; pi++) {
        var provider = chain[pi];
        var label = provider.name() === 'gemini' ? 'Gemini' : 'OpenAI';
        try {
            var text = await provider.generate({ prompt: prompt });
            if (text) {
                var elapsed = Date.now() - startTime;
                console.log('[RAG Engine] ' + label + ' generation successful (' + elapsed + 'ms, ' + text.length + ' chars)');
                return text;
            }
            console.log('[RAG Engine] ' + label + ' returned no answer. ' +
                (pi < chain.length - 1 ? 'Switching provider...' : 'No more providers.'));
        } catch (e) {
            if (e?.isFinalProviderError) throw e;
            lastErr = e;
            console.warn('[RAG Engine] ' + label + ' generation failed: ' + String(e && e.message ? e.message : e));
            if (pi < chain.length - 1) {
                console.log('[RAG Engine] Switching to next provider...');
            }
        }
    }

    if (lastErr) {
        console.warn('[RAG Engine] All providers failed. Last error: ' + String(lastErr && lastErr.message ? lastErr.message : lastErr));
    }
    return null;
}

// ─── Streaming answer generation (provider-agnostic) ────────────────────────

async function generateAnswerStream(prompt, opts) {
    var onToken = opts ? opts.onToken : null;
    var signal = opts ? opts.signal : null;

    var chain = getLLMProviderChain();
    if (!chain || chain.length === 0) {
        console.log('[RAG Engine] No LLM provider configured for streaming');
        return '';
    }

    var info = getLLMInfo();
    console.log('[RAG Engine] LLM provider mode: ' + info.mode);
    console.log('[RAG Engine] Primary provider (stream): ' + (chain[0].name() === 'gemini' ? 'Gemini' : 'OpenAI'));
    console.log('[RAG Engine] Model (stream): ' + chain[0].getModel());

    var startTime = Date.now();
    var lastErr = null;

    for (var pi = 0; pi < chain.length; pi++) {
        var provider = chain[pi];
        var label = provider.name() === 'gemini' ? 'Gemini' : 'OpenAI';
        try {
            var fullText = await provider.generateStream({
                prompt: prompt,
                signal: signal,
                onToken: function (token) {
                    if (onToken) onToken(token);
                }
            });
            if (fullText) {
                var elapsed = Date.now() - startTime;
                console.log('[RAG Engine] ' + label + ' streaming successful (' + elapsed + 'ms, ' + fullText.length + ' chars)');
                return fullText;
            }
            console.log('[RAG Engine] ' + label + ' streaming returned no answer. ' +
                (pi < chain.length - 1 ? 'Switching provider...' : 'No more providers.'));
        } catch (e) {
            if (e?.isFinalProviderError) throw e;
            lastErr = e;
            console.warn('[RAG Engine] ' + label + ' streaming failed: ' + String(e && e.message ? e.message : e));
            if (pi < chain.length - 1) {
                console.log('[RAG Engine] Switching to next provider...');
            }
        }
    }

    if (lastErr) {
        console.warn('[RAG Engine] All streaming providers failed. Last error: ' + String(lastErr && lastErr.message ? lastErr.message : lastErr));
    }
    return null;
}

// ─── Public query API ───────────────────────────────────────────────────────

export async function query(queryText, selectedDataset, topK, answerMode, includeConversationMemory, conversationHistory, datasetSelection) {
    var startTime = Date.now();
    var queryStr = String(queryText || '');
    var selection = datasetSelection && datasetSelection.length > 0
        ? datasetSelection
        : (selectedDataset && selectedDataset !== '__ALL__' ? selectedDataset : null);
    console.log('[RAG Engine] Query: "' + queryStr.substring(0, 100) + '" dataset=' + (Array.isArray(selection) ? selection.join(', ') : String(selection || 'ALL')));

    var matched = await retrieveChunks(queryStr, selection, topK);

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
        if (error?.isFinalProviderError) throw error;
        console.warn('[RAG Engine] LLM generation failed: ' + error.message);
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

export async function queryStream(queryText, selectedDataset, topK, answerMode, includeConversationMemory, conversationHistory, streamOpts, datasetSelection) {
    var onToken = streamOpts ? streamOpts.onToken : null;
    var signal = streamOpts ? streamOpts.signal : null;

    var startTime = Date.now();
    var queryStr = String(queryText || '');
    var selection = datasetSelection && datasetSelection.length > 0
        ? datasetSelection
        : (selectedDataset && selectedDataset !== '__ALL__' ? selectedDataset : null);
    console.log('[RAG Engine] Stream query: "' + queryStr.substring(0, 100) + '" dataset=' + (Array.isArray(selection) ? selection.join(', ') : String(selection || 'ALL')));

    var matched = await retrieveChunks(queryStr, selection, topK);

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
    var streamFailed = false;
    try {
        fullAnswer = await generateAnswerStream(promptText, {
            onToken: function (token) {
                fullAnswer += token;
                if (onToken) onToken(token);
            },
            signal: signal
        });
        if (fullAnswer === null) {
            streamFailed = true;
        }
    } catch (error) {
        if (error?.isFinalProviderError) {
            console.warn('[RAG Engine] Final Gemini provider error: ' + error.message);
            throw error;
        }
        console.warn('[RAG Engine] Stream generation error: ' + error.message);
        streamFailed = true;
    }

    // Only use the non-streaming path for an actual recoverable stream failure.
    // A terminal Gemini key-pool failure is propagated immediately so the UI
    // can display the concise red error instead of waiting through another
    // generation attempt.
    if (streamFailed || !fullAnswer) {
        console.log('[RAG Engine] Streaming failed. Falling back to non-streaming generation...');
        try {
            fullAnswer = await generateAnswer(promptText);
        } catch (fbError) {
            if (fbError?.isFinalProviderError) throw fbError;
            console.warn('[RAG Engine] Non-streaming fallback failed: ' + fbError.message);
            fullAnswer = null;
        }
        if (!fullAnswer) {
            fullAnswer = 'I could not find this information in the selected dataset.';
        }
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
