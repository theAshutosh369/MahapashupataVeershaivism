/**
 * Krutidev 010 → Unicode Devanagari converter.
 *
 * Many older Hindi PDFs embed a legacy "Krutidev"/"Shusha"/"Chanakya" font:
 * the PDF has a real text layer, but glyph codes map to Latin-1/ASCII codepoints
 * instead of Unicode Devanagari (e.g. `keâ` should read `कें`, `Yee` → `यी`).
 *
 * This module implements the well-known Krutidev 010 keyboard mapping with
 * context-aware vowel-matra handling:
 *
 *   - A vowel-sign char AFTER a consonant is a matra (e.g. `e` → ि, `d` → ा)
 *   - The same char at word start is an independent vowel (e.g. `e` → इ)
 *   - `ee` is the long ी / ई digraph
 *   - A consonant directly after a consonant gets a halant (half-form)
 *   - `w` / `P` / `W` are dual-role (consonant vs ो / ः / ौ) resolved by context
 *
 * NOTE: Not every legacy font follows the standard Krutidev layout (e.g. Akruti
 * Dev Priya uses its own contextual encoding). `krutidevToUnicode()` is therefore
 * best-effort: callers should validate the output's Devanagari ratio and fall
 * through to OCR when it stays too low.
 */

// ─── Krutidev 010 → Devanagari consonant map ───────────────────────────────
const CONSONANTS = {
    k: 'क', K: 'ख', M: 'ग', '[': 'घ', ']': 'ङ',
    c: 'च', C: 'छ', V: 'ज', '^': 'झ', H: 'ञ',
    t: 'ट', T: 'ठ', f: 'ड', F: 'ढ', P: 'ण',
    l: 'त', L: 'थ', A: 'द', '$': 'ध', N: 'न',
    p: 'प', Q: 'फ', b: 'ब', B: 'भ', m: 'म',
    Y: 'य', r: 'र', j: 'ल', w: 'व',
    S: 'श', s: 'ष', v: 'स', u: 'ह'
};

// Char → [matra (after consonant), independent vowel (standalone)]
const VOWELS = {
    d: ['ा', 'आ'],
    e: ['ि', 'इ'],
    o: ['ु', 'उ'],
    O: ['ू', 'ऊ'],
    E: ['े', 'ए'],
    g: ['ै', 'ऐ'],
    W: ['ौ', 'औ'],
    '~': ['ं', 'ं']
};

const MATRA_ONLY = new Set(['d', 'e', 'o', 'O', 'E', 'g', '~']);
const CONSONANT_KEYS = new Set(Object.keys(CONSONANTS));

const DEVANAGARI_RE = /[\u0900-\u097F]/;
const DEVANAGARI_CONSONANT_RE = /[\u0915-\u0939\u0958-\u095F]/;

/**
 * Detect whether text looks like a legacy Devanagari font (Krutidev/Shusha/
 * Chanakya/Akruti-style) rather than real Unicode.
 *
 * Uses a combination of Latin-1/Latin-Extended glyph frequency (the signature
 * of a legacy font whose codes are mapped into the Latin range) and known
 * Krutidev bigram signatures.
 */
export function isLegacyHindiText(text) {
    const t = String(text || '');
    if (!t) return false;

    // Latin-1 Supplement + Latin Extended-A/B + common punctuation used by
    // legacy fonts (ß Ø â Û Ú Ù « » ‰ etc.)
    const GLYPH_RE = /[\u00C0-\u017F\u2018-\u201F\u2030\u00AB\u00BB\u2026]/g;
    const glyphMatches = t.match(GLYPH_RE);
    if (glyphMatches && glyphMatches.length / Math.max(1, t.length) > 0.02) {
        return true;
    }

    // Well-known Krutidev/Shusha signature bigrams/words (user-identified):
    // keâ, mee, Yee, Je, De, ve, ef, Û, Ú, Ù, ßee, Øe, «ebLe, Mees, eÙe …
    const SIGNATURE_RE = /keâ|mee|Yee|Û|Ú|Ù|ßee|Øe|«ebLe|Mees|eÙe|Ùees|efJ|Je\b|De\b|jÛ|Ús/;
    if (SIGNATURE_RE.test(t)) return true;

    return false;
}

/**
 * Convert a single character plus context into Devanagari output.
 * Internal helper — not exported.
 */
function convertChar(ch, next, prevOut) {
    const prevDeva = prevOut && DEVANAGARI_RE.test(prevOut[prevOut.length - 1] || '');

    // 'ee' digraph handled by caller — ी (matra) or ई (vowel)
    if (ch === 'e' && next === 'e') return prevDeva ? 'ी' : 'ई';

    if (MATRA_ONLY.has(ch)) {
        const pair = VOWELS[ch];
        return prevDeva ? pair[0] : pair[1];
    }

    if (ch === 'w') {
        // व (consonant) at word start; ो (o-matra) after a consonant
        const nextIsConsonant = next && CONSONANT_KEYS.has(next);
        return (prevDeva && !nextIsConsonant) ? 'ो' : 'व';
    }

    if (ch === 'P') {
        // ण (consonant) or ः (visarga)
        const nextIsConsonant = next && CONSONANT_KEYS.has(next);
        return (prevDeva && !nextIsConsonant) ? 'ः' : 'ण';
    }

    if (ch === 'W') {
        return prevDeva ? 'ौ' : 'औ';
    }

    if (CONSONANT_KEYS.has(ch)) {
        const c = CONSONANTS[ch];
        const lastOut = prevOut ? prevOut[prevOut.length - 1] : '';
        // Half-form: consonant directly after a consonant → halant + consonant
        return (DEVANAGARI_CONSONANT_RE.test(lastOut)) ? '्' + c : c;
    }

    return ch;
}

/**
 * Convert Krutidev-encoded text to Unicode Devanagari (best-effort).
 */
export function krutidevToUnicode(input) {
    const s = String(input || '');
    if (!s) return '';

    let out = '';
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        const next = s[i + 1];
        out += convertChar(ch, next, out);
        // skip consumed digraph
        if (ch === 'e' && next === 'e') i += 2;
        else i += 1;
    }
    return out;
}

