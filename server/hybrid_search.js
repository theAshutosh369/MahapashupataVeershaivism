import { hybridSearch as legacyHybridSearch, keywordSearch as legacyKeywordSearch } from './hybrid_search_legacy.js';

const STOP_WORDS = new Set([
    'a','an','the','is','are','was','were','be','been','being','who','what','which','when','where','why','how','whom','whose',
    'do','does','did','done','has','have','had','of','to','in','on','at','for','with','by','from','as','and','or','but','not',
    'no','yes','so','it','its','he','she','they','them','we','you','i','this','that','these','those','am','will','would','can',
    'could','should','may','might','tell','about','give','me','some','info','information','explain','describe'
]);

function normalize(value) {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function searchable(chunk) {
    return normalize([
        chunk?.dataset, chunk?.author, chunk?.title, chunk?.language,
        chunk?.filename, chunk?.text
    ].filter(Boolean).join(' '));
}

function queryTokens(query) {
    return normalize(query).split(/\s+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

// The legacy scorer is intentionally preserved, but it is quadratic-ish for
// large candidate sets because fuzzy matching compares every query token with
// every chunk token. Keep that expensive scorer focused on a small, highly
// relevant lexical candidate pool. This is the compatibility optimization that
// lets the old RAG orchestration work with large sharded indexes safely.
function narrowCandidates(query, chunks, limit = 250) {
    if (!Array.isArray(chunks) || chunks.length <= limit) return chunks || [];
    const tokens = queryTokens(query);
    if (!tokens.length) return chunks.slice(0, limit);

    const scored = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const text = searchable(chunk);
        let score = 0;
        for (const token of tokens) {
            if (text.includes(token)) score += 4;
            else {
                const words = text.split(/\s+/);
                for (const word of words) {
                    if (word.startsWith(token) && token.length >= 5) { score += 2; break; }
                }
            }
            if (chunk?.author && normalize(chunk.author).includes(token)) score += 3;
            if (chunk?.title && normalize(chunk.title).includes(token)) score += 3;
        }
        if (score > 0) scored.push({ chunk, score });
    }

    if (!scored.length) return chunks.slice(0, limit);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(item => item.chunk);
}

export function hybridSearch(queryEmbedding, query, chunks, opts = {}) {
    const pool = narrowCandidates(query, chunks, Math.max(100, Math.min(400, Number(opts.retrieveK || 50) * 5)));
    return legacyHybridSearch(queryEmbedding, query, pool, {
        ...opts,
        retrieveK: Math.min(Number(opts.retrieveK || 50), pool.length),
        topK: Math.min(Number(opts.topK || 10), pool.length)
    });
}

export function keywordSearch(query, chunks, opts = {}) {
    const pool = narrowCandidates(query, chunks, Math.max(100, Math.min(400, Number(opts.topK || 10) * 20)));
    return legacyKeywordSearch(query, pool, opts);
}
