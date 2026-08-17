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

// const publicRoot = "C:\\vachana-sanchaya\\vachana-sanchaya\\public\\data";
const dataRoot = "C:\\vachana-sanchaya\\vachana-sanchaya\\public\\data";


function isJsonFile(fileName) {
    return typeof fileName === 'string' && fileName.toLowerCase().endsWith('.json');
}

async function walk(dir) {
    // returns absolute paths of all json files under dir
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...(await walk(full)));
            continue;
        }

        if (entry.isFile() && isJsonFile(entry.name)) {
            out.push(full);
        }
    }

    return out;
}

app.get('/api/datasets/list', async (_req, res) => {
    try {
        const files = await walk(dataRoot);

        // We only want dataset filenames (base name + extension) that the UI can request
        // via /api/datasets/:datasetName.
        // Only dataset json files under public/data/datasets
        const datasetDir = path.join(dataRoot, 'datasets');

        // If datasets folder doesn't exist, return empty list (avoid crashing UI)
        let datasetFiles = [];
        try {
            datasetFiles = (await walk(datasetDir))
                .map(f => path.basename(f))
                .filter(name => isJsonFile(name))
                .sort((a, b) => a.localeCompare(b));
        } catch {
            datasetFiles = [];
        }

        res.status(200).json({ ok: true, datasets: datasetFiles });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to scan public/data', details: e?.message ?? String(e) });
    }
});

// Return all JSON files under public/data as relative paths (forward-slash)
app.get('/api/datasets/all', async (_req, res) => {
    try {
        const files = await walk(dataRoot);
        const rel = files.map(f => path.relative(dataRoot, f).split(path.sep).join('/'));
        res.status(200).json({ ok: true, files: rel });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to list data files', details: e?.message ?? String(e) });
    }
});

const port = process.env.DATASET_LIST_PORT ? Number(process.env.DATASET_LIST_PORT) : 3003;
app.listen(port, () => {
    console.log(`Dataset list API listening on http://localhost:${port}`);
});

