export type AnswerMode = 'concise' | 'detailed';

export type RAGDataset = {
    name: string;
    value: string;
};

/**
 * A node in the hierarchical dataset tree. Built from the relative dataset
 * paths returned by the backend (e.g. "authors/akkamahādēvi.json",
 * "datasets/Hariharataratamyam.json", "Veershaiv Granthas/SomeBook.pdf").
 */
export type RAGDatasetNode = {
    /** Unique id within the tree (path for files, path + '/' for folders). */
    id: string;
    /** Display label (file basename or folder name). */
    label: string;
    /** 'root' for the synthetic "All Datasets" node, 'folder' or 'file' otherwise. */
    type: 'root' | 'folder' | 'file';
    /** Absolute dataset path (relative to public/data) for a file node. */
    path?: string;
    /** Child nodes (folders and files). Leave empty for file nodes. */
    children: RAGDatasetNode[];
    /** Number of file leaves under this node (including descendants). */
    fileCount: number;
};

export type RAGSource = {
    id: string;
    dataset: string;
    sourceType?: 'pdf' | 'txt' | 'json';
    filename?: string;
    source?: 'unicode' | 'legacy' | 'ocr';
    page?: number;
    vachanaNumber?: number | string;
    author?: string;
    title?: string;
    language?: string;
    score: number;
    excerpt: string;
};

export type RAGQueryRequest = {
    query: string;
    selectedDataset: string;
    /** Multi-dataset selection (relative dataset paths). Overrides selectedDataset when present. */
    selectedDatasets?: string[];
    topK: number;
    answerMode: AnswerMode;
    includeConversationMemory: boolean;
    conversationHistory: string[];
};

export type RAGQueryResponse = {
    answer: string;
    sources: RAGSource[];
    confidence: number;
    retrievedChunks: Array<{
        id: string;
        dataset: string;
        sourceType?: 'pdf' | 'txt' | 'json';
        filename?: string;
        source?: 'unicode' | 'legacy' | 'ocr';
        page?: number;
        vachanaNumber?: number | string;
        author?: string;
        title?: string;
        language?: string;
        text: string;
    }>;
    prompt: string;
};
