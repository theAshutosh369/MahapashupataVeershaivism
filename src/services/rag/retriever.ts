import type { RAGDataset, RAGQueryRequest, RAGQueryResponse } from '../../types/rag';

const API_BASE = import.meta.env.VITE_RAG_API_URL ?? 'http://localhost:3001';

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

    return [
        { name: 'All datasets', value: '__ALL__' },
        ...data.datasets.map((dataset: unknown) => ({
            name: String(dataset),
            value: String(dataset)
        }))
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


