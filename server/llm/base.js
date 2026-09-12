/**
 * LLMProvider — abstract base class.
 *
 * Both GeminiProvider and OpenAIProvider extend this so the RAG engine can call
 * a single normalized interface regardless of the underlying provider.
 *
 * Public interface implemented by subclasses:
 *   - name()                    → 'gemini' | 'openai'
 *   - isConfigured()            → boolean (has valid API key)
 *   - getModel()                → configured model string
 *   - getModelInfo()            → { provider, model } for logging / status
 *   - async generate({ prompt, signal, attempt })          → string | null
 *   - async generateStream({ prompt, signal, attempt, onToken }) → string | null
 *
 * Error contract:
 *   - Thrown errors carry a `.provCode` (see errors.js) so the auto provider can
 *     decide whether to retry, switch providers, or fail.
 *   - Subclasses convert provider-specific errors into normalized errors before
 *     rethrowing.
 */

import { ProvCode, classifyError, makeProvError } from './errors.js';

export class LLMProvider {
    constructor() {
        if (this.constructor === LLMProvider) {
            throw new Error('LLMProvider is abstract');
        }
    }

    /** Human-readable provider name ('gemini' or 'openai'). */
    name() {
        throw new Error('name() not implemented');
    }

    /** True if the provider has a usable API key configured. */
    isConfigured() {
        return false;
    }

    /** The configured model string. */
    getModel() {
        return '';
    }

    /** Metadata for logging / status endpoint. */
    getModelInfo() {
        return { provider: this.name(), model: this.getModel() };
    }

    /**
     * Normalize an arbitrary thrown error into one carrying a `provCode`.
     * Subclasses may override/extend this for provider-specific parsing.
     */
    normalizeError(error) {
        if (error && error.isProviderError && error.provCode) {
            return error;
        }
        const raw = this.extractErrorText(error);
        const code = classifyError(raw);
        return makeProvError(code, String(error && error.message ? error.message : error), raw);
    }

    /**
     * Build the most informative raw text from an SDK error object so
     * classification has access to status / cause / details.
     */
    extractErrorText(error) {
        if (!error) return '';
        const parts = [];

        if (error.status || error.statusCode) parts.push(String(error.status || error.statusCode));
        if (error.message) parts.push(String(error.message));
        if (typeof error === 'string') parts.push(error);

        try {
            if (error.cause) {
                parts.push(typeof error.cause === 'string'
                    ? error.cause
                    : (error.cause.message || JSON.stringify(error.cause)));
            }
        } catch { /* ignore */ }

        try {
            if (error.error_details || error.errorDetails) {
                parts.push(JSON.stringify(error.error_details || error.errorDetails));
            }
            if (error.response) {
                parts.push(JSON.stringify(error.response));
            }
        } catch { /* ignore */ }

        return parts.join(' ').trim();
    }

    /**
     * Non-streaming generation. Returns the full answer string, or null if the
     * provider could not produce an answer for a recoverable reason.
     */
    async generate() {
        throw new Error('generate() not implemented');
    }

    /**
     * Streaming generation. Invokes `onToken(text)` for each chunk and returns
     * the full assembled answer string. Returns null for a recoverable failure,
     * or throws a normalized provider error.
     */
    async generateStream() {
        throw new Error('generateStream() not implemented');
    }
}

export { ProvCode, classifyError, makeProvError };
