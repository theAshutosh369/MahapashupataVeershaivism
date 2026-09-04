import type { RAGSource } from '../../types/rag';
import { isDocumentSource } from './formatCitation';

type CitationPanelProps = {
    source: RAGSource | null;
    index: number;
    onClose: () => void;
};

function sourcePath(source: RAGSource) {
    return String(source.dataset || source.filename || source.source || '').replace(/^\/+/, '').replace(/^data\//, '');
}

function sourceTitle(source: RAGSource) {
    const raw = String(source.title || source.filename || source.dataset || 'Source');
    return raw.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/_/g, ' ') || raw;
}

export default function CitationPanel({ source, index, onClose }: CitationPanelProps) {
    if (!source) return null;
    const doc = isDocumentSource(source);
    const title = sourceTitle(source);
    const path = sourcePath(source);
    const match = source.excerpt || '';
    const openUrl = `/granthas/source?path=${encodeURIComponent(path)}&match=${encodeURIComponent(match)}`;

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

                <div className="citation-modal-label">Exact evidence</div>
                <div className="citation-modal-excerpt">{source.excerpt}</div>

                <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                    {path && <a href={openUrl} className="citation-open-source" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 7, background: '#7A1F1F', color: '#fff', textDecoration: 'none', fontSize: 12, fontWeight: 650 }}>Open exact location →</a>}
                </div>
            </div>
        </div>
    );
}