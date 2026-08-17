import { GoogleGenAI } from '@google/genai';



const DEFAULT_MODEL = 'models/gemini-flash-latest';


function assertApiKey() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY in environment variables.');
    }
    return apiKey.trim();
}

function stripThinkBlocks(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
}

export async function generateGeminiMarkdown({ prompt, model }) {
    const apiKey = assertApiKey();
    const usedModel = model || DEFAULT_MODEL;

    const client = new GoogleGenAI({ apiKey });

    // Non-streaming, with timeout.
    const controller = new AbortController();
    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 20000);

    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const result = await client.models.generateContent({
            model: usedModel,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            // Request-level safety: Gemini should only use provided context via prompt.
            generationConfig: {
                temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
                topP: 0.95,
                maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 1024)
            },
            signal: controller.signal
        });

        const text = result?.response?.text?.() ?? result?.text ?? '';
        return stripThinkBlocks(text);
    } catch (err) {
        const message = err?.message ?? String(err);
        if (message.toLowerCase().includes('aborted')) {
            throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

function toSseData(obj) {
    // SSE requires each event data line to be prefixed with "data:".
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// Streams plain text tokens/chunks.
// onToken(token: string) is called repeatedly.
export async function streamGeminiMarkdown({ prompt, model, onToken, signal }) {
    const apiKey = assertApiKey();
    const usedModel = model || DEFAULT_MODEL;

    const client = new GoogleGenAI({ apiKey });

    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 20000);
    const controller = new AbortController();

    // If caller provided a signal, abort when either aborts.
    if (signal) {
        if (signal.aborted) controller.abort();
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const stream = await client.models.generateContentStream({
            model: usedModel,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
                topP: 0.95,
                maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 1024)
            },
            signal: controller.signal
        });

        // Defensive: handle SDK variations.
        // Some versions expose `stream.stream`, others may expose `stream` itself.
        const asyncIterable = stream?.stream ?? stream;
        if (!asyncIterable || typeof asyncIterable[Symbol.asyncIterator] !== 'function') {
            throw new Error(
                'Gemini streaming response did not include an async stream. ' +
                `Got keys: ${stream ? Object.keys(stream) : 'undefined'}`
            );
        }

        for await (const chunk of asyncIterable) {
            // Be resilient to SDK chunk shape variations.
            const text =
                chunk?.text ??
                chunk?.candidates?.[0]?.content?.parts?.map((p) => p?.text).join('') ??
                chunk?.candidates?.[0]?.content?.parts?.map((p) => p?.inlineData?.data).join('') ??
                '';

            const cleaned = stripThinkBlocks(text);
            if (!cleaned) continue;
            onToken(cleaned);
        }

    } finally {
        clearTimeout(timeout);
    }
}


