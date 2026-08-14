import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RAGSource } from '../../types/rag';
import '../../styles/components/answerPanel.css';
import { isDocumentSource, formatCitationSummary, linkifyCitations } from './formatCitation';
import CitationPanel from './CitationPanel';

// ─── Inline SVG Icons ──────────────────────────────────────────────────────

const CopyIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
);

const SourcesIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
    </svg>
);

const CheckIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

type AnswerPanelProps = {
    answer: string;
    sources: RAGSource[];
    confidence: number;
    loading: boolean;
    onCopyAnswer: () => void;
    onCopyReferences: () => void;
};

export default function AnswerPanel({ answer, sources, loading, onCopyAnswer }: AnswerPanelProps) {
    const [showSources, setShowSources] = useState(false);
    const [copied, setCopied] = useState(false);
    const [activeCitation, setActiveCitation] = useState<number | null>(null);
    const sourceCount = sources.length;

    function handleCopy() {
        onCopyAnswer();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    const markdownComponents: Components = {
        a: ({ href, children }) => {
            if (href && href.startsWith('#cite-')) {
                const n = Number(href.slice('#cite-'.length));
                return (
                    <button
                        type="button"
                        className="citation-link"
                        onClick={() => setActiveCitation(n)}
                        aria-label={`View source ${n}`}
                    >
                        {children}
                    </button>
                );
            }
            return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                </a>
            );
        }
    };

    const processedAnswer = linkifyCitations(answer, sourceCount);

    return (
        <div className="assistant-bubble">
            {/* Answer text */}
            <div className="markdown-content" style={{ color: '#1f2937', fontSize: 'var(--font-body)' }}>
                {answer ? (
                    <>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {processedAnswer}
                        </ReactMarkdown>
                        {loading && (
                            <span aria-hidden="true" style={{ display: 'inline-block', marginLeft: 2, verticalAlign: 'baseline' }}>
                                <span style={{ display: 'inline-block', width: 2, height: '1.05em', background: '#7A1F1F', borderRadius: 1, transform: 'translateY(3px)', animation: 'bb_cursor_blink 1s steps(2, end) infinite' }} />
                                <style>{`@keyframes bb_cursor_blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }`}</style>
                            </span>
                        )}
                    </>
                ) : loading ? (
                    <div style={{ color: '#6b7280' }}>Preparing response...</div>
                ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {'No answer yet. Ask a question to retrieve context from your local datasets.'}
                    </ReactMarkdown>
                )}
            </div>

            {/* Action buttons below answer */}
            {!loading && answer && (
                <div className="assistant-actions">
                    <button type="button" className="assistant-action-btn" onClick={handleCopy} title="Copy answer">
                        {copied ? <CheckIcon /> : <CopyIcon />}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                    {sourceCount > 0 && (
                        <button
                            type="button"
                            className="assistant-action-btn"
                            onClick={() => setShowSources(!showSources)}
                            title="View sources"
                        >
                            <SourcesIcon />
                            <span>{showSources ? 'Hide sources' : 'View sources'}</span>
                        </button>
                    )}
                </div>
            )}

            {/* Sources panel (inline, collapsible) */}
            {showSources && sourceCount > 0 && (
                <div className="sources-inline-panel">
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 8 }}>
                        Retrieved References
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {sources.map((source, index) => (
                            <details key={source.id} className="source-detail">
                                <summary>
                                    {isDocumentSource(source) ? (
                                        formatCitationSummary(source, index)
                                    ) : (
                                        <>
                                            [{index + 1}] {source.dataset}
                                            {source.page !== undefined && ` · Page ${source.page}`}
                                            {source.vachanaNumber !== undefined && ` · Vachana ${source.vachanaNumber}`}
                                        </>
                                    )}
                                </summary>
                                <div className="source-detail-content">{source.excerpt}</div>
                                <div className="source-detail-score">Score: {source.score}</div>
                            </details>
                        ))}
                    </div>
                </div>
            )}

            {/* Citation click-through panel */}
            {activeCitation !== null && (
                <CitationPanel
                    source={sources[activeCitation - 1] ?? null}
                    index={activeCitation}
                    onClose={() => setActiveCitation(null)}
                />
            )}
        </div>
    );
}
