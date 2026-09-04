import type { RAGSource } from '../../types/rag';

/**
 * Shared citation formatting for RAG sources.
 *
 * JSON datasets → "Dataset · Vachana N" (vachanaNumber present)
 * PDF sources   → "Title · Page N" (sourceType === 'pdf')
 *
 * vachanaNumber is null for PDF chunks, so callers must NOT render
 * "Vachana: null" for PDFs.
 */
export function isPdfSource(source: { sourceType?: string; dataset?: string }): boolean {
    return source?.sourceType === 'pdf' || String(source?.dataset ?? '').toLowerCase().endsWith('.pdf');
}

/**
 * A "document" source is a free-form document (PDF or TXT) that has no
 * vachanaNumber — these must not render "Vachana: N".
 */
export function isDocumentSource(source: { sourceType?: string; dataset?: string }): boolean {
    return source?.sourceType === 'pdf' || source?.sourceType === 'txt'
        || String(source?.dataset ?? '').toLowerCase().endsWith('.pdf')
        || String(source?.dataset ?? '').toLowerCase().endsWith('.txt');
}

export function formatCitationSummary(source: RAGSource, index: number): string {
    const prefix = `[${index + 1}] `;
    const doc = isDocumentSource(source);

    if (doc) {
        const title = source.title || source.filename || source.dataset;
        return `${prefix}${title}${source.page != null ? ` · Page ${source.page}` : ''}`;
    }

    const parts = [`${prefix}${source.dataset}`];
    if (source.page != null) parts.push(`Page ${source.page}`);
    if (source.vachanaNumber != null) parts.push(`Vachana ${source.vachanaNumber}`);
    return parts.join(' · ');
}

export function formatCitationPlain(source: RAGSource, index: number): string {
    const doc = isDocumentSource(source);

    if (doc) {
        const title = source.title || source.filename || source.dataset;
        const parts = [`[${index + 1}] ${title}`];
        if (source.page != null) parts.push(`Page: ${source.page}`);
        if (source.author) parts.push(`Author: ${source.author}`);
        return parts.join(' · ');
    }

    const parts = [`[${index + 1}] ${source.dataset}`];
    if (source.page != null) parts.push(`Page: ${source.page}`);
    if (source.vachanaNumber != null) parts.push(`Vachana: ${source.vachanaNumber}`);
    if (source.author) parts.push(`Author: ${source.author}`);
    return parts.join(' · ');
}

export function formatCitationLines(sources: RAGSource[]): string {
    return sources.map((source, i) => formatCitationPlain(source, i)).join('\n');
}

