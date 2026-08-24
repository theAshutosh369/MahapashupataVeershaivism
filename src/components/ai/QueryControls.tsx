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
    datasets, selectedDataset, onDatasetChange, topK, onTopKChange,
    answerMode, onAnswerModeChange, includeConversationMemory,
    onIncludeConversationMemoryChange, prompt, onPromptChange,
    onAsk, onStop, onRegenerate, hasGeneration, loading, status, error
}: QueryControlsProps) {
    return (
        <div className="form-grid" style={{ gap: 14 }}>
            <div>
                <label htmlFor="dataset-select" className="form-label">Select Dataset</label>
                <select id="dataset-select" value={selectedDataset}
                    onChange={(event) => onDatasetChange(event.target.value)}
                    disabled={datasets.length === 0 || loading}
                    className="form-input" style={{ maxWidth: 520 }}>
                    <option value="">-- Choose a dataset --</option>
                    {datasets.map((dataset) => (
                        <option key={dataset.value} value={dataset.value}>{dataset.name}</option>
                    ))}
                </select>
            </div>

            <div className="form-grid form-grid-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div>
                    <label htmlFor="top-k" className="form-label">Retrieval size</label>
                    <input id="top-k" type="range" min={3} max={20} value={topK}
                        onChange={(event) => onTopKChange(Number(event.target.value))}
                        disabled={loading} style={{ width: '100%' }} />
                    <div style={{ marginTop: 6, fontSize: 13, color: '#6b7280' }}>{topK}</div>
                </div>
                <div>
                    <label htmlFor="answer-mode" className="form-label">Answer mode</label>
                    <select id="answer-mode" value={answerMode}
                        onChange={(event) => onAnswerModeChange(event.target.value as AnswerMode)}
                        disabled={loading} className="form-input">
                        <option value="concise">Concise</option>
                        <option value="detailed">Detailed</option>
                    </select>
                </div>
            </div>

            <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600, cursor: 'pointer' }}>
                    <input type="checkbox" checked={includeConversationMemory}
                        onChange={(event) => onIncludeConversationMemoryChange(event.target.checked)}
                        disabled={loading} />
                    Use conversation memory
                </label>
                <div style={{ marginTop: 6, fontSize: 13, color: '#6b7280' }}>
                    Uses recent queries to improve relevance.
                </div>
            </div>

            <div>
                <label htmlFor="prompt-input" className="form-label">Your Question</label>
                <textarea id="prompt-input" value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    disabled={loading} placeholder="Enter your question here..."
                    className="form-input" style={{ minHeight: 100, resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={onAsk} disabled={!selectedDataset || !prompt.trim() || loading}
                    className="btn btn-primary" style={{ minWidth: 80 }}>
                    {loading ? 'Thinking…' : 'Ask'}
                </button>
                <button onClick={onStop} disabled={!loading} className="btn">Stop generating</button>
                <button onClick={onRegenerate} disabled={loading || !hasGeneration} className="btn">Regenerate</button>
                {status && <div style={{ color: '#6b7280', fontSize: 14, fontWeight: 500 }}>{status}</div>}
            </div>

            {error && <div style={{ color: '#b91c1c', fontSize: 14, fontWeight: 500 }}>{error}</div>}
        </div>
    );
}

