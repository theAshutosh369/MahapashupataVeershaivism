/**
 * Phase 2 — RAG accuracy layer.
 * Deterministic source/evidence validation. No additional LLM calls.
 */

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function matchText(value) {
    return normalizeText(value)
        .toLocaleLowerCase()
        .replace(/[।॥]/g, ' ')
        .replace(/[^\p{L}\p{N}\s'"_-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokens(value) {
    return matchText(value).split(/\s+/).filter(token => token.length >= 2);
}

function overlapScore(a, b) {
    const left = new Set(tokens(a));
    const right = new Set(tokens(b));
    if (!left.size || !right.size) return 0;
    let hits = 0;
    for (const token of left) if (right.has(token)) hits++;
    return hits / Math.max(1, left.size);
}

function sourceRecord(item, index) {
    const chunk = item?.chunk || item || {};
    return {
        id: chunk.id || `source-${index + 1}`,
        citationId: index + 1,
        dataset: chunk.dataset || null,
        sourceType: chunk.sourceType || null,
        filename: chunk.filename || chunk.file || null,
        source: chunk.source || null,
        title: chunk.title || null,
        author: chunk.author || null,
        page: chunk.page ?? null,
        vachanaNumber: chunk.vachanaNumber ?? null,
        language: chunk.language || null,
        text: String(chunk.text || ''),
        retrievalScore: Number(item?.rerankScore ?? item?.score ?? item?.similarity ?? 0)
    };
}

/** Build stable, source-aware records used by validation and the API/UI. */
export function buildEvidence(matched) {
    return (Array.isArray(matched) ? matched : [])
        .map(sourceRecord)
        .filter(source => source.text);
}

function citationIds(answer) {
    return [...new Set(
        [...String(answer || '').matchAll(/\[(\d+)\]/g)]
            .map(match => Number(match[1]))
            .filter(Number.isInteger)
    )];
}

function extractQuotedLines(answer) {
    const lines = [];
    for (const match of String(answer || '').matchAll(/^>\s?(.*)$/gm)) {
        const line = String(match[1] || '').trim();
        if (line && !/^\[\d+\]$/.test(line)) lines.push(line);
    }
    return lines;
}

function makeSourceExcerpt(source, maxLength = 320) {
    const text = normalizeText(source?.text || '');
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}

/**
 * Validate generated text against the exact retrieved source set.
 * Citations must point to real retrieved sources. Blockquoted original text
 * must occur verbatim after whitespace/punctuation normalization. Ordinary
 * prose is checked for lexical support rather than requiring word-for-word
 * overlap, because faithful paraphrasing is valid RAG output.
 */
export function validateGrounding(answer, matched) {
    const sources = buildEvidence(matched);
    const sourceByCitation = new Map(sources.map(source => [source.citationId, source]));
    const text = String(answer || '').trim();

    if (!text || !sources.length) {
        return {
            grounded: false,
            confidence: 0,
            citations: [],
            invalidCitations: [],
            evidence: [],
            citedSources: [],
            reasons: ['No answer or evidence available.'],
            sourceCount: sources.length,
            supportRatio: 0,
            exactEvidenceRatio: 0,
            citationCoverage: 0
        };
    }

    const citations = citationIds(text);
    const invalidCitations = citations.filter(id => !sourceByCitation.has(id));

    const quotedLines = extractQuotedLines(text);
    const quoteChecks = quotedLines.map(quote => {
        const normalizedQuote = matchText(quote);
        const matchingSource = sources.find(source => {
            const sourceText = matchText(source.text);
            return normalizedQuote.length >= 2 && sourceText.includes(normalizedQuote);
        });
        return {
            quote,
            exact: Boolean(matchingSource),
            citationId: matchingSource?.citationId || null,
            sourceId: matchingSource?.id || null
        };
    });

    const exactEvidence = quoteChecks.filter(item => item.exact).length;
    const exactEvidenceRatio = quoteChecks.length ? exactEvidence / quoteChecks.length : 1;

    const paragraphs = text
        .replace(/^>.*$/gm, '')
        .split(/\n\s*\n/)
        .map(part => part.replace(/\[\d+\]/g, '').trim())
        .filter(part => part.length >= 25);

    let supportedParagraphs = 0;
    const paragraphEvidence = [];
    for (const paragraph of paragraphs) {
        let bestScore = 0;
        let bestSource = null;
        for (const source of sources) {
            const score = overlapScore(paragraph, source.text);
            if (score > bestScore) {
                bestScore = score;
                bestSource = source;
            }
        }
        if (bestScore >= 0.20) supportedParagraphs++;
        paragraphEvidence.push({
            excerpt: paragraph.length > 280 ? paragraph.slice(0, 280) + '...' : paragraph,
            supported: bestScore >= 0.20,
            overlap: Math.round(bestScore * 100) / 100,
            citationId: bestSource?.citationId || null,
            sourceId: bestSource?.id || null
        });
    }

    const supportRatio = paragraphs.length ? supportedParagraphs / paragraphs.length : 1;
    const citedParagraphs = paragraphs.filter(paragraph => /\[\d+\]/.test(paragraph)).length;
    const citationCoverage = paragraphs.length
        ? citedParagraphs / paragraphs.length
        : (citations.length ? 1 : 0.5);

    const retrievalQuality = Math.min(1, Math.max(0,
        sources.slice(0, 5).reduce((sum, source) => sum + Math.min(1, Math.max(0, source.retrievalScore)), 0)
        / Math.max(1, Math.min(5, sources.length))
    ));

    const reasons = [];
    if (invalidCitations.length) reasons.push(`Invalid citation id(s): ${invalidCitations.join(', ')}`);
    if (quoteChecks.some(item => !item.exact)) reasons.push('One or more quoted passages are not exact evidence from the retrieved sources.');
    if (supportRatio < 0.50 && paragraphs.length > 0) reasons.push('Too much answer text lacks lexical support in the retrieved evidence.');

    const confidence = Math.round(Math.max(0, Math.min(1,
        retrievalQuality * 0.35 + supportRatio * 0.35 + exactEvidenceRatio * 0.20 + citationCoverage * 0.10
    )) * 100);

    const grounded = invalidCitations.length === 0
        && exactEvidenceRatio >= 1
        && (paragraphs.length === 0 || supportRatio >= 0.50);

    const citedSources = sources.filter(source => citations.includes(source.citationId)).map(source => ({
        id: source.id,
        citationId: source.citationId,
        dataset: source.dataset,
        sourceType: source.sourceType,
        filename: source.filename,
        source: source.source,
        title: source.title,
        author: source.author,
        page: source.page,
        vachanaNumber: source.vachanaNumber,
        language: source.language,
        retrievalScore: source.retrievalScore,
        excerpt: makeSourceExcerpt(source)
    }));

    const exactEvidenceRecords = quoteChecks
        .filter(item => item.exact)
        .map(item => ({
            quote: item.quote,
            citationId: item.citationId,
            sourceId: item.sourceId
        }));

    return {
        grounded,
        confidence,
        citations,
        invalidCitations,
        evidence: exactEvidenceRecords,
        paragraphEvidence,
        citedSources,
        sourceCount: sources.length,
        supportRatio,
        exactEvidenceRatio,
        citationCoverage,
        reasons
    };
}

/** Return only sources explicitly cited by the generated answer. */
export function extractCitedSources(answer, matched) {
    const sources = buildEvidence(matched);
    const ids = new Set(citationIds(answer));
    return sources.filter(source => ids.has(source.citationId)).map(source => ({
        ...source,
        text: undefined,
        excerpt: makeSourceExcerpt(source)
    }));
}

/** Deterministic confidence combining retrieval quality and grounding quality. */
export function calculateConfidence(matched, validation = null) {
    const results = Array.isArray(matched) ? matched : [];
    if (!results.length) return 0;
    const retrieval = Math.max(...results.slice(0, 5)
        .map(item => Number(item?.rerankScore ?? item?.score ?? item?.similarity ?? 0))
        .map(value => Math.min(1, Math.max(0, value))), 0);
    if (!validation) return Math.round(retrieval * 100);
    return Math.round(Math.min(1,
        retrieval * 0.45 + (validation.confidence / 100) * 0.55
    ) * 100);
}
