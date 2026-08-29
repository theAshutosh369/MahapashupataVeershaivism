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

const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_ERROR_PREFIX = '__RAG_GEMINI_ERROR__:';
const GEMINI_EMBEDDING_MODEL = 'models/gemini-embedding-001';

function parseApiKeys() {
    // GEMINI_API_KEYS is authoritative when present. This prevents an
    // unexpected/old GEMINI_API_KEY from silently being tried first.
    const configuredList = String(process.env.GEMINI_API_KEYS || '').trim();
    const source = configuredList || String(process.env.GEMINI_API_KEY || '');
    return [...new Set(source.split(/[\s,;]+/).map((key) => String(key || '').trim()).filter(Boolean))];
}

export class GeminiProvider extends LLMProvider {
    constructor(opts) {
        super();
        this.opts = opts || {};
        this._clients = new Map();
        this._keyIndex = 0;
        this._quotaBlockedUntil = new Map();
        this._authBlocked = new Set();
        this._transientBlockedUntil = new Map();
    }

    name() { return 'gemini'; }
    getApiKeys() { return parseApiKeys(); }
    getApiKey() { return this.getApiKeys()[0]; }
    isConfigured() { return this.getApiKeys().length > 0; }

    getModel() {
        const configured = process.env.GEMINI_MODEL;
        return configured && typeof configured === 'string' && configured.trim()
            ? configured.trim()
            : (this.opts.model || GEMINI_DEFAULT_MODEL);
    }

    getModelInfo() { return { provider: 'gemini', model: this.getModel(), keyCount: this.getApiKeys().length }; }
    getModelChain() { return [this.getModel()]; }

    async _getClient(apiKey) {
        if (!this._clients.has(apiKey)) {
            const { GoogleGenAI } = await import('@google/genai');
            this._clients.set(apiKey, new GoogleGenAI({ apiKey }));
        }
        return this._clients.get(apiKey);
    }

    _config(model, signal) {
        const config = {
            maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)
        };

        // Gemini 3.x no longer supports the legacy sampling parameters.
        // Sending temperature/topP to these models can turn a valid request
        // into an avoidable API error. Keep the old configuration for models
        // such as Gemini 2.5 where those parameters remain supported.
        if (!/^models\/gemini-3(?:\.|-|$)/i.test(String(model || '')) && !/^gemini-3(?:\.|-|$)/i.test(String(model || ''))) {
            config.temperature = Number(process.env.GEMINI_TEMPERATURE || 0.2);
            config.topP = 0.95;
        }

        if (signal) config.abortSignal = signal;
        return config;
    }

    _quotaResetTime() {
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
        this._quotaBlockedUntil.set(apiKey, this._quotaResetTime());
        console.warn(`[GeminiProvider] Gemini key quota exhausted; rotating immediately to the next key.`);
    }

    _markAuthenticationFailed(apiKey) {
        this._authBlocked.add(apiKey);
        console.warn(`[GeminiProvider] Gemini key ${this._keyLabel(apiKey)} rejected authentication; key disabled for this server process.`);
    }

    _markTransientBlocked(apiKey, ms = 15000) {
        this._transientBlockedUntil.set(apiKey, Date.now() + ms);
    }

    _isTransientBlocked(apiKey) {
        const until = this._transientBlockedUntil.get(apiKey) || 0;
        if (until && until <= Date.now()) {
            this._transientBlockedUntil.delete(apiKey);
            return false;
        }
        return until > Date.now();
    }

    _isBlocked(apiKey) {
        return this._authBlocked.has(apiKey) || this._isQuotaBlocked(apiKey) || this._isTransientBlocked(apiKey);
    }

    _availableKeys() { return this.getApiKeys().filter((key) => !this._isBlocked(key)); }

    _orderedKeys() {
        const keys = this._availableKeys();
        if (!keys.length) return [];
        const start = this._keyIndex % keys.length;
        const ordered = [...keys.slice(start), ...keys.slice(0, start)];
        this._keyIndex = (start + 1) % keys.length;
        return ordered;
    }

    _isQuotaError(code) { return code === ProvCode.QUOTA_EXHAUSTED; }

    _failureMessage(code, attemptedKeyCount) {
        if (code === ProvCode.QUOTA_EXHAUSTED) return 'Gemini quota limit reached on the configured API keys.';
        if (code === ProvCode.RATE_LIMITED) return 'Gemini rate limit reached on the configured API keys.';
        if (code === ProvCode.TIMEOUT) return 'Gemini request timed out on the configured API keys.';
        if (code === ProvCode.NETWORK_ERROR) return 'Gemini network error on the configured API keys.';
        if (code === ProvCode.AUTHENTICATION_ERROR) return 'Gemini API key authentication failed.';
        if (code === ProvCode.MODEL_NOT_FOUND) return 'Gemini model is unavailable for the configured API keys.';
        if (attemptedKeyCount > 1) return 'Gemini service is temporarily unavailable on all configured API keys.';
        return 'Gemini service is temporarily unavailable.';
    }

    async generate({ prompt, signal }) {
        if (!this.isConfigured()) return null;
        const model = this.getModel();
        // Key rotation is intentionally one attempt per key. Never wait and
        // retry the same key before trying the next configured key.
        let lastError = null;
        let lastCode = null;
        let attemptedKey = false;

        for (const apiKey of this._orderedKeys()) {
            attemptedKey = true;
            const client = await this._getClient(apiKey);
            try {
                console.log(`[GeminiProvider] Generating with ${model} using key ${this._keyLabel(apiKey)} (single attempt)`);
                const result = await client.models.generateContent({
                    model,
                    contents: prompt,
                    config: this._config(model, signal)
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
                    this._markAuthenticationFailed(apiKey);
                } else if (norm.provCode === ProvCode.MODEL_NOT_FOUND || this._isQuotaError(norm.provCode)) {
                    if (this._isQuotaError(norm.provCode)) this._markQuotaExhausted(apiKey);
                } else if (norm.provCode === ProvCode.TIMEOUT || norm.provCode === ProvCode.NETWORK_ERROR || norm.provCode === ProvCode.UNKNOWN || norm.provCode === ProvCode.RATE_LIMITED) {
                    this._markTransientBlocked(apiKey);
                }
                // Immediately continue to the next key. No backoff and no
                // second attempt on the current key.
            }
        }
        if (!attemptedKey) console.warn('[GeminiProvider] All configured Gemini keys are currently blocked.');
        console.warn(`[GeminiProvider] All Gemini keys failed for model ${model}. Last error [${lastCode}]: ${lastError}`);
        return null;
    }

    async generateStream({ prompt, signal, onToken }) {
        if (!this.isConfigured()) return null;
        const model = this.getModel();
        let lastCode = null;
        let lastError = null;
        let attemptedKeyCount = 0;
        let emittedAnyToken = false;

        for (const apiKey of this._orderedKeys()) {
            attemptedKeyCount += 1;
            const client = await this._getClient(apiKey);
            const controller = new AbortController();
            const forwardAbort = () => controller.abort();
            if (signal) {
                if (signal.aborted) controller.abort();
                else signal.addEventListener('abort', forwardAbort, { once: true });
            }

            try {
                console.log(`[GeminiProvider] Streaming with ${model} using key ${this._keyLabel(apiKey)} (single attempt)`);
                const stream = await client.models.generateContentStream({
                    model,
                    contents: prompt,
                    config: this._config(model, controller.signal)
                });
                const iterable = stream?.stream || stream;
                if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw new Error('Gemini streaming response has no async iterable');
                let fullText = '';
                for await (const chunk of iterable) {
                    let text = String(chunk?.text || '');
                    if (!text && chunk?.candidates?.[0]?.content?.parts) text = chunk.candidates[0].content.parts.map((p) => p?.text || '').join('');
                    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
                    if (!text) continue;
                    fullText += text;
                    emittedAnyToken = true;
                    onToken?.(text);
                }
                if (signal) signal.removeEventListener('abort', forwardAbort);
                console.log(`[GeminiProvider] Streaming completed (${fullText.length} chars)`);
                return fullText.trim();
            } catch (error) {
                if (signal) signal.removeEventListener('abort', forwardAbort);
                if (signal?.aborted) throw error;
                const normalized = this.normalizeError(error);
                lastCode = normalized.provCode;
                lastError = normalized.message;
                console.warn(`[GeminiProvider] Stream failed with ${model} using key ${this._keyLabel(apiKey)} [${normalized.provCode}]: ${this.extractErrorText(error).trim()}`);
                if (normalized.provCode === ProvCode.AUTHENTICATION_ERROR) {
                    this._markAuthenticationFailed(apiKey);
                } else if (normalized.provCode === ProvCode.MODEL_NOT_FOUND || this._isQuotaError(normalized.provCode)) {
                    if (this._isQuotaError(normalized.provCode)) this._markQuotaExhausted(apiKey);
                } else if (normalized.provCode === ProvCode.TIMEOUT || normalized.provCode === ProvCode.NETWORK_ERROR || normalized.provCode === ProvCode.UNKNOWN || normalized.provCode === ProvCode.RATE_LIMITED) {
                    this._markTransientBlocked(apiKey);
                }
                // Immediately rotate to the next key. There is deliberately no
                // sleep/backoff and no retry of this key.
            }
        }

        if (attemptedKeyCount === 0) console.warn('[GeminiProvider] All configured Gemini keys are currently blocked for streaming.');
        console.warn(`[GeminiProvider] All Gemini keys failed for model ${model}. Last error [${lastCode}]: ${lastError}`);
        if (!emittedAnyToken) {
            const message = this._failureMessage(lastCode, attemptedKeyCount);
            console.warn(`[GeminiProvider] Reporting concise UI error: ${message}`);
            onToken?.(`${GEMINI_ERROR_PREFIX}${message}`);
        }
        return null;
    }

    async embed({ texts, signal }) {
        if (!this.isConfigured()) return null;
        if (!Array.isArray(texts) || texts.length === 0) return [];

        let lastError = null;
        let lastCode = null;
        let attemptedKey = false;

        for (const apiKey of this._orderedKeys()) {
            attemptedKey = true;
            const client = await this._getClient(apiKey);
            try {
                console.log(`[GeminiProvider] Embedding ${texts.length} texts using key ${this._keyLabel(apiKey)} (single attempt)`);

                // @google/genai exposes embeddings through models.embedContent.
                // It accepts one string or an array of strings and returns the
                // corresponding embeddings in the same order. The old
                // client.models.batchEmbedContents() call does not exist in the
                // installed JS SDK and was the cause of the previous embedding
                // failure on every key.
                const result = await client.models.embedContent({
                    model: GEMINI_EMBEDDING_MODEL,
                    contents: texts.map((text) => String(text || '').slice(0, 6000)),
                    config: {
                        outputDimensionality: 768,
                        ...(signal ? { abortSignal: signal } : {})
                    }
                });

                if (!result || !Array.isArray(result.embeddings)) {
                    throw new Error('Embedding response missing embeddings array');
                }

                const embeddings = result.embeddings.map((emb) =>
                    emb && Array.isArray(emb.values) ? emb.values.map(Number) : []
                );

                if (embeddings.length !== texts.length || embeddings.some((vector) => vector.length !== 768 || vector.some((value) => !Number.isFinite(value)))) {
                    throw new Error(`Embedding response has invalid dimensions; expected ${texts.length} vectors of 768 dimensions`);
                }

                console.log(`[GeminiProvider] Embedding completed (${embeddings.length} vectors)`);
                return embeddings;
            } catch (error) {
                const norm = this.normalizeError(error);
                lastError = norm.message;
                lastCode = norm.provCode;
                console.warn(`[GeminiProvider] Embedding failed using key ${this._keyLabel(apiKey)} [${norm.provCode}]: ${this.extractErrorText(error).trim()}`);

                if (norm.provCode === ProvCode.AUTHENTICATION_ERROR) {
                    this._markAuthenticationFailed(apiKey);
                } else if (norm.provCode === ProvCode.QUOTA_EXHAUSTED) {
                    this._markQuotaExhausted(apiKey);
                } else if (norm.provCode === ProvCode.TIMEOUT || norm.provCode === ProvCode.NETWORK_ERROR || norm.provCode === ProvCode.UNKNOWN || norm.provCode === ProvCode.RATE_LIMITED) {
                    this._markTransientBlocked(apiKey);
                }
                // Immediately continue to the next key. No backoff and no
                // second attempt on the current key.
            }
        }

        if (!attemptedKey) console.warn('[GeminiProvider] All configured Gemini keys are currently blocked for embedding.');
        console.warn(`[GeminiProvider] All Gemini keys failed for embedding. Last error [${lastCode}]: ${lastError}`);
        return null;
    }

    _keyLabel(apiKey) {
        const key = String(apiKey || '');
        if (key.length <= 8) return '****';
        return `${key.slice(0, 4)}...${key.slice(-4)}`;
    }
}

export default GeminiProvider;
