import express from 'express';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';

const app = express();

app.use(cors({
    origin: 'http://localhost:5173',
    methods: ['GET', 'PUT', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '5mb' }));

const publicRoot = "C:\\vachana-sanchaya\\vachana-sanchaya\\public";

function safeBasename(fileName) {
    return path.basename(String(fileName ?? '').trim());
}

function datasetFilePath(datasetName) {
    const base = safeBasename(datasetName);
    if (!base) return null;
    const full = path.join(publicRoot, 'data', 'datasets', base);
    // Only allow if it lives under our datasets dir.
    if (!full.startsWith(path.join(publicRoot, 'data', 'datasets'))) return null;
    return full;
}

async function readJsonIfExists(filePath) {
    if (!existsSync(filePath)) return null;
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
}

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
            'kannada',
            'transliteration',
            'english',
            'hindi',
            'sanskrit',
            'tamil',
            'telugu',
            'marathi'
        ]);

        for (const lang of languages) {
            if (!allowedLangFields.has(lang)) {
                return res.status(400).json({ error: `Unsupported language field: ${lang}` });
            }
        }

        const existing = await readJsonIfExists(filePath);

        const baseJson =
            existing && typeof existing === 'object'
                ? existing
                : {
                    name: safeBasename(datasetName),
                    data: []
                };

        const dataRows = Array.isArray(baseJson.data) ? baseJson.data : [];

        const idx = dataRows.findIndex((x) => Number(x?.page) === Number(item.page));

        // Merge by page. Only update fields included in `languages`.
        // IMPORTANT: JSON key insertion order matters for your requirement.
        // We'll rebuild the row with a deterministic key order:
        //   - page first
        //   - then the selected languages in the exact `languages` order (excluding english)
        //   - then english last (if present)

        const existingRow = idx === -1 ? {} : (dataRows[idx] ?? {});

        const valuesByLang = Object.fromEntries(
            languages.map((lang) => [
                lang,
                lang in item ? item[lang] : existingRow?.[lang]
            ])
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

        // Also preserve any other fields already present in the row
        // (append them after the required ordered keys, to avoid reordering surprises)
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


        // Atomic write
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

const port = process.env.DATASET_PORT ? Number(process.env.DATASET_PORT) : 3002;
app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Dataset API listening on http://localhost:${port}`);
});

