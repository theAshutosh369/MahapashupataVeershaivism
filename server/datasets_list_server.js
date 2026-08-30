import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import cors from 'cors';

const app = express();

app.use(
    cors({
        origin: 'http://localhost:5173',
        methods: ['GET'],
        allowedHeaders: ['Content-Type']
    })
);

const dataRoot = path.resolve(process.cwd(), 'public', 'data');

function isJsonFile(fileName) {
    return typeof fileName === 'string' && fileName.toLowerCase().endsWith('.json');
}

async function walk(dir, { jsonOnly = false, skipDirs = new Set(), skipFiles = new Set() } = {}) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue;
            out.push(...(await walk(full, { jsonOnly, skipDirs, skipFiles })));
            continue;
        }

        if (!entry.isFile()) continue;
        if (skipFiles.has(entry.name)) continue;
        if (jsonOnly && !isJsonFile(entry.name)) continue;
        out.push(full);
    }

    return out;
}

app.get('/api/datasets/list', async (_req, res) => {
    try {
        const datasetDir = path.join(dataRoot, 'datasets');
        let datasetFiles = [];
        try {
            datasetFiles = (await walk(datasetDir, { jsonOnly: true }))
                .map((file) => path.basename(file))
                .sort((a, b) => a.localeCompare(b));
        } catch {
            datasetFiles = [];
        }

        res.status(200).json({ ok: true, datasets: datasetFiles });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to scan public/data', details: e?.message ?? String(e) });
    }
});

// Existing JSON-only endpoint kept for compatibility with current consumers.
app.get('/api/datasets/all', async (_req, res) => {
    try {
        const files = await walk(dataRoot, { jsonOnly: true });
        const rel = files.map((file) => path.relative(dataRoot, file).split(path.sep).join('/'));
        res.status(200).json({ ok: true, files: rel });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to list data files', details: e?.message ?? String(e) });
    }
});

// Granthas browser: mirrors the actual source hierarchy under public/data.
// Generated datasets and authors.json are metadata, not Granthas, so they are
// intentionally excluded. No source files are moved or reclassified.
app.get('/api/granthas/list', async (_req, res) => {
    try {
        const files = await walk(dataRoot, {
            skipDirs: new Set(['datasets']),
            skipFiles: new Set(['authors.json'])
        });

        const relativePaths = files
            .map((file) => path.relative(dataRoot, file).split(path.sep).join('/'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        res.status(200).json({ ok: true, files: relativePaths });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to list Granthas', details: e?.message ?? String(e) });
    }
});

const port = process.env.DATASET_LIST_PORT ? Number(process.env.DATASET_LIST_PORT) : 3003;
app.listen(port, () => {
    console.log(`Dataset list API listening on http://localhost:${port}`);
});
