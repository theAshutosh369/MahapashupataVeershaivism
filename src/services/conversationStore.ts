import type { Conversation, ConversationMessage, DatasetSelection } from '../types/conversation';

const STORAGE_KEY = 'mahapashupata_ai_conversations';
const ACTIVE_KEY = 'mahapashupata_ai_active_chat';

// ── Types ─────────────────────────────────────────────────────────────────

type StoreState = {
    conversations: Conversation[];
    activeConversationId: string | null;
};

// ── Pure helpers (id / title / message factory) ──────────────────────────

export function createConversationId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMessageId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate a short, human-friendly chat title from the first user question.
 * Kept client-side — no LLM call is made for titles. Truncated to ~8 words.
 */
export function deriveTitle(question: string): string {
    const cleaned = question
        .replace(/\s+/g, ' ')
        .replace(/^(who|what|when|where|why|how|which|explain|explain about|tell me about|tell me|describe|what is|what are|who is|who was|what was|what are|who is an|what are the)\s+/i, '')
        .replace(/^[\s:;,.!?\-–—]+/, '')
        .trim();

    const words = cleaned.split(' ').filter(Boolean);
    const short = words.slice(0, 8).join(' ');
    const title = short.charAt(0).toUpperCase() + short.slice(1);
    return title.trim() || 'New conversation';
}

export function makeConversation(opts: {
    id?: string;
    title?: string;
    datasetSelection: DatasetSelection;
}): Conversation {
    const now = Date.now();
    const id = opts.id && opts.id.trim() ? opts.id : createConversationId();
    return {
        id,
        title: opts.title?.trim() || 'New conversation',
        createdAt: now,
        updatedAt: now,
        pinned: false,
        messages: [],
        datasetSelection: opts.datasetSelection,
    };
}

export function makeMessage(msg: {
    role: 'user' | 'assistant';
    content: string;
    sources?: ConversationMessage['sources'];
    confidence?: number;
}): ConversationMessage {
    return {
        id: createMessageId(),
        role: msg.role,
        content: msg.content,
        sources: msg.sources,
        confidence: msg.confidence,
    };
}

export function buildDatasetSelection(opts: {
    allSelected: boolean;
    selectedPaths: ReadonlySet<string> | string[];
}): DatasetSelection {
    if (opts.allSelected) return { selectionType: 'all' };
    const paths = Array.from(opts.selectedPaths as Iterable<string>);
    if (paths.length === 0) return { selectionType: 'all' };
    const allFiles = paths.every((p) => !p.includes('/'));
    return allFiles
        ? { selectionType: 'files', files: paths }
        : { selectionType: 'folders', folders: paths };
}

// ── Storage read/write (migrates any legacy format) ──────────────────────

function loadConversationsFromStorage(): Conversation[] {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed;
    } catch {
        try {
            window.localStorage.removeItem(STORAGE_KEY);
        } catch {
            // ignore
        }
        return [];
    }
}

function loadActiveIdFromStorage(conversations: Conversation[]): string | null {
    try {
        const raw = window.localStorage.getItem(ACTIVE_KEY);
        if (!raw || !raw.trim()) return null;
        // Only trust the stored id if it still exists in the conversation list.
        return conversations.some((c) => c.id === raw) ? raw : null;
    } catch {
        return null;
    }
}

// ── Module-level singleton store ──────────────────────────────────────────
// This lives outside React so it survives component unmount/remount (route
// navigation) while localStorage makes it survive a full browser refresh.

let state: StoreState = (() => {
    const conversations = loadConversationsFromStorage();
    const activeConversationId = loadActiveIdFromStorage(conversations);
    return { conversations, activeConversationId };
})();

const listeners = new Set<() => void>();

function commit(next: StoreState) {
    state = next;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next.conversations));
    } catch {
        // storage full/unavailable — ignore
    }
    try {
        if (next.activeConversationId) {
            window.localStorage.setItem(ACTIVE_KEY, next.activeConversationId);
        } else {
            window.localStorage.removeItem(ACTIVE_KEY);
        }
    } catch {
        // ignore
    }
    listeners.forEach((l) => l());
}

// ── Subscription API (for useSyncExternalStore) ──────────────────────────

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getSnapshot(): StoreState {
    return state;
}

// ── Read helpers ──────────────────────────────────────────────────────────

export function getConversations(): Conversation[] {
    return state.conversations;
}

export function getActiveConversationId(): string | null {
    return state.activeConversationId;
}

export function getActiveConversation(): Conversation | null {
    return (
        state.conversations.find((c) => c.id === state.activeConversationId) ??
        null
    );
}

export function getConversationById(id: string): Conversation | null {
    return state.conversations.find((c) => c.id === id) ?? null;
}

// ── Mutations (each writes to localStorage and notifies subscribers) ──────

export function setActiveConversationId(id: string | null): void {
    commit({ ...state, activeConversationId: id });
}

export function createConversation(conversation: Conversation): void {
    commit({
        conversations: [conversation, ...state.conversations],
        activeConversationId: conversation.id,
    });
}

export function updateConversation(
    id: string,
    updater: (conversation: Conversation) => Conversation
): void {
    commit({
        ...state,
        conversations: state.conversations.map((c) =>
            c.id === id ? updater(c) : c
        ),
    });
}

export function deleteConversation(id: string): void {
    const conversations = state.conversations.filter((c) => c.id !== id);
    let activeConversationId = state.activeConversationId;
    if (activeConversationId === id) {
        const mostRecent = conversations.reduce<Conversation | null>(
            (best, c) => (!best || c.updatedAt > best.updatedAt ? c : best),
            null
        );
        activeConversationId = mostRecent ? mostRecent.id : null;
    }
    commit({ conversations, activeConversationId });
}

export function togglePin(id: string): void {
    updateConversation(id, (c) => ({ ...c, pinned: !c.pinned }));
}

export function renameConversation(id: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    updateConversation(id, (c) => ({ ...c, title: trimmed }));
}

export function clearAllConversations(): void {
    commit({ conversations: [], activeConversationId: null });
}

// Backward-compatible named helpers that operate on the store.
export function loadConversations(): Conversation[] {
    return state.conversations;
}

export function saveConversations(conversations: Conversation[]): void {
    commit({ ...state, conversations });
}

export function findConversation(
    conversations: Conversation[],
    id: string | null
): Conversation | null {
    if (!id) return null;
    return conversations.find((c) => c.id === id) ?? null;
}

export function upsertConversation(
    conversations: Conversation[],
    conversation: Conversation
): Conversation[] {
    const idx = conversations.findIndex((c) => c.id === conversation.id);
    if (idx === -1) return [conversation, ...conversations];
    const next = [...conversations];
    next[idx] = conversation;
    return next;
}

export function deleteConversationById(
    conversations: Conversation[],
    id: string
): Conversation[] {
    return conversations.filter((c) => c.id !== id);
}
