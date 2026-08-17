import express from 'express';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import { attachRagRoutes } from './rag_routes.js';

// Load project-root .env without adding new dependencies.
// This ensures GEMINI_API_KEY / OPENAI_API_KEY are available to server-side RAG.
import { existsSync as _existsSync } from 'node:fs';

async function loadDotEnv() {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!_existsSync(envPath)) return;


    try {
        const raw = await (await import('node:fs/promises')).readFile(envPath, 'utf8');

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
        // ignore - environment may already be set
    }
}

await loadDotEnv();

const app = express();



// Allow requests from your frontend
app.use(
    cors({
        origin: 'http://localhost:5173',
        methods: ['GET', 'PUT', 'POST'],
        allowedHeaders: ['Content-Type']
    })
);

app.use(express.json({ limit: '2mb' }));

const publicRoot = 'C:\\vachana-sanchaya\\vachana-sanchaya\\public';

attachRagRoutes(app, { publicRoot });

function authorFilePath(authorFile) {
    const raw = String(authorFile ?? '');

    // Generate stable candidate filenames by decoding repeatedly (client may double-encode)
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

    const authorsDir = path.join(publicRoot, 'data', 'authors');

    // 1) Exact match first (fast + deterministic)
    for (const filename of filenames) {
        const fullPath = path.join(authorsDir, filename);
        if (existsSync(fullPath)) return fullPath;
    }

    // 2) Fallback: directory scan for basename match (handles odd encodings)
    try {
        const dirFiles = require('node:fs').readdirSync(authorsDir);
        for (const filename of filenames) {
            const exact = dirFiles.find(f => f === filename);
            if (exact) return path.join(authorsDir, exact);
        }
    } catch {
        // ignore
    }

    // 3) No-match: do not guess. Returning null prevents writing into the wrong author file.
    return null;
}



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

// Generic field update (kept for future)
app.put('/api/authors/:authorFile/vachanas/:vachanaNumber/:field', async (req, res) => {
    try {
        const { field } = req.params;
        const allowedFields = new Set([
            'translation',
            'kannada',
            'transliteration',
            'english',
            'hindi',
            'sanskrit',
            'tamil',
            'telugu',
            'marathi'
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

        // Atomic write: write tmp then rename
        const tmpPath = filePath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
        await fs.rename(tmpPath, filePath);

        res.status(200).json({ ok: true, [field]: bodyValue });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update field', details: err?.message ?? String(err) });
    }
});

// Frontend compatibility: update only translation via
// PUT /api/authors/:authorFile/vachanas/:vachanaNumber/translation
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

// SSE for Gemini streaming is handled inside rag_routes.js.

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Translation API listening on http://localhost:${port}`);
});


