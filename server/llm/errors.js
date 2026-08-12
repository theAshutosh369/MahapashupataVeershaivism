/**
 * LLM provider error classification.
 *
 * Normalizes errors from different providers (Gemini, OpenAI) into a small set
 * of categories so the RAG engine / auto-provider can make correct decisions:
 *
 *   - 'quota_exhausted'      → 429 daily quota / RESOURCE_EXHAUSTED → switch provider immediately
 *   - 'rate_limited'         → transient 429 RPM/TPM → small retry, then switch
 *   - 'authentication_error' → 401/403 invalid key → do NOT retry repeatedly
 *   - 'model_not_found'      → 404 / deprecated / unavailable model → switch provider
 *   - 'timeout'              → request timed out → retry once, then switch
 *   - 'network_error'        → connection / DNS / fetch failure → retry once, then switch
 *   - 'invalid_request'      → malformed request / invalid params → fail
 *   - 'unknown'              → anything else
 */

export const ProvCode = Object.freeze({
    QUOTA_EXHAUSTED: 'quota_exhausted',
    RATE_LIMITED: 'rate_limited',
    AUTHENTICATION_ERROR: 'authentication_error',
    MODEL_NOT_FOUND: 'model_not_found',
    TIMEOUT: 'timeout',
    NETWORK_ERROR: 'network_error',
    INVALID_REQUEST: 'invalid_request',
    UNKNOWN: 'unknown'
});

/** Codes that are immediately recoverable by switching to another provider. */
export function isQuotaLike(code) {
    return code === ProvCode.QUOTA_EXHAUSTED || code === ProvCode.MODEL_NOT_FOUND;
}

/** Codes for which a single small retry on the same provider makes sense. */
export function isTransientRetryable(code) {
    return code === ProvCode.RATE_LIMITED || code === ProvCode.TIMEOUT || code === ProvCode.NETWORK_ERROR;
}

/**
 * Attempt to read a numeric HTTP status from a raw error string.
 * Returns null if none found.
 */
function extractStatus(raw) {
    const m = String(raw || '').match(/\b(4\d\d|5\d\d)\b/);
    return m ? Number(m[1]) : null;
}

/**
 * Classify a provider error (from its message / status / cause / details) into
 * a ProvCode. This is intentionally generous — it inspects the concatenated
 * raw text so nested SDK error objects are handled.
 */
export function classifyError(rawMsg) {
    const raw = String(rawMsg || '');
    const lower = raw.toLowerCase();
    const status = extractStatus(raw);

    // --- Explicit status-code based signals ---
    if (status === 401 || status === 403) {
        return ProvCode.AUTHENTICATION_ERROR;
    }
    if (status === 404) {
        return ProvCode.MODEL_NOT_FOUND;
    }
    if (status === 400 || status === 422) {
        return ProvCode.INVALID_REQUEST;
    }

    // --- 5xx / transient server errors ---
    if (status && status >= 500) {
        return ProvCode.UNKNOWN;
    }

    // --- 429 handling ---
    if (status === 429 || /429/.test(raw)) {
        // Billing/credit exhaustion ("no credits remaining", "billing") is a
        // quota problem, not a transient rate limit — switch provider.
        if (/no credits|credits remaining|credit balance|billing|payment|insufficient_quota|quota|exhausted|per_day|daily/.test(lower)) {
            return ProvCode.QUOTA_EXHAUSTED;
        }
        if (/rate.?limit|tpm|rpm|resource_exhausted/.test(lower)) {
            return ProvCode.RATE_LIMITED;
        }
        return ProvCode.RATE_LIMITED;
    }

    // --- Status unaffected by extractStatus but still present in text ---
    if (/401|403|invalid api key|unauthorized|authentication|permission denied/.test(lower)) {
        return ProvCode.AUTHENTICATION_ERROR;
    }
    // Billing / credit exhaustion (e.g. "You have no credits remaining") is a
    // quota shortage → switch provider rather than retrying.
    if (/no credits|credits remaining|credit balance|billing|payment required|insufficient balance/.test(lower)) {
        return ProvCode.QUOTA_EXHAUSTED;
    }
    // Network / DNS errors must be checked BEFORE the generic "not found" model
    // check, because "ENOTFOUND" / "getaddrinfo" contain "not found" / "notfound".
    if (/network|econnrefused|econnreset|fetch failed|socket|enotfound|dns|getaddrinfo|und_conn|connection|eai_again|eai_noname/i.test(lower)) {
        return ProvCode.NETWORK_ERROR;
    }
    if (/404|not ?found|no longer available|model not|does not exist|unknown model|deprecated/i.test(lower)) {
        return ProvCode.MODEL_NOT_FOUND;
    }
    if (/quota|resource_exhausted|exhausted|per_day|daily limit|insufficient_quota/.test(lower)) {
        return ProvCode.QUOTA_EXHAUSTED;
    }
    if (/rate.?limit|too many requests|tpm|rpm|429/.test(lower)) {
        return ProvCode.RATE_LIMITED;
    }
    if (/timeout|timed out|deadline|abort/i.test(raw)) {
        return ProvCode.TIMEOUT;
    }

    return ProvCode.UNKNOWN;
}

/**
 * Create a normalized provider error object.
 */
export function makeProvError(code, message, details) {
    const err = new Error(message);
    err.provCode = code;
    err.isProviderError = true;
    if (details !== undefined) err.details = details;
    return err;
}
