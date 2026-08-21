import type { RAGSource } from './rag';

/**
 * Dataset selection snapshot captured when a conversation's messages are
 * created. Allows reopening an old conversation with the same source scope.
 */
export type DatasetSelection =
    | { selectionType: 'all' }
    | { selectionType: 'folders'; folders: string[] }
    | { selectionType: 'files'; files: string[] };

export type ConversationMessageRole = 'user' | 'assistant';

export type AnswerVariant = {
    content: string;
    sources?: RAGSource[];
    confidence?: number;
};

export type ConversationMessage = {
    id: string;
    role: ConversationMessageRole;
    content: string;
    sources?: RAGSource[];
    confidence?: number;
    /** Multiple generated answers for the same assistant turn. */
    variants?: AnswerVariant[];
    /** Zero-based active variant index. Legacy messages omit this field. */
    activeVariant?: number;
};

export type Conversation = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    pinned: boolean;
    messages: ConversationMessage[];
    datasetSelection: DatasetSelection;
};
