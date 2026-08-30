/**
 * Phase 3 performance cache.
 * In-process only: safe for a single Node instance and deliberately bounded.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;

const answerCache = new Map();

function numberEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ttlMs() {
    return numberEnv('RAG_ANSWER_CACHE_TTL_MS', DEFAULT_TTL_MS);
}

function maxEntries() {
    return Math.max(10, Math.floor(numberEnv('RAG_ANSWER_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES)));
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => {
            out[key] = stableValue(value[key]);
            return out;
        }, {});
    }
    return value;
}

export function makeAnswerCacheKey({ query, datasetSelection, selectedDataset, topK, answerMode, includeConversationMemory }) {
    // Conversation-aware answers must never be shared across turns because the
    // conversation state is intentionally outside this cache key.
    if (includeConversationMemory) return null;
    return JSON.stringify(stableValue({
        query: String(query || '').trim(),
        datasetSelection: Array.isArray(datasetSelection) ? [...datasetSelection].sort() : null,
        selectedDataset: selectedDataset || '__ALL__',
        topK: Number(topK) || 10,
        answerMode: answerMode || 'detailed'
    }));
}

export function getCachedAnswer(key) {
    if (!key) return null;
    const entry = answerCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt >= ttlMs()) {
        answerCache.delete(key);
        return null;
    }
    // LRU: touching an entry moves it to the end.
    answerCache.delete(key);
    answerCache.set(key, entry);
    return entry.value;
}

export function setCachedAnswer(key, value) {
    if (!key || !value) return;
    answerCache.delete(key);
    answerCache.set(key, { createdAt: Date.now(), value });
    while (answerCache.size > maxEntries()) {
        const oldest = answerCache.keys().next().value;
        if (oldest === undefined) break;
        answerCache.delete(oldest);
    }
}

export function clearAnswerCache() {
    answerCache.clear();
    console.log('[Performance] Answer cache cleared');
}

export function getPerformanceCacheStats() {
    return {
        answerEntries: answerCache.size,
        answerTtlMs: ttlMs(),
        answerMaxEntries: maxEntries()
    };
}
