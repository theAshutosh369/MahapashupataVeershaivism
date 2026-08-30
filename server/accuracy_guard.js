/**
 * Phase 2 — RAG accuracy layer.
 * Keeps source/evidence handling deterministic and independent of the LLM.
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

/** Build deterministic source-aware evidence records for the LLM and UI. */
export function buildEvidence(matched) {
    return (Array.isArray(matched) ? matched : []).map(sourceRecord).filter(source => source.text);
}

/**
 * Validate an answer against the retrieved evidence.
 * This is intentionally conservative: it never claims a statement is grounded
 * merely because a citation number exists. Quoted evidence must exist verbatim
 * (ignoring whitespace), while uncited prose must have meaningful lexical
 * support from the retrieved sources.
 */
export function validateGrounding(answer, matched) {
    const sources = buildEvidence(matched);
    const sourceByCitation = new Map(sources.map(source => [source.citationId, source]));
    const text = String(answer || '').trim();
    if (!text || !sources.length) {
        return { grounded: false, confidence: 0, citations: [], evidence: [], reasons: ['No answer or evidence available.'] };
    }

    const citationMatches = [...text.matchAll(/\[(\d+)\]/g)];
    const citations = [...new Set(citationMatches.map(match => Number(match[1])).filter(Number.isInteger))];
    const invalidCitations = citations.filter(id => !sourceByCitation.has(id));

    const quotedLines = [];
    for (const match of text.matchAll(/^>\s?(.*)$/gm)) {
        const line = String(match[1] || '').trim();
        if (line && !/^\[\d+\]$/.test(line)) quotedLines.push(line);
    }
    const quoteChecks = quotedLines.map(quote => {
        const normalizedQuote = matchText(quote);
        const exact = sources.some(source => matchText(source.text).includes(normalizedQuote));
        return { quote, exact };
    });
    const exactEvidence = quoteChecks.filter(item => item.exact).length;
    const exactEvidenceRatio = quoteChecks.length ? exactEvidence / quoteChecks.length : 1;

    const paragraphs = text
        .replace(/^>.*$/gm, '')
        .split(/\n\s*\n/)
        .map(part => part.replace(/\[\d+\]/g, '').trim())
        .filter(part => part.length >= 25);
    let supportedParagraphs = 0;
    for (const paragraph of paragraphs) {
        const best = Math.max(...sources.map(source => overlapScore(paragraph, source.text)), 0);
        if (best >= 0.20) supportedParagraphs++;
    }
    const supportRatio = paragraphs.length ? supportedParagraphs / paragraphs.length : 1;
    const citationCoverage = paragraphs.length ? Math.min(1, citations.length / paragraphs.length) : (citations.length ? 1 : 0.5);
    const retrievalQuality = Math.min(1, Math.max(0, sources.slice(0, 5).reduce((sum, source) => sum + Math.min(1, Math.max(0, source.retrievalScore)), 0) / Math.max(1, Math.min(5, sources.length))));

    const reasons = [];
    if (invalidCitations.length) reasons.push(`Invalid citation id(s): ${invalidCitations.join(', ')}`);
    if (quoteChecks.some(item => !item.exact)) reasons.push('One or more quoted passages are not exact evidence from the retrieved sources.');
    if (supportRatio < 0.50 && paragraphs.length > 0) reasons.push('Too much answer text lacks lexical support in the retrieved evidence.');

    const confidence = Math.round(Math.max(0, Math.min(1,
        retrievalQuality * 0.35 + supportRatio * 0.35 + exactEvidenceRatio * 0.20 + citationCoverage * 0.10
    )) * 100);
    const grounded = invalidCitations.length === 0 && exactEvidenceRatio >= 1 && (paragraphs.length === 0 || supportRatio >= 0.50);

    return {
        grounded,
        confidence,
        citations,
        invalidCitations,
        evidence: quoteChecks,
        sourceCount: sources.length,
        supportRatio,
        exactEvidenceRatio,
        citationCoverage,
        reasons
    };
}

/** Return only sources actually cited by the generated answer. */
export function extractCitedSources(answer, matched) {
    const sources = buildEvidence(matched);
    const ids = new Set([...String(answer || '').matchAll(/\[(\d+)\]/g)].map(match => Number(match[1])));
    return sources.filter(source => ids.has(source.citationId));
}

/** Deterministic confidence based on retrieval + grounding, with no LLM call. */
export function calculateConfidence(matched, validation = null) {
    const results = Array.isArray(matched) ? matched : [];
    if (!results.length) return 0;
    const retrieval = Math.max(...results.slice(0, 5).map(item => Number(item?.rerankScore ?? item?.score ?? item?.similarity ?? 0)).map(value => Math.min(1, Math.max(0, value))), 0);
    if (!validation) return Math.round(retrieval * 100);
    return Math.round(Math.min(1, retrieval * 0.45 + (validation.confidence / 100) * 0.55) * 100);
}
