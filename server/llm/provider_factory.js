/**
 * Provider factory — selects the LLM provider(s) based on LLM_PROVIDER.
 *
 *   LLM_PROVIDER=gemini   → only Gemini
 *   LLM_PROVIDER=openai   → only OpenAI
 *   LLM_PROVIDER=auto     → Gemini primary, OpenAI fallback
 *                          (or the single configured provider if only one key exists)
 *
 * The factory also validates configuration at startup and exposes:
 *   - getLLMProvider()       → the primary provider (or null)
 *   - getLLMProviderChain()  → ordered list of providers for auto-fallback
 *   - validateLLMConfig()    → startup validation with clear logs
 */

import { GeminiProvider } from './gemini_provider.js';
import { OpenAIProvider } from './openai_provider.js';

function env(key) {
    const v = process.env[key];
    return v && typeof v === 'string' ? v.trim() : '';
}

function hasGeminiKey() {
    return env('GEMINI_API_KEY').length > 0;
}

function hasOpenAIKey() {
    return env('OPENAI_API_KEY').length > 0;
}

/** Resolve the configured provider mode ('gemini' | 'openai' | 'auto'). */
function getConfiguredMode() {
    const mode = env('LLM_PROVIDER').toLowerCase();
    if (mode === 'gemini' || mode === 'openai' || mode === 'auto') return mode;
    return 'auto'; // default
}

/**
 * Validate configuration at startup and log clear, non-secret messages.
 * Returns { mode, gemini, openai, ok, message }.
 */
export function validateLLMConfig() {
    const mode = getConfiguredMode();
    const gemini = hasGeminiKey();
    const openai = hasOpenAIKey();

    const geminiModel = env('GEMINI_MODEL') || 'models/gemini-flash-latest';
    const openaiModel = env('OPENAI_MODEL') || 'gpt-4o-mini';

    console.log('[LLM Config] LLM provider mode: ' + mode);
    console.log('[LLM Config] Gemini: ' + (gemini ? 'configured' : 'NOT configured') + ' | model: ' + geminiModel);
    console.log('[LLM Config] OpenAI: ' + (openai ? 'configured' : 'NOT configured') + ' | model: ' + openaiModel);

    if (mode === 'gemini') {
        if (!gemini) {
            console.error('[LLM Config] ERROR: LLM_PROVIDER=gemini but GEMINI_API_KEY is missing. Set GEMINI_API_KEY.');
            return { mode, gemini, openai, ok: false, message: 'GEMINI_API_KEY missing for gemini mode' };
        }
        return { mode, gemini, openai, ok: true, message: 'gemini' };
    }

    if (mode === 'openai') {
        if (!openai) {
            console.error('[LLM Config] ERROR: LLM_PROVIDER=openai but OPENAI_API_KEY is missing. Set OPENAI_API_KEY.');
            return { mode, gemini, openai, ok: false, message: 'OPENAI_API_KEY missing for openai mode' };
        }
        return { mode, gemini, openai, ok: true, message: 'openai' };
    }

    // auto mode
    if (!gemini && !openai) {
        console.error('[LLM Config] ERROR: LLM_PROVIDER=auto but neither GEMINI_API_KEY nor OPENAI_API_KEY is set. ' +
            'At least one is required.');
        return { mode, gemini, openai, ok: false, message: 'No LLM API key configured' };
    }

    if (gemini && !openai) {
        console.warn('[LLM Config] auto mode: only GEMINI_API_KEY present. Using Gemini only.');
        return { mode, gemini, openai, ok: true, message: 'gemini' };
    }
    if (openai && !gemini) {
        console.warn('[LLM Config] auto mode: only OPENAI_API_KEY present. Using OpenAI only.');
        return { mode, gemini, openai, ok: true, message: 'openai' };
    }

    console.log('[LLM Config] auto mode: Gemini primary, OpenAI fallback.');
    return { mode, gemini, openai, ok: true, message: 'auto' };
}

/**
 * Build the primary provider based on configuration.
 * Returns a provider instance or null.
 */
export function getLLMProvider(opts) {
    const mode = getConfiguredMode();

    if (mode === 'gemini') {
        return hasGeminiKey() ? new GeminiProvider(opts) : null;
    }
    if (mode === 'openai') {
        return hasOpenAIKey() ? new OpenAIProvider(opts) : null;
    }

    // auto
    const gemini = hasGeminiKey();
    const openai = hasOpenAIKey();
    if (gemini) return new GeminiProvider(opts);
    if (openai) return new OpenAIProvider(opts);
    return null;
}

/**
 * Build the ordered chain of providers for auto-fallback.
 *   - gemini mode → [Gemini]
 *   - openai mode → [OpenAI]
 *   - auto        → [Gemini, OpenAI] (or single configured provider)
 *
 * Returns an array of provider instances (possibly empty).
 */
export function getLLMProviderChain(opts) {
    const mode = getConfiguredMode();
    const chain = [];

    if (mode === 'gemini') {
        if (hasGeminiKey()) chain.push(new GeminiProvider(opts));
        return chain;
    }
    if (mode === 'openai') {
        if (hasOpenAIKey()) chain.push(new OpenAIProvider(opts));
        return chain;
    }

    // auto
    if (hasGeminiKey()) chain.push(new GeminiProvider(opts));
    if (hasOpenAIKey()) chain.push(new OpenAIProvider(opts));
    return chain;
}

/**
 * Resolve provider summary for the status endpoint (no secrets).
 */
export function getLLMInfo() {
    const mode = getConfiguredMode();
    const gemini = hasGeminiKey();
    const openai = hasOpenAIKey();

    const primary = getLLMProvider();
    const primaryModel = primary ? primary.getModel() : '';
    const primaryProvider = primary ? primary.name() : '';

    return {
        mode,
        primaryProvider,
        primaryModel,
        geminiConfigured: gemini,
        openaiConfigured: openai,
        geminiModel: env('GEMINI_MODEL') || 'models/gemini-flash-latest',
        openaiModel: env('OPENAI_MODEL') || 'gpt-4o-mini',
        chain: getLLMProviderChain().map(function (p) { return { provider: p.name(), model: p.getModel() }; })
    };
}

export { GeminiProvider, OpenAIProvider };
