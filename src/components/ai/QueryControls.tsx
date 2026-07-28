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
    datasets, selectedDataset, onDatasetChange, loading, error
}: QueryControlsProps) {
    return (
        <div className="form-grid" style={{ gap: 14 }}>
            <div>
                <label htmlFor="dataset-select" className="form-label">Select Dataset</label>
                <select id="dataset-select" value={selectedDataset}
                    onChange={(event) => onDatasetChange(event.target.value)}
                    disabled={datasets.length === 0 || loading}
                    className="form-input" style={{ maxWidth: 520 }}>
                    <option value="">----- Choose dataset(s) -----</option>
                    {datasets.map((dataset) => (
                        <option key={dataset.value} value={dataset.value}> {dataset.value === "__ALL__"
                            ? `${dataset.name} (${datasets.length - 1})`
                            : dataset.name}</option>
                    ))}
                </select>
            </div>


            {error && <div style={{ color: '#b91c1c', fontSize: 14, fontWeight: 500 }}>{error}</div>}
        </div>
    );
}

