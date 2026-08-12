/**
 * LLM Provider Layer — barrel export.
 *
 * Provider abstraction supporting Google Gemini and OpenAI with auto-fallback.
 */

export { ProvCode, classifyError, isQuotaLike, isTransientRetryable, makeProvError } from './errors.js';
export { LLMProvider } from './base.js';
export { GeminiProvider } from './gemini_provider.js';
export { OpenAIProvider } from './openai_provider.js';
export {
    getLLMProvider,
    getLLMProviderChain,
    validateLLMConfig,
    getLLMInfo
} from './provider_factory.js';
