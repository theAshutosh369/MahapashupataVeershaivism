/**
 * GeminiProvider — Google Gemini LLM provider.
 * Keeps Gemini-specific configuration, retry/backoff and streaming isolated
 * behind the normalized LLMProvider interface.
 */

import { LLMProvider, ProvCode } from './base.js';

// Use a stable model instead of the mutable gemini-flash-latest alias.
// This avoids the alias moving underneath the application and changing API behavior.
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GeminiProvider extends LLMProvider {
    constructor(opts) {
        super();
        this.opts = opts || {};
        this._clientPromise = null;
    }

    name() {
        return 'gemini';
    }

    getApiKey() {
        return process.env.GEMINI_API_KEY;
    }

    isConfigured() {
        const key = this.getApiKey();
        return Boolean(key && typeof key === 'string' && key.trim());
    }

    getModel() {
        const configured = process.env.GEMINI_MODEL;
        return configured && typeof configured === 'string' && configured.trim()
            ? configured.trim()
            : (this.opts.model || GEMINI_DEFAULT_MODEL);
    }

    getModelInfo() {
        return { provider: 'gemini', model: this.getModel() };
    }

    getModelChain() {
        const chain = [this.getModel()];
        const configuredFallbacks = process.env.GEMINI_FALLBACK_MODELS;
        if (configuredFallbacks) {
            for (const model of configuredFallbacks.split(',').map((s) => s.trim()).filter(Boolean)) {
                if (!chain.includes(model)) chain.push(model);
            }
        }
        return chain;
    }

    async _getClient() {
        if (!this._clientPromise) {
            const { GoogleGenAI } = await import('@google/genai');
            this._clientPromise = Promise.resolve(new GoogleGenAI({ apiKey: this.getApiKey() }));
        }
        return this._clientPromise;
    }

    _config() {
        return {
            temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
            topP: 0.95,
            maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)
        };
    }

    async generate({ prompt, signal }) {
        if (!this.isConfigured()) {
            console.warn('[GeminiProvider] GEMINI_API_KEY is not configured');
            return null;
        }

        const client = await this._getClient();
        const models = this.getModelChain();
        const maxAttempts = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS || 3));
        const backoffBase = Math.max(100, Number(process.env.GEMINI_BACKOFF_BASE_MS || 1000));
        let lastError = null;
        let lastCode = null;

        for (const model of models) {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    console.log(`[GeminiProvider] Generating with ${model} (attempt ${attempt + 1}/${maxAttempts})`);
                    const result = await client.models.generateContent({
                        model,
                        contents: prompt,
                        config: this._config(),
                        abortSignal: signal
                    });
                    const text = String(result?.text || result?.response?.text?.() || '').trim();
                    if (text) return text;
                    throw new Error('Gemini returned an empty response');
                } catch (error) {
                    const norm = this.normalizeError(error);
                    lastError = norm.message;
                    lastCode = norm.provCode;
                    console.warn(`[GeminiProvider] Generation failed with ${model} [${norm.provCode}]: ${this.extractErrorText(error).trim()}`);

                    if (norm.provCode === ProvCode.AUTHENTICATION_ERROR) return null;
                    if (norm.provCode === ProvCode.MODEL_NOT_FOUND || norm.provCode === ProvCode.QUOTA_EXHAUSTED) break;

                    if (attempt < maxAttempts - 1 &&
                        (norm.provCode === ProvCode.RATE_LIMITED || norm.provCode === ProvCode.TIMEOUT ||
                         norm.provCode === ProvCode.NETWORK_ERROR || norm.provCode === ProvCode.UNKNOWN)) {
                        const delay = Math.min(backoffBase * 2 ** attempt, 15000) + Math.floor(Math.random() * 500);
                        await sleep(delay);
                        continue;
                    }
                    if (norm.provCode !== ProvCode.RATE_LIMITED && norm.provCode !== ProvCode.TIMEOUT &&
                        norm.provCode !== ProvCode.NETWORK_ERROR && norm.provCode !== ProvCode.UNKNOWN) {
                        break;
                    }
                }
            }
        }

        console.warn(`[GeminiProvider] All models failed. Last error [${lastCode}]: ${lastError}`);
        return null;
    }

    async generateStream({ prompt, signal, onToken }) {
        if (!this.isConfigured()) {
            console.warn('[GeminiProvider] GEMINI_API_KEY is not configured for streaming');
            return null;
        }

        const client = await this._getClient();
        const models = this.getModelChain();
        const timeoutMs = Math.max(1000, Number(process.env.GEMINI_TIMEOUT_MS || 90000));
        const maxAttempts = Math.max(1, Number(process.env.GEMINI_STREAM_MAX_ATTEMPTS || 2));
        const backoffBase = Math.max(100, Number(process.env.GEMINI_BACKOFF_BASE_MS || 1000));

        for (const model of models) {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const controller = new AbortController();
                let timedOut = false;
                const forwardAbort = () => controller.abort();
                if (signal) {
                    if (signal.aborted) controller.abort();
                    else signal.addEventListener('abort', forwardAbort, { once: true });
                }
                const timeout = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                }, timeoutMs);

                try {
                    console.log(`[GeminiProvider] Streaming with ${model} (attempt ${attempt + 1}/${maxAttempts})`);
                    const stream = await client.models.generateContentStream({
                        model,
                        contents: prompt,
                        config: this._config(),
                        abortSignal: controller.signal
                    });

                    const iterable = stream?.stream || stream;
                    if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
                        throw new Error('Gemini streaming response has no async iterable');
                    }

                    let fullText = '';
                    for await (const chunk of iterable) {
                        let text = String(chunk?.text || '');
                        if (!text && chunk?.candidates?.[0]?.content?.parts) {
                            text = chunk.candidates[0].content.parts.map((p) => p?.text || '').join('');
                        }
                        text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
                        if (!text) continue;
                        fullText += text;
                        onToken?.(text);
                    }

                    clearTimeout(timeout);
                    if (signal) signal.removeEventListener('abort', forwardAbort);
                    console.log(`[GeminiProvider] Streaming completed (${fullText.length} chars)`);
                    return fullText.trim();
                } catch (error) {
                    clearTimeout(timeout);
                    if (signal) signal.removeEventListener('abort', forwardAbort);

                    if (signal?.aborted) throw error;
                    const normalized = this.normalizeError(
                        timedOut ? new Error(`Gemini streaming timed out after ${timeoutMs}ms`) : error
                    );
                    console.warn(`[GeminiProvider] Stream failed with ${model} [${normalized.provCode}]: ${this.extractErrorText(error).trim()}`);

                    if (normalized.provCode === ProvCode.AUTHENTICATION_ERROR ||
                        normalized.provCode === ProvCode.MODEL_NOT_FOUND ||
                        normalized.provCode === ProvCode.QUOTA_EXHAUSTED) {
                        break;
                    }

                    if (attempt < maxAttempts - 1 &&
                        (normalized.provCode === ProvCode.RATE_LIMITED || normalized.provCode === ProvCode.TIMEOUT ||
                         normalized.provCode === ProvCode.NETWORK_ERROR || normalized.provCode === ProvCode.UNKNOWN)) {
                        const delay = Math.min(backoffBase * 2 ** attempt, 15000) + Math.floor(Math.random() * 500);
                        await sleep(delay);
                        continue;
                    }
                    break;
                }
            }
        }

        return null;
    }
}

export default GeminiProvider;
