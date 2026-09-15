import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnswerMode, RAGDataset, RAGSource } from '../types/rag';
import type { RAGQueryRequest } from '../types/rag';
import type { Conversation, DatasetSelection } from '../types/conversation';
import { listRagDatasets, queryRagAssistantStream } from '../services/rag/retriever';
import {
    subscribe,
    getSnapshot,
    getActiveConversation,
    createConversation as storeCreateConversation,
    updateConversation as storeUpdateConversation,
    deleteConversation as storeDeleteConversation,
    togglePin as storeTogglePin,
    renameConversation as storeRenameConversation,
    clearAllConversations as storeClearAll,
    setActiveConversationId as storeSetActiveConversationId,
    makeConversation,
    makeMessage,
    buildDatasetSelection,
    deriveTitle
} from '../services/conversationStore';

export type ChatTurn = { role: 'user' | 'assistant'; content: string; sources?: RAGSource[]; confidence?: number };

function toTurn(m: { role: 'user' | 'assistant'; content: string; sources?: RAGSource[]; confidence?: number }): ChatTurn {
    return { role: m.role, content: m.content, sources: m.sources, confidence: m.confidence };
}

export default function useRagAssistant() {
    const [datasets, setDatasets] = useState<RAGDataset[]>([]);

    // ── Source of truth: the module-level store (survives unmount/remount + refresh) ──
    const { conversations, activeConversationId } = useSyncExternalStore(subscribe, getSnapshot);
    const activeConversation = useMemo<Conversation | null>(
        () => conversations.find((c) => c.id === activeConversationId) ?? null,
        [conversations, activeConversationId]
    );

    // Derive the visible chat history from the active conversation's messages.
    const chatHistory = useMemo<ChatTurn[]>(
        () => (activeConversation?.messages ?? []).map(toTurn),
        [activeConversation]
    );

    // Live ref mirroring the active conversation's messages, used inside async
    // streaming callbacks to avoid stale closures.
    const messagesRef = useRef<Conversation['messages']>(activeConversation?.messages ?? []);
    useEffect(() => {
        messagesRef.current = activeConversation?.messages ?? [];
    }, [activeConversation]);

    // ── Dataset selection state (conversation-scoped) ──────────────────────
    const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => {
        const sel = activeConversation?.datasetSelection;
        if (sel?.selectionType === 'folders') return new Set(sel.folders);
        if (sel?.selectionType === 'files') return new Set(sel.files);
        return new Set();
    });
    const [allSelected, setAllSelected] = useState(() => {
        const sel = activeConversation?.datasetSelection;
        return !sel || sel.selectionType === 'all';
    });

    const [prompt, setPrompt] = useState('');
    const [answer, setAnswer] = useState('');
    const [sources, setSources] = useState<RAGSource[]>([]);
    const [confidence, setConfidence] = useState(0);
    const [topK, setTopK] = useState(10);
    const [answerMode, setAnswerMode] = useState<AnswerMode>('detailed');
    const [includeConversationMemory, setIncludeConversationMemory] = useState(true);
    const [loading, setLoading] = useState(false);

    const [status, setStatus] = useState('');
    const [error, setError] = useState('');

    const abortControllerRef = useRef<AbortController | null>(null);
    const lastRequestRef = useRef<RAGQueryRequest | null>(null);
    const streamIdRef = useRef(0);

    // ── Mount: just load datasets. Conversation restoration is handled by the store. ──
    useEffect(() => {
        async function loadDatasets() {
            setStatus('Loading datasets...');
            try {
                const list = await listRagDatasets();
                setDatasets(list);
                setStatus('');
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStatus('Unable to load datasets.');
            }
        }

        void loadDatasets();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The flat list of dataset value paths (excluding the virtual "__ALL__" entry).
    const datasetPathList = useMemo(
        () => datasets.filter((dataset) => dataset.value !== '__ALL__').map((dataset) => dataset.value),
        [datasets]
    );

    const effectiveSelected = useMemo<ReadonlySet<string>>(
        () => (allSelected ? new Set(datasetPathList) : selectedPaths),
        [allSelected, selectedPaths, datasetPathList]
    );

    const selectedDataset = useMemo(() => {
        if (allSelected) return '__ALL__';
        return effectiveSelected.size > 0 ? Array.from(effectiveSelected)[0] : '';
    }, [allSelected, effectiveSelected]);

    const datasetLabel = useMemo(() => {
        if (allSelected) return 'All datasets';
        if (effectiveSelected.size === 0) return 'No datasets selected';
        if (effectiveSelected.size === 1) {
            const only = Array.from(effectiveSelected)[0];
            return datasets.find((dataset) => dataset.value === only)?.name ?? only;
        }
        return `${effectiveSelected.size} datasets selected`;
    }, [datasets, allSelected, effectiveSelected]);

    function handleDatasetChange(selected: Set<string>, nextAll: boolean) {
        setSelectedPaths(selected);
        setAllSelected(nextAll);
    }

    function restoreDatasetSelection(sel: DatasetSelection) {
        if (sel.selectionType === 'all') {
            setAllSelected(true);
            setSelectedPaths(new Set());
        } else if (sel.selectionType === 'folders') {
            setAllSelected(false);
            setSelectedPaths(new Set(sel.folders));
        } else {
            setAllSelected(false);
            setSelectedPaths(new Set(sel.files));
        }
    }

    async function startStream(request: RAGQueryRequest) {
        setLoading(true);
        setError('');
        setStatus('Searching for the most relevant context...');
        setAnswer('');
        setSources([]);

        const conversationHistory = includeConversationMemory
            ? messagesRef.current
                .filter((turn) => turn.role === 'user')
                .map((turn) => turn.content)
                .slice(-5)
            : [];

        const fullRequest: RAGQueryRequest = {
            query: request.query,
            selectedDataset: request.selectedDataset,
            selectedDatasets: request.selectedDatasets,
            topK: request.topK,
            answerMode: request.answerMode,
            includeConversationMemory,
            conversationHistory
        };

        lastRequestRef.current = fullRequest;

        setStatus('Streaming response...');

        const controller = new AbortController();
        abortControllerRef.current = controller;

        const myStreamId = ++streamIdRef.current;

        const rawTimeoutMs = Number(import.meta.env.VITE_RAG_STREAM_TIMEOUT_MS ?? 30000);
        const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 30000;
        if (rawTimeoutMs !== timeoutMs) {
            console.warn('[RAG client] Invalid VITE_RAG_STREAM_TIMEOUT_MS:', import.meta.env.VITE_RAG_STREAM_TIMEOUT_MS, 'using', timeoutMs);
        }

        let timeout: number | undefined;
        if (timeoutMs > 0) {
            timeout = window.setTimeout(() => {
                try {
                    controller.abort();
                } catch {
                    // ignore
                }
            }, timeoutMs);
        }

        try {
            await queryRagAssistantStream(fullRequest, {
                signal: controller.signal,
                onToken: (t) => {
                    if (streamIdRef.current !== myStreamId) return;
                    if (!t) return;
                    setAnswer((prev) => prev + t);
                },
                onDone: (d) => {
                    if (streamIdRef.current !== myStreamId) return;
                    setSources(d.sources);
                    setConfidence(d.confidence);

                    // Append the assistant message to the active conversation and persist.
                    const assistantMsg = makeMessage({
                        role: 'assistant',
                        content: d.answer,
                        sources: d.sources,
                        confidence: d.confidence
                    });
                    const nextMessages = [...messagesRef.current, assistantMsg];
                    messagesRef.current = nextMessages;

                    const conv = getActiveConversation();
                    if (conv) {
                        storeUpdateConversation(conv.id, (c) => ({
                            ...c,
                            messages: nextMessages,
                            updatedAt: Date.now()
                        }));
                    }

                    // Clear live answer state so only chatHistory renders it.
                    setAnswer('');
                    setStatus('');
                }
            });

            if (streamIdRef.current === myStreamId) {
                setLoading(false);
            }
        } catch (err) {
            if (streamIdRef.current !== myStreamId) return;

            const msg = err instanceof Error ? err.message : String(err);

            if (controller.signal.aborted || msg.toLowerCase().includes('abort')) {
                console.info('[RAG client] stream aborted:', msg);
                setError('');
                setStatus('Stopped.');
                setLoading(false);
                return;
            }

            console.error('[RAG client] stream error:', msg, 'aborted:', controller.signal.aborted);
            setError(msg);
            setStatus('');
            setLoading(false);
        } finally {
            if (timeout !== undefined) window.clearTimeout(timeout);
        }
    }

    function stop() {
        try {
            abortControllerRef.current?.abort();
        } catch {
            // ignore
        }
        setLoading(false);
        setStatus('Stopped.');
    }

    async function regenerate() {
        const req = lastRequestRef.current;
        if (!req || loading) return;
        // Remove the last assistant entry together with its preceding user message
        // so the regenerated response replaces it cleanly.
        let nextMessages = [...messagesRef.current];
        const last = nextMessages[nextMessages.length - 1];
        if (last && last.role === 'assistant') {
            nextMessages = nextMessages.slice(0, -2);
        }
        messagesRef.current = nextMessages;

        const conv = getActiveConversation();
        if (conv) {
            storeUpdateConversation(conv.id, (c) => ({ ...c, messages: nextMessages, updatedAt: Date.now() }));
        }

        await startStream(req);
    }

    async function ask() {
        const rawPrompt = prompt;

        if (!rawPrompt.trim()) {
            setError('Please enter a prompt.');
            return;
        }
        if (!selectedDataset) {
            setError('Please select a dataset.');
            return;
        }

        const request: RAGQueryRequest = {
            query: rawPrompt,
            selectedDataset,
            selectedDatasets: allSelected ? undefined : Array.from(effectiveSelected),
            topK,
            answerMode,
            includeConversationMemory,
            conversationHistory: []
        };

        const userMsg = makeMessage({ role: 'user', content: rawPrompt });

        // Create or update the active conversation. The user message is added
        // and persisted BEFORE the backend request starts — it never depends on
        // the streaming response.
        let conv = getActiveConversation();
        if (!conv) {
            const datasetSelection = buildDatasetSelection({ allSelected, selectedPaths: effectiveSelected });
            conv = makeConversation({ title: deriveTitle(prompt.trim()), datasetSelection });
            conv = { ...conv, messages: [userMsg] };
            storeCreateConversation(conv);
            messagesRef.current = [userMsg];
        } else {
            const nextMessages = [...messagesRef.current, userMsg];
            messagesRef.current = nextMessages;
            storeUpdateConversation(conv.id, (c) => ({ ...c, messages: nextMessages, updatedAt: Date.now() }));
        }

        setPrompt('');
        await startStream(request);
    }

    // ── Conversation management API (all backed by the persistent store) ────
    function newChat() {
        if (loading) return;
        // Start a fresh chat: clear the active conversation without persisting
        // an empty placeholder. The conversation is created (and persisted) only
        // when the first message is actually submitted.
        storeSetActiveConversationId(null);
        messagesRef.current = [];
        resetLiveState();
        setPrompt('');
    }

    function selectConversation(id: string) {
        if (loading) return;
        const conv = conversations.find((c) => c.id === id);
        if (!conv) return;
        setActiveConversationIdLocal(id);
        messagesRef.current = conv.messages;
        restoreDatasetSelection(conv.datasetSelection);
        resetLiveState();
        setPrompt('');
    }

    function setActiveConversationIdLocal(id: string) {
        storeSetActiveConversationId(id);
    }

    function deleteConversation(id: string) {
        storeDeleteConversation(id);
        if (activeConversationId === id) {
            messagesRef.current = [];
            resetLiveState();
        }
    }

    function renameConversation(id: string, title: string) {
        storeRenameConversation(id, title);
    }

    function togglePin(id: string) {
        storeTogglePin(id);
    }

    function clearConversations() {
        storeClearAll();
        messagesRef.current = [];
        resetLiveState();
        setPrompt('');
    }

    function resetLiveState() {
        setAnswer('');
        setSources([]);
        setConfidence(0);
        setError('');
        setStatus('');
    }

    return {
        datasets,
        datasetPathList,
        selectedPaths,
        setSelectedPaths,
        allSelected,
        setAllSelected,
        handleDatasetChange,
        selectedDataset,
        prompt,
        setPrompt,
        answer,
        sources,
        confidence,
        datasetLabel,
        topK,
        setTopK,
        answerMode,
        setAnswerMode,
        includeConversationMemory,
        setIncludeConversationMemory,
        chatHistory,
        loading,
        status,
        error,
        ask,
        stop,
        regenerate,
        // Conversation management
        conversations,
        activeConversationId,
        activeConversation,
        newChat,
        selectConversation,
        deleteConversation,
        renameConversation,
        togglePin,
        clearConversations
    };
}
