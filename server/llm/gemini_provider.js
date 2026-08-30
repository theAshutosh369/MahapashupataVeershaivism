/**
 * GeminiProvider — Google Gemini LLM provider.
 *
 * Uses ONE configured Gemini model and rotates only between configured Gemini
 * API keys. Each key is expected to belong to a different Google project.
 *
 * Important runtime rules:
 * - GEMINI_API_KEYS is authoritative when present.
 * - 401/403 disables that key for the current process.
 * - Daily quota exhaustion parks only that key until the next Pacific reset.
 * - 429 RPM/TPM rotates immediately; it never sleeps/retries the same key.
 * - 5xx, network and stream/parser failures rotate immediately.
 * - There is NO artificial per-key timeout and NO backoff sleep.
 * - Streaming uses the Google GenAI SDK directly rather than the Interactions
 *   API. This restores the normal Gemini generateContentStream path and lets
 *   the SDK handle SSE parsing.
 */

import { LLMProvider, ProvCode } from './base.js';

const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_EMBEDDING_MODEL = 'models/gemini-embedding-001';
const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_BLOCK_MS = 60_000;

// Shared across GeminiProvider instances. RAG creates providers for query
// embedding and generation; keeping state at module scope prevents every new
// instance from forgetting which key was just rate-limited or used.
const keyState = new Map();
let keyIndex = 0;
let keySignature = '';

function parseApiKeys() {
    const configuredList = String(process.env.GEMINI_API_KEYS || '').trim();
    const source = configuredList || String(process.env.GEMINI_API_KEY || '');
    return [...new Set(
        source
            .split(/[\s,;]+/)
            .map((key) => String(key || '').trim())
            .filter(Boolean)
    )];
}

function createProviderError(code, message, details) {
    const err = new Error(String(message || 'Gemini request failed'));
    err.provCode = code;
    err.isProviderError = true;
    if (details !== undefined) err.details = details;
    return err;
}

function normalizeModel(model) {
    return String(model || '').replace(/^models\//i, '');
}

function isGemini3Model(model) {
    return /^models\/gemini-3(?:\.|-|$)/i.test(String(model || ''))
        || /^gemini-3(?:\.|-|$)/i.test(String(model || ''));
}

function getGenerationConfig(model) {
    const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048);
    const config = {
        maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2048
    };

    if (isGemini3Model(model)) {
        // Low is the default for interactive RAG. It substantially reduces
        // unnecessary reasoning latency while retaining the same model.
        const level = String(process.env.GEMINI_THINKING_LEVEL || 'low').trim().toLowerCase();
        config.thinkingConfig = {
            thinkingLevel: ['low', 'medium', 'high'].includes(level) ? level : 'low'
        };
    } else {
        const temperature = Number(process.env.GEMINI_TEMPERATURE || 0.2);
        const topP = Number(process.env.GEMINI_TOP_P || 0.95);
        if (Number.isFinite(temperature)) config.temperature = temperature;
        if (Number.isFinite(topP)) config.topP = topP;
    }

    return config;
}

function stateFor(apiKey) {
    let state = keyState.get(apiKey);
    if (!state) {
        state = {
            usedAt: 0,
            requestTimes: [],
            rateBlockedUntil: 0,
            quotaBlockedUntil: 0,
            authBlocked: false
        };
        keyState.set(apiKey, state);
    }
    return state;
}

function syncKeyState(keys, model) {
    const signature = keys.join('|');
    if (signature === keySignature) return;
    keySignature = signature;
    const valid = new Set(keys);
    for (const key of keyState.keys()) {
        if (!valid.has(key)) keyState.delete(key);
    }
    console.log(`[GeminiProvider] Loaded ${keys.length} configured Gemini API key(s) for model ${model}.`);
    console.log(`[GeminiProvider] Key rotation order: ${keys.map(keyLabel).join(', ')}`);
}

function pruneRequests(state, now = Date.now()) {
    state.requestTimes = state.requestTimes.filter(time => now - time < RATE_WINDOW_MS);
}

function recordRequest(apiKey) {
    const state = stateFor(apiKey);
    const now = Date.now();
    pruneRequests(state, now);
    state.requestTimes.push(now);
    state.usedAt = now;
}

function nextPacificMidnight() {
    const now = new Date();
    const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const next = new Date(pacific);
    next.setHours(24, 0, 0, 0);
    return Date.now() + Math.max(60_000, next.getTime() - pacific.getTime());
}

function isBlocked(apiKey, now = Date.now()) {
    const state = stateFor(apiKey);
    if (state.authBlocked) return true;
    if (state.quotaBlockedUntil > now) return true;
    if (state.rateBlockedUntil > now) return true;
    if (state.quotaBlockedUntil) state.quotaBlockedUntil = 0;
    if (state.rateBlockedUntil) state.rateBlockedUntil = 0;
    return false;
}

function orderedKeys() {
    const keys = parseApiKeys();
    syncKeyState(keys, process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL);
    if (!keys.length) return [];

    const now = Date.now();
    const available = keys.filter(key => !isBlocked(key, now));

    // Never fall back to blocked keys. If every key is currently parked, fail
    // immediately instead of waiting for a reset/rate window.
    if (!available.length) return [];

    const candidates = available.map((key, originalIndex) => {
        const state = stateFor(key);
        pruneRequests(state, now);
        return {
            key,
            originalIndex,
            requestCount: state.requestTimes.length,
            usedAt: state.usedAt || 0
        };
    });

    // Least-used key first, then least-recently-used. The rotating offset makes
    // equal-state startup requests distribute instead of always choosing key 1.
    candidates.sort((a, b) => {
        if (a.requestCount !== b.requestCount) return a.requestCount - b.requestCount;
        if (a.usedAt !== b.usedAt) return a.usedAt - b.usedAt;
        const aOffset = (a.originalIndex - keyIndex + keys.length) % keys.length;
        const bOffset = (b.originalIndex - keyIndex + keys.length) % keys.length;
        return aOffset - bOffset;
    });

    keyIndex = (keyIndex + 1) % keys.length;
    return candidates.map(item => item.key);
}

function retryAfterMs(response, message) {
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

function classifyHttpStatus(status, message) {
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

function markFailure(apiKey, code, details = {}) {
    const state = stateFor(apiKey);
    if (code === ProvCode.AUTHENTICATION_ERROR) {
        state.authBlocked = true;
        console.warn(`[GeminiProvider] Gemini key ${keyLabel(apiKey)} rejected authentication; disabled for this server process.`);
    } else if (code === ProvCode.QUOTA_EXHAUSTED) {
        state.quotaBlockedUntil = nextPacificMidnight();
        console.warn(`[GeminiProvider] Gemini key ${keyLabel(apiKey)} reached daily quota; parked until the next Pacific reset.`);
    } else if (code === ProvCode.RATE_LIMITED) {
        state.rateBlockedUntil = Date.now() + retryAfterMs(details.response, details.message);
        console.warn(`[GeminiProvider] Gemini key ${keyLabel(apiKey)} is rate-limited; rotating immediately.`);
    }
    // 5xx, network and parser failures are deliberately not blocked.
}

function failureMessage(code, count) {
    if (code === ProvCode.QUOTA_EXHAUSTED) return 'Gemini daily quota is exhausted on the available API keys.';
    if (code === ProvCode.RATE_LIMITED) return 'Gemini rate limit reached on the available API keys.';
    if (code === ProvCode.AUTHENTICATION_ERROR) return 'All available Gemini API keys failed authentication.';
    if (code === ProvCode.MODEL_NOT_FOUND) return `Gemini model ${process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL} is unavailable.`;
    if (code === ProvCode.NETWORK_ERROR) return 'Gemini network connection failed on the available API keys.';
    if (code === ProvCode.TIMEOUT) return 'Gemini did not respond in time.';
    return count > 1 ? 'Gemini service is temporarily unavailable on all configured API keys.' : 'Gemini service is temporarily unavailable.';
}

function extractText(result) {
    if (!result) return '';
    if (typeof result.text === 'string') return result.text;
    if (typeof result.output_text === 'string') return result.output_text;
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    return candidates
        .flatMap(candidate => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .join('');
}

function keyLabel(apiKey) {
    const key = String(apiKey || '');
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export class GeminiProvider extends LLMProvider {
    constructor(opts) {
        super();
        this.opts = opts || {};
        this._clients = new Map();
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
        return { provider: 'gemini', model: this.getModel(), keyCount: this.getApiKeys().length };
    }

    getModelChain() { return [this.getModel()]; }

    async _getClient(apiKey) {
        if (!this._clients.has(apiKey)) {
            const { GoogleGenAI } = await import('@google/genai');
            this._clients.set(apiKey, new GoogleGenAI({ apiKey }));
        }
        return this._clients.get(apiKey);
    }

    async generate({ prompt, signal }) {
        if (!this.isConfigured()) return null;
        const model = this.getModel();
        let lastCode = ProvCode.UNKNOWN;
        let lastError = '';
        const keys = orderedKeys();

        if (!keys.length) {
            throw createProviderError(ProvCode.QUOTA_EXHAUSTED, 'All configured Gemini API keys are currently blocked or exhausted.', { model });
        }

        for (const apiKey of keys) {
            try {
                const client = await this._getClient(apiKey);
                recordRequest(apiKey);
                console.log(`[GeminiProvider] Generating with ${model} using key ${keyLabel(apiKey)} (SDK, single attempt)`);

                const result = await client.models.generateContent({
                    model: normalizeModel(model),
                    contents: String(prompt || ''),
                    config: {
                        ...getGenerationConfig(model),
                        ...(signal ? { abortSignal: signal } : {})
                    }
                });

                const text = extractText(result).trim();
                if (text) return text;
                throw createProviderError(ProvCode.UNKNOWN, 'Gemini returned an empty response');
            } catch (error) {
                if (signal?.aborted) throw error;
                const normalized = this.normalizeError(error);
                lastCode = normalized.provCode;
                lastError = this.extractErrorText(error);
                console.warn(`[GeminiProvider] Generation failed with ${model} using key ${keyLabel(apiKey)} [${lastCode}]: ${lastError}`);
                markFailure(apiKey, lastCode, { message: lastError, response: error?.details?.responseObject });
            }
        }

        throw createProviderError(lastCode, failureMessage(lastCode, keys.length), { model, attemptedKeyCount: keys.length, lastError });
    }

    async generateStream({ prompt, signal, onToken }) {
        if (!this.isConfigured()) return null;
        const model = this.getModel();
        let lastCode = ProvCode.UNKNOWN;
        let lastError = '';
        const keys = orderedKeys();

        if (!keys.length) {
            throw createProviderError(ProvCode.QUOTA_EXHAUSTED, 'All configured Gemini API keys are currently blocked or exhausted.', { model });
        }

        for (const apiKey of keys) {
            try {
                const client = await this._getClient(apiKey);
                recordRequest(apiKey);
                console.log(`[GeminiProvider] Streaming with ${model} using key ${keyLabel(apiKey)} (Google GenAI SDK, single attempt)`);

                const stream = await client.models.generateContentStream({
                    model: normalizeModel(model),
                    contents: String(prompt || ''),
                    config: {
                        ...getGenerationConfig(model),
                        ...(signal ? { abortSignal: signal } : {})
                    }
                });

                let fullText = '';
                for await (const chunk of stream) {
                    if (signal?.aborted) throw createProviderError(ProvCode.TIMEOUT, 'Request aborted by client');
                    const text = extractText(chunk);
                    if (text) {
                        fullText += text;
                        onToken?.(text);
                    }
                }

                if (!fullText.trim()) throw createProviderError(ProvCode.UNKNOWN, 'Gemini returned an empty response');
                console.log(`[GeminiProvider] Streaming completed (${fullText.length} chars)`);
                return fullText.trim();
            } catch (error) {
                if (signal?.aborted) throw error;
                const normalized = this.normalizeError(error);
                lastCode = normalized.provCode;
                lastError = this.extractErrorText(error);
                console.warn(`[GeminiProvider] Stream failed with ${model} using key ${keyLabel(apiKey)} [${lastCode}]: ${lastError}`);
                markFailure(apiKey, lastCode, { message: lastError, response: error?.details?.responseObject });
                // Immediate rotation. No retry of the same key and no sleep.
            }
        }

        const message = failureMessage(lastCode, keys.length);
        console.warn(`[GeminiProvider] All Gemini keys failed for model ${model}: ${message}`);
        const error = createProviderError(lastCode, message, {
            model,
            attemptedKeyCount: keys.length,
            lastError
        });
        error.isFinalProviderError = true;
        throw error;
    }

    async embed({ texts, signal }) {
        if (!this.isConfigured()) return null;
        if (!Array.isArray(texts) || texts.length === 0) return [];

        let lastCode = ProvCode.UNKNOWN;
        let lastError = '';
        const keys = orderedKeys();
        if (!keys.length) return null;

        for (const apiKey of keys) {
            try {
                const client = await this._getClient(apiKey);
                recordRequest(apiKey);
                console.log(`[GeminiProvider] Embedding ${texts.length} texts using key ${keyLabel(apiKey)} (single attempt)`);

                const result = await client.models.embedContent({
                    model: GEMINI_EMBEDDING_MODEL,
                    contents: texts.map(text => String(text || '').slice(0, 6000)),
                    config: {
                        outputDimensionality: 768,
                        ...(signal ? { abortSignal: signal } : {})
                    }
                });

                if (!result || !Array.isArray(result.embeddings)) {
                    throw createProviderError(ProvCode.UNKNOWN, 'Embedding response missing embeddings array');
                }

                const embeddings = result.embeddings.map(embedding =>
                    embedding && Array.isArray(embedding.values) ? embedding.values.map(Number) : []
                );

                if (embeddings.length !== texts.length || embeddings.some(vector =>
                    vector.length !== 768 || vector.some(value => !Number.isFinite(value))
                )) {
                    throw createProviderError(ProvCode.UNKNOWN, `Embedding response has invalid dimensions; expected ${texts.length} vectors of 768 dimensions`);
                }

                console.log(`[GeminiProvider] Embedding completed (${embeddings.length} vectors)`);
                return embeddings;
            } catch (error) {
                if (signal?.aborted) throw error;
                const normalized = this.normalizeError(error);
                lastCode = normalized.provCode;
                lastError = this.extractErrorText(error);
                console.warn(`[GeminiProvider] Embedding failed using key ${keyLabel(apiKey)} [${lastCode}]: ${lastError}`);
                markFailure(apiKey, lastCode, { message: lastError, response: error?.details?.responseObject });
            }
        }

        console.warn(`[GeminiProvider] All Gemini keys failed for embedding. Last error [${lastCode}]: ${lastError}`);
        return null;
    }
}

export default GeminiProvider;
