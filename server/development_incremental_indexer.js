import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { updateNewSourceFile } from './incremental_shard_indexer.js';

const EXTENSIONS = /\.(json|pdf|txt)$/i;
const IGNORED = new Set(['other']);

function normalize(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
function categoryFor(relPath) {
    const value = normalize(relPath);
    return value.includes('/') ? value.split('/')[0] : 'root';
}
function safeShard(ragRoot, category) {
    const value = normalize(category);
    if (!value || value === '.' || value === '..' || value.includes('..') || IGNORED.has(value.toLowerCase())) return null;
    const root = path.resolve(ragRoot);
    const full = path.resolve(root, value);
    return full === root || !full.startsWith(root + path.sep) ? null : full;
}
async function readJson(file, fallback = null) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function sha1(file) {
    const hash = crypto.createHash('sha1');
    const buffer = await fs.readFile(file);
    hash.update(buffer);
    return { hash: hash.digest('hex'), size: buffer.length };
}

async function removePreviousVersion({ ragRoot, relPath }) {
    const category = categoryFor(relPath);
    const dir = safeShard(ragRoot, category);
    if (!dir) return null;
    const indexPath = path.join(dir, 'index.json');
    const index = await readJson(indexPath, null);
    if (!index) return null;

    const oldChunks = Array.isArray(index.chunks) ? index.chunks : [];
    const oldSourceFiles = Array.isArray(index.sourceFiles) ? index.sourceFiles : [];
    const hasPrevious = oldSourceFiles.some((entry) => normalize(entry?.path) === normalize(relPath)) || oldChunks.some((chunk) => normalize(chunk?.dataset || chunk?.filename) === normalize(relPath));
    if (!hasPrevious) return null;

    const nextChunks = oldChunks.filter((chunk) => normalize(chunk?.dataset || chunk?.filename) !== normalize(relPath));
    const nextSources = oldSourceFiles.filter((entry) => normalize(entry?.path) !== normalize(relPath));
    const next = {
        ...index,
        updatedAt: new Date().toISOString(),
        sourceFiles: nextSources,
        datasetNames: [...new Set(nextChunks.map((chunk) => chunk.dataset).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
        chunkCount: nextChunks.length,
        chunks: nextChunks
    };
    const temp = `${indexPath}.dev-remove.${process.pid}.${Date.now()}`;
    await fs.writeFile(temp, JSON.stringify(next), 'utf8');
    await fs.rename(temp, indexPath);
    return { indexPath, original: index };
}

async function walkData(dataRoot) {
    const files = [];
    async function walk(dir, relative = '') {
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full, rel);
            else if (entry.isFile() && EXTENSIONS.test(entry.name)) files.push({ relPath: normalize(rel), fullPath: full });
        }
    }
    await walk(dataRoot);
    return files;
}

export async function reconcileDevelopmentSources({ dataRoot, ragRoot }) {
    const results = [];
    const files = await walkData(dataRoot);
    for (const file of files) {
        const category = categoryFor(file.relPath);
        const dir = safeShard(ragRoot, category);
        if (!dir) continue;
        const indexPath = path.join(dir, 'index.json');
        const index = await readJson(indexPath, null);
        const fingerprint = await sha1(file.fullPath);
        const sourceEntry = index?.sourceFiles?.find((entry) => normalize(entry?.path) === file.relPath);
        const indexed = Array.isArray(index?.chunks) && index.chunks.some((chunk) => normalize(chunk?.dataset || chunk?.filename) === file.relPath);

        if (sourceEntry?.hash === fingerprint.hash && indexed) continue;
        if (!sourceEntry && indexed) continue; // Legacy prebuilt index: don't duplicate it on first dev startup.

        const changed = Boolean(sourceEntry || indexed);
        let backup = null;
        try {
            if (changed) backup = await removePreviousVersion({ ragRoot, relPath: file.relPath });
            console.log(`[DevIncremental] ${changed ? 'Updated file' : 'New file'} detected: ${file.relPath}`);
            const result = await updateNewSourceFile({ dataRoot, ragRoot, relPath: file.relPath });
            results.push({ ...result, status: changed ? 'updated' : result.status });
        } catch (error) {
            if (backup) {
                const temp = `${backup.indexPath}.dev-restore.${process.pid}.${Date.now()}`;
                await fs.writeFile(temp, JSON.stringify(backup.original), 'utf8');
                await fs.rename(temp, backup.indexPath);
            }
            results.push({ status: 'error', path: file.relPath, error: error.message });
            console.warn(`[DevIncremental] Failed to index ${file.relPath}: ${error.message}`);
        }
    }
    return results;
}

export function startDevelopmentWatcher({ dataRoot, ragRoot, onUpdate }) {
    let timer = null;
    let running = false;
    const pending = new Set();

    async function flush() {
        if (running || pending.size === 0) return;
        running = true;
        const paths = [...pending];
        pending.clear();
        try {
            for (const relPath of paths) {
                if (!EXTENSIONS.test(relPath)) continue;
                const fullPath = path.resolve(dataRoot, relPath);
                if (!fullPath.startsWith(path.resolve(dataRoot) + path.sep)) continue;
                try {
                    await fs.access(fullPath);
                    const result = (await reconcileDevelopmentSources({ dataRoot, ragRoot })).find((item) => item.path === normalize(relPath));
                    if (result) onUpdate?.(result);
                } catch {
                    // A save can emit rename/change before the file is visible.
                    // The next event will reconcile it.
                }
            }
        } finally {
            running = false;
            if (pending.size) void flush();
        }
    }

    const trigger = (filename) => {
        const relPath = normalize(filename);
        if (!relPath || !EXTENSIONS.test(relPath)) return;
        pending.add(relPath);
        clearTimeout(timer);
        timer = setTimeout(() => void flush(), 700);
    };

    let watcher = null;
    try {
        watcher = fsc.watch(dataRoot, { recursive: true }, (_event, filename) => {
            if (filename) trigger(String(filename));
        });
        watcher.on('error', (error) => console.warn('[DevIncremental] Watcher error:', error.message));
        console.log('[DevIncremental] Watching public/data for new and updated source files.');
    } catch (error) {
        console.warn('[DevIncremental] Could not start source watcher:', error.message);
    }

    return () => {
        clearTimeout(timer);
        try { watcher?.close(); } catch {}
    };
}
