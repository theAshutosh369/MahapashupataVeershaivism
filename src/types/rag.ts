export type AnswerMode = 'concise' | 'detailed';

export type RAGDataset = {
    name: string;
    value: string;
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
