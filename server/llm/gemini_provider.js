/**
 * GeminiProvider — Google Gemini LLM provider.
 *
 * Gemini generation uses the current Interactions API over native fetch. This
 * avoids the legacy GenerateContent stream parser and its "Incomplete JSON
 * segment at the end" failure mode while keeping the SAME configured Gemini
 * model. Multiple API keys are rotated only when the current key cannot serve
 * the request.
 */

import { LLMProvider, ProvCode } from './base.js';

const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_EMBEDDING_MODEL = 'models/gemini-embedding-001';
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

function parseApiKeys() {
    // GEMINI_API_KEYS is authoritative when present. GEMINI_API_KEY is only a
    // fallback for installations that have not configured the key list.
    const configuredList = String(process.env.GEMINI_API_KEYS || '').trim();
    const source = configuredList || String(process.env.GEMINI_API_KEY || '');
    return [...new Set(source.split(/[\s,;]+/).map((key) => String(key || '').trim()).filter(Boolean))];
}

function normalizeModelForInteractions(model) {
    return String(model || '').replace(/^models\//i, '');
}

function createProviderError(code, message, details) {
    const err = new Error(message);
    err.provCode = code;
    err.isProviderError = true;
    if (details !== undefined) err.details = details;
    return err;
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

        // Gemini 3.x does not support the legacy sampling parameters.
        if (!/^models\/gemini-3(?:\.|-|$)/i.test(String(model || '')) && !/^gemini-3(?:\.|-|$)/i.test(String(model || ''))) {
            config.temperature = Number(process.env.GEMINI_TEMPERATURE || 0.2);
            config.topP = 0.95;
        }

        if (signal) config.abortSignal = signal;
        return config;
    }

    _interactionGenerationConfig(model) {
        const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048);
        const config = { max_output_tokens: maxOutputTokens };

        // Gemini 3.x uses thinking_level rather than legacy sampling controls.
        if (/^models\/gemini-3(?:\.|-|$)/i.test(String(model || '')) || /^gemini-3(?:\.|-|$)/i.test(String(model || ''))) {
            const configuredLevel = String(process.env.GEMINI_THINKING_LEVEL || 'medium').trim().toLowerCase();
            config.thinking_level = ['low', 'medium', 'high'].includes(configuredLevel) ? configuredLevel : 'medium';
        } else {
            const temperature = Number(process.env.GEMINI_TEMPERATURE || 0.2);
            if (Number.isFinite(temperature)) config.temperature = temperature;
            const topP = Number(process.env.GEMINI_TOP_P || 0.95);
            if (Number.isFinite(topP)) config.top_p = topP;
        }

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
        console.warn('[GeminiProvider] Gemini key quota exhausted; rotating immediately to the next key.');
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
        if (code === ProvCode.TIMEOUT) return 'Gemini service did not respond in time on the configured API keys.';
        if (code === ProvCode.NETWORK_ERROR) return 'Gemini network error on the configured API keys.';
        if (code === ProvCode.AUTHENTICATION_ERROR) return 'Gemini API key authentication failed.';
        if (code === ProvCode.MODEL_NOT_FOUND) return 'Gemini model is unavailable for the configured API keys.';
        if (attemptedKeyCount > 1) return 'Gemini service is temporarily unavailable on all configured API keys.';
        return 'Gemini service is temporarily unavailable.';
    }

    async _fetchJson(apiKey, body, signal) {
        const response = await fetch(GEMINI_INTERACTIONS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(body),
            signal
        });

        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }

        if (!response.ok) {
            const message = data?.error?.message || text || `Gemini HTTP ${response.status}`;
            throw createProviderError(
                this._classifyHttpStatus(response.status, message),
                message,
                { status: response.status, response: data }
            );
        }

        return data;
    }

    _classifyHttpStatus(status, message) {
        if (status === 401 || status === 403) return ProvCode.AUTHENTICATION_ERROR;
        if (status === 404) return ProvCode.MODEL_NOT_FOUND;
        if (status === 429) {
            const lower = String(message || '').toLowerCase();
            return /quota|resource_exhausted|per_day|daily|exhausted/.test(lower)
                ? ProvCode.QUOTA_EXHAUSTED
                : ProvCode.RATE_LIMITED;
        }
        if (status === 408 || status === 504) return ProvCode.TIMEOUT;
        if (status >= 500) return ProvCode.UNKNOWN;
        if (status === 400 || status === 422) return ProvCode.INVALID_REQUEST;
        return ProvCode.UNKNOWN;
    }

    async generate({ prompt, signal }) {
        if (!this.isConfigured()) return null;
        const model = this.getModel();
        const interactionModel = normalizeModelForInteractions(model);
        let lastError = null;
        let lastCode = null;
        let attemptedKey = false;

        for (const apiKey of this._orderedKeys()) {
            attemptedKey = true;
            const controller = new AbortController();
            const forwardAbort = () => controller.abort();
            if (signal) {
                if (signal.aborted) controller.abort();
                else signal.addEventListener('abort', forwardAbort, { once: true });
            }

            try {
                console.log(`[GeminiProvider] Generating with ${model} using key ${this._keyLabel(apiKey)} (single attempt)`);
                const result = await this._fetchJson(apiKey, {
                    model: interactionModel,
                    input: String(prompt || ''),
                    stream: false,
                    store: false,
                    generation_config: this._interactionGenerationConfig(model)
                }, controller.signal);

                if (signal) signal.removeEventListener('abort', forwardAbort);
                const text = this._extractInteractionText(result).trim();
                if (text) return text;
                throw createProviderError(ProvCode.UNKNOWN, 'Gemini returned an empty response');
            } catch (error) {
                if (signal) signal.removeEventListener('abort', forwardAbort);
                if (signal?.aborted) throw error;
                const norm = this.normalizeError(error);
                lastError = norm.message;
                lastCode = norm.provCode;
                console.warn(`[GeminiProvider] Generation failed with ${model} using key ${this._keyLabel(apiKey)} [${norm.provCode}]: ${this.extractErrorText(error).trim()}`);
                this._markKeyAfterFailure(apiKey, norm.provCode);
            }
        }

        if (!attemptedKey) console.warn('[GeminiProvider] All configured Gemini keys are currently blocked.');
        console.warn(`[GeminiProvider] All Gemini keys failed for model ${model}. Last error [${lastCode}]: ${lastError}`);
        return null;
    }

    async generateStream({ prompt, signal, onToken }) {
        if (!this.isConfigured()) return null;
        const model = this.getModel();
        const interactionModel = normalizeModelForInteractions(model);
        let lastCode = null;
        let lastError = null;
        let attemptedKeyCount = 0;

        for (const apiKey of this._orderedKeys()) {
            attemptedKeyCount += 1;
            const controller = new AbortController();
            const forwardAbort = () => controller.abort();
            if (signal) {
                if (signal.aborted) controller.abort();
                else signal.addEventListener('abort', forwardAbort, { once: true });
            }

            try {
                console.log(`[GeminiProvider] Streaming with ${model} using key ${this._keyLabel(apiKey)} (Interactions API, single attempt)`);

                // There is deliberately NO artificial per-key timeout here.
                // If Gemini returns an HTTP/SSE error, rotation happens immediately.
                // Once streaming starts, the answer is allowed to finish normally.
                const response = await fetch(GEMINI_INTERACTIONS_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream',
                        'x-goog-api-key': apiKey
                    },
                    body: JSON.stringify({
                        model: interactionModel,
                        input: String(prompt || ''),
                        stream: true,
                        store: false,
                        generation_config: this._interactionGenerationConfig(model)
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    let errorData = null;
                    try { errorData = errorText ? JSON.parse(errorText) : null; } catch { /* ignore */ }
                    const message = errorData?.error?.message || errorText || `Gemini HTTP ${response.status}`;
                    throw createProviderError(this._classifyHttpStatus(response.status, message), message, { status: response.status, response: errorData });
                }

                if (!response.body) throw createProviderError(ProvCode.NETWORK_ERROR, 'Gemini streaming response has no body');

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullText = '';
                let sawEvent = false;

                const processEvent = (rawEvent) => {
                    const lines = rawEvent.split(/\r?\n/);
                    let eventType = '';
                    const dataLines = [];
                    for (const line of lines) {
                        if (line.startsWith('event:')) eventType = line.slice(6).trim();
                        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
                    }
                    if (!dataLines.length) return;
                    const rawData = dataLines.join('\n');
                    if (rawData === '[DONE]') return;

                    let event;
                    try { event = JSON.parse(rawData); }
                    catch (parseError) {
                        throw createProviderError(ProvCode.UNKNOWN, `Gemini stream event could not be parsed: ${parseError.message}`);
                    }
                    sawEvent = true;

                    if (eventType === 'error' || event?.event_type === 'error') {
                        const error = event?.error || {};
                        throw createProviderError(
                            this._classifyHttpStatus(Number(error.code) || 500, error.message),
                            error.message || 'Gemini streaming request failed',
                            error
                        );
                    }

                    if (event?.event_type === 'step.delta' && event?.delta?.type === 'text') {
                        const text = String(event.delta.text || '');
                        if (text) {
                            fullText += text;
                            onToken?.(text);
                        }
                    }
                };

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const events = buffer.split(/\r?\n\r?\n/);
                    buffer = events.pop() || '';
                    for (const rawEvent of events) processEvent(rawEvent);
                }
                buffer += decoder.decode();
                if (buffer.trim()) processEvent(buffer);

                if (!sawEvent) throw createProviderError(ProvCode.UNKNOWN, 'Gemini stream ended without an SSE event');
                if (!fullText.trim()) throw createProviderError(ProvCode.UNKNOWN, 'Gemini returned an empty response');

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
                this._markKeyAfterFailure(apiKey, normalized.provCode);
                // Rotate immediately. There is no retry and no sleep.
            }
        }

        if (attemptedKeyCount === 0) console.warn('[GeminiProvider] All configured Gemini keys are currently blocked for streaming.');
        const message = this._failureMessage(lastCode, attemptedKeyCount);
        console.warn(`[GeminiProvider] All Gemini keys failed for model ${model}. Last error [${lastCode}]: ${lastError}`);
        console.warn(`[GeminiProvider] Reporting concise UI error: ${message}`);

        const error = createProviderError(lastCode || ProvCode.UNKNOWN, message, {
            model,
            attemptedKeyCount,
            lastError
        });
        error.isFinalProviderError = true;
        throw error;
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
                const result = await client.models.embedContent({
                    model: GEMINI_EMBEDDING_MODEL,
                    contents: texts.map((text) => String(text || '').slice(0, 6000)),
                    config: {
                        outputDimensionality: 768,
                        ...(signal ? { abortSignal: signal } : {})
                    }
                });

                if (!result || !Array.isArray(result.embeddings)) throw new Error('Embedding response missing embeddings array');
                const embeddings = result.embeddings.map((emb) => emb && Array.isArray(emb.values) ? emb.values.map(Number) : []);
                if (embeddings.length !== texts.length || embeddings.some((vector) => vector.length !== 768 || vector.some((value) => !Number.isFinite(value)))) {
                    throw new Error(`Embedding response has invalid dimensions; expected ${texts.length} vectors of 768 dimensions`);
                }
                console.log(`[GeminiProvider] Embedding completed (${embeddings.length} vectors)`);
                return embeddings;
            } catch (error) {
                if (signal?.aborted) throw error;
                const norm = this.normalizeError(error);
                lastError = norm.message;
                lastCode = norm.provCode;
                console.warn(`[GeminiProvider] Embedding failed using key ${this._keyLabel(apiKey)} [${norm.provCode}]: ${this.extractErrorText(error).trim()}`);
                this._markKeyAfterFailure(apiKey, norm.provCode);
            }
        }

        if (!attemptedKey) console.warn('[GeminiProvider] All configured Gemini keys are currently blocked for embedding.');
        console.warn(`[GeminiProvider] All Gemini keys failed for embedding. Last error [${lastCode}]: ${lastError}`);
        return null;
    }

    _extractInteractionText(result) {
        if (!result) return '';
        if (typeof result.output_text === 'string') return result.output_text;
        const steps = Array.isArray(result.steps) ? result.steps : [];
        return steps
            .filter((step) => step?.type === 'model_output')
            .flatMap((step) => Array.isArray(step.content) ? step.content : [])
            .map((part) => part?.text || '')
            .join('');
    }

    _markKeyAfterFailure(apiKey, code) {
        if (code === ProvCode.AUTHENTICATION_ERROR) {
            this._markAuthenticationFailed(apiKey);
        } else if (code === ProvCode.QUOTA_EXHAUSTED) {
            this._markQuotaExhausted(apiKey);
        } else if (code === ProvCode.TIMEOUT || code === ProvCode.NETWORK_ERROR || code === ProvCode.UNKNOWN || code === ProvCode.RATE_LIMITED) {
            this._markTransientBlocked(apiKey);
        }
    }

    _keyLabel(apiKey) {
        const key = String(apiKey || '');
        if (key.length <= 8) return '****';
        return `${key.slice(0, 4)}...${key.slice(-4)}`;
    }
}

export default GeminiProvider;
