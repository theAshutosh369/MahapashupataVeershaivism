/**
 * GeminiProvider — Google Gemini LLM provider.
 * Keeps Gemini-specific configuration, retry/backoff and streaming isolated
 * behind the normalized LLMProvider interface.
 *
 * Multiple Gemini API keys are supported for failover while keeping the SAME
 * Gemini model. Keys should normally belong to separate Google projects if
 * they are intended to provide separate quota pools; Gemini quotas are
 * project-level, not key-level.
 */

import { LLMProvider, ProvCode } from './base.js';

// Use a stable model instead of the mutable gemini-flash-latest alias.
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseApiKeys() {
    const values = [];

    // Backward compatible: the existing single-key variable still works.
    if (process.env.GEMINI_API_KEY) values.push(process.env.GEMINI_API_KEY);

    // Preferred for failover. Comma, semicolon and newline separated values
    // are accepted so Render/environment managers can use whichever is easier.
    if (process.env.GEMINI_API_KEYS) {
        values.push(...String(process.env.GEMINI_API_KEYS).split(/[\s,;]+/));
    }

    return [...new Set(values.map((key) => String(key || '').trim()).filter(Boolean))];
}

export class GeminiProvider extends LLMProvider {
    constructor(opts) {
        super();
        this.opts = opts || {};
        this._clients = new Map();
        this._keyIndex = 0;
        this._quotaBlockedUntil = new Map();
    }

    name() {
        return 'gemini';
    }

    getApiKeys() {
        return parseApiKeys();
    }

    getApiKey() {
        return this.getApiKeys()[0];
    }

    isConfigured() {
        return this.getApiKeys().length > 0;
    }

    getModel() {
        const configured = process.env.GEMINI_MODEL;
        return configured && typeof configured === 'string' && configured.trim()
            ? configured.trim()
            : (this.opts.model || GEMINI_DEFAULT_MODEL);
    }

    getModelInfo() {
        return {
            provider: 'gemini',
            model: this.getModel(),
            keyCount: this.getApiKeys().length
        };
    }

    // Deliberately one model only. GEMINI_FALLBACK_MODELS is not used because
    // this application is configured to keep the exact same Gemini model.
    getModelChain() {
        return [this.getModel()];
    }

    async _getClient(apiKey) {
        if (!this._clients.has(apiKey)) {
            const { GoogleGenAI } = await import('@google/genai');
            this._clients.set(apiKey, new GoogleGenAI({ apiKey }));
        }
        return this._clients.get(apiKey);
    }

    _config() {
        return {
            temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
            topP: 0.95,
            maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)
        };
    }

    _quotaResetTime() {
        // Gemini daily quotas reset at midnight Pacific Time. Keep the key
        // blocked only until the next Pacific midnight, not permanently.
        const now = new Date();
        const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
        const nextPacific = new Date(pacificNow);
        nextPacific.setHours(24, 0, 0, 0);
        const resetSeconds = Math.max(60, (nextPacific.getTime() - pacificNow.getTime()) / 1000);
        return Date.now() + resetSeconds * 1000;
    }

    _isQuotaBlocked(apiKey) {
        const until = this._quotaBlockedUntil.get(apiKey) || 0;
        if (until && until <= Date.now()) {
            this._quotaBlockedUntil.delete(apiKey);
            return false;
        }
        return until > Date.now();
    }

    _markQuotaExhausted(apiKey) {
        const until = this._quotaResetTime();
        this._quotaBlockedUntil.set(apiKey, until);
        console.warn(`[GeminiProvider] Gemini key quota exhausted; rotating key until the next Pacific quota reset.`);
    }

    _availableKeys() {
        const keys = this.getApiKeys();
        return keys.filter((key) => !this._isQuotaBlocked(key));
    }

    _orderedKeys() {
        const keys = this._availableKeys();
        if (!keys.length) return [];

        const start = this._keyIndex % keys.length;
        const ordered = [...keys.slice(start), ...keys.slice(0, start)];
        this._keyIndex = (start + 1) % keys.length;
        return ordered;
    }

    _isQuotaError(code) {
        return code === ProvCode.QUOTA_EXHAUSTED;
    }

    _shouldRetrySameKey(code) {
        return code === ProvCode.RATE_LIMITED ||
            code === ProvCode.TIMEOUT ||
            code === ProvCode.NETWORK_ERROR ||
            code === ProvCode.UNKNOWN;
    }

    async generate({ prompt, signal }) {
        if (!this.isConfigured()) {
            console.warn('[GeminiProvider] GEMINI_API_KEY / GEMINI_API_KEYS is not configured');
            return null;
        }

        const model = this.getModel();
        const maxAttempts = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS || 3));
        const backoffBase = Math.max(100, Number(process.env.GEMINI_BACKOFF_BASE_MS || 1000));
        let lastError = null;
        let lastCode = null;
        let attemptedKey = false;

        for (const apiKey of this._orderedKeys()) {
            attemptedKey = true;
            const client = await this._getClient(apiKey);

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    console.log(`[GeminiProvider] Generating with ${model} using key ${this._keyLabel(apiKey)} (attempt ${attempt + 1}/${maxAttempts})`);
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
                    console.warn(`[GeminiProvider] Generation failed with ${model} using key ${this._keyLabel(apiKey)} [${norm.provCode}]: ${this.extractErrorText(error).trim()}`);

                    if (norm.provCode === ProvCode.AUTHENTICATION_ERROR) {
                        // Invalid key should not consume time on retries, but it
                        // should not stop other configured keys from working.
                        break;
                    }

                    if (norm.provCode === ProvCode.MODEL_NOT_FOUND || this._isQuotaError(norm.provCode)) {
                        if (this._isQuotaError(norm.provCode)) this._markQuotaExhausted(apiKey);
                        break;
                    }

                    if (attempt < maxAttempts - 1 && this._shouldRetrySameKey(norm.provCode)) {
                        const delay = Math.min(backoffBase * 2 ** attempt, 15000) + Math.floor(Math.random() * 500);
                        await sleep(delay);
                        continue;
                    }
                    break;
                }
            }
        }

        if (!attemptedKey) {
            console.warn('[GeminiProvider] All configured Gemini keys are currently quota-blocked.');
        }
        console.warn(`[GeminiProvider] All Gemini keys failed for model ${model}. Last error [${lastCode}]: ${lastError}`);
        return null;
    }

    async generateStream({ prompt, signal, onToken }) {
        if (!this.isConfigured()) {
            console.warn('[GeminiProvider] GEMINI_API_KEY / GEMINI_API_KEYS is not configured for streaming');
            return null;
        }

        const model = this.getModel();
        const timeoutMs = Math.max(1000, Number(process.env.GEMINI_TIMEOUT_MS || 90000));
        const maxAttempts = Math.max(1, Number(process.env.GEMINI_STREAM_MAX_ATTEMPTS || 2));
        const backoffBase = Math.max(100, Number(process.env.GEMINI_BACKOFF_BASE_MS || 1000));
        let lastCode = null;
        let lastError = null;
        let attemptedKey = false;

        for (const apiKey of this._orderedKeys()) {
            attemptedKey = true;
            const client = await this._getClient(apiKey);

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
                    console.log(`[GeminiProvider] Streaming with ${model} using key ${this._keyLabel(apiKey)} (attempt ${attempt + 1}/${maxAttempts})`);
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
                    lastCode = normalized.provCode;
                    lastError = normalized.message;
                    console.warn(`[GeminiProvider] Stream failed with ${model} using key ${this._keyLabel(apiKey)} [${normalized.provCode}]: ${this.extractErrorText(error).trim()}`);

                    if (normalized.provCode === ProvCode.AUTHENTICATION_ERROR) {
                        break;
                    }

                    if (normalized.provCode === ProvCode.MODEL_NOT_FOUND || this._isQuotaError(normalized.provCode)) {
                        if (this._isQuotaError(normalized.provCode)) this._markQuotaExhausted(apiKey);
                        break;
                    }

                    if (attempt < maxAttempts - 1 && this._shouldRetrySameKey(normalized.provCode)) {
                        const delay = Math.min(backoffBase * 2 ** attempt, 15000) + Math.floor(Math.random() * 500);
                        await sleep(delay);
                        continue;
                    }
                    break;
                }
            }
        }

        if (!attemptedKey) {
            console.warn('[GeminiProvider] All configured Gemini keys are currently quota-blocked for streaming.');
        }
        console.warn(`[GeminiProvider] All Gemini keys failed for model ${model}. Last error [${lastCode}]: ${lastError}`);
        return null;
    }

    _keyLabel(apiKey) {
        const key = String(apiKey || '');
        if (key.length <= 8) return '****';
        return `${key.slice(0, 4)}...${key.slice(-4)}`;
    }
}

export default GeminiProvider;
