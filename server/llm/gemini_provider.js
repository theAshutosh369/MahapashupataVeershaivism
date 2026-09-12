/**
 * GeminiProvider — Google Gemini LLM provider.
 *
 * Extracted from the original rag_engine.js answer-generation logic. All
 * Gemini-specific behavior remains here (model chain, retry/backoff, streaming
 * via @google/genai, error classification). The RAG engine calls this through
 * the normalized LLMProvider interface.
 */

import { LLMProvider, ProvCode } from './base.js';

const GEMINI_DEFAULT_MODEL = 'models/gemini-flash-latest';

function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
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
        return Boolean(key && typeof key === 'string' && key.trim().length > 0);
    }

    getModel() {
        const configured = process.env.GEMINI_MODEL;
        if (configured && typeof configured === 'string' && configured.trim().length > 0) {
            return configured.trim();
        }
        return this.opts.model || GEMINI_DEFAULT_MODEL;
    }

    getModelInfo() {
        return { provider: 'gemini', model: this.getModel() };
    }

    /** Ordered list of models to try (configured primary + configured fallbacks). */
    getModelChain() {
        const chain = [];
        const primary = this.getModel();
        chain.push(primary);

        const configuredFallbacks = process.env.GEMINI_FALLBACK_MODELS;
        if (configuredFallbacks && typeof configuredFallbacks === 'string') {
            const parts = configuredFallbacks.split(',').map((s) => s.trim()).filter(Boolean);
            for (const p of parts) {
                if (chain.indexOf(p) === -1) chain.push(p);
            }
        }

        return chain;
    }

    async _getClient() {
        if (!this._clientPromise) {
            const { GoogleGenAI } = await import('@google/genai');
            this._clientPromise = new GoogleGenAI({ apiKey: this.getApiKey() });
        }
        return this._clientPromise;
    }

    /**
     * Non-streaming generation. Returns the full answer string, or null if the
     * provider could not produce an answer (recoverable) — the caller decides
     * whether to fall back to another provider.
     */
    async generate({ prompt, signal, attempt }) {
        if (!this.isConfigured()) {
            console.log('[GeminiProvider] No GEMINI_API_KEY for answer generation');
            return null;
        }

        const client = await this._getClient();
        const modelChain = this.getModelChain();
        const MAX_GEN_ATTEMPTS = Number(process.env.GEMINI_MAX_ATTEMPTS || 3);
        const BACKOFF_BASE_MS = Number(process.env.GEMINI_BACKOFF_BASE_MS || 1000);

        let result = null;
        let lastError = null;
        let lastProvCode = null;

        for (let mi = 0; mi < modelChain.length; mi++) {
            const model = modelChain[mi];
            let ok = false;

            for (let attemptIdx = 0; attemptIdx < MAX_GEN_ATTEMPTS; attemptIdx++) {
                console.log('[GeminiProvider] Generating answer with ' + model +
                    ' (model ' + (mi + 1) + '/' + modelChain.length +
                    ', attempt ' + (attemptIdx + 1) + '/' + MAX_GEN_ATTEMPTS + ')...');
                try {
                    result = await client.models.generateContent({
                        model: model,
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
                            topP: 0.95,
                            maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)
                        },
                        signal: signal
                    });
                    ok = true;
                    break;
                } catch (e) {
                    const norm = this.normalizeError(e);
                    lastError = norm.message;
                    lastProvCode = norm.provCode;
                    const genMsg = this.extractErrorText(e);
                    console.warn('[GeminiProvider] Generation failed with ' + model +
                        ' [' + norm.provCode + ']: ' + genMsg.trim());

                    if (norm.provCode === ProvCode.RATE_LIMITED || norm.provCode === ProvCode.TIMEOUT ||
                        norm.provCode === ProvCode.NETWORK_ERROR || norm.provCode === ProvCode.UNKNOWN) {
                        // Transient — back off and retry the same model.
                        if (attemptIdx < MAX_GEN_ATTEMPTS - 1) {
                            const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, attemptIdx), 15000);
                            const jitter = Math.floor(Math.random() * 500);
                            console.log('[GeminiProvider] Transient error. Retrying in ' + (backoffMs + jitter) + 'ms...');
                            await sleep(backoffMs + jitter);
                            continue;
                        }
                        break;
                    }

                    if (norm.provCode === ProvCode.QUOTA_EXHAUSTED || norm.provCode === ProvCode.MODEL_NOT_FOUND) {
                        // Not recoverable by waiting — switch to next fallback model.
                        console.log('[GeminiProvider] ' +
                            (norm.provCode === ProvCode.QUOTA_EXHAUSTED ? 'Daily quota exhausted' : 'Model unavailable') +
                            ' on ' + model + '. Trying next model...');
                        break;
                    }

                    if (norm.provCode === ProvCode.AUTHENTICATION_ERROR) {
                        console.warn('[GeminiProvider] Authentication error (invalid key). Not retrying.');
                        return null;
                    }

                    // invalid_request — unrecoverable; abort.
                    return null;
                }
            }

            if (ok && result) break;
        }

        if (!result) {
            console.warn('[GeminiProvider] All ' + modelChain.length + ' model(s) failed. Last error [' + lastProvCode + ']: ' + lastError);
            return null;
        }

        const text = result && result.response ? result.response.text() : (result ? result.text : '');
        return String(text || '').trim();
    }

    /**
     * Streaming generation. Invokes onToken for each cleaned chunk and returns
     * the full assembled text. Returns null for a recoverable failure so the
     * caller can switch providers.
     */
    async generateStream({ prompt, signal, attempt, onToken }) {
        if (!this.isConfigured()) {
            console.log('[GeminiProvider] No GEMINI_API_KEY for streaming');
            return null;
        }

        const client = await this._getClient();
        const model = this.getModel();
        const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 30000);
        const MAX_STREAM_ATTEMPTS = Number(process.env.GEMINI_STREAM_MAX_ATTEMPTS || 3);
        const BASE_BACKOFF_MS = Number(process.env.GEMINI_BACKOFF_BASE_MS || 1000);

        for (let sAttempt = 0; sAttempt < MAX_STREAM_ATTEMPTS; sAttempt++) {
            const controller = new AbortController();
            if (signal) {
                if (signal.aborted) controller.abort();
                else signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
            }

            const timeout = setTimeout(function () { controller.abort(); }, timeoutMs);

            console.log('[GeminiProvider] Streaming answer with ' + model +
                ' (attempt ' + (sAttempt + 1) + '/' + MAX_STREAM_ATTEMPTS + ')...');
            const startTime = Date.now();

            try {
                const stream = await client.models.generateContentStream({
                    model: model,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
                        topP: 0.95,
                        maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048)
                    },
                    signal: controller.signal
                });

                const asyncIterable = stream && stream.stream ? stream.stream : stream;
                if (!asyncIterable || typeof asyncIterable[Symbol.asyncIterator] !== 'function') {
                    throw new Error('Gemini streaming response has no async iterable');
                }

                let fullText = '';
                for await (const chunk of asyncIterable) {
                    let text = '';
                    if (chunk) {
                        text = chunk.text || '';
                        if (!text && chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts) {
                            for (const part of chunk.candidates[0].content.parts) {
                                text += part.text || '';
                            }
                        }
                    }
                    if (!text) continue;
                    const cleaned = String(text).replace(/<think[\s\S]*?<\/think>/gi, '').trim();
                    if (cleaned) {
                        fullText += cleaned;
                        if (onToken) onToken(cleaned);
                    }
                }

                const elapsed = Date.now() - startTime;
                console.log('[GeminiProvider] Streaming completed in ' + elapsed + 'ms (' + fullText.length + ' chars)');
                clearTimeout(timeout);
                return fullText;
            } catch (error) {
                clearTimeout(timeout);
                if (controller.signal.aborted) {
                    throw this.normalizeError(new Error('Gemini streaming timed out after ' + timeoutMs + 'ms'));
                }

                const norm = this.normalizeError(error);
                const sRaw = this.extractErrorText(error);
                console.warn('[GeminiProvider] Stream failed with ' + model + ' [' + norm.provCode + ']: ' + sRaw.trim());

                if (norm.provCode === ProvCode.QUOTA_EXHAUSTED || norm.provCode === ProvCode.MODEL_NOT_FOUND) {
                    console.log('[GeminiProvider] ' +
                        (norm.provCode === ProvCode.QUOTA_EXHAUSTED ? 'Daily quota exhausted' : 'Model unavailable') +
                        ' on ' + model + '. Stopping streaming to try a fallback provider.');
                    return null;
                }

                if (norm.provCode === ProvCode.AUTHENTICATION_ERROR) {
                    return null;
                }

                if (norm.provCode === ProvCode.RATE_LIMITED || norm.provCode === ProvCode.TIMEOUT ||
                    norm.provCode === ProvCode.NETWORK_ERROR || norm.provCode === ProvCode.UNKNOWN) {
                    if (sAttempt < MAX_STREAM_ATTEMPTS - 1) {
                        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, sAttempt), 15000);
                        const jitter = Math.floor(Math.random() * 500);
                        console.log('[GeminiProvider] Transient stream error. Retrying in ' + (backoffMs + jitter) + 'ms...');
                        await new Promise(function (res) { setTimeout(res, backoffMs + jitter); });
                        continue;
                    }
                    console.warn('[GeminiProvider] Transient stream error after ' + MAX_STREAM_ATTEMPTS + ' attempts. Giving up streaming.');
                    return null;
                }

                // invalid_request — unrecoverable; propagate.
                throw error;
            }
        }
        const err = new Error('Gemini streaming failed');
        return null;
    }
}

export default GeminiProvider;
