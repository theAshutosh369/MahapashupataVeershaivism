import type { RAGDataset, RAGLogEntry, RAGQueryRequest, RAGQueryResponse } from '../../types/rag';

const API_BASE = import.meta.env.VITE_RAG_API_URL ?? '';
const GEMINI_ERROR_PREFIX = '__RAG_GEMINI_ERROR__:';

export async function listRagDatasets(): Promise<RAGDataset[]> {
    console.log('Fetching RAG datasets from:', `${API_BASE}/api/rag/datasets`);
    const response = await fetch(`${API_BASE}/api/rag/datasets`, { method: 'GET' });
    if (!response.ok) throw new Error('Failed to load dataset list');
    const data = await response.json();
    if (!data?.ok || !Array.isArray(data.datasets)) throw new Error('Invalid dataset list response');
    function formatDatasetName(raw: string): string {
        let name = raw.replace(/\.(json|pdf|txt)$/i, '');
        try { name = decodeURIComponent(name); } catch { /* ignore */ }
        return name;
    }
    return [
        { name: 'All datasets', value: '__ALL__' },
        ...data.datasets.filter((dataset: unknown) => String(dataset).trim().length > 0).map((dataset: unknown) => {
            const raw = String(dataset);
            return { name: formatDatasetName(raw), value: raw };
        })
    ];
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

export async function queryRagAssistantStream(request: RAGQueryRequest, opts: {
    signal: AbortSignal;
    onToken: (t: string) => void;
    onLog?: (log: RAGLogEntry) => void;
    onDone: (d: RAGQueryResponse) => void;
}): Promise<void> {
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
                if (log && typeof log.message === 'string') opts.onLog?.(log);
                return;
            }
            if (type === 'token') {
                const token = typeof data === 'string' ? data : String(data ?? '');
                if (token.startsWith(GEMINI_ERROR_PREFIX)) throw new Error(token.slice(GEMINI_ERROR_PREFIX.length).trim() || 'Gemini request failed.');
                opts.onToken(token);
                return;
            }
            if (type === 'done') {
                const done = data as RAGQueryResponse;
                opts.onDone(done);
                return;
            }
            const errMsg = typeof data === 'string' ? data : 'Stream error';
            throw new Error(errMsg);
        }
    });
}
