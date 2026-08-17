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
        <div
            style={{
                marginTop: 20,
                padding: 18,
                backgroundColor: 'rgba(248,250,252,0.95)',
                border: '1px solid rgba(122,31,31,0.18)',
                borderRadius: 16,
                boxShadow: '0 8px 20px rgba(0, 0, 0, 0.04)'
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#7A1F1F' }}>Answer</div>
                    <div style={{ marginTop: 8, color: '#334155' }}>
                        Confidence: <strong>{confidence}%</strong> · Retrieved sources: <strong>{sourceCount}</strong>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        onClick={onCopyAnswer}
                        disabled={loading || !answer}
                        style={{
                            padding: '10px 14px',
                            borderRadius: 12,
                            border: '1px solid #e5e7eb',
                            background: '#fff',
                            cursor: loading || !answer ? 'not-allowed' : 'pointer'
                        }}
                    >
                        Copy answer
                    </button>
                    <button
                        type="button"
                        onClick={onCopyReferences}
                        disabled={loading || sourceCount === 0}
                        style={{
                            padding: '10px 14px',
                            borderRadius: 12,
                            border: '1px solid #e5e7eb',
                            background: '#fff',
                            cursor: loading || sourceCount === 0 ? 'not-allowed' : 'pointer'
                        }}
                    >
                        Copy references
                    </button>
                </div>
            </div>

            <div style={{ marginTop: 18, color: '#1f2937' }}>
                {answer ? (
                    <>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
                        {loading && (
                            <span
                                aria-hidden="true"
                                style={{
                                    display: 'inline-block',
                                    marginLeft: 2,
                                    width: 10,
                                    textAlign: 'left',
                                    verticalAlign: 'baseline'
                                }}
                            >
                                <span
                                    style={{
                                        display: 'inline-block',
                                        width: 2,
                                        height: 1.05 * 16,
                                        background: '#7A1F1F',
                                        borderRadius: 1,
                                        transform: 'translateY(3px)',
                                        animation: 'bb_cursor_blink 1s steps(2, end) infinite'
                                    }}
                                />
                                <style>
                                    {`
                                    @keyframes bb_cursor_blink {
                                        0% { opacity: 1; }
                                        50% { opacity: 0; }
                                        100% { opacity: 1; }
                                    }
                                `}
                                </style>
                            </span>
                        )}
                    </>
                ) : loading ? (
                    <div style={{ color: '#6b7280' }}>
                        Preparing response...
                        <span style={{ display: 'inline-block', width: 10, marginLeft: 6, verticalAlign: 'middle' }}>
                            <span
                                style={{
                                    display: 'inline-block',
                                    width: 6,
                                    height: 6,
                                    marginRight: 2,
                                    borderRadius: 99,
                                    background: '#7A1F1F',
                                    animation: 'bb_think_dots 1.2s infinite ease-in-out'
                                }}
                            />
                        </span>
                        <style>
                            {`
                            @keyframes bb_think_dots {
                                0%, 100% { opacity: 0.35; transform: translateY(0); }
                                50% { opacity: 1; transform: translateY(-2px); }
                            }
                        `}
                        </style>
                    </div>
                ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {'No answer yet. Ask a question to retrieve context from your local datasets.'}
                    </ReactMarkdown>
                )}
            </div>
        </div>
    );
}
