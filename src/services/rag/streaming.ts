export function parseSseDataLines(line: string): string | null {
    // Expect lines in form: data: <json>
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
    onEvent: (event: { type: 'token' | 'done' | 'error'; data?: unknown }) => void;
    signal: AbortSignal;
}): Promise<void> {
    if (!response.body) throw new Error('SSE response has no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let buffer = '';
    while (true) {
        if (signal.aborted) {
            try {
                reader.cancel();
            } catch {
                // ignore
            }
            return;
        }

        const { value, done } = await reader.read();
        if (done) return;

        buffer += decoder.decode(value, { stream: true });

        // SSE uses double newline to separate events.
        // We'll process line-by-line for simplicity.
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop() ?? '';

        for (const part of parts) {
            const lines = part.split(/\r?\n/);

            let eventType: 'token' | 'done' | 'error' | null = null;
            let dataJson: string | null = null;

            for (const line of lines) {
                const trimmed = String(line ?? '').trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('event:')) {
                    const raw = trimmed.slice('event:'.length).trim();
                    if (raw === 'token' || raw === 'done' || raw === 'error') eventType = raw;
                } else if (trimmed.startsWith('data:')) {
                    dataJson = trimmed.slice('data:'.length).trim();
                }
            }

            // Some SSE implementations may send only `data:` without an explicit `event:`.
            // In that case, default to `token` so streaming UI still works.
            if (!eventType) {
                if (dataJson === null) continue;
                eventType = 'token';
            }

            let parsed: unknown = undefined;
            if (dataJson !== null) {
                try {
                    parsed = JSON.parse(dataJson);
                } catch {
                    // token events might send a raw string as JSON string or plain string.
                    // Try to salvage: if it's quoted JSON, JSON.parse would succeed; otherwise ignore.
                    parsed = dataJson;
                }
            }

            onEvent({ type: eventType, data: parsed });
        }
    }
}

