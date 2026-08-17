export type EmbeddingModelName = 'bge-small-en-v1.5' | 'nomic-embed-text' | 'all-MiniLM-L6-v2';

export interface VectorConfig {
    model: EmbeddingModelName;
    useLocalModel: boolean;
}
