import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RAGSource } from '../../types/rag';

type AnswerPanelProps = {
    answer: string;
    sources: RAGSource[];
    confidence: number;
    loading: boolean;
    onCopyAnswer: () => void;
    onCopyReferences: () => void;
};

export default function AnswerPanel({ answer, sources, confidence, loading, onCopyAnswer, onCopyReferences }: AnswerPanelProps) {
    const sourceCount = sources.length;

    return (
        <div style={{
            padding: 'clamp(12px, 2vw, 18px)',
            backgroundColor: 'rgba(248,250,252,0.95)',
            border: '1px solid rgba(122,31,31,0.18)',
            borderRadius: 16
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div>
                    <div style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 800, color: '#7A1F1F' }}>Answer</div>
                    <div style={{ marginTop: 6, color: '#334155', fontSize: 'var(--font-body)' }}>
                        Confidence: <strong>{confidence}%</strong> · Sources: <strong>{sourceCount}</strong>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" onClick={onCopyAnswer} disabled={loading || !answer} className="btn" style={{ fontSize: 13, padding: '8px 12px' }}>
                        Copy answer
                    </button>
                    <button type="button" onClick={onCopyReferences} disabled={loading || sourceCount === 0} className="btn" style={{ fontSize: 13, padding: '8px 12px' }}>
                        Copy references
                    </button>
                </div>
            </div>

            <div className="markdown-content" style={{ marginTop: 14, color: '#1f2937', fontSize: 'var(--font-body)' }}>
                {answer ? (
                    <>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
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
        </div>
    );
}

