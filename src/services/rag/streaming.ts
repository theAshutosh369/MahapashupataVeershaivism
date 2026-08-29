export function parseSseDataLines(line: string): string | null {
    const trimmed = String(line ?? '').trim();
    if (!trimmed.startsWith('data:')) return null;
    return trimmed.slice('data:'.length).trim();
}

export async function consumeSseStream({
    response,
    onEvent,
    signal
}: {
    response: Response;
    onEvent: (event: { type: 'token' | 'log' | 'done' | 'error'; data?: unknown }) => void;
    signal: AbortSignal;
}): Promise<void> {
    if (!response.body) throw new Error('SSE response has no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        if (signal.aborted) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return;
        }

        const { value, done } = await reader.read();
        if (done) return;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop() ?? '';

        for (const part of parts) {
            const lines = part.split(/\r?\n/);
            let eventType: 'token' | 'log' | 'done' | 'error' | null = null;
            let dataJson: string | null = null;

            for (const line of lines) {
                const trimmed = String(line ?? '').trim();
                if (!trimmed) continue;
                if (trimmed.startsWith('event:')) {
                    const raw = trimmed.slice('event:'.length).trim();
                    if (raw === 'token' || raw === 'log' || raw === 'done' || raw === 'error') eventType = raw;
                } else if (trimmed.startsWith('data:')) {
                    dataJson = trimmed.slice('data:'.length).trim();
                }
            }

            if (!eventType) {
                if (dataJson === null) continue;
                eventType = 'token';
            }

            let parsed: unknown = undefined;
            if (dataJson !== null) {
                try { parsed = JSON.parse(dataJson); }
                catch { parsed = dataJson; }
            }

            onEvent({ type: eventType, data: parsed });

            // `done` and `error` are terminal SSE events. A log event is
            // deliberately non-terminal so the UI can keep receiving logs and
            // answer tokens while the request is still running.
            if (eventType === 'done' || eventType === 'error') {
                try { await reader.cancel(); } catch { /* ignore */ }
                if (eventType === 'error') {
                    const message = typeof parsed === 'string' ? parsed : 'Stream error';
                    throw new Error(message);
                }
                return;
            }
        }
    }
}