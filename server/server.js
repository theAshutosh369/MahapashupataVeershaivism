import express from 'express';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { attachRagRoutes } from './rag_routes.js';

// ----- Environment & paths -----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.resolve(PROJECT_ROOT, 'public');
const DIST_DIR = path.resolve(PROJECT_ROOT, 'dist');
const DATA_DIR = path.resolve(PUBLIC_DIR, 'data');
const DATASETS_DIR = path.resolve(DATA_DIR, 'datasets');
const AUTHORS_DIR = path.resolve(DATA_DIR, 'authors');

// Determine if we are in production (dist folder exists)
const isProduction = existsSync(DIST_DIR);

// ----- Load .env file -----
async function loadDotEnv() {
    const envPath = path.resolve(PROJECT_ROOT, '.env');
    if (!existsSync(envPath)) return;

    try {
        const raw = await fs.readFile(envPath, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;

            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();

            // Remove surrounding quotes
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            if (!key) continue;
            if (process.env[key] === undefined) process.env[key] = value;
        }
    } catch {
        // ignore
    }
}

await loadDotEnv();

// ----- Express app -----
const app = express();

// CORS: Allow the Vite dev server origin in development, or allow all in production
const DEV_ORIGIN = 'http://localhost:5173';
app.use(cors({
    origin: isProduction
        ? true  // Allow any origin in production (same-origin or proxied)
        : [DEV_ORIGIN, 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
    methods: ['GET', 'PUT', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '5mb' }));

// ----- Helper functions -----

function isJsonFile(fileName) {
    return typeof fileName === 'string' && fileName.toLowerCase().endsWith('.json');
}

async function walk(dir) {
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

function authorFilePath(authorFile) {
    const raw = String(authorFile ?? '');

    const candidatesRaw = [raw];
    for (let i = 0; i < 5; i++) {
        const last = candidatesRaw[candidatesRaw.length - 1];
        if (!last || !last.includes('%')) break;
        try {
            candidatesRaw.push(decodeURIComponent(last));
        } catch {
            break;
        }
    }

    const filenames = new Set();
    for (const c of candidatesRaw) {
        filenames.add(path.basename(c));
    }

    // 1) Exact match
    for (const filename of filenames) {
        const fullPath = path.join(AUTHORS_DIR, filename);
        if (existsSync(fullPath)) return fullPath;
    }

    // 2) Directory scan fallback
    try {
        const dirFiles = fs.readdirSync(AUTHORS_DIR);
        for (const filename of filenames) {
            const exact = dirFiles.find(f => f === filename);
            if (exact) return path.join(AUTHORS_DIR, exact);
        }
    } catch {
        // ignore
    }

    return null;
}

function safeBasename(fileName) {
    return path.basename(String(fileName ?? '').trim());
}

function datasetFilePath(datasetName) {
    const base = safeBasename(datasetName);
    if (!base) return null;
    const full = path.join(DATASETS_DIR, base);
    if (!full.startsWith(DATASETS_DIR)) return null;
    return full;
}

async function readJsonIfExists(filePath) {
    if (!existsSync(filePath)) return null;
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
}

// ----- API Routes from original server.js (authors) -----

app.get('/api/authors/:authorFile', async (req, res) => {
    try {
        const filePath = authorFilePath(req.params.authorFile);
        if (!filePath) {
            return res.status(404).json({ error: 'Author file not found' });
        }
        const content = await fs.readFile(filePath, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(content);
    } catch (err) {
        res.status(404).json({ error: 'Author file not found' });
    }
});

app.put('/api/authors/:authorFile/vachanas/:vachanaNumber/:field', async (req, res) => {
    try {
        const { field } = req.params;
        const allowedFields = new Set([
            'translation', 'kannada', 'transliteration', 'english',
            'hindi', 'sanskrit', 'tamil', 'telugu', 'marathi'
        ]);

        if (!allowedFields.has(field)) {
            return res.status(400).json({ error: 'Invalid field. Unsupported language field.' });
        }

        const bodyValue = req.body?.[field];
        if (typeof bodyValue !== 'string' && bodyValue !== null) {
            return res.status(400).json({ error: `Invalid ${field}. Expected string or null.` });
        }

        const filePath = authorFilePath(req.params.authorFile);
        if (!filePath) {
            return res.status(404).json({ error: 'Author file not found' });
        }

        const raw = await fs.readFile(filePath, 'utf8');
        const json = JSON.parse(raw);
        const vachanaNumber = Number(req.params.vachanaNumber);
        const idx = json.vachanas.findIndex(v => Number(v.number) === vachanaNumber);
        if (idx === -1) {
            return res.status(404).json({ error: 'Vachana not found in author file' });
        }

        json.vachanas[idx][field] = bodyValue;

        const tmpPath = filePath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
        await fs.rename(tmpPath, filePath);

        res.status(200).json({ ok: true, [field]: bodyValue });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update field', details: err?.message ?? String(err) });
    }
});

app.put('/api/authors/:authorFile/vachanas/:vachanaNumber/translation', async (req, res) => {
    try {
        const { translation } = req.body ?? {};
        if (typeof translation !== 'string' && translation !== null) {
            return res.status(400).json({ error: 'Invalid translation. Expected string or null.' });
        }

        const filePath = authorFilePath(req.params.authorFile);
        if (!filePath) {
            return res.status(404).json({ error: 'Author file not found' });
        }

        const raw = await fs.readFile(filePath, 'utf8');
        const json = JSON.parse(raw);
        const vachanaNumber = Number(req.params.vachanaNumber);
        const idx = json.vachanas.findIndex(v => Number(v.number) === vachanaNumber);
        if (idx === -1) {
            return res.status(404).json({ error: 'Vachana not found in author file' });
        }

        json.vachanas[idx].translation = translation;

        const tmpPath = filePath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
        await fs.rename(tmpPath, filePath);

        res.status(200).json({ ok: true, translation });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update translation', details: err?.message ?? String(err) });
    }
});

// ----- API Routes from datasets_list_server.js (MUST come before :datasetName routes) -----

app.get('/api/datasets/list', async (_req, res) => {
    try {
        let datasetFiles = [];
        try {
            datasetFiles = (await walk(DATASETS_DIR))
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

app.get('/api/datasets/all', async (_req, res) => {
    try {
        const files = await walk(DATA_DIR);
        const rel = files.map(f => path.relative(DATA_DIR, f).split(path.sep).join('/'));
        res.status(200).json({ ok: true, files: rel });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Failed to list data files', details: e?.message ?? String(e) });
    }
});

// ----- API Routes from dataset_server.js (parameterized, after fixed routes) -----

app.get('/api/datasets/:datasetName', async (req, res) => {
    try {
        const filePath = datasetFilePath(req.params.datasetName);
        if (!filePath) return res.status(400).json({ error: 'Invalid dataset name' });

        const json = await readJsonIfExists(filePath);
        if (!json) return res.status(404).json({ error: 'Dataset not found' });

        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(json, null, 2) + '\n');
    } catch (e) {
        res.status(500).json({ error: 'Failed to load dataset', details: e?.message ?? String(e) });
    }
});

app.post('/api/datasets/:datasetName/items', async (req, res) => {
    try {
        const { datasetName } = req.params;
        const filePath = datasetFilePath(datasetName);
        if (!filePath) return res.status(400).json({ error: 'Invalid dataset name' });

        const payload = req.body;
        const { languages, item } = payload ?? {};

        if (!Array.isArray(languages) || languages.length === 0) {
            return res.status(400).json({ error: 'languages must be a non-empty array' });
        }
        if (!item || typeof item !== 'object') {
            return res.status(400).json({ error: 'item is required' });
        }
        if (typeof item.page !== 'number') {
            return res.status(400).json({ error: 'item.page must be a number' });
        }

        const allowedLangFields = new Set([
            'kannada', 'transliteration', 'english', 'hindi',
            'sanskrit', 'tamil', 'telugu', 'marathi'
        ]);

        for (const lang of languages) {
            if (!allowedLangFields.has(lang)) {
                return res.status(400).json({ error: `Unsupported language field: ${lang}` });
            }
        }

        const existing = await readJsonIfExists(filePath);
        const baseJson = existing && typeof existing === 'object'
            ? existing
            : { name: safeBasename(datasetName), data: [] };

        const dataRows = Array.isArray(baseJson.data) ? baseJson.data : [];
        const idx = dataRows.findIndex((x) => Number(x?.page) === Number(item.page));
        const existingRow = idx === -1 ? {} : (dataRows[idx] ?? {});

        const valuesByLang = Object.fromEntries(
            languages.map((lang) => [lang, lang in item ? item[lang] : existingRow?.[lang]])
        );

        for (const lang of languages) {
            if (!(lang in valuesByLang)) valuesByLang[lang] = null;
        }

        const nonEnglishLangs = languages.filter(l => l !== 'english');
        const orderedKeys = [
            'page',
            ...nonEnglishLangs,
            ...(languages.includes('english') ? ['english'] : [])
        ];

        const nextRow = {};
        for (const k of orderedKeys) {
            if (k === 'page') {
                nextRow.page = item.page;
                continue;
            }
            nextRow[k] = k in valuesByLang ? valuesByLang[k] : null;
        }

        for (const [k, v] of Object.entries(existingRow)) {
            if (k === 'page') continue;
            if (k in nextRow) continue;
            nextRow[k] = v;
        }

        const nextData = idx === -1 ? [...dataRows, nextRow] : dataRows.map((r, i) => (i === idx ? nextRow : r));

        const outJson = {
            ...baseJson,
            name: safeBasename(datasetName),
            data: nextData
        };

        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });

        const tmpPath = filePath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(outJson, null, 2) + '\n', 'utf8');
        await fs.rename(tmpPath, filePath);

        res.status(200).json({ ok: true, dataset: outJson });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update dataset', details: e?.message ?? String(e) });
    }
});

// ----- RAG Routes -----
attachRagRoutes(app, { publicRoot: PUBLIC_DIR });

// ----- Serve static frontend (production) -----
if (isProduction) {
    console.log(`[Production mode] Serving static files from: ${DIST_DIR}`);
    app.use(express.static(DIST_DIR));

    // All other GET requests -> index.html (SPA fallback)
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api/')) {
            res.sendFile(path.join(DIST_DIR, 'index.html'));
        }
    });
} else {
    console.log('[Development mode] Static files not served. Use `npm run frontend` for Vite dev server.');
}

// ----- Start server -----
const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`  Vachana Sanchaya Server`);
    console.log(`  Mode: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`  URL: http://localhost:${port}`);
    console.log(`  On your network: http://YOUR_IP_ADDRESS:${port}`);
    console.log(`========================================================\n`);
});

