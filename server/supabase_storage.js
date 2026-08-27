/**
 * Supabase Storage — Persist RAG index files (rag_index.json + rag_embeddings.bin)
 * so a production server can download a pre-built index instead of rebuilding it
 * from scratch (which takes minutes and consumes Gemini quota).
 *
 * Large uploads use Supabase Storage's TUS resumable-upload endpoint with
 * 6 MiB chunks. This avoids the 413 Payload Too Large error from standard
 * object uploads and keeps the local RAG files as single objects.
 */

import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
    process.loadEnvFile?.();
} catch {
    // Environment variables may already be supplied by the hosting platform.
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_FILE = path.resolve(__dirname, 'rag_index.json');
const EMBEDDINGS_FILE = path.resolve(__dirname, 'rag_embeddings.bin');

const INDEX_BLOB_NAME = 'rag_index.json';
const EMBEDDINGS_BLOB_NAME = 'rag_embeddings.bin';
const RESUMABLE_CHUNK_SIZE = 6 * 1024 * 1024;
const RESUMABLE_THRESHOLD = 6 * 1024 * 1024;

function getConfig() {
    const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
    const bucket = (process.env.SUPABASE_STORAGE_BUCKET || 'rag-index').trim().replace(/^\/+|\/+$/g, '');
    const prefix = (process.env.SUPABASE_INDEX_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');
    return { enabled: !!(url && key), url, key, bucket, prefix };
}

function objectPath(name) {
    const cfg = getConfig();
    if (!cfg.prefix) return name;
    return cfg.prefix + '/' + name;
}

function storageApiBase() {
    const cfg = getConfig();
    return cfg.url + '/storage/v1/object/' + encodeURIComponent(cfg.bucket);
}

function resumableUploadEndpoint() {
    const cfg = getConfig();
    const parsed = new URL(cfg.url);
    const hostname = parsed.hostname.replace(/\.supabase\.co$/i, '.storage.supabase.co');
    return parsed.protocol + '//' + hostname + '/storage/v1/upload/resumable';
}

function authHeaders() {
    const cfg = getConfig();
    return { Authorization: 'Bearer ' + cfg.key, apikey: cfg.key };
}

function encodeMetadataValue(value) {
    return Buffer.from(String(value), 'utf8').toString('base64');
}

function resumableMetadata(blobName) {
    const cfg = getConfig();
    return [
        'bucketName ' + encodeMetadataValue(cfg.bucket),
        'objectName ' + encodeMetadataValue(objectPath(blobName)),
        'contentType ' + encodeMetadataValue(blobName.endsWith('.json') ? 'application/json' : 'application/octet-stream'),
        'cacheControl ' + encodeMetadataValue('3600')
    ].join(',');
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = -1;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.ceil(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function printUploadProgress(blobName, uploaded, total, startedAt, forceNewLine = false) {
    const percent = total > 0 ? Math.min(100, (uploaded / total) * 100) : 0;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speed = uploaded / elapsedSeconds;
    const remainingSeconds = speed > 0 ? Math.max(0, (total - uploaded) / speed) : Infinity;
    const width = 28;
    const filled = Math.round((percent / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const line = `[SupabaseStorage] Uploading ${blobName} [${bar}] ${percent.toFixed(1)}% | ${formatBytes(uploaded)} / ${formatBytes(total)} | ${formatBytes(speed)}/s | ETA ${formatDuration(remainingSeconds)}`;
    process.stdout.write('\r' + line + (forceNewLine ? '\n' : ''));
}

// ─── Upload ────────────────────────────────────────────────────────────────

export async function uploadFile(localPath, blobName) {
    const cfg = getConfig();
    if (!cfg.enabled) return { ok: false, reason: 'supabase_disabled' };
    if (!existsSync(localPath)) return { ok: false, reason: 'file_not_found', path: localPath };

    const stat = await fs.stat(localPath);
    if (stat.size > RESUMABLE_THRESHOLD) {
        return uploadFileResumable(localPath, blobName, stat.size);
    }

    const buffer = await fs.readFile(localPath);
    const url = storageApiBase() + '/' + encodeURIComponent(objectPath(blobName));
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'Content-Type': blobName.endsWith('.json') ? 'application/json' : 'application/octet-stream',
            'x-upsert': 'true'
        },
        body: buffer
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, status: response.status, error: text.slice(0, 300) };
    }

    return { ok: true, blob: blobName, size: stat.size, method: 'standard' };
}

async function uploadFileResumable(localPath, blobName, fileSize) {
    const endpoint = resumableUploadEndpoint();

    console.log(`[SupabaseStorage] Starting resumable upload: ${blobName} (${formatBytes(fileSize)})`);
    console.log(`[SupabaseStorage] Chunk size: ${formatBytes(RESUMABLE_CHUNK_SIZE)} | This may take a while depending on upload speed.`);

    const createResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'Tus-Resumable': '1.0.0',
            'Upload-Length': String(fileSize),
            'Upload-Metadata': resumableMetadata(blobName),
            'x-upsert': 'true'
        }
    });

    if (!createResponse.ok) {
        const text = await createResponse.text().catch(() => '');
        return { ok: false, status: createResponse.status, error: text.slice(0, 500), method: 'resumable' };
    }

    const locationHeader = createResponse.headers.get('location');
    if (!locationHeader) {
        return { ok: false, status: createResponse.status, error: 'Supabase did not return a resumable upload URL', method: 'resumable' };
    }

    const uploadUrl = new URL(locationHeader, endpoint).toString();
    const file = await fs.open(localPath, 'r');
    let offset = 0;
    const startedAt = Date.now();
    printUploadProgress(blobName, 0, fileSize, startedAt);

    try {
        while (offset < fileSize) {
            const chunkLength = Math.min(RESUMABLE_CHUNK_SIZE, fileSize - offset);
            const chunk = Buffer.allocUnsafe(chunkLength);
            const { bytesRead } = await file.read(chunk, 0, chunkLength, offset);
            if (bytesRead !== chunkLength) {
                process.stdout.write('\n');
                return { ok: false, status: 500, error: `Unexpected end of file at ${offset}B`, method: 'resumable' };
            }

            let uploaded = false;
            let lastError = '';

            for (let attempt = 1; attempt <= 3 && !uploaded; attempt += 1) {
                try {
                    const patchResponse = await fetch(uploadUrl, {
                        method: 'PATCH',
                        headers: {
                            ...authHeaders(),
                            'Tus-Resumable': '1.0.0',
                            'Upload-Offset': String(offset),
                            'Content-Type': 'application/offset+octet-stream',
                            'Content-Length': String(chunkLength)
                        },
                        body: chunk
                    });

                    if (patchResponse.ok) {
                        const returnedOffset = Number(patchResponse.headers.get('upload-offset'));
                        if (Number.isFinite(returnedOffset) && returnedOffset >= offset + chunkLength) {
                            offset = returnedOffset;
                        } else {
                            offset += chunkLength;
                        }
                        uploaded = true;
                        printUploadProgress(blobName, offset, fileSize, startedAt);
                        continue;
                    }

                    lastError = (await patchResponse.text().catch(() => '')).slice(0, 500);

                    const headResponse = await fetch(uploadUrl, {
                        method: 'HEAD',
                        headers: { ...authHeaders(), 'Tus-Resumable': '1.0.0' }
                    });
                    const serverOffset = Number(headResponse.headers.get('upload-offset'));
                    if (headResponse.ok && Number.isFinite(serverOffset) && serverOffset >= offset) {
                        offset = serverOffset;
                        uploaded = true;
                        printUploadProgress(blobName, offset, fileSize, startedAt);
                        continue;
                    }
                } catch (error) {
                    lastError = error?.message || String(error);
                }

                if (!uploaded && attempt < 3) {
                    process.stdout.write(`\n[SupabaseStorage] Chunk retry ${attempt + 1}/3...\n`);
                    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
                }
            }

            if (!uploaded) {
                process.stdout.write('\n');
                return { ok: false, status: 502, error: lastError || 'Chunk upload failed after 3 attempts', method: 'resumable' };
            }
        }
    } finally {
        await file.close();
    }

    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    printUploadProgress(blobName, fileSize, fileSize, startedAt, true);
    console.log(`[SupabaseStorage] Upload complete: ${blobName} in ${formatDuration(elapsedSeconds)}.`);

    return { ok: true, blob: blobName, size: fileSize, method: 'resumable' };
}

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

export async function downloadFile(blobName, localPath) {
    const cfg = getConfig();
    if (!cfg.enabled) return { ok: false, reason: 'supabase_disabled' };

    const url = storageApiBase() + '/' + encodeURIComponent(objectPath(blobName));
    const response = await fetch(url, { method: 'GET', headers: authHeaders() });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, status: response.status, error: text.slice(0, 200) };
    }

    if (!response.body) return { ok: false, status: 500, error: 'Supabase returned an empty response body' };

    await pipeline(Readable.fromWeb(response.body), createWriteStream(localPath));
    const size = (await fs.stat(localPath)).size;
    return { ok: true, blob: blobName, size };
}

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

export async function objectExists(blobName) {
    const cfg = getConfig();
    if (!cfg.enabled) return false;
    const url = storageApiBase() + '/' + encodeURIComponent(objectPath(blobName));
    const response = await fetch(url, { method: 'HEAD', headers: authHeaders() });
    return response.ok;
}

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
