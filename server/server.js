import express from 'express';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { attachRagRoutes } from './rag_routes.js';
import { commitFile } from './github_sync.js';

// ----- Environment & paths -----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.resolve(PROJECT_ROOT, 'public');
const DIST_DIR = path.resolve(PROJECT_ROOT, 'dist');
const DATA_DIR = path.resolve(PUBLIC_DIR, 'data');
const DATASETS_DIR = path.resolve(DATA_DIR, 'datasets');
const AUTHORS_DIR = path.resolve(DATA_DIR, 'Vachanas');

// Determine if we are in production (dist folder exists)
const isProduction = existsSync(DIST_DIR);
// RAG runtime follows the same mode as this server. Development explicitly
// watches public/data; production remains read-only and uses prebuilt shards.
if (process.env.RAG_RUNTIME_MODE === undefined) {
    process.env.RAG_RUNTIME_MODE = isProduction ? 'production' : 'development';
}

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
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
            if (!key) continue;
            if (process.env[key] === undefined) process.env[key] = value;
        }
    } catch {
        // ignore
    }
}

await loadDotEnv();

const app = express();
const DEV_ORIGIN = 'http://localhost:5173';
app.use(cors({
    origin: isProduction ? true : [DEV_ORIGIN, 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
    methods: ['GET', 'PUT', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '5mb' }));

function isJsonFile(fileName) { return typeof fileName === 'string' && fileName.toLowerCase().endsWith('.json'); }
async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (entry.isFile() && isJsonFile(entry.name)) out.push(full);
    }
    return out;
}
function authorFilePath(authorFile) {
    const raw = String(authorFile ?? '');
    const candidatesRaw = [raw];
    for (let i = 0; i < 5; i++) {
        const last = candidatesRaw[candidatesRaw.length - 1];
        if (!last || !last.includes('%')) break;
        try { candidatesRaw.push(decodeURIComponent(last)); } catch { break; }
    }
    const filenames = new Set(candidatesRaw.map((c) => path.basename(c)));
    for (const filename of filenames) { const fullPath = path.join(AUTHORS_DIR, filename); if (existsSync(fullPath)) return fullPath; }
    try {
        const dirFiles = fs.readdirSync(AUTHORS_DIR);
        for (const filename of filenames) if (dirFiles.includes(filename)) return path.join(AUTHORS_DIR, filename);
    } catch {}
    try {
        const dirFiles = fs.readdirSync(DATA_DIR, { withFileTypes: true });
        const toVisit = dirFiles.filter(e => e.isDirectory()).map(e => path.join(DATA_DIR, e.name));
        for (const dir of toVisit) {
            const files = fs.readdirSync(dir);
            for (const filename of filenames) if (files.includes(filename)) { const fullPath = path.join(dir, filename); if (fullPath.startsWith(DATA_DIR)) return fullPath; }
        }
    } catch {}
    return null;
}
function safeBasename(fileName) { return path.basename(String(fileName ?? '').trim()); }
function datasetFilePath(datasetName) { const base = safeBasename(datasetName); if (!base) return null; const full = path.join(DATASETS_DIR, base); return full.startsWith(DATASETS_DIR) ? full : null; }
async function readJsonIfExists(filePath) { if (!existsSync(filePath)) return null; return JSON.parse(await fs.readFile(filePath, 'utf8')); }

app.get('/api/authors/:authorFile', async (req, res) => {
    try { const filePath = authorFilePath(req.params.authorFile); if (!filePath) return res.status(404).json({ error: 'Author file not found' }); const content = await fs.readFile(filePath, 'utf-8'); res.setHeader('Content-Type', 'application/json'); res.status(200).send(content); }
    catch { res.status(404).json({ error: 'Author file not found' }); }
});

app.put('/api/authors/:authorFile/vachanas/:vachanaNumber/:field', async (req, res) => {
    try {
        const { field } = req.params;
        const allowedFields = new Set(['translation', 'kannada', 'transliteration', 'english', 'hindi', 'sanskrit', 'tamil', 'telugu', 'marathi']);
        if (!allowedFields.has(field)) return res.status(400).json({ error: 'Invalid field. Unsupported language field.' });
        const bodyValue = req.body?.[field];
        if (typeof bodyValue !== 'string' && bodyValue !== null) return res.status(400).json({ error: `Invalid ${field}. Expected string or null.` });
        const filePath = authorFilePath(req.params.authorFile); if (!filePath) return res.status(404).json({ error: 'Author file not found' });
        const json = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const vachanaNumber = Number(req.params.vachanaNumber); const idx = json.vachanas.findIndex(v => Number(v.number) === vachanaNumber);
        if (idx === -1) return res.status(404).json({ error: 'Vachana not found in author file' });
        json.vachanas[idx][field] = bodyValue;
        const tmpPath = filePath + '.tmp'; await fs.writeFile(tmpPath, JSON.stringify(json, null, 2) + '\n', 'utf8'); await fs.rename(tmpPath, filePath);
        const repoPath = 'public/data/Vachanas/' + path.basename(filePath); commitFile(repoPath, JSON.stringify(json, null, 2) + '\n', `Update ${field} for vachana #${vachanaNumber} [auto-save]`).catch(() => {});
        res.status(200).json({ ok: true, [field]: bodyValue });
    } catch (err) { res.status(500).json({ error: 'Failed to update field', details: err?.message ?? String(err) }); }
});

app.put('/api/authors/:authorFile/vachanas/:vachanaNumber/translation', async (req, res) => {
    try {
        const { translation } = req.body ?? {}; if (typeof translation !== 'string' && translation !== null) return res.status(400).json({ error: 'Invalid translation. Expected string or null.' });
        const filePath = authorFilePath(req.params.authorFile); if (!filePath) return res.status(404).json({ error: 'Author file not found' });
        const json = JSON.parse(await fs.readFile(filePath, 'utf8')); const vachanaNumber = Number(req.params.vachanaNumber); const idx = json.vachanas.findIndex(v => Number(v.number) === vachanaNumber);
        if (idx === -1) return res.status(404).json({ error: 'Vachana not found in author file' });
        json.vachanas[idx].translation = translation; const tmpPath = filePath + '.tmp'; await fs.writeFile(tmpPath, JSON.stringify(json, null, 2) + '\n', 'utf8'); await fs.rename(tmpPath, filePath);
        const repoPath = 'public/data/Vachanas/' + path.basename(filePath); commitFile(repoPath, JSON.stringify(json, null, 2) + '\n', `Update translation for vachana #${vachanaNumber} [auto-save]`).catch(() => {});
        res.status(200).json({ ok: true, translation });
    } catch (err) { res.status(500).json({ error: 'Failed to update translation', details: err?.message ?? String(err) }); }
});

app.get('/api/datasets/list', async (_req, res) => {
    try { let datasetFiles = []; try { datasetFiles = (await walk(DATASETS_DIR)).map(f => path.basename(f)).filter(isJsonFile).sort((a, b) => a.localeCompare(b)); } catch {} res.status(200).json({ ok: true, datasets: datasetFiles }); }
    catch (e) { res.status(500).json({ ok: false, error: 'Failed to scan public/data', details: e?.message ?? String(e) }); }
});
app.get('/api/datasets/all', async (_req, res) => {
    try { const files = await walk(DATA_DIR); const rel = files.map(f => path.relative(DATA_DIR, f).split(path.sep).join('/')); res.status(200).json({ ok: true, files: rel }); }
    catch (e) { res.status(500).json({ ok: false, error: 'Failed to list data files', details: e?.message ?? String(e) }); }
});
app.get('/api/datasets/:datasetName', async (req, res) => {
    try { const filePath = datasetFilePath(req.params.datasetName); if (!filePath) return res.status(400).json({ error: 'Invalid dataset name' }); const json = await readJsonIfExists(filePath); if (!json) return res.status(404).json({ error: 'Dataset not found' }); res.setHeader('Content-Type', 'application/json'); res.status(200).send(JSON.stringify(json, null, 2) + '\n'); }
    catch (e) { res.status(500).json({ error: 'Failed to load dataset', details: e?.message ?? String(e) }); }
});
app.post('/api/datasets/:datasetName/items', async (req, res) => {
    try {
        const filePath = datasetFilePath(req.params.datasetName); if (!filePath) return res.status(400).json({ error: 'Invalid dataset name' });
        const { languages, item } = req.body ?? {};
        if (!Array.isArray(languages) || !languages.length) return res.status(400).json({ error: 'languages must be a non-empty array' });
        if (!item || typeof item !== 'object') return res.status(400).json({ error: 'item is required' });
        if (typeof item.page !== 'number') return res.status(400).json({ error: 'item.page must be a number' });
        const allowedLangFields = new Set(['kannada', 'transliteration', 'english', 'hindi', 'sanskrit', 'tamil', 'telugu', 'marathi']);
        for (const lang of languages) if (!allowedLangFields.has(lang)) return res.status(400).json({ error: `Unsupported language field: ${lang}` });
        const existing = await readJsonIfExists(filePath); const baseJson = existing && typeof existing === 'object' ? existing : { name: safeBasename(req.params.datasetName), data: [] };
        const dataRows = Array.isArray(baseJson.data) ? baseJson.data : []; const idx = dataRows.findIndex(x => Number(x?.page) === Number(item.page)); const existingRow = idx === -1 ? {} : (dataRows[idx] ?? {});
        const valuesByLang = Object.fromEntries(languages.map(lang => [lang, lang in item ? item[lang] : existingRow?.[lang]]));
        const orderedKeys = ['page', ...languages.filter(l => l !== 'english'), ...(languages.includes('english') ? ['english'] : [])]; const nextRow = {};
        for (const k of orderedKeys) nextRow[k] = k === 'page' ? item.page : (k in valuesByLang ? valuesByLang[k] : null);
        for (const [k, v] of Object.entries(existingRow)) if (k !== 'page' && !(k in nextRow)) nextRow[k] = v;
        const nextData = idx === -1 ? [...dataRows, nextRow] : dataRows.map((r, i) => i === idx ? nextRow : r); const outJson = { ...baseJson, name: safeBasename(req.params.datasetName), data: nextData };
        await fs.mkdir(path.dirname(filePath), { recursive: true }); const tmpPath = filePath + '.tmp'; await fs.writeFile(tmpPath, JSON.stringify(outJson, null, 2) + '\n', 'utf8'); await fs.rename(tmpPath, filePath);
        res.status(200).json({ ok: true, dataset: outJson });
    } catch (e) { res.status(500).json({ error: 'Failed to update dataset', details: e?.message ?? String(e) }); }
});

attachRagRoutes(app, { publicRoot: PUBLIC_DIR });

if (isProduction) {
    console.log(`[Production mode] Serving static files from: ${DIST_DIR}`);
    app.use(express.static(DIST_DIR));
    app.get('*', (req, res) => { if (!req.path.startsWith('/api/')) res.sendFile(path.join(DIST_DIR, 'index.html')); });
} else {
    console.log('[Development mode] Static files not served. Use `npm run frontend` for Vite dev server.');
}

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`  Vachana Sanchaya Server`);
    console.log(`  Mode: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`  URL: http://localhost:${port}`);
    console.log(`  On your network: http://YOUR_IP_ADDRESS:${port}`);
    console.log(`========================================================\n`);
});
