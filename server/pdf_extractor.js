/**
 * PDF Extractor — Extracts per-page text from PDF files.
 *
 * THREE-MODE SMART EXTRACTION PIPELINE:
 *
 *   Mode 1 (UNICODE):  PDF has a proper Unicode text layer.
 *                       → extractText() output is used directly.
 *
 *   Mode 2 (LEGACY):   PDF has a text layer but uses a legacy Hindi font
 *                       (Krutidev / Shusha / Chanakya / Akruti Dev Priya…).
 *                       The glyph codes are NOT Unicode — they are Latin-1
 *                       codepoints that only render as Devanagari via the
 *                       font's cmap.
 *                       → For standard Krutidev 010, apply krutidevToUnicode().
 *                       → For ambiguous encodings (e.g. Akruti Dev Priya,
 *                         whose mapping is context-dependent and lossy),
 *                         render the page as an image and OCR it.
 *
 *   Mode 3 (SCANNED):  PDF page is a pure scanned image (no text layer, or a
 *                       negligible amount of text).
 *                       → render the page via pdfjs + @napi-rs/canvas, then
 *                         OCR with tesseract.js.
 *
 * DECISION GATE (per page):
 *   1. Extract text via pdfjs-dist getTextContent().
 *   2. If it contains real Unicode Devanagari → index as-is (Mode 1).
 *   3. Else if it looks like a legacy Hindi font:
 *        a. Run krutidevToUnicode(). If output has good Devanagari ratio → use it.
 *        b. Else → OCR the page (Mode 3).
 *   4. Else if page text is very short (scanned/empty) → OCR the page (Mode 3).
 *   5. Otherwise use the extracted text as-is.
 *
 * OCR is the LAST resort — never applied to pages that already yield usable
 * Unicode, because it is slow and less accurate for Sanskrit/Devanagari.
 *
 * Backend: pdfjs-dist (legacy build for Node.js) — NOT unpdf (which produces
 *   "Math.sumPrecise is not a function" on Node 22).
 *
 * API:
 *   extractPdf(pdfBuffer, options) → {
 *     totalPages: number,
 *     pages: [{ page, text, source: 'unicode'|'legacy'|'ocr', ocrUsed?: boolean }],
 *     title: string | null,
 *     author: string | null,
 *     metadata: object
 *   }
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLegacyHindiText, krutidevToUnicode } from './krutidev.js';

const MAX_PDF_BYTES = Number(process.env.RAG_PDF_MAX_BYTES || 1024 * 1024 * 1024); // 1 GB default

// OCR gating
const OCR_ENABLED = process.env.RAG_PDF_OCR_ENABLED !== '0'; // default: enabled
const OCR_MIN_CHARS = Number(process.env.RAG_PDF_OCR_MIN_CHARS || 50); // pages with < 50 usable chars get OCR
const OCR_SCALE = Number(process.env.RAG_PDF_OCR_DPI || 150) / 72; // ~150 DPI default
const OCR_MAX_PAGES = Number(process.env.RAG_PDF_OCR_MAX_PAGES || 2000); // safety cap
const OCR_LANGS = (process.env.RAG_PDF_OCR_LANGS || 'eng+hin').split(',').join('+');

const DEVANAGARI_RE = /[\u0900-\u097F]/;
const LEGACY_RATIO_THRESHOLD = 0.5; // fraction of Devanagari needed to trust conversion

// ─── Tesseract worker singleton (created lazily, reused across pages) ───────
let ocrWorker = null;
let ocrWorkerPromise = null;

async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (ocrWorkerPromise) return ocrWorkerPromise;

    ocrWorkerPromise = (async () => {
        try {
            const { createWorker } = await import('tesseract.js');
            const worker = await createWorker(OCR_LANGS);
            ocrWorker = worker;
            return worker;
        } catch (e) {
            console.warn('[PDF Extractor] tesseract.js OCR worker init failed:', e.message);
            ocrWorker = null;
            return null;
        }
    })();

    return ocrWorkerPromise;
}

async function terminateOcrWorker() {
    if (ocrWorker) {
        try { await ocrWorker.terminate(); } catch { /* ignore */ }
        ocrWorker = null;
        ocrWorkerPromise = null;
    }
}

// ─── Normalization ──────────────────────────────────────────────────────────

function normalizePageText(raw) {
    if (!raw) return '';
    return String(raw)
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Count "usable" characters: Devanagari + Latin letters + digits.
 * Ignores whitespace, punctuation, and legacy-font garbage.
 */
function countUsableChars(text) {
    const t = String(text || '');
    let count = 0;
    for (const ch of t) {
        const code = ch.codePointAt(0);
        if (
            (code >= 0x0900 && code <= 0x097F) ||        // Devanagari
            (code >= 0x41 && code <= 0x5A) ||             // A-Z
            (code >= 0x61 && code <= 0x7A) ||             // a-z
            (code >= 0x30 && code <= 0x39)                // 0-9
        ) count++;
    }
    return count;
}

function devanagariRatio(text) {
    const t = String(text || '');
    if (!t) return 0;
    const deva = (t.match(DEVANAGARI_RE) || []).length;
    return deva / t.length;
}

/**
 * Strip boilerplate lines (e.g. "CC-0. Jangamwadi Math Digital Collection.",
 * "Digitized by eGangotri") that pollute scanned pages and mislead the
 * "is this scanned?" heuristic.
 */
function stripBoilerplate(text) {
    const lines = String(text || '').split('\n');
    const kept = [];
    for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        // Common digitization boilerplate
        if (/^(cc-?0\.?|digitized by|scanned by|courtesy of|source[:.]|original from|collection)/i.test(l)) continue;
        if (l.includes('Jangamwadi') || l.includes('eGangotri') || l.includes('digital collection')) continue;
        kept.push(l);
    }
    return kept.join('\n');
}

// ─── Mode 3: OCR ────────────────────────────────────────────────────────────

/**
 * Render a PDF page to a PNG image buffer for OCR.
 * Uses pdfjs-dist's page.render() with @napi-rs/canvas.
 */
async function renderPageToImage(pdfPage, scale) {
    const viewport = pdfPage.getViewport({ scale: scale || OCR_SCALE });

    // Dynamic import of @napi-rs/canvas
    let canvasModule;
    try {
        canvasModule = await import('@napi-rs/canvas');
    } catch (e) {
        console.warn('[PDF Extractor] @napi-rs/canvas not available for rendering:', e.message);
        return null;
    }

    // Create an offscreen canvas
    const canvas = canvasModule.createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    // Render PDF page to the canvas
    const renderContext = {
        canvasContext: ctx,
        viewport: viewport
    };

    await pdfPage.render(renderContext).promise;

    // Export as PNG buffer
    return canvas.toBuffer('image/png');
}

/**
 * OCR a single page by rendering it to an image and running Tesseract.
 */
async function ocrPage(pdfPage) {
    const worker = await getOcrWorker();
    if (!worker) return '';

    try {
        const imageBuf = await renderPageToImage(pdfPage);
        if (!imageBuf || imageBuf.length === 0) return '';

        const result = await worker.recognize(imageBuf);
        const text = result && result.data && result.data.text ? result.data.text : '';
        return normalizePageText(text);
    } catch (e) {
        console.warn('[PDF Extractor] OCR failed for page:', e.message);
        return '';
    }
}

// ─── Main extraction ────────────────────────────────────────────────────────

/**
 * Extract per-page text from a PDF Buffer.
 *
 * Uses pdfjs-dist (legacy build for Node.js compatibility) instead of unpdf
 * (which crashes with "Math.sumPrecise is not a function" on Node 22).
 */
export async function extractPdf(pdfBuffer, options) {
    if (!pdfBuffer || pdfBuffer.length === 0) {
        throw new Error('Empty PDF buffer');
    }

    if (pdfBuffer.length > MAX_PDF_BYTES) {
        throw new Error('PDF too large to index: ' + pdfBuffer.length + ' bytes (max ' + MAX_PDF_BYTES + ')');
    }

    // Dynamic import — pdfjs-dist is a large dependency
    let pdfjs;
    try {
        pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (e) {
        throw new Error('pdfjs-dist is not installed. Run `npm install pdfjs-dist` in server/. ' + e.message);
    }

    const uint8 = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);

    // Resolve resource paths for pdfjs-dist font/image decoding.
    // import.meta.resolve() returns a file:// URL — convert to a filesystem path,
    // then build file:// URLs for each resource directory (Node's fs.readFile
    // accepts file:// URLs, which is how pdfjs-dist's NodeBinaryDataFactory reads).
    const pdfModuleUrl = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjsDistDir = path.dirname(fileURLToPath(pdfModuleUrl));
    const pdfjsRoot = path.resolve(pdfjsDistDir, '..', '..');
    const cmapsUrl = pathToFileURL(path.join(pdfjsRoot, 'cmaps')).href + '/';
    const standardFontDataUrl = pathToFileURL(path.join(pdfjsRoot, 'standard_fonts')).href + '/';
    const wasmUrl = pathToFileURL(path.join(pdfjsRoot, 'wasm')).href + '/';

    let doc;
    try {
        doc = await pdfjs.getDocument({
            data: uint8,
            cMapUrl: cmapsUrl,
            cMapPacked: true,
            standardFontDataUrl: standardFontDataUrl,
            wasmUrl: wasmUrl,
            useSystemFonts: true
        }).promise;
    } catch (e) {
        throw new Error('Failed to open PDF: ' + e.message);
    }

    const totalPages = doc.numPages || 0;
    const pages = [];
    let ocrPageCount = 0;
    let ocrAttempted = false;

    // Best-effort title/author metadata
    let title = null;
    let author = null;
    try {
        const meta = await doc.getMetadata().catch(() => null);
        if (meta && meta.info) {
            if (meta.info.Title) title = String(meta.info.Title).trim() || null;
            if (meta.info.Author) author = String(meta.info.Author).trim() || null;
        }
    } catch (e) {
        // non-fatal
    }

    const pageLimit = Math.min(totalPages, OCR_MAX_PAGES);

    for (let p = 1; p <= pageLimit; p++) {
        let page;
        try {
            page = await doc.getPage(p);
        } catch (e) {
            console.warn('[PDF Extractor] Failed to get page ' + p + ':', e.message);
            continue;
        }

        // Extract text content
        let rawText = '';
        try {
            const content = await page.getTextContent();
            rawText = (content.items || [])
                .map(item => item.str || '')
                .join(' ');
        } catch (e) {
            // If getTextContent fails, treat as scanned
            rawText = '';
        }

        rawText = normalizePageText(rawText);

        // --- Decision gate ---
        let finalText = rawText;
        let source = 'unicode';

        // If text is mostly real Devanagari → Mode 1, done.
        if (devanagariRatio(rawText) >= LEGACY_RATIO_THRESHOLD) {
            source = 'unicode';
        }
        // If it looks like a legacy Hindi font → try conversion (Mode 2).
        else if (isLegacyHindiText(rawText)) {
            const converted = normalizePageText(krutidevToUnicode(rawText));
            if (devanagariRatio(converted) >= LEGACY_RATIO_THRESHOLD) {
                finalText = converted;
                source = 'legacy';
            } else if (OCR_ENABLED && ocrPageCount < OCR_MAX_PAGES) {
                // Ambiguous legacy encoding — render + OCR.
                ocrAttempted = true;
                const ocrText = await ocrPage(page);
                if (ocrText) {
                    finalText = ocrText;
                    source = 'ocr';
                    ocrPageCount++;
                }
            }
        }
        // Short / scanned text (after stripping boilerplate) → OCR (Mode 3).
        else {
            const stripped = stripBoilerplate(rawText);
            if (OCR_ENABLED && countUsableChars(stripped) < OCR_MIN_CHARS && ocrPageCount < OCR_MAX_PAGES) {
                ocrAttempted = true;
                const ocrText = await ocrPage(page);
                if (ocrText) {
                    finalText = ocrText;
                    source = 'ocr';
                    ocrPageCount++;
                }
            }
        }

        // Skip empty pages
        if (!finalText || finalText.trim().length === 0) continue;

        pages.push({
            page: p,
            text: finalText,
            source,
            ocrUsed: source === 'ocr'
        });

        // Free page resources
        try { page.cleanup(); } catch { /* ignore */ }
    }

    // Close the document
    try { await doc.destroy(); } catch { /* ignore */ }

    // Release OCR worker resources
    if (ocrAttempted) {
        await terminateOcrWorker();
    }

    return {
        totalPages,
        pages,
        title,
        author,
        metadata: {
            totalPages,
            ocrPageCount,
            ocrEnabled: OCR_ENABLED
        }
    };
}
