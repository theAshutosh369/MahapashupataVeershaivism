import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RAGLogEntry, RAGSource } from '../../types/rag';
import '../../styles/components/answerPanel.css';
import { isDocumentSource, formatCitationSummary, linkifyCitations } from './formatCitation';
import CitationPanel from './CitationPanel';

const CopyIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>);
const SourcesIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>);
const CheckIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>);
const LogsIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>);

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
    const [showLogs, setShowLogs] = useState(false);
    const [latestLogs, setLatestLogs] = useState<RAGLogEntry[]>([]);
    const [latestAnswer, setLatestAnswer] = useState('');
    const sourceCount = sources.length;

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ answer?: string; logs?: RAGLogEntry[] }>).detail;
            setLatestAnswer(detail?.answer || '');
            setLatestLogs(Array.isArray(detail?.logs) ? detail.logs : []);
        };
        window.addEventListener('rag-query-logs', handler);
        return () => window.removeEventListener('rag-query-logs', handler);
    }, []);

    const hasLogsForThisAnswer = !loading && !!answer && latestAnswer === answer && latestLogs.length > 0;

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
        a: ({ href, children }) => href?.startsWith('#cite-') ? <button type="button" className="citation-link" onClick={() => setActiveCitation(Number(href.slice(6)))} aria-label="View source">{children}</button> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
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
                {sourceCount > 0 && <button type="button" className="assistant-action-btn" onClick={() => setShowSources(!showSources)} title="View sources"><SourcesIcon/><span>{showSources ? 'Hide sources' : 'View sources'}</span></button>}
                {hasLogsForThisAnswer && <button type="button" className="assistant-action-btn" onClick={() => setShowLogs(!showLogs)} title="View application logs"><LogsIcon/><span>{showLogs ? 'Hide logs' : 'Logs'}</span></button>}
            </div>}

            {showLogs && hasLogsForThisAnswer && <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#111827', color: '#e5e7eb' }}>
                <div style={{ padding: '10px 12px', background: '#1f2937', borderBottom: '1px solid #374151', fontWeight: 600, fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                    <span>Application logs for this question</span><span style={{ opacity: .7 }}>{latestLogs.length} entries · IST</span>
                </div>
                <div style={{ maxHeight: 420, overflowY: 'auto', padding: 10, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5, lineHeight: 1.55 }}>
                    {latestLogs.map((log, index) => <div key={`${log.time}-${index}`} style={{ display: 'grid', gridTemplateColumns: '170px 52px 1fr', gap: 8, padding: '3px 0', color: log.level === 'error' ? '#fca5a5' : log.level === 'warn' ? '#fcd34d' : '#d1d5db' }}><span style={{ opacity: .8 }}>{log.time}</span><span style={{ textTransform: 'uppercase' }}>{log.level}</span><span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{log.message}</span></div>)}
                </div>
            </div>}

            {showSources && sourceCount > 0 && <div className="sources-inline-panel"><div style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 8 }}>Retrieved References</div><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{sources.map((source, index) => <details key={source.id} className="source-detail"><summary>{isDocumentSource(source) ? formatCitationSummary(source, index) : <>{`[${index + 1}] ${source.dataset}`}{source.page !== undefined && ` · Page ${source.page}`}{source.vachanaNumber !== undefined && ` · Vachana ${source.vachanaNumber}`}</>}</summary><div className="source-detail-content">{source.excerpt}</div><div className="source-detail-score">Score: {source.score}</div></details>)}</div></div>}

            {activeCitation !== null && <CitationPanel source={sources[activeCitation - 1] ?? null} index={activeCitation} onClose={() => setActiveCitation(null)} />}
        </div>
    );
}
