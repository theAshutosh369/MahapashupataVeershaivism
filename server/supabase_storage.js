/**
 * Google Drive storage for the pre-built RAG index.
 *
 * The index files are kept outside GitHub and downloaded from public Google
 * Drive links when the server needs them. Downloads are streamed directly to
 * disk so large files do not need to be held entirely in memory.
 */

import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

try {
    process.loadEnvFile?.();
} catch {
    // Environment variables may already be supplied by the hosting platform.
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.resolve(__dirname, 'rag_index.json');
const EMBEDDINGS_FILE = path.resolve(__dirname, 'rag_embeddings.bin');

const DEFAULT_INDEX_FILE_ID = '128Hv5D93LMrWSjomQCsQAJrhGyWE7PV3';
const DEFAULT_EMBEDDINGS_FILE_ID = '106hbwJ8a3f5hnOo_yuTEbP0X5SjaMVFV';

const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_DOWNLOAD_RETRIES = 3;

function getConfig() {
    const indexId = (process.env.GOOGLE_DRIVE_INDEX_ID || DEFAULT_INDEX_FILE_ID).trim();
    const embeddingsId = (process.env.GOOGLE_DRIVE_EMBEDDINGS_ID || DEFAULT_EMBEDDINGS_FILE_ID).trim();
    return { enabled: Boolean(indexId && embeddingsId), indexId, embeddingsId };
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

function printProgress(name, downloaded, total, startedAt, newLine = false) {
    const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speed = downloaded / elapsed;
    const remaining = speed > 0 && total > 0 ? Math.max(0, (total - downloaded) / speed) : Infinity;
    const width = 28;
    const filled = Math.round((percent / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const totalText = total > 0 ? formatBytes(total) : 'unknown size';
    const line = `[GoogleDrive] Downloading ${name} [${bar}] ${percent.toFixed(1)}% | ${formatBytes(downloaded)} / ${totalText} | ${formatBytes(speed)}/s | ETA ${formatDuration(remaining)}`;
    process.stdout.write('\r' + line + (newLine ? '\n' : ''));
}

function getCookieHeader(response) {
    const cookies = response.headers.getSetCookie?.() || [];
    return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

function getConfirmationToken(html) {
    const patterns = [
        /[?&]confirm=([0-9A-Za-z_-]+)/i,
        /name=["']confirm["'][^>]*value=["']([^"']+)/i,
        /confirm=([0-9A-Za-z_-]+)/i,
        /[?&]uuid=([0-9A-Za-z_-]+)/i
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return match[1];
    }
    return null;
}

function isHtmlResponse(response) {
    return (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

async function fetchWithTimeout(url, options = {}) {
    return fetch(url, {
        ...options,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'follow'
    });
}

async function resolveDownloadUrl(fileId) {
    const urls = [
        `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download`,
        `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
    ];

    for (const baseUrl of urls) {
        const response = await fetchWithTimeout(baseUrl);
        if (!isHtmlResponse(response)) {
            return { url: response.url || baseUrl, cookie: getCookieHeader(response), response };
        }

        const html = await response.text();
        const token = getConfirmationToken(html);
        if (!token) continue;

        const cookie = getCookieHeader(response);
        const confirmedUrl = `${baseUrl}&confirm=${encodeURIComponent(token)}`;
        const confirmedResponse = await fetchWithTimeout(confirmedUrl, {
            headers: cookie ? { Cookie: cookie } : {}
        });

        if (!isHtmlResponse(confirmedResponse)) {
            return {
                url: confirmedResponse.url || confirmedUrl,
                cookie: cookie || getCookieHeader(confirmedResponse),
                response: confirmedResponse
            };
        }
    }

    throw new Error('Google Drive returned an HTML download/confirmation page instead of the file. Make sure the file is shared as "Anyone with the link" and is downloadable.');
}

async function downloadGoogleDriveFile(fileId, localPath, displayName) {
    const tempPath = `${localPath}.download`;
    const startedAt = Date.now();

    console.log(`[GoogleDrive] Starting download: ${displayName}`);
    console.log(`[GoogleDrive] Streaming download | Timeout: ${DOWNLOAD_TIMEOUT_MS / 1000}s | Retries: ${MAX_DOWNLOAD_RETRIES}`);

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt += 1) {
        try {
            if (attempt > 1) {
                console.log(`[GoogleDrive] Retrying ${displayName} (attempt ${attempt}/${MAX_DOWNLOAD_RETRIES})...`);
            }

            await fs.rm(tempPath, { force: true });
            const resolved = await resolveDownloadUrl(fileId);
            const response = resolved.response;

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
            }

            const total = Number(response.headers.get('content-length')) || 0;
            let downloaded = 0;
            let lastPrinted = 0;
            const output = createWriteStream(tempPath, { flags: 'w' });

            const progressStream = new TransformStream({
                transform(chunk, controller) {
                    downloaded += chunk.byteLength;
                    const now = Date.now();
                    if (downloaded - lastPrinted >= 256 * 1024 || (total > 0 && downloaded >= total)) {
                        lastPrinted = downloaded;
                        printProgress(displayName, downloaded, total, startedAt);
                    }
                    controller.enqueue(chunk);
                }
            });

            try {
                await pipeline(response.body, progressStream.writable, output);
            } finally {
                output.destroy();
            }

            if (total > 0 && downloaded !== total) {
                throw new Error(`Incomplete download: received ${downloaded} of ${total} bytes`);
            }

            const stat = await fs.stat(tempPath);
            if (stat.size === 0) throw new Error('Downloaded file is empty');

            await fs.rm(localPath, { force: true });
            await fs.rename(tempPath, localPath);
            printProgress(displayName, stat.size, total || stat.size, startedAt, true);
            console.log(`[GoogleDrive] Download complete: ${displayName} (${formatBytes(stat.size)}).`);
            return { ok: true, blob: displayName, size: stat.size, method: 'google_drive' };
        } catch (error) {
            const message = error?.message || String(error);
            if (attempt < MAX_DOWNLOAD_RETRIES) {
                const delayMs = attempt * 1500;
                console.log(`\n[GoogleDrive] Attempt ${attempt}/${MAX_DOWNLOAD_RETRIES} failed: ${message}`);
                console.log(`[GoogleDrive] Waiting ${delayMs / 1000}s before retry...`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            } else {
                console.error(`\n[GoogleDrive] Failed to download ${displayName}: ${message}`);
            }
        }
    }

    await fs.rm(tempPath, { force: true }).catch(() => {});
    return { ok: false, status: 502, error: `Download failed after ${MAX_DOWNLOAD_RETRIES} attempts`, method: 'google_drive' };
}

export async function uploadFile() {
    return { ok: false, reason: 'google_drive_read_only', error: 'Google Drive integration is download-only. Upload the RAG files to Google Drive manually.' };
}

export async function uploadIndexFiles() {
    return { ok: false, reason: 'google_drive_read_only', error: 'Upload the RAG index files to Google Drive manually; this server integration only downloads them.' };
}

export async function downloadFile(blobName, localPath) {
    const cfg = getConfig();
    if (!cfg.enabled) return { ok: false, reason: 'google_drive_disabled' };
    const fileId = blobName === 'rag_index.json' ? cfg.indexId : blobName === 'rag_embeddings.bin' ? cfg.embeddingsId : null;
    if (!fileId) return { ok: false, reason: 'unknown_blob', blob: blobName };
    return downloadGoogleDriveFile(fileId, localPath, blobName);
}

export async function downloadIndexFiles() {
    const cfg = getConfig();
    if (!cfg.enabled) {
        console.log('[GoogleDrive] Disabled: no Google Drive file IDs configured.');
        return { ok: false, reason: 'google_drive_disabled', downloaded: [], skipped: [] };
    }

    const downloaded = [];
    const skipped = [];
    const failures = [];

    for (const [localPath, blobName] of [[INDEX_FILE, 'rag_index.json'], [EMBEDDINGS_FILE, 'rag_embeddings.bin']]) {
        if (existsSync(localPath)) {
            const size = (await fs.stat(localPath)).size;
            if (size > 0) {
                skipped.push(blobName);
                console.log(`[GoogleDrive] Using existing local file: ${blobName} (${formatBytes(size)})`);
                continue;
            }
            await fs.rm(localPath, { force: true });
        }

        const result = await downloadFile(blobName, localPath);
        if (result.ok) downloaded.push(blobName);
        else failures.push({ blob: blobName, error: result.error || result.reason });
    }

    return { ok: failures.length === 0, enabled: true, downloaded, skipped, failures };
}

export async function objectExists(blobName) {
    const localPath = blobName === 'rag_index.json' ? INDEX_FILE : blobName === 'rag_embeddings.bin' ? EMBEDDINGS_FILE : null;
    return Boolean(localPath && existsSync(localPath) && (await fs.stat(localPath)).size > 0);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    const flag = process.argv[2];
    if (flag === '--download') {
        downloadIndexFiles().then((result) => {
            console.log('Download result:', result);
            process.exit(result.ok ? 0 : 1);
        }).catch((error) => {
            console.error('Download failed:', error?.message || String(error));
            process.exit(1);
        });
    } else if (flag === '--upload') {
        console.log('[GoogleDrive] Upload is not performed by this server. Upload the two files to Google Drive manually.');
        process.exit(1);
    } else {
        console.log('Usage: node server/supabase_storage.js --download | --upload');
        process.exit(1);
    }
}