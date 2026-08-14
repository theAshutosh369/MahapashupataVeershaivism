import type { RAGSource } from '../../types/rag';
import { isDocumentSource } from './formatCitation';

type CitationPanelProps = {
    source: RAGSource | null;
    index: number;
    onClose: () => void;
};

export default function CitationPanel({ source, index, onClose }: CitationPanelProps) {
    if (!source) return null;
    const doc = isDocumentSource(source);
    const title = doc ? (source.title || source.filename || source.dataset) : source.dataset;

    return (
        <div className="citation-modal-overlay" onClick={onClose}>
            <div className="citation-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
                <div className="citation-modal-header">
                    <span>Source [{index}]</span>
                    <button type="button" onClick={onClose} aria-label="Close">✕</button>
                </div>

                <div className="citation-modal-title">{title}</div>

                <div className="citation-modal-meta">
                    {source.page != null && <span>Page {source.page}</span>}
                    {!doc && source.vachanaNumber != null && <span>Vachana {source.vachanaNumber}</span>}
                    {source.author && <span>{source.author}</span>}
                    {source.language && <span>{source.language}</span>}
                </div>

                <hr />

                <div className="citation-modal-label">Original passage</div>
                <div className="citation-modal-excerpt">{source.excerpt}</div>
            </div>
        </div>
    );
}