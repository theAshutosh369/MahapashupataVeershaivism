import type { AnswerMode } from '../../types/rag';
import DatasetTree from './DatasetTree';

type QueryControlsProps = {
    paths: string[];
    selected: ReadonlySet<string>;
    allSelected: boolean;
    onDatasetChange: (selected: Set<string>, allSelected: boolean) => void;
    topK: number;
    onTopKChange: (value: number) => void;
    answerMode: AnswerMode;
    onAnswerModeChange: (value: AnswerMode) => void;
    includeConversationMemory: boolean;
    onIncludeConversationMemoryChange: (value: boolean) => void;
    onAsk: () => void;
    onStop: () => void;
    onRegenerate: () => void;
    hasGeneration: boolean;
    loading: boolean;
    status: string;
    error: string;
};

export default function QueryControls({
    paths,
    selected,
    allSelected,
    onDatasetChange,
    loading,
    error
}: QueryControlsProps) {
    return (
        <div className="form-grid" style={{ gap: 14 }}>
            <div>
                <label htmlFor="dataset-tree" className="form-label">Select Datasets</label>
                <DatasetTree
                    paths={paths}
                    selected={selected}
                    allSelected={allSelected}
                    onChange={onDatasetChange}
                    disabled={loading}
                />
            </div>

            {error && <div style={{ color: '#b91c1c', fontSize: 14, fontWeight: 500 }}>{error}</div>}
        </div>
    );
}
