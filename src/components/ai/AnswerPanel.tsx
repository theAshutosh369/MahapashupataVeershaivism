import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RAGSource } from '../../types/rag';
import '../../styles/components/answerPanel.css';
import { isDocumentSource, formatCitationSummary, linkifyCitations } from './formatCitation';
import CitationPanel from './CitationPanel';

const CopyIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>);
const SourcesIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>);
const CheckIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>);

function cleanSourceTitle(source: RAGSource) {
    const raw = String(source.title || source.filename || source.dataset || 'Source');
    return raw.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/_/g, ' ') || raw;
}

function sourcePath(source: RAGSource) {
    return String(source.dataset || source.filename || source.source || '').replace(/^\/+/, '').replace(/^data\//, '');
}

function openSource(source: RAGSource) {
    const path = sourcePath(source);
    if (!path) return;
    const url = `/granthas/source?path=${encodeURIComponent(path)}&match=${encodeURIComponent(source.excerpt || '')}`;
    window.location.assign(url);
}

function sourceText(source: RAGSource) {
    return String(source.excerpt || '').replace(/\s+/g, ' ').trim();
}

function tokenSet(value: string) {
    return new Set(value.toLocaleLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3));
}

function bestEvidence(statement: string, sources: RAGSource[]) {
    const left = tokenSet(statement);
    let best: RAGSource | null = null;
    let bestScore = 0;
    for (const source of sources) {
        const right = tokenSet(sourceText(source));
        if (!left.size || !right.size) continue;
        let hits = 0;
        left.forEach((token) => { if (right.has(token)) hits += 1; });
        const score = hits / left.size;
        if (score > bestScore) { bestScore = score; best = source; }
    }
    return bestScore >= 0.18 ? best : null;
}

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
    const [showEvidence, setShowEvidence] = useState(false);
    const [copied, setCopied] = useState(false);
    const [activeCitation, setActiveCitation] = useState<number | null>(null);
    const sourceCount = sources.length;

    const evidenceItems = useMemo(() => {
        return answer.split(/\n\s*\n/).map((part) => part.replace(/\[[0-9]+\]/g, '').trim()).filter((part) => part.length >= 25).map((statement) => ({ statement, source: bestEvidence(statement, sources) }));
    }, [answer, sources]);

    function handleCopy() {
        onCopyAnswer();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    const markdownComponents: Components = {
        h1: ({ children }) => <h1 className="answer-heading answer-heading-1">{children}</h1>,
        h2: ({ children }) => <h2 className="answer-heading answer-heading-2">{children}</h2>,
        h3: ({ children }) => <h3 className="answer-heading answer-heading-3">{children}</h3>,
        h4: ({ children }) => <h4 className="answer-heading answer-heading-4">{children}</h4>,
        p: ({ children }) => <p className="answer-paragraph">{children}</p>,
        strong: ({ children }) => <strong className="answer-strong">{children}</strong>,
        em: ({ children }) => <em className="answer-em">{children}</em>,
        ul: ({ children }) => <ul className="answer-list answer-list-unordered">{children}</ul>,
        ol: ({ children }) => <ol className="answer-list answer-list-ordered">{children}</ol>,
        li: ({ children }) => <li className="answer-list-item">{children}</li>,
        blockquote: ({ children }) => <blockquote className="answer-blockquote">{children}</blockquote>,
        hr: () => <hr className="answer-divider" />,
        a: ({ href, children }) => href?.startsWith('#cite-') ? <button type="button" className="citation-link" onClick={() => setActiveCitation(Number(href.slice(6)))} aria-label="Open exact source location">{children}</button> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    };

    const processedAnswer = linkifyCitations(answer, sourceCount);

    return (
        <div className="assistant-bubble">
            <div className="markdown-content answer-markdown-shell">
                {answer ? <>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{processedAnswer}</ReactMarkdown>
                    {loading && <span aria-hidden="true" style={{ display: 'inline-block', marginLeft: 2, verticalAlign: 'baseline' }}><span style={{ display: 'inline-block', width: 2, height: '1.05em', background: '#7A1F1F', borderRadius: 1, transform: 'translateY(3px)', animation: 'bb_cursor_blink 1s steps(2,end) infinite' }}/><style>{`@keyframes bb_cursor_blink {0%{opacity:1}50%{opacity:0}100%{opacity:1}}`}</style></span>}
                </> : loading ? <div style={{ color: '#6b7280' }}>Preparing response...</div> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{'No answer yet. Ask a question to retrieve context from your local datasets.'}</ReactMarkdown>}
            </div>

            {!loading && answer && <div className="assistant-actions">
                <button type="button" className="assistant-action-btn" onClick={handleCopy} title="Copy answer">{copied ? <CheckIcon/> : <CopyIcon/>}<span>{copied ? 'Copied' : 'Copy'}</span></button>
                {sourceCount > 0 && <button type="button" className="assistant-action-btn" onClick={() => setShowSources(!showSources)} title="View sources"><SourcesIcon/><span>{showSources ? 'Hide sources' : 'Sources'}</span></button>}
                {sourceCount > 0 && evidenceItems.length > 0 && <button type="button" className="assistant-action-btn" onClick={() => setShowEvidence(!showEvidence)} title="Show evidence">⌕<span>{showEvidence ? 'Hide evidence' : 'Show evidence'}</span></button>}
            </div>}

            {showEvidence && evidenceItems.length > 0 && <div className="sources-inline-panel" style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 650, fontSize: 13, color: '#374151', marginBottom: 8 }}>Evidence for the answer</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {evidenceItems.map((item, index) => <div key={`${index}-${item.statement.slice(0, 20)}`} style={{ border: '1px solid #e5ddd8', borderRadius: 9, padding: 10, background: '#fff' }}>
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: '#403936' }}>{item.statement.length > 360 ? `${item.statement.slice(0, 360)}…` : item.statement}</div>
                        {item.source ? <div style={{ marginTop: 7 }}>
                            <button type="button" onClick={() => openSource(item.source)} style={{ border: 0, background: 'transparent', padding: 0, color: '#7A1F1F', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Show evidence · {cleanSourceTitle(item.source)} →</button>
                            <div style={{ marginTop: 5, padding: 8, borderRadius: 7, background: '#faf7f4', color: '#5a504b', fontSize: 11, lineHeight: 1.55 }}>{sourceText(item.source)}</div>
                        </div> : <div style={{ marginTop: 6, color: '#9a7a6e', fontSize: 11 }}>No sufficiently strong retrieved evidence match for this statement.</div>}
                    </div>)}
                </div>
            </div>}

            {showSources && sourceCount > 0 && <div className="sources-inline-panel"><div style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 8 }}>Sources</div><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{sources.map((source, index) => <div key={source.id || `${source.dataset}-${index}`} className="source-detail" style={{ padding: 10, border: '1px solid #e5ddd8', borderRadius: 9 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><div style={{ fontSize: 12, fontWeight: 650, color: '#403936' }}>{isDocumentSource(source) ? formatCitationSummary(source, index) : <>{`[${index + 1}] ${source.dataset}`}{source.page !== undefined && ` · Page ${source.page}`}{source.vachanaNumber !== undefined && ` · Vachana ${source.vachanaNumber}`}</>}</div><button type="button" onClick={() => openSource(source)} style={{ border: 0, background: '#7A1F1F', color: '#fff', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 10, fontWeight: 700 }}>Open</button></div><div style={{ color: '#4d4541', fontSize: 12, lineHeight: 1.55, marginTop: 6 }}>{source.excerpt}</div></div>)}</div></div>}

            {activeCitation !== null && <CitationPanel source={sources[activeCitation - 1] ?? null} index={activeCitation} onClose={() => setActiveCitation(null)} />}
        </div>
    );
}
