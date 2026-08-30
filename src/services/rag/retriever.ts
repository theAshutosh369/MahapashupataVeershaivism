import type { RAGDataset, RAGLogEntry, RAGQueryRequest, RAGQueryResponse } from '../../types/rag';

const API_BASE = import.meta.env.VITE_RAG_API_URL ?? '';
const GEMINI_ERROR_PREFIX = '__RAG_GEMINI_ERROR__:';

function formatDatasetName(raw: string): string {
    let name = raw.replace(/\.(json|pdf|txt)$/i, '');
    try { name = decodeURIComponent(name); } catch { /* ignore */ }
    return name;
}

function toDatasetList(values: unknown[]): RAGDataset[] {
    const unique = new Set<string>();
    const datasets: RAGDataset[] = [];
    for (const value of values) {
        const raw = String(value ?? '').trim();
        if (!raw || raw === 'authors.json' || raw.endsWith('/authors.json') || unique.has(raw)) continue;
        unique.add(raw);
        datasets.push({ name: formatDatasetName(raw), value: raw });
    }
    datasets.sort((a, b) => a.name.localeCompare(b.name));
    return [{ name: 'All datasets', value: '__ALL__' }, ...datasets];
}

export async function listRagDatasets(): Promise<RAGDataset[]> {
    const ragUrl = `${API_BASE}/api/rag/datasets`;
    console.log('Fetching RAG datasets from:', ragUrl);

    // The RAG catalog endpoint normally returns the exact source paths used by
    // the sharded index. Do not make the UI depend on index initialization,
    // however: on a cold deployment the index can be unavailable while the
    // public data directory is already readable. Fall back to the independent
    // dataset catalog endpoint in that case.
    try {
        const response = await fetch(ragUrl, { method: 'GET' });
        if (response.ok) {
            const data = await response.json().catch(() => null);
            if (data?.ok && Array.isArray(data.datasets)) {
                return toDatasetList(data.datasets);
            }
        }
    } catch (error) {
        console.warn('[RAG datasets] Primary catalog unavailable:', error);
    }

    const fallbackUrl = `${API_BASE}/api/datasets/all`;
    console.warn('[RAG datasets] Falling back to:', fallbackUrl);
    try {
        const response = await fetch(fallbackUrl, { method: 'GET' });
        if (response.ok) {
            const data = await response.json().catch(() => null);
            if (data?.ok && Array.isArray(data.files)) {
                const jsonFiles = data.files.filter((file: unknown) => /\.(json|pdf|txt)$/i.test(String(file)));
                return toDatasetList(jsonFiles);
            }
        }
    } catch (error) {
        console.warn('[RAG datasets] Fallback catalog unavailable:', error);
    }

    throw new Error('Failed to load dataset list. The RAG server is not reachable.');
}

export async function queryRagAssistant(request: RAGQueryRequest): Promise<RAGQueryResponse> {
    const response = await fetch(`${API_BASE}/api/rag/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
    });
    if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new Error(errorBody?.error || 'RAG query request failed');
    }
    const data = await response.json();
    if (!data?.ok) throw new Error(data?.error || 'RAG assistant returned an error');
    return data as RAGQueryResponse;
}

function normalizeStreamToken(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data == null) return '';
    if (typeof data === 'object') {
        const value = data as Record<string, unknown>;
        const candidates = [
            value.text,
            value.token,
            value.content,
            value.delta,
            value.output_text,
            value.outputText
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string') return candidate;
            if (candidate && typeof candidate === 'object') {
                const nested = candidate as Record<string, unknown>;
                if (typeof nested.text === 'string') return nested.text;
                if (typeof nested.value === 'string') return nested.value;
            }
        }
        try { return JSON.stringify(data); } catch { return ''; }
    }
    return String(data);
}

export async function queryRagAssistantStream(request: RAGQueryRequest, opts: {
    signal: AbortSignal;
    onToken: (t: string) => void;
    onLog?: (log: RAGLogEntry) => void;
    onDone: (d: RAGQueryResponse) => void;
}): Promise<void> {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rag-query-log-start'));
    const response = await fetch(`${API_BASE}/api/rag/query/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: opts.signal
    });
    if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorBody?.error || 'RAG stream request failed');
    }
    const { consumeSseStream } = await import('./streaming');
    await consumeSseStream({
        response, signal: opts.signal,
        onEvent: ({ type, data }) => {
            if (type === 'log') {
                const log = data as RAGLogEntry;
                if (log && typeof log.message === 'string') {
                    opts.onLog?.(log);
                    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rag-query-log-live', { detail: log }));
                }
                return;
            }
            if (type === 'token') {
                const token = normalizeStreamToken(data);
                if (token.startsWith(GEMINI_ERROR_PREFIX)) throw new Error(token.slice(GEMINI_ERROR_PREFIX.length).trim() || 'Gemini request failed.');
                if (token) opts.onToken(token);
                return;
            }
            if (type === 'done') {
                const done = data as RAGQueryResponse;
                if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rag-query-logs-complete', {
                    detail: { requestLogId: done.requestLogId, answer: done.answer || '', logs: done.logs || [] }
                }));
                opts.onDone(done);
                return;
            }
            const errMsg = typeof data === 'string' ? data : 'Stream error';
            throw new Error(errMsg);
        }
    });
}
