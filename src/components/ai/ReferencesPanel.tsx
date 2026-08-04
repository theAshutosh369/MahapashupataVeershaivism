import type { RAGSource } from '../../types/rag';
import { isDocumentSource, formatCitationSummary } from './formatCitation';

type ReferencesPanelProps = {
    sources: RAGSource[];
};

export default function ReferencesPanel({ sources }: ReferencesPanelProps) {
    if (sources.length === 0) {
        return null;
    }

    return (
        <div
            style={{
                marginTop: 20,
                padding: 18,
                backgroundColor: 'rgba(255,255,255,0.96)',
                border: '1px solid rgba(148,163,184,0.16)',
                borderRadius: 16
            }}
        >
            <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 12 }}>Retrieved references</div>
            <div style={{ display: 'grid', gap: 14 }}>
                {sources.map((source, index) => (
                    <details key={source.id} style={{ padding: 14, borderRadius: 12, backgroundColor: '#f8fafc' }}>
                        <summary style={{ fontWeight: 600, cursor: 'pointer', color: '#0f172a' }}>
                            {isDocumentSource(source) ? (
                                formatCitationSummary(source, index)
                            ) : (
                                <>[{index + 1}] {source.dataset} · Page {source.page ?? 'N/A'} · Vachana {source.vachanaNumber ?? 'N/A'}</>
                            )}
                        </summary>
                        <div style={{ marginTop: 10, color: '#334155', fontSize: 14, whiteSpace: 'pre-wrap' }}>{source.excerpt}</div>
                        <div style={{ marginTop: 10, color: '#475569', fontSize: 13 }}>
                            Score: {source.score}
                        </div>
                    </details>
                ))}
            </div>
        </div>
    );
}
