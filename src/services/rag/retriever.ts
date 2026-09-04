import type { RAGDataset, RAGQueryRequest, RAGQueryResponse } from '../../types/rag';

// In development, Vite dev server (port 5173) proxies /api/ requests to the backend.
// In production, Express serves both the React build and /api/ from the same origin.
// Set VITE_RAG_API_URL only when the backend is on a different origin.
const API_BASE = import.meta.env.VITE_RAG_API_URL ?? '';

export async function listRagDatasets(): Promise<RAGDataset[]> {
    console.log('Fetching RAG datasets from:', `${API_BASE}/api/rag/datasets`);
    const response = await fetch(`${API_BASE}/api/rag/datasets`, { method: 'GET' });
    if (!response.ok) {
        throw new Error('Failed to load dataset list');
    }

    const data = await response.json();
    if (!data?.ok || !Array.isArray(data.datasets)) {
        throw new Error('Invalid dataset list response');
    }

    // Dataset names can be relative paths like "datasets/Hariharataratamyam.json",
    // "authors/basavaṇṇa.json", or top-level "SomeBook.pdf". Strip the directory
    // prefix and the file extension (.json or .pdf) for display.
    function formatDatasetName(raw: string): string {
        // Remove directory prefix (e.g., "datasets/", "authors/")
        let name = raw.replace(/^(datasets\/|authors\/)/i, '');
        // Remove .json, .pdf, or .txt extension
        name = name.replace(/\.(json|pdf|txt)$/i, '');
        // Decode URL-encoded characters
        try {
            name = decodeURIComponent(name);
        } catch {
            // ignore decoding errors
        }
        return name;
    }

    return [
        { name: 'All datasets', value: '__ALL__' },
        ...data.datasets
            .filter((dataset: unknown) => String(dataset).trim().length > 0)
            .map((dataset: unknown) => {
                const raw = String(dataset);
                return {
                    name: formatDatasetName(raw),
                    value: raw
                };
            })
    ];
}

export async function queryRagAssistant(request: RAGQueryRequest): Promise<RAGQueryResponse> {
    const response = await fetch(`${API_BASE}/api/rag/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new Error(errorBody?.error || 'RAG query request failed');
    }

    const data = await response.json();
    if (!data?.ok) {
        throw new Error(data?.error || 'RAG assistant returned an error');
    }

    return data as RAGQueryResponse;
}

export async function queryRagAssistantStream(
    request: RAGQueryRequest,
    opts: {
        signal: AbortSignal;
        onToken: (t: string) => void;
        onDone: (d: RAGQueryResponse) => void;
    }
): Promise<void> {
    // Ensure this function resolves as soon as we receive `event: done`/`event: error`.
    // Without this, SSE connections can remain open and `consumeSseStream()` may not return.
    const localController = new AbortController();
    const combinedSignal = localController.signal;

    // Propagate external abort -> local abort
    if (opts.signal) {
        if (opts.signal.aborted) localController.abort();
        else opts.signal.addEventListener('abort', () => localController.abort(), { once: true });
    }

    const response = await fetch(`${API_BASE}/api/rag/query/stream`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: combinedSignal
    });


    if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorBody?.error || 'RAG stream request failed');
    }

    const { consumeSseStream } = await import('./streaming');

    await consumeSseStream({
        response,
        signal: opts.signal,
        onEvent: ({ type, data }) => {
            if (type === 'token') {
                // backend sends token as raw string via JSON.stringify
                const token = typeof data === 'string' ? data : '';
                opts.onToken(String(token ?? ''));
                return;
            }

            if (type === 'done') {
                opts.onDone(data as RAGQueryResponse);
                // Abort to force consumeSseStream() to resolve immediately.
                localController.abort();
                return;
            }

            if (type === 'error') {
                localController.abort();
                const errMsg = typeof data === 'string' ? data : 'Stream error';
                throw new Error(errMsg);
            }

        }
    });
}
