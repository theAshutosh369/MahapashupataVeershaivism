/**
 * Supabase Storage — Persist RAG index files (rag_index.json + rag_embeddings.bin)
 * so a production server can download a pre-built index instead of rebuilding it
 * from scratch (which takes minutes and consumes Gemini quota).
 *
 * ── WORKFLOW ────────────────────────────────────────────────────────────────
 *
 *   Local development:
 *     Edit datasets → build index once → upload index files to Supabase Storage
 *
 *   Production:
 *     Server starts → checks local files → exists? load immediately
 *     → else download from Supabase → load
 *
 *   Only when you intentionally update datasets:
 *     Update datasets → run incrementalUpdate() → upload new index files
 *
 * ── CONFIGURATION (env vars) ────────────────────────────────────────────────
 *   SUPABASE_URL            e.g. https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY    Service role key (bypasses RLS) — keep secret
 *   SUPABASE_STORAGE_BUCKET e.g. "rag-index" (default)
 *   SUPABASE_INDEX_PREFIX   optional folder prefix inside the bucket (default "")
 *
 * This module is OPTIONAL. If the env vars are not set, every public function
 * returns a disabled result and the existing local-file behaviour is preserved.
 *
 * Uses the Supabase Storage REST API with Node's built-in fetch — no extra
 * npm dependency required (Node 18+).
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const INDEX_FILE = path.resolve(__dirname, 'rag_index.json');
const EMBEDDINGS_FILE = path.resolve(__dirname, 'rag_embeddings.bin');

const INDEX_BLOB_NAME = 'rag_index.json';
const EMBEDDINGS_BLOB_NAME = 'rag_embeddings.bin';

function getConfig() {
    const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
    const bucket = (process.env.SUPABASE_STORAGE_BUCKET || 'rag-index').trim().replace(/^\/+|\/+$/g, '');
    const prefix = (process.env.SUPABASE_INDEX_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');
    return {
        enabled: !!(url && key),
        url,
        key,
        bucket,
        prefix
    };
}

function objectPath(name) {
    const cfg = getConfig();
    if (!cfg.prefix) return name;
    return cfg.prefix + '/' + name;
}

function storageApiBase() {
    const cfg = getConfig();
    // Supabase Storage REST API: /storage/v1/object/<bucket>/<path>
    return cfg.url + '/storage/v1/object/' + encodeURIComponent(cfg.bucket);
}

function authHeaders() {
    const cfg = getConfig();
    return {
        Authorization: 'Bearer ' + cfg.key,
        apikey: cfg.key
    };
}

// ─── Upload ────────────────────────────────────────────────────────────────

/**
 * Upload a single local file to Supabase Storage (upsert).
 * @param {string} localPath Absolute path to the local file.
 * @param {string} blobName  Storage object name (e.g. "rag_index.json").
 */
export async function uploadFile(localPath, blobName) {
    const cfg = getConfig();
    if (!cfg.enabled) {
        return { ok: false, reason: 'supabase_disabled' };
    }
    if (!existsSync(localPath)) {
        return { ok: false, reason: 'file_not_found', path: localPath };
    }

    const buffer = await fs.readFile(localPath);
    const url = storageApiBase() + '/' + encodeURIComponent(objectPath(blobName));

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'Content-Type': 'application/octet-stream',
            'x-upsert': 'true'
        },
        body: buffer
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, status: response.status, error: text.slice(0, 300) };
    }

    return { ok: true, blob: blobName, size: buffer.length };
}

/**
 * Upload both index files (rag_index.json + rag_embeddings.bin) to Supabase.
 */
export async function uploadIndexFiles() {
    const cfg = getConfig();
    if (!cfg.enabled) {
        console.log('[SupabaseStorage] Disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY not set). Skipping upload.');
        return { ok: false, reason: 'supabase_disabled' };
    }

    const results = {};
    const indexRes = await uploadFile(INDEX_FILE, INDEX_BLOB_NAME);
    results.index = indexRes;

    const embedRes = await uploadFile(EMBEDDINGS_FILE, EMBEDDINGS_BLOB_NAME);
    results.embeddings = embedRes;

    const allOk = indexRes.ok && embedRes.ok;
    console.log(
        '[SupabaseStorage] Upload ' + (allOk ? 'OK' : 'FAILED') +
        ' (index=' + (indexRes.ok ? indexRes.size + 'B' : (indexRes.error || indexRes.reason)) +
        ', embeddings=' + (embedRes.ok ? embedRes.size + 'B' : (embedRes.error || embedRes.reason)) + ')'
    );

    return { ok: allOk, bucket: cfg.bucket, prefix: cfg.prefix, results };
}

// ─── Download ──────────────────────────────────────────────────────────────

/**
 * Download a single object from Supabase Storage to a local file.
 * @param {string} blobName Storage object name.
 * @param {string} localPath Absolute path to write to.
 */
export async function downloadFile(blobName, localPath) {
    const cfg = getConfig();
    if (!cfg.enabled) {
        return { ok: false, reason: 'supabase_disabled' };
    }

    const url = storageApiBase() + '/' + encodeURIComponent(objectPath(blobName));
    const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders()
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, status: response.status, error: text.slice(0, 200) };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(localPath, buffer);
    return { ok: true, blob: blobName, size: buffer.length };
}

/**
 * Download both index files from Supabase Storage to the local server dir.
 * Only downloads files that are NOT already present locally.
 * Returns { downloaded: [...], skipped: [...], ok, enabled }.
 */
export async function downloadIndexFiles() {
    const cfg = getConfig();
    if (!cfg.enabled) {
        console.log('[SupabaseStorage] Disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY not set). Skipping download.');
        return { ok: false, reason: 'supabase_disabled', downloaded: [], skipped: [] };
    }

    const downloaded = [];
    const skipped = [];

    for (const [localPath, blobName] of [
        [INDEX_FILE, INDEX_BLOB_NAME],
        [EMBEDDINGS_FILE, EMBEDDINGS_BLOB_NAME]
    ]) {
        if (existsSync(localPath)) {
            skipped.push(blobName);
            continue;
        }
        const res = await downloadFile(blobName, localPath);
        if (res.ok) {
            downloaded.push(blobName);
            console.log('[SupabaseStorage] Downloaded ' + blobName + ' (' + res.size + 'B)');
        } else {
            console.warn('[SupabaseStorage] Download skipped ' + blobName + ': ' + (res.error || res.reason));
        }
    }

    return { ok: true, enabled: true, downloaded, skipped };
}

// ─── Discovery / listing (optional helpers) ────────────────────────────────

/**
 * Check whether a storage object exists.
 */
export async function objectExists(blobName) {
    const cfg = getConfig();
    if (!cfg.enabled) return false;
    const url = storageApiBase() + '/' + encodeURIComponent(objectPath(blobName));
    const response = await fetch(url, { method: 'HEAD', headers: authHeaders() });
    return response.ok;
}

// ─── CLI entry (upload after a local rebuild) ──────────────────────────────

/**
 * Run as a standalone script:
 *   node server/supabase_storage.js --upload
 *   node server/supabase_storage.js --download
 */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    const flag = process.argv[2];
    if (flag === '--upload') {
        uploadIndexFiles().then((r) => {
            console.log('Upload result:', r);
            process.exit(r.ok ? 0 : 1);
        }).catch((e) => {
            console.error('Upload failed:', e?.message || String(e));
            process.exit(1);
        });
    } else if (flag === '--download') {
        downloadIndexFiles().then((r) => {
            console.log('Download result:', r);
            process.exit(0);
        }).catch((e) => {
            console.error('Download failed:', e?.message || String(e));
            process.exit(1);
        });
    } else {
        console.log('Usage: node server/supabase_storage.js --upload | --download');
        process.exit(1);
    }
}
