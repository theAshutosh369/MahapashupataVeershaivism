/**
 * Hybrid Search Engine
 * Combines semantic (cosine similarity) + keyword + fuzzy search with boosting.
 * When chunks have no embeddings, falls back to keyword+fuzzy search.
 */

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    return normalizeText(text)
        .split(/\s+/)
        .filter(function (t) { return t.length > 0; });
}

/**
 * Levenshtein distance (for fuzzy matching).
 */
function levenshteinDistance(a, b) {
    var m = a.length;
    var n = b.length;
    var dp = [];
    for (var di = 0; di <= m; di++) {
        dp[di] = [];
        for (var dj = 0; dj <= n; dj++) dp[di][dj] = 0;
    }
    for (var i = 0; i <= m; i++) dp[i][0] = i;
    for (var j = 0; j <= n; j++) dp[0][j] = j;

    for (var i2 = 1; i2 <= m; i2++) {
        for (var j2 = 1; j2 <= n; j2++) {
            var cost = a[i2 - 1] === b[j2 - 1] ? 0 : 1;
            dp[i2][j2] = Math.min(
                dp[i2 - 1][j2] + 1,
                dp[i2][j2 - 1] + 1,
                dp[i2 - 1][j2 - 1] + cost
            );
        }
    }
    return dp[m][n];
}

/**
 * Check if text contains Kannada characters.
 */
function hasKannada(text) {
    return /[\u0C80-\u0CFF]/.test(text);
}

/**
 * Check if text looks like a transliteration.
 */
function isTransliteration(text) {
    var patterns = [
        /\b[aāeēiīoōuū][nṇlḷrṛsṣśtṭdḍ]\b/i,
        /[ṅñṇḍṭṛṣśḷ]/,
        /(?:ara|ana|aya|āya|eśa|īśa|iśa|ēśvara)/i,
        /[kgcjṭḍtdpb][hv]/,
    ];
    for (var pi = 0; pi < patterns.length; pi++) {
        if (patterns[pi].test(text)) return true;
    }
    return false;
}

/**
 * Check if token is a proper noun.
 */
function isProperNoun(token) {
    if (/^[A-Z][a-zāīūōṛṣśṇḷ]+$/.test(token)) return true;
    if (/^[\u0C80-\u0CFF]{2,}$/.test(token)) return true;
    return false;
}

/**
 * Get searchable text for a chunk.
 */
function getSearchableText(chunk) {
    var parts = [
        chunk.dataset,
        chunk.author,
        chunk.title,
        chunk.language,
        String(chunk.page != null ? chunk.page : ''),
        String(chunk.vachanaNumber != null ? chunk.vachanaNumber : ''),
        chunk.text
    ];
    var filtered = [];
    for (var pi = 0; pi < parts.length; pi++) {
        if (parts[pi] != null && parts[pi] !== '') filtered.push(parts[pi]);
    }
    return filtered.join(' ');
}

/**
 * Compute keyword overlap score.
 */
function computeKeywordScore(queryTokens, chunk) {
    var chunkText = normalizeText(getSearchableText(chunk));
    var matches = 0;
    for (var ti = 0; ti < queryTokens.length; ti++) {
        if (chunkText.indexOf(queryTokens[ti]) !== -1) matches += 1;
    }
    return queryTokens.length > 0 ? matches / queryTokens.length : 0;
}

/**
 * Compute fuzzy match score.
 */
function computeFuzzyScore(queryTokens, chunk) {
    var chunkText = normalizeText(getSearchableText(chunk));
    var chunkTokens = tokenize(chunkText);

    if (queryTokens.length === 0 || chunkTokens.length === 0) return 0;

    var totalScore = 0;
    for (var qi = 0; qi < queryTokens.length; qi++) {
        var qt = queryTokens[qi];
        if (qt.length < 3) continue;
        var bestScore = 0;
        for (var ci = 0; ci < chunkTokens.length; ci++) {
            var ct = chunkTokens[ci];
            if (ct.length < 3) continue;
            var dist = levenshteinDistance(qt, ct);
            var maxLen = Math.max(qt.length, ct.length);
            var similarity = 1 - (dist / maxLen);
            if (similarity > bestScore) bestScore = similarity;
        }
        totalScore += bestScore;
    }
    return totalScore / queryTokens.length;
}

/**
 * Compute boost score for metadata/entity matches.
 */
function computeBoost(queryTokens, chunk) {
    var boost = 0;
    var authorNorm = normalizeText(chunk.author || '');
    var titleNorm = normalizeText(chunk.title || '');
    var datasetNorm = normalizeText(chunk.dataset || '');

    for (var ti = 0; ti < queryTokens.length; ti++) {
        var token = queryTokens[ti];
        if (authorNorm.indexOf(token) !== -1 || titleNorm.indexOf(token) !== -1) boost += 0.3;
        if (isProperNoun(token) && datasetNorm.indexOf(token) !== -1) boost += 0.2;
        if (hasKannada(token) && hasKannada(chunk.text || '')) boost += 0.15;
        if (isTransliteration(token)) boost += 0.1;
    }

    return Math.min(boost, 0.5);
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    var dot = 0;
    var magA = 0;
    var magB = 0;
    for (var i = 0; i < a.length; i += 1) {
        var x = Number(a[i]) || 0;
        var y = Number(b[i]) || 0;
        dot += x * y;
        magA += x * x;
        magB += y * y;
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Check if any chunk has valid embeddings.
 */
function hasValidEmbeddings(chunks) {
    for (var ci = 0; ci < chunks.length; ci++) {
        if (Array.isArray(chunks[ci].embedding) && chunks[ci].embedding.length > 0) return true;
    }
    return false;
}

/**
 * Hybrid search: semantic (0.5) + keyword (0.25) + fuzzy (0.15) + boost (0.10).
 * If no chunks have embeddings, falls back to keyword+fuzzy only.
 * Retrieve 25, rerank, return topK.
 */
export function hybridSearch(queryEmbedding, query, chunks, opts) {
    if (!opts) opts = {};
    var topK = opts.topK || 10;
    var retrieveK = opts.retrieveK || 25;

    if (!chunks || chunks.length === 0) {
        return [];
    }

    var queryTokens = tokenize(query);
    var useEmbeddings = queryEmbedding && Array.isArray(queryEmbedding) && queryEmbedding.length > 0 && hasValidEmbeddings(chunks);

    if (!useEmbeddings) {
        console.log('[hybridSearch] No embeddings available, using keyword+fuzzy search');
        return keywordSearch(query, chunks, { topK: topK });
    }

    var scored = [];
    for (var ci = 0; ci < chunks.length; ci++) {
        var chunk = chunks[ci];
        var semanticScore = 0;
        if (Array.isArray(chunk.embedding) && chunk.embedding.length > 0) {
            semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
        }
        var keywordScore = computeKeywordScore(queryTokens, chunk);
        var fuzzyScore = computeFuzzyScore(queryTokens, chunk);
        var boost = computeBoost(queryTokens, chunk);
        var combinedScore = (semanticScore * 0.50) + (keywordScore * 0.25) + (fuzzyScore * 0.15) + (boost * 0.10);

        scored.push({
            chunk: chunk,
            similarity: semanticScore,
            keywordScore: keywordScore,
            fuzzyScore: fuzzyScore,
            boost: boost,
            score: combinedScore
        });
    }

    scored.sort(function (a, b) { return b.score - a.score; });

    var retrieved = scored.slice(0, retrieveK);

    var seen = new Set();
    var reranked = [];
    for (var si = 0; si < retrieved.length; si++) {
        var item = retrieved[si];
        var id = item.chunk.id;
        if (seen.has(id)) continue;
        seen.add(id);
        reranked.push(item);
        if (reranked.length >= topK) break;
    }

    return reranked;
}

/**
 * Pure keyword search (fallback when no embeddings).
 */
export function keywordSearch(query, chunks, opts) {
    if (!opts) opts = {};
    var topK = opts.topK || 10;

    if (!chunks || chunks.length === 0 || !query) return [];

    var queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    var scored = [];
    for (var ci = 0; ci < chunks.length; ci++) {
        var chunk = chunks[ci];
        var keywordScore = computeKeywordScore(queryTokens, chunk);
        var fuzzyScore = computeFuzzyScore(queryTokens, chunk);
        var boost = computeBoost(queryTokens, chunk);
        var score = (keywordScore * 0.55) + (fuzzyScore * 0.25) + (boost * 0.20);

        scored.push({
            chunk: chunk,
            similarity: keywordScore,
            keywordScore: keywordScore,
            fuzzyScore: fuzzyScore,
            boost: boost,
            score: score
        });
    }

    scored.sort(function (a, b) { return b.score - a.score; });

    var seen = new Set();
    var results = [];
    for (var si = 0; si < scored.length; si++) {
        var item = scored[si];
        if (item.score === 0) break;
        if (seen.has(item.chunk.id)) continue;
        seen.add(item.chunk.id);
        results.push(item);
        if (results.length >= topK) break;
    }

    return results;
}
