/**
 * OpenAIProvider — OpenAI LLM provider.
 *
 * Uses the official `openai` Node SDK. Implements the same normalized
 * LLMProvider interface as GeminiProvider so the RAG engine can call either
 * interchangeably.
 *
 * The model is the authoritative configured value (OPENAI_MODEL). No hard-coded
 * model fallbacks are used. On a quota/rate-limit/model error the provider
 * returns null so the auto-provider can fall back to Gemini.
 */

import { LLMProvider, ProvCode } from './base.js';

const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
}

export class OpenAIProvider extends LLMProvider {
    constructor(opts) {
        super();
        this.opts = opts || {};
        this._client = null;
    }

    name() {
        return 'openai';
    }

    getApiKey() {
        return process.env.OPENAI_API_KEY;
    }

    isConfigured() {
        const key = this.getApiKey();
        return Boolean(key && typeof key === 'string' && key.trim().length > 0);
    }

    getModel() {
        const configured = process.env.OPENAI_MODEL;
        if (configured && typeof configured === 'string' && configured.trim().length > 0) {
            return configured.trim();
        }
        return this.opts.model || OPENAI_DEFAULT_MODEL;
    }

    getModelInfo() {
        return { provider: 'openai', model: this.getModel() };
    }

    async _getClient() {
        if (!this._client) {
            const { default: OpenAI } = await import('openai');
            this._client = new OpenAI({ apiKey: this.getApiKey() });
        }
        return this._client;
    }

    /**
     * Non-streaming generation. Returns the full answer string, or null for a
     * recoverable failure (quota / rate limit / model / auth).
     */
    async generate({ prompt, signal, attempt }) {
        if (!this.isConfigured()) {
            console.log('[OpenAIProvider] No OPENAI_API_KEY for answer generation');
            return null;
        }

        const client = await this._getClient();
        const model = this.getModel();
        const MAX_ATTEMPTS = Math.max(1, Number(process.env.OPENAI_MAX_ATTEMPTS || 2));
        const BACKOFF_BASE_MS = Number(process.env.OPENAI_BACKOFF_BASE_MS || 1000);

        for (let attemptIdx = 0; attemptIdx < MAX_ATTEMPTS; attemptIdx++) {
            console.log('[OpenAIProvider] Generating answer with ' + model +
                ' (attempt ' + (attemptIdx + 1) + '/' + MAX_ATTEMPTS + ')...');
            try {
                const completion = await client.chat.completions.create(
                    {
                        model: model,
                        messages: [{ role: 'user', content: prompt }],
                        temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
                        max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 2048)
                    },
                    { signal: signal }
                );
                const text = completion && completion.choices && completion.choices[0]
                    ? (completion.choices[0].message && completion.choices[0].message.content) || ''
                    : '';
                console.log('[OpenAIProvider] Answer generated (' + (text ? text.length : 0) + ' chars)');
                return String(text || '').trim();
            } catch (e) {
                const norm = this.normalizeError(e);
                const raw = this.extractErrorText(e);
                console.warn('[OpenAIProvider] Generation failed with ' + model + ' [' + norm.provCode + ']: ' + raw.trim());

                if (norm.provCode === ProvCode.QUOTA_EXHAUSTED || norm.provCode === ProvCode.MODEL_NOT_FOUND ||
                    norm.provCode === ProvCode.AUTHENTICATION_ERROR) {
                    // Not recoverable by retrying — return null so caller can switch provider.
                    return null;
                }

                if (norm.provCode === ProvCode.RATE_LIMITED || norm.provCode === ProvCode.TIMEOUT ||
                    norm.provCode === ProvCode.NETWORK_ERROR || norm.provCode === ProvCode.UNKNOWN) {
                    if (attemptIdx < MAX_ATTEMPTS - 1) {
                        const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, attemptIdx), 10000);
                        const jitter = Math.floor(Math.random() * 400);
                        console.log('[OpenAIProvider] Transient error. Retrying in ' + (backoffMs + jitter) + 'ms...');
                        await sleep(backoffMs + jitter);
                        continue;
                    }
                    return null;
                }

                // invalid_request — unrecoverable; propagate.
                return null;
            }
        }
        return null;
    }

    /**
     * Streaming generation. Invokes onToken for each text delta and returns the
     * full assembled text. Returns null for a recoverable failure.
     */
    async generateStream({ prompt, signal, attempt, onToken }) {
        if (!this.isConfigured()) {
            console.log('[OpenAIProvider] No OPENAI_API_KEY for streaming');
            return null;
        }

        const client = await this._getClient();
        const model = this.getModel();
        const MAX_ATTEMPTS = Math.max(1, Number(process.env.OPENAI_STREAM_MAX_ATTEMPTS || 2));
        const BACKOFF_BASE_MS = Number(process.env.OPENAI_BACKOFF_BASE_MS || 1000);

        for (let attemptIdx = 0; attemptIdx < MAX_ATTEMPTS; attemptIdx++) {
            console.log('[OpenAIProvider] Streaming answer with ' + model +
                ' (attempt ' + (attemptIdx + 1) + '/' + MAX_ATTEMPTS + ')...');
            try {
                const stream = await client.chat.completions.create(
                    {
                        model: model,
                        messages: [{ role: 'user', content: prompt }],
                        temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
                        max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 2048),
                        stream: true
                    },
                    { signal: signal }
                );

                let fullText = '';
                for await (const chunk of stream) {
                    const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta
                        ? chunk.choices[0].delta.content || ''
                        : '';
                    if (delta) {
                        const cleaned = String(delta).replace(/<think[\s\S]*?<\/think>/gi, '').trim();
                        if (cleaned) {
                            fullText += cleaned;
                            if (onToken) onToken(cleaned);
                        }
                    }
                }

                console.log('[OpenAIProvider] Streaming completed (' + fullText.length + ' chars)');
                return fullText;
            } catch (e) {
                const norm = this.normalizeError(e);
                const raw = this.extractErrorText(e);
                console.warn('[OpenAIProvider] Stream failed with ' + model + ' [' + norm.provCode + ']: ' + raw.trim());

                if (norm.provCode === ProvCode.QUOTA_EXHAUSTED || norm.provCode === ProvCode.MODEL_NOT_FOUND ||
                    norm.provCode === ProvCode.AUTHENTICATION_ERROR) {
                    return null;
                }

                if (norm.provCode === ProvCode.RATE_LIMITED || norm.provCode === ProvCode.TIMEOUT ||
                    norm.provCode === ProvCode.NETWORK_ERROR || norm.provCode === ProvCode.UNKNOWN) {
                    if (attemptIdx < MAX_ATTEMPTS - 1) {
                        const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, attemptIdx), 10000);
                        const jitter = Math.floor(Math.random() * 400);
                        console.log('[OpenAIProvider] Transient stream error. Retrying in ' + (backoffMs + jitter) + 'ms...');
                        await sleep(backoffMs + jitter);
                        continue;
                    }
                    return null;
                }

                return null;
            }
        }
        return null;
    }
}

export default OpenAIProvider;
