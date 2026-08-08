/**
 * Rebuild the RAG index from scratch.
 * Usage: node --max-old-space-size=4096 server/rebuild_index.js
 *
 * Deletes the existing index files (rag_index.json, rag_embeddings.bin) and
 * rebuilds ALL chunks with fresh embeddings using the fixed batch-size logic
 * in index_manager.js (batches of ≤100 for Google batchEmbedContents).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.resolve(__dirname, 'rag_index.json');
const EMBEDDINGS_FILE = path.resolve(__dirname, 'rag_embeddings.bin');

// Load .env (GEMINI_API_KEY) — mirrors server.js loadDotEnv()
const envPath = path.resolve(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!key) continue;
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

// Delete old index files to force full rebuild
for (const f of [INDEX_FILE, EMBEDDINGS_FILE]) {
    if (fs.existsSync(f)) {
        console.log('Deleting:', f);
        fs.unlinkSync(f);
    }
}

const dataRoot = path.resolve(PROJECT_ROOT, 'public', 'data');
console.log('Rebuilding index from:', dataRoot);

// CLI flags:
//   --upload   → after the rebuild, upload index files to Supabase Storage
//   --skip-upload → (default) do not upload
const SHOULD_UPLOAD = process.argv.includes('--upload');

const { ensureIndex } = await import('./index_manager.js');
// skipSupabaseDownload: a rebuild always starts from scratch — never pull a
// pre-built index down first (that would defeat the purpose of a rebuild).
const index = await ensureIndex(dataRoot, { skipSupabaseDownload: true });

console.log('=== REBUILD COMPLETE ===');
console.log('Chunks:', index.chunks.length);
console.log('Datasets:', index.datasetNames.length);

const virakt = index.chunks.filter((c) => c.dataset && c.dataset.toLowerCase().includes('virakt'));
console.log('Viraktotpatti chunks:', virakt.length);

const zeroDatasets = new Set();
for (const c of index.chunks) {
    if (c.embeddingIndex === undefined || c.embeddingIndex < 0) {
        zeroDatasets.add(c.dataset);
    }
}
console.log('Datasets with missing embeddings:', zeroDatasets.size);

// Optional: upload the freshly built index to Supabase Storage so a production
// server can download it on startup instead of rebuilding.
if (SHOULD_UPLOAD) {
    console.log('');
    console.log('Uploading index files to Supabase Storage...');
    try {
        const { uploadIndexFiles } = await import('./supabase_storage.js');
        const result = await uploadIndexFiles();
        if (result.ok) {
            console.log('Upload OK → bucket:', result.bucket, 'prefix:', result.prefix || '(root)');
        } else {
            console.warn('Upload skipped/disabled:', result.reason || 'unknown');
        }
    } catch (uploadErr) {
        console.warn('Upload failed:', uploadErr?.message || String(uploadErr));
    }
} else {
    console.log('');
    console.log('Tip: run with --upload to push the index to Supabase Storage for production use.');
}

