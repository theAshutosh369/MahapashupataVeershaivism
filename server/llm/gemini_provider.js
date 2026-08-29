/**
 * GeminiProvider — Google Gemini LLM provider.
 *
 * Uses the Gemini Interactions API with the SAME configured model for every
 * configured API key. Keys are treated as independent quota pools because the
 * application expects each key to belong to a different Google project.
 *
 * Key selection is quota-aware from information the API actually exposes:
 * - 401/403: disable the key for this server process.
 * - daily quota exhaustion: park the key until the next Pacific-midnight reset.
 * - 429 RPM/short-window rate limit: park the key until Retry-After (or a
 *   conservative one-minute window) and immediately try another key.
 * - 503/500/network errors: rotate immediately; DO NOT add an artificial sleep.
 *
 * IMPORTANT: Gemini quotas are project-level, not key-level. Therefore this
 * strategy is useful only when the configured keys really belong to separate
 * projects, as intended by this application.
 */

import { LLMProvider, ProvCode } from './base.js';

const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_EMBEDDING_MODEL = 'models/gemini-embedding-001';
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_BLOCK_MS = 60_000;

function parseApiKeys() {
    // GEMINI_API_KEYS is authoritative. This is intentional: when a key list
    // is configured, GEMINI_API_KEY must NOT silently become an extra/fallback
    // key and change rotation order.
    const configuredList = String(process.env.GEMINI_API_KEYS || '').trim();
    const source = configuredList || String(process.env.GEMINI_API_KEY || '');
    return [...new Set(
        source
            .split(/[\s,;]+/)
            .map((key) => String(key || '').trim())
            .filter(Boolean)
    )];
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

        // Per-key state. Nothing here sleeps the request.
        this._keyState = new Map();
        this._lastConfiguredKeySignature = '';
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

    getModelInfo() {
        return {
            provider: 'gemini',
            model: this.getModel(),
            keyCount: this.getApiKeys().length
        };
    }

    getModelChain() { return [this.getModel()]; }

    async _getClient(apiKey) {
        if (!this._clients.has(apiKey)) {
            const { GoogleGenAI } = await import('@google/genai');
            this._clients.set(apiKey, new GoogleGenAI({ apiKey }));
        }
        return this._clients.get(apiKey);
    }

    _interactionGenerationConfig(model) {
        const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048);
        const config = {
            max_output_tokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2048
        };

        const isGemini3 = /^models\/gemini-3(?:\.|-|$)/i.test(String(model || ''))
            || /^gemini-3(?:\.|-|$)/i.test(String(model || ''));

        if (isGemini3) {
            const configuredLevel = String(process.env.GEMINI_THINKING_LEVEL || 'medium').trim().toLowerCase();
            config.thinking_level = ['low', 'medium', 'high'].includes(configuredLevel)
                ? configuredLevel
                : 'medium';
        } else {
            const temperature = Number(process.env.GEMINI_TEMPERATURE || 0.2);
            const topP = Number(process.env.GEMINI_TOP_P || 0.95);
            if (Number.isFinite(temperature)) config.temperature = temperature;
            if (Number.isFinite(topP)) config.top_p = topP;
        }

        return config;
    }

    _state(apiKey) {
        let state = this._keyState.get(apiKey);
        if (!state) {
            state = {
                usedAt: 0,
                requestTimes: [],
                rateBlockedUntil: 0,
                quotaBlockedUntil: 0,
                authBlocked: false
            };
            this._keyState.set(apiKey, state);
        }
        return state;
    }

    _syncKeyState() {
        const keys = this.getApiKeys();
        const signature = keys.join('|');
        if (signature === this._lastConfiguredKeySignature) return;
        this._lastConfiguredKeySignature = signature;
        const valid = new Set(keys);
        for (const key of this._keyState.keys()) {
            if (!valid.has(key)) this._keyState.delete(key);
        }
        console.log(`[GeminiProvider] Loaded ${keys.length} configured Gemini API key(s) for model ${this.getModel()}.`);
        console.log(`[GeminiProvider] Key rotation order: ${keys.map((key) => this._keyLabel(key)).join(', ')}`);
    }

    _pruneRequestTimes(state, now = Date.now()) {
        state.requestTimes = state.requestTimes.filter((time) => now - time < RATE_WINDOW_MS);
    }

    _recordRequest(apiKey) {
        const state = this._state(apiKey);
        const now = Date.now();
        this._pruneRequestTimes(state, now);
        state.requestTimes.push(now);
        state.usedAt = now;
    }

    _nextPacificMidnight() {
        const now = new Date();
        const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
        const next = new Date(pacific);
        next.setHours(24, 0, 0, 0);
        return Date.now() + Math.max(60_000, next.getTime() - pacific.getTime());
    }

    _isBlocked(apiKey, now = Date.now()) {
        const state = this._state(apiKey);
        if (state.authBlocked) return true;
        if (state.quotaBlockedUntil > now) return true;
        if (state.rateBlockedUntil > now) return true;
        if (state.quotaBlockedUntil && state.quotaBlockedUntil <= now) state.quotaBlockedUntil = 0;
        if (state.rateBlockedUntil && state.rateBlockedUntil <= now) state.rateBlockedUntil = 0;
        return false;
    }

    _orderedKeys() {
        this._syncKeyState();
        const keys = this.getApiKeys();
        if (!keys.length) return [];

        const now = Date.now();
        const available = keys.filter((key) => !this._isBlocked(key, now));

        // Prefer the key with the least recent short-window usage. This spreads
        // requests across separate projects instead of hammering one key first.
        const candidates = (available.length ? available : keys).map((key, originalIndex) => {
            const state = this._state(key);
            this._pruneRequestTimes(state, now);
            return {
                key,
                originalIndex,
                requestCount: state.requestTimes.length,
                usedAt: state.usedAt || 0
            };
        });

        candidates.sort((a, b) => {
            if (a.requestCount !== b.requestCount) return a.requestCount - b.requestCount;
            if (a.usedAt !== b.usedAt) return a.usedAt - b.usedAt;
            const aIndex = (a.originalIndex - this._keyIndex + keys.length) % keys.length;
            const bIndex = (b.originalIndex - this._keyIndex + keys.length) % keys.length;
            return aIndex - bIndex;
        });

        this._keyIndex = (this._keyIndex + 1) % keys.length;
        return candidates.map((item) => item.key);
    }

    _retryAfterMs(response, message) {
        const header = response?.headers?.get?.('retry-after');
        if (header) {
            const seconds = Number(header);
            if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10 * 60_000, seconds * 1000);
            const dateMs = Date.parse(header);
            if (Number.isFinite(dateMs)) return Math.max(0, Math.min(10 * 60_000, dateMs - Date.now()));
        }

        const match = String(message || '').match(/retry(?: after|Delay| in)\D{0,8}(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|minutes)?/i);
        if (match) {
            const value = Number(match[1]);
            const unit = String(match[2] || 's').toLowerCase();
            const multiplier = unit.startsWith('ms') ? 1 : unit.startsWith('m') ? 60_000 : 1000;
            return Math.min(10 * 60_000, Math.max(0, value * multiplier));
        }

        return DEFAULT_RATE_BLOCK_MS;
    }

    _classifyHttpStatus(status, message) {
        if (status === 401 || status === 403) return ProvCode.AUTHENTICATION_ERROR;
        if (status === 404) return ProvCode.MODEL_NOT_FOUND;
        if (status === 429) {
            const lower = String(message || '').toLowerCase();
            return /quota_exhausted|resource_exhausted|per_day|daily quota|requests_per_day|quota.*day|exceeded.*day/.test(lower)
                ? ProvCode.QUOTA_EXHAUSTED
                : ProvCode.RATE_LIMITED;
        }
        if (status === 408 || status === 504) return ProvCode.TIMEOUT;
        if (status >= 500) return ProvCode.UNKNOWN;
        if (status === 400 || status === 422) return ProvCode.INVALID_REQUEST;
        return ProvCode.UNKNOWN;
    }

    _markKeyAfterFailure(apiKey, code, details = {}) {
        const state = this._state(apiKey);

        if (code === ProvCode.AUTHENTICATION_ERROR) {
            state.authBlocked = true;
            console.warn(`[GeminiProvider] Gemini key ${this._keyLabel(apiKey)} rejected authentication; disabled for this server process.`);
            return;
        }

        if (code === ProvCode.QUOTA_EXHAUSTED) {
            state.quotaBlockedUntil = this._nextPacificMidnight();
            console.warn(`[GeminiProvider] Gemini key ${this._keyLabel(apiKey)} reached daily quota; parked until the next Pacific reset.`);
            return;
        }

        if (code === ProvCode.RATE_LIMITED) {
            state.rateBlockedUntil = Date.now() + this._retryAfterMs(details.response, details.message);
            console.warn(`[GeminiProvider] Gemini key ${this._keyLabel(apiKey)} is rate-limited; rotating immediately.`);
            return;
        }

        // 5xx, network and parser failures are NOT parked. The next key is
        // attempted immediately. This is important for transient capacity
        // failures and avoids artificial delays in production.
    }

    _failureMessage(code, attemptedKeyCount) {
        if (code === ProvCode.QUOTA_EXHAUSTED) return 'Gemini daily quota is exhausted on the available API keys.';
        if (code === ProvCode.RATE_LIMITED) return 'Gemini rate limit reached on the available API keys.';
        if (code === ProvCode.TIMEOUT) return 'Gemini did not respond before the server request ended.';
        if (code === ProvCode.NETWORK_ERROR) return 'Gemini network connection failed on the available API keys.';
        if (code === ProvCode.AUTHENTICATION_ERROR) return 'All available Gemini API keys failed authentication.';
        if (code === ProvCode.MODEL_NOT_FOUND) return `Gemini model ${this.getModel()} is unavailable.`;
        if (attemptedKeyCount > 1) return 'Gemini service is temporarily unavailable on all configured API keys.';
        return 'Gemini service is temporarily unavailable.';
    }

    async _fetchJson(apiKey, body, signal) {
        this._recordRequest(apiKey);
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
            const code = this._classifyHttpStatus(response.status, message);
            const error = createProviderError(code, message, {
                status: response.status,
                response: data,
                retryAfterMs: this._retryAfterMs(response, message),
                responseObject: response
            });
            throw error;
        }

        return data;
    }

    async generate({ prompt, signal }) {
        if (!this.isConfigured()) return null;
        const model = this.getModel();
        const interactionModel = normalizeModelForInteractions(model);
        let lastError = null;
        let lastCode = null;
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
                this._markKeyAfterFailure(apiKey, norm.provCode, {
                    message: this.extractErrorText(error),
                    response: error?.details?.responseObject
                });
            }
        }

        const message = this._failureMessage(lastCode, attemptedKeyCount);
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

                // NO artificial per-key timeout and NO sleep/backoff here.
                // A Gemini HTTP error causes immediate rotation. Once a stream
                // starts, it is allowed to finish unless the caller aborts.
                this._recordRequest(apiKey);
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
                    throw createProviderError(this._classifyHttpStatus(response.status, message), message, {
                        status: response.status,
                        response: errorData,
                        responseObject: response
                    });
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
                    if (rawData === '[DONE]') {
                        sawEvent = true;
                        return;
                    }

                    let event;
                    try {
                        event = JSON.parse(rawData);
                    } catch (parseError) {
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

                    // SSE events are separated by a blank line. Keeping the
                    // unfinished tail prevents the old "Incomplete JSON
                    // segment at the end" parser failure.
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

                this._markKeyAfterFailure(apiKey, normalized.provCode, {
                    message: this.extractErrorText(error),
                    response: error?.details?.responseObject
                });

                // Rotate immediately. There is deliberately no retry and no
                // delay on this key.
            }
        }

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
        let attemptedKeyCount = 0;

        for (const apiKey of this._orderedKeys()) {
            attemptedKeyCount += 1;
            const client = await this._getClient(apiKey);
            try {
                console.log(`[GeminiProvider] Embedding ${texts.length} texts using key ${this._keyLabel(apiKey)} (single attempt)`);
                const state = this._state(apiKey);
                this._recordRequest(apiKey);

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
                this._markKeyAfterFailure(apiKey, norm.provCode, {
                    message: this.extractErrorText(error),
                    response: error?.details?.responseObject
                });
            }
        }

        console.warn(`[GeminiProvider] All ${attemptedKeyCount} Gemini keys failed for embedding. Last error [${lastCode}]: ${lastError}`);
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

    _keyLabel(apiKey) {
        const key = String(apiKey || '');
        if (key.length <= 8) return '****';
        return `${key.slice(0, 4)}...${key.slice(-4)}`;
    }
}

export default GeminiProvider;
