



import type { AnswerMode, RAGDataset } from '../../types/rag';

type QueryControlsProps = {
    datasets: RAGDataset[];
    selectedDataset: string;
    onDatasetChange: (value: string) => void;
    topK: number;
    onTopKChange: (value: number) => void;
    answerMode: AnswerMode;
    onAnswerModeChange: (value: AnswerMode) => void;
    includeConversationMemory: boolean;
    onIncludeConversationMemoryChange: (value: boolean) => void;
    prompt: string;
    onPromptChange: (value: string) => void;
    onAsk: () => void;

    onStop: () => void;
    onRegenerate: () => void;
    hasGeneration: boolean;

    loading: boolean;
    status: string;
    error: string;
};


export default function QueryControls({
    datasets,
    selectedDataset,
    onDatasetChange,
    topK,
    onTopKChange,
    answerMode,
    onAnswerModeChange,
    includeConversationMemory,
    onIncludeConversationMemoryChange,
    prompt,
    onPromptChange,
    onAsk,
    onStop,
    onRegenerate,
    hasGeneration,
    loading,
    status,
    error
}: QueryControlsProps) {
    return (
        <div className="ai-agent-controls" style={{ display: 'grid', gap: 16 }}>
            <div>
                <label htmlFor="dataset-select" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
                    Select Dataset
                </label>
                <select
                    id="dataset-select"
                    value={selectedDataset}
                    onChange={(event) => onDatasetChange(event.target.value)}
                    disabled={datasets.length === 0 || loading}
                    style={{
                        padding: '10px 12px',
                        fontSize: 14,
                        width: '100%',
                        maxWidth: 520,
                        borderRadius: 12,
                        border: '1px solid #e5e7eb',
                        background: 'white'
                    }}
                >
                    <option value="">-- Choose a dataset --</option>
                    {datasets.map((dataset) => (
                        <option key={dataset.value} value={dataset.value}>
                            {dataset.name}
                        </option>
                    ))}
                </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                    <label htmlFor="top-k" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
                        Retrieval size
                    </label>
                    <input
                        id="top-k"
                        type="range"
                        min={3}
                        max={20}
                        value={topK}
                        onChange={(event) => onTopKChange(Number(event.target.value))}
                        disabled={loading}
                        style={{ width: '100%' }}
                    />
                    <div style={{ marginTop: 6, fontSize: 13, color: '#6b7280' }}>{topK}</div>
                </div>

                <div>
                    <label htmlFor="answer-mode" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
                        Answer mode
                    </label>
                    <select
                        id="answer-mode"
                        value={answerMode}
                        onChange={(event) => onAnswerModeChange(event.target.value as AnswerMode)}
                        disabled={loading}
                        style={{
                            padding: '10px 12px',
                            fontSize: 14,
                            width: '100%',
                            borderRadius: 12,
                            border: '1px solid #e5e7eb',
                            background: 'white'
                        }}
                    >
                        <option value="concise">Concise</option>
                        <option value="detailed">Detailed</option>
                    </select>
                </div>
            </div>

            <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600 }}>
                    <input
                        type="checkbox"
                        checked={includeConversationMemory}
                        onChange={(event) => onIncludeConversationMemoryChange(event.target.checked)}
                        disabled={loading}
                    />
                    Use conversation memory
                </label>
                <div style={{ marginTop: 6, fontSize: 13, color: '#6b7280' }}>
                    Uses recent queries to improve relevance while staying grounded in your local dataset.
                </div>
            </div>

            <div>
                <label htmlFor="prompt-input" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
                    Your Question
                </label>
                <textarea
                    id="prompt-input"
                    value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    disabled={loading}
                    placeholder="Enter your question here..."
                    style={{
                        padding: '12px 12px',
                        fontSize: 14,
                        width: '100%',
                        minHeight: 140,
                        fontFamily: 'monospace',
                        borderRadius: 12,
                        border: '1px solid #e5e7eb',
                        background: 'white'
                    }}
                />
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                    onClick={onAsk}
                    disabled={!selectedDataset || !prompt.trim() || loading}
                    style={{
                        padding: '12px 20px',
                        fontSize: 16,
                        backgroundColor: '#7A1F1F',
                        color: 'white',
                        border: 'none',
                        borderRadius: 12,
                        cursor: loading ? 'not-allowed' : 'pointer',
                        opacity: loading || !selectedDataset || !prompt.trim() ? 0.6 : 1
                    }}
                >
                    {loading ? 'Thinking…' : 'Ask'}
                </button>

                <button
                    onClick={onStop}
                    disabled={!loading}
                    style={{
                        padding: '12px 16px',
                        fontSize: 14,
                        backgroundColor: '#ffffff',
                        color: '#111827',
                        border: '1px solid #e5e7eb',
                        borderRadius: 12,
                        cursor: loading ? 'pointer' : 'not-allowed',
                        opacity: loading ? 1 : 0.6
                    }}
                >
                    Stop generating
                </button>

                <button
                    onClick={onRegenerate}
                    disabled={loading || !hasGeneration}
                    style={{
                        padding: '12px 16px',
                        fontSize: 14,
                        backgroundColor: '#ffffff',
                        color: '#111827',
                        border: '1px solid #e5e7eb',
                        borderRadius: 12,
                        cursor: !loading && hasGeneration ? 'pointer' : 'not-allowed',
                        opacity: !loading && hasGeneration ? 1 : 0.6
                    }}
                >
                    Regenerate
                </button>

                {status && (
                    <div style={{ color: '#6b7280', fontSize: 14, fontWeight: 500 }}>
                        {status}
                    </div>
                )}
                {!status && loading && (
                    <div style={{ color: '#6b7280', fontSize: 14, fontWeight: 500 }}>
                        Working<span style={{ display: 'inline-block', width: 6 }} />…
                    </div>
                )}
            </div>

            {error && (
                <div style={{ color: '#b91c1c', fontSize: 14, fontWeight: 500, marginTop: 10 }}>{error}</div>
            )}
        </div>
    );
}
