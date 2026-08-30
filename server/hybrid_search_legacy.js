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
 *
 * A query token counts as a match if it appears verbatim in the chunk's
 * searchable text, OR if it is a prefix/substring of a token in the chunk
 * (e.g. query "renukacharya" matches chunk token "renuka"). This handles
 * compound Sanskrit/Kannada names that are spelled slightly differently in
 * the source text.
 */
var STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'who', 'what', 'which',
    'when', 'where', 'why', 'how', 'whom', 'whose', 'do', 'does', 'did', 'done', 'has', 'have',
    'had', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'and', 'or', 'but',
    'not', 'no', 'yes', 'so', 'it', 'its', 'he', 'she', 'they', 'them', 'we', 'you', 'i', 'this',
    'that', 'these', 'those', 'am', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
    'tell', 'tellme', 'about', 'give', 'me', 'some', 'info', 'information', 'explain', 'describe'
]);

function isStopWord(token) {
    return STOP_WORDS.has(token);
}

/**
 * Check whether a query token shares a meaningful common prefix with any chunk
 * token. This matches compound names spelled slightly differently in the
 * source, e.g. query "renukacharya" matches chunk token "renuka" (a prefix),
 * while common suffixes like "acharya" are deliberately NOT matched because
 * they are not a leading portion of the query name.
 */
function tokenHasSubstringMatch(queryToken, chunkTokens) {
    if (queryToken.length < 5) return false;
    for (var ti = 0; ti < chunkTokens.length; ti++) {
        var ct = chunkTokens[ti];
        if (ct.length < 5) continue;
        var shorter = queryToken.length < ct.length ? queryToken : ct;
        var longer = queryToken.length < ct.length ? ct : queryToken;
        // The shorter token must be a prefix of the longer one AND be at least
        // half the length of the longer, so "renuka" (6) matches "renukacharya"
        // (12) but the suffix "acharya" (7) does not.
        if (longer.indexOf(shorter) === 0 && shorter.length >= longer.length * 0.5) {
            return true;
        }
    }
    return false;
}

/**
 * Compute keyword overlap score.
 *
 * A query token counts as a match if it appears verbatim in the chunk's
 * searchable text, OR (for meaningful, non-stop tokens length >= 5) if it is
 * a prefix/substring of a chunk token. Stop-words are down-weighted so a query
 * like "who is renukacharya" is scored primarily by "renukacharya".
 */
function computeKeywordScore(queryTokens, chunk) {
    var chunkText = normalizeText(getSearchableText(chunk));
    var chunkTokens = tokenize(chunkText);

    // Split query tokens into meaningful names/entities and stop/generic words.
    var meaningful = [];
    var generic = [];
    for (var ti = 0; ti < queryTokens.length; ti++) {
        var qt = queryTokens[ti];
        if (!isStopWord(qt)) meaningful.push(qt);
        else generic.push(qt);
    }

    var meaningfulMatches = 0;
    for (var mi = 0; mi < meaningful.length; mi++) {
        var mq = meaningful[mi];
        if (chunkText.indexOf(mq) !== -1) {
            meaningfulMatches += 1;
        } else if (tokenHasSubstringMatch(mq, chunkTokens)) {
            meaningfulMatches += 1;
        }
    }
    var meaningfulScore = meaningful.length > 0 ? meaningfulMatches / meaningful.length : 0;

    var genericMatches = 0;
    for (var gi = 0; gi < generic.length; gi++) {
        if (chunkText.indexOf(generic[gi]) !== -1) genericMatches += 1;
    }
    var genericScore = generic.length > 0 ? genericMatches / generic.length : 0;

    // Meaningful (entity/name) tokens dominate the score; generic words are
    // a small tie-breaker so verbatim-phrase chunks still edge ahead.
    return (meaningfulScore * 0.85) + (genericScore * 0.15);
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
 *
 * A strong, dedicated boost is given when a meaningful query token (e.g. a
 * proper noun like "renukacharya") matches the chunk text verbatim or via a
 * shared prefix (e.g. "renuka"). This ensures that specific entity queries
 * surface the genuinely relevant chunks even when the semantic (embedding)
 * score is noisy.
 */
function computeBoost(queryTokens, chunk) {
    var boost = 0;
    var authorNorm = normalizeText(chunk.author || '');
    var titleNorm = normalizeText(chunk.title || '');
    var datasetNorm = normalizeText(chunk.dataset || '');
    var chunkTextNorm = normalizeText(chunk.text || '');
    var chunkTokens = tokenize(chunk.text || '');

    for (var ti = 0; ti < queryTokens.length; ti++) {
        var token = queryTokens[ti];
        if (isStopWord(token)) continue;
        if (authorNorm.indexOf(token) !== -1 || titleNorm.indexOf(token) !== -1) boost += 0.3;
        if (isProperNoun(token) && datasetNorm.indexOf(token) !== -1) boost += 0.2;
        if (hasKannada(token) && hasKannada(chunk.text || '')) boost += 0.15;
        if (isTransliteration(token)) boost += 0.1;

        // Strong boost when the named entity appears in the chunk text
        // (verbatim or via a shared prefix for compound names).
        if (token.length >= 5) {
            if (chunkTextNorm.indexOf(token) !== -1) {
                boost += 0.45;
            } else if (tokenHasSubstringMatch(token, chunkTokens)) {
                boost += 0.4;
            }
        }
    }

    return Math.min(boost, 0.9);
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
    if ((!Array.isArray(a) && !(a instanceof Float32Array)) || (!Array.isArray(b) && !(b instanceof Float32Array)) || a.length !== b.length) return 0;
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
        var e = chunks[ci].embedding;
        if ((Array.isArray(e) || e instanceof Float32Array) && e.length > 0) return true;
    }
    return false;
}

/**
 * Hybrid search: semantic (0.25) + keyword (0.35) + fuzzy (0.15) + boost (0.25).
 * If no chunks have embeddings, falls back to keyword+fuzzy only.
 * Retrieve 50, rerank, return topK.
 *
 * Keyword and boost are weighted more heavily than the raw semantic score so
 * that specific entity queries (e.g. "who is renukacharya") surface the
 * genuinely relevant chunks even when the embedding similarity is noisy.
 */
export function hybridSearch(queryEmbedding, query, chunks, opts) {
    if (!opts) opts = {};
    var topK = opts.topK || 10;
    var retrieveK = opts.retrieveK || 50;

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
        var ce = chunk.embedding;
        if ((Array.isArray(ce) || ce instanceof Float32Array) && ce.length > 0) {
            semanticScore = cosineSimilarity(queryEmbedding, ce);
        }
        var keywordScore = computeKeywordScore(queryTokens, chunk);
        var fuzzyScore = computeFuzzyScore(queryTokens, chunk);
        var boost = computeBoost(queryTokens, chunk);
        var combinedScore = (semanticScore * 0.25) + (keywordScore * 0.35) + (fuzzyScore * 0.15) + (boost * 0.25);

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
