/**
 * One-time patch: add PDF metadata (sourceType, filename, source) to existing
 * PDF chunks in rag_index.json.
 *
 * The current index was built before index_manager.js started persisting the
 * `sourceType`/`filename`/`source` fields that chunkPdfFile() already produces.
 * This script enriches the stored PDF chunks in-place WITHOUT re-embedding
 * (embeddings are positional in rag_embeddings.bin and untouched).
 *
 * Usage: node patch_index_pdf_metadata.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.resolve(__dirname, 'rag_index.json');
const BACKUP_FILE = INDEX_FILE + '.pre-pdf-meta.bak';

const DEVANAGARI_RE = /[\u0900-\u097F]/;
const LEGACY_SIGNATURE_RE = /keâ|mee|Yee|Û|Ú|Ù|ßee|Øe|«ebLe|Mees|eÙe|Ùees|efJ/;

function basenameSafe(p) {
    return path.basename(String(p || '')).trim();
}

function inferSource(text) {
    const t = String(text || '');
    if (!t) return undefined;
    // Legacy Hindi font glyphs are Latin-1/Latin-Extended characters
    const glyphMatches = t.match(/[\u00C0-\u017F\u2018-\u201F\u2030\u00AB\u00BB\u2026]/g);
    if (glyphMatches && glyphMatches.length / Math.max(1, t.length) > 0.02) return 'legacy';
    if (LEGACY_SIGNATURE_RE.test(t)) return 'legacy';
    // Real Unicode Devanagari → unicode
    if (DEVANAGARI_RE.test(t)) return 'unicode';
    return 'unicode';
}

function main() {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const idx = JSON.parse(raw);
    if (!idx || !Array.isArray(idx.chunks)) {
        console.error('Invalid index — aborting.');
        process.exit(1);
    }

    // Backup before mutating
    fs.writeFileSync(BACKUP_FILE, raw, 'utf8');
    console.log('Backup written:', BACKUP_FILE);

    let pdfChunks = 0;
    let changed = 0;
    for (const chunk of idx.chunks) {
        const ds = String(chunk.dataset || '');
        const isPdf = chunk.sourceType === 'pdf' || ds.toLowerCase().endsWith('.pdf');
        if (!isPdf) continue;
        pdfChunks++;
        let mutated = false;

        if (!chunk.sourceType) { chunk.sourceType = 'pdf'; mutated = true; }
        if (!chunk.filename) { chunk.filename = basenameSafe(ds); mutated = true; }
        if (!chunk.source) {
            const inferred = inferSource(chunk.text);
            if (inferred) { chunk.source = inferred; mutated = true; }
        }

        if (mutated) changed++;
    }

    fs.writeFileSync(INDEX_FILE, JSON.stringify(idx), 'utf8');

    console.log('PDF chunks found:', pdfChunks);
    console.log('Chunks enriched:', changed);
    console.log('Index size:', (fs.statSync(INDEX_FILE).size / 1024 / 1024).toFixed(2), 'MB');
    console.log('DONE. Restart the server so the in-memory index reloads with the new metadata.');
}

main();

