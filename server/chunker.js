/**
 * Token-aware chunker with overlap.
 * Splits text into chunks of target ~500-800 tokens with ~100-150 token overlap.
 * Since we don't have access to a tokenizer, we approximate:
 * - English: ~4 characters per token
 * - Kannada/Devanagari: ~2 characters per token (UTF-8 wide chars)
 * - Mixed: weighted average (~3 chars/token)
 */

import path from 'node:path';

const TARGET_CHUNK_TOKENS = 700;
const OVERLAP_TOKENS = 120;
const MAX_CHUNK_TOKENS = 800;

const SOURCE_FIELDS = ['translation', 'english', 'kannada', 'transliteration', 'hindi', 'sanskrit', 'tamil', 'telugu'];

// ─── Debug flag ────────────────────────────────────────────────────────────
const DEBUG = false;

function debugLog(...args) {
    if (DEBUG) console.log('[CHUNKER]', ...args);
}

function getMemMB() {
    if (!DEBUG) return 0;
    try {
        const u = process.memoryUsage();
        return Math.round(u.heapUsed / 1024 / 1024);
    } catch (e) {
        return -1;
    }
}

function estimateTokens(text) {
    return Math.ceil((String(text || '').length) / 3);
}

function estimateChars(tokenCount) {
    return tokenCount * 3;
}

function splitTextIntoChunks(text) {
    const chunks = [];
    if (!text || String(text).trim().length === 0) return chunks;

    const fullText = String(text);
    const estimatedTotalTokens = estimateTokens(fullText);

    if (estimatedTotalTokens <= MAX_CHUNK_TOKENS) {
        chunks.push({
            text: fullText,
            chunkIndex: 0,
            totalChunks: 1,
            tokenCount: estimatedTotalTokens
        });
        return chunks;
    }

    const targetChars = estimateChars(TARGET_CHUNK_TOKENS);
    const overlapChars = estimateChars(OVERLAP_TOKENS);
    let startPos = 0;
    let chunkIndex = 0;
    let iterCount = 0;
    const MAX_ITER = 10000;
    let prevStart = -1;
    let prevEnd = -1;
    let stallCount = 0;

    while (startPos < fullText.length) {
        iterCount++;
        if (iterCount > MAX_ITER) {
            const mem = process.memoryUsage();
            throw new Error('[CHUNKER] splitTextIntoChunks exceeded ' + MAX_ITER +
                ' iterations. textLen=' + fullText.length + ' targetChars=' + targetChars +
                ' overlapChars=' + overlapChars + ' startPos=' + startPos +
                ' chunks=' + chunkIndex + ' heap=' + Math.round(mem.heapUsed / 1024 / 1024) + 'MB');
        }

        let endPos = Math.min(startPos + targetChars, fullText.length);

        // INFINITE LOOP DETECTION: if startPos and endPos are identical to previous iteration,
        // we're stuck producing the same chunk forever
        if (prevStart === startPos && prevEnd === endPos) {
            stallCount++;
            if (stallCount > 3) {
                throw new Error('[CHUNKER] splitTextIntoChunks: startPos=' + startPos +
                    ' endPos=' + endPos + ' repeated for ' + stallCount +
                    ' iterations. Bug: overlapChars=' + overlapChars + ' causes a non-advancing tail loop. ' +
                    'Text length=' + fullText.length + ' chars=' + (fullText.length - startPos) + ' remaining.');
            }
        } else {
            stallCount = 0;
        }
        prevStart = startPos;
        prevEnd = endPos;

        // Log every 100 iterations to track progress
        if (DEBUG && iterCount % 100 === 0) {
            debugLog('iter=' + iterCount + ' start=' + startPos + ' end=' + endPos +
                ' remaining=' + (fullText.length - startPos) + ' chunks=' + chunkIndex +
                ' heap=' + getMemMB() + 'MB');
        }

        if (endPos < fullText.length) {
            const searchStart = Math.max(startPos, endPos - 200);
            const searchRegion = fullText.slice(searchStart, endPos);

            let breakAt = searchRegion.lastIndexOf('\n\n');
            if (breakAt === -1 || breakAt < 50) breakAt = searchRegion.lastIndexOf('\n');
            if (breakAt === -1 || breakAt < 50) breakAt = searchRegion.lastIndexOf('. ');
            if (breakAt === -1 || breakAt < 50) breakAt = searchRegion.lastIndexOf('? ');
            if (breakAt === -1 || breakAt < 50) breakAt = searchRegion.lastIndexOf('! ');
            if (breakAt === -1 || breakAt < 50) breakAt = searchRegion.lastIndexOf(' | ');
            if (breakAt === -1 || breakAt < 50) breakAt = targetChars;

            endPos = searchStart + breakAt + 1;
        }

        const chunkText = fullText.slice(startPos, endPos).trim();
        if (chunkText) {
            chunks.push({
                text: chunkText,
                chunkIndex,
                totalChunks: 0,
                tokenCount: estimateTokens(chunkText)
            });
            chunkIndex++;
        }

        startPos = endPos - overlapChars;
        if (startPos < 0) startPos = 0;

        // Verify forward progress
        if (iterCount > 1 && startPos <= prevStart) {
            throw new Error('[CHUNKER] splitTextIntoChunks: startPos did not advance. ' +
                'prevStart=' + prevStart + ' newStart=' + startPos + ' endPos=' + endPos +
                ' overlapChars=' + overlapChars + ' textLen=' + fullText.length);
        }

        // Break conditions: catch the infinite tail loop in the original code
        if (endPos >= fullText.length) break;
        if (startPos >= fullText.length - 1) break;
    }

    debugLog('split complete: iter=' + iterCount + ' chunks=' + chunkIndex +
        ' textLen=' + fullText.length);

    if (chunkIndex > 10000) {
        throw new Error('[CHUNKER] splitTextIntoChunks produced ' + chunkIndex +
            ' chunks — runaway loop from text length ' + fullText.length);
    }

    for (const chunk of chunks) {
        chunk.totalChunks = chunks.length;
    }

    return chunks;
}

/**
 * Build chunk text for embedding — semantic content only, no metadata prefixes.
 * Metadata (title, author, page) is stored separately in chunk fields.
 */
function buildChunkText(row, metadata) {
    const pieces = [];

    for (const field of SOURCE_FIELDS) {
        const value = row?.[field];
        if (value === null || value === undefined || String(value).trim() === '') continue;
        pieces.push(field + ': ' + String(value).trim());
    }

    if (pieces.length === 0) {
        return Object.entries(row || {})
            .filter(([_, value]) => value !== null && value !== undefined && String(value).trim() !== '')
            .map(([key, value]) => key + ': ' + String(value).trim())
            .join(' | ') || 'No indexed text available.';
    }

    return pieces.join('\n');
}

export function chunkDatasetFile(relPath, json) {
    const chunks = [];
    if (!json || typeof json !== 'object') return chunks;
    const items = Array.isArray(json.data) ? json.data : [];
    const title = String(json.name || path.basename(relPath)).trim();

    debugLog('chunkDatasetFile: file=' + relPath + ' items=' + items.length);
    let memCheckCount = 0;

    for (let i = 0; i < items.length; i += 1) {
        const row = items[i] ?? {};
        const page = Number(row.page) || null;
        const vachanaNumber = row.number ?? row.page ?? i + 1;
        const author = String(row.author || title).trim();
        const language = SOURCE_FIELDS.find((field) =>
            row[field] !== undefined && row[field] !== null && String(row[field]).trim() !== ''
        ) || 'unknown';

        const fullText = buildChunkText(row, { title, author, page, language });

        // Log every 5 vachanas when DEBUG is on
        memCheckCount++;
        if (DEBUG && (memCheckCount % 5 === 0 || i === items.length - 1)) {
            debugLog('processing vachana ' + (i + 1) + '/' + items.length +
                ' textLen=' + fullText.length + ' chunksSoFar=' + chunks.length +
                ' heap=' + getMemMB() + 'MB');
        }

        const textChunks = splitTextIntoChunks(fullText);

        for (const textChunk of textChunks) {
            chunks.push({
                id: relPath + '#p' + (page ?? i + 1) + '#v' + vachanaNumber + '#c' + textChunk.chunkIndex,
                dataset: relPath,
                page,
                vachanaNumber,
                author,
                title,
                language,
                chunkIndex: textChunk.chunkIndex,
                totalChunks: textChunk.totalChunks,
                tokenCount: textChunk.tokenCount,
                text: textChunk.text
            });
        }
    }

    debugLog('chunkDatasetFile done: file=' + relPath + ' vachanas=' + items.length +
        ' chunks=' + chunks.length);

    if (chunks.length > 10000) {
        throw new Error('[CHUNKER] chunkDatasetFile produced ' + chunks.length +
            ' chunks from ' + items.length + ' vachanas — runaway detected.');
    }

    return chunks;
}

export function chunkAuthorFile(relPath, json) {
    const chunks = [];
    if (!json || typeof json !== 'object') return chunks;
    const vachanas = Array.isArray(json.vachanas) ? json.vachanas : [];
    const authorName = String(json.name || path.basename(relPath)).trim();

    debugLog('chunkAuthorFile: file=' + relPath + ' vachanas=' + vachanas.length);
    let memCheckCount = 0;

    for (let i = 0; i < vachanas.length; i += 1) {
        const record = vachanas[i] ?? {};
        const page = Number(record.page || record.number) || null;
        const vachanaNumber = record.number ?? record.page ?? i + 1;
        const language = SOURCE_FIELDS.find((field) =>
            record[field] !== undefined && record[field] !== null && String(record[field]).trim() !== ''
        ) || 'unknown';

        const fullText = buildChunkText(record, {
            title: authorName,
            author: authorName,
            page,
            language
        });

        // Log every 5 vachanas when DEBUG is on
        memCheckCount++;
        if (DEBUG && (memCheckCount % 5 === 0 || i === vachanas.length - 1)) {
            debugLog('processing vachana ' + (i + 1) + '/' + vachanas.length +
                ' textLen=' + fullText.length + ' chunksSoFar=' + chunks.length +
                ' heap=' + getMemMB() + 'MB');
        }

        const textChunks = splitTextIntoChunks(fullText);

        for (const textChunk of textChunks) {
            chunks.push({
                id: relPath + '#p' + (page ?? i + 1) + '#v' + vachanaNumber + '#c' + textChunk.chunkIndex,
                dataset: relPath,
                page,
                vachanaNumber,
                author: authorName,
                title: authorName,
                language,
                chunkIndex: textChunk.chunkIndex,
                totalChunks: textChunk.totalChunks,
                tokenCount: textChunk.tokenCount,
                text: textChunk.text
            });
        }
    }

    debugLog('chunkAuthorFile done: file=' + relPath + ' vachanas=' + vachanas.length +
        ' chunks=' + chunks.length);

    if (chunks.length > 10000) {
        throw new Error('[CHUNKER] chunkAuthorFile produced ' + chunks.length +
            ' chunks from ' + vachanas.length + ' vachanas — runaway detected.');
    }

    return chunks;
}
