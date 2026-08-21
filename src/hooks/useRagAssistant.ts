import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnswerMode, RAGDataset, RAGSource } from '../types/rag';
import type { RAGQueryRequest } from '../types/rag';
import type { Conversation, ConversationMessage, DatasetSelection } from '../types/conversation';
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

export type ChatTurn = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    sources?: RAGSource[];
    confidence?: number;
    variantIndex: number;
    variantCount: number;
};

type AnswerVariant = {
    content: string;
    sources?: RAGSource[];
    confidence?: number;
};

function getAssistantVariants(message: ConversationMessage): AnswerVariant[] {
    if (message.variants?.length) return message.variants;
    return [{ content: message.content, sources: message.sources, confidence: message.confidence }];
}

function toTurn(m: ConversationMessage): ChatTurn {
    if (m.role === 'assistant') {
        const variants = getAssistantVariants(m);
        const rawIndex = typeof m.activeVariant === 'number' ? m.activeVariant : 0;
        const index = Math.min(Math.max(rawIndex, 0), variants.length - 1);
        const variant = variants[index];
        return {
            id: m.id,
            role: m.role,
            content: variant.content,
            sources: variant.sources,
            confidence: variant.confidence,
            variantIndex: index,
            variantCount: variants.length,
        };
    }
    return {
        id: m.id,
        role: m.role,
        content: m.content,
        sources: m.sources,
        confidence: m.confidence,
        variantIndex: 0,
        variantCount: 1,
    };
}

export default function useRagAssistant() {
    const [datasets, setDatasets] = useState<RAGDataset[]>([]);
    const { conversations, activeConversationId } = useSyncExternalStore(subscribe, getSnapshot);
    const activeConversation = useMemo<Conversation | null>(
        () => conversations.find((c) => c.id === activeConversationId) ?? null,
        [conversations, activeConversationId]
    );

    const chatHistory = useMemo<ChatTurn[]>(
        () => (activeConversation?.messages ?? []).map(toTurn),
        [activeConversation]
    );

    const messagesRef = useRef<Conversation['messages']>(activeConversation?.messages ?? []);
    useEffect(() => {
        messagesRef.current = activeConversation?.messages ?? [];
    }, [activeConversation]);

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
    const pendingVariantRef = useRef<{ assistantId: string } | null>(null);

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

    function buildRequest(query: string): RAGQueryRequest {
        return {
            query,
            selectedDataset,
            selectedDatasets: allSelected ? undefined : Array.from(effectiveSelected),
            topK,
            answerMode,
            includeConversationMemory,
            conversationHistory: []
        };
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
                try { controller.abort(); } catch { /* ignore */ }
            }, timeoutMs);
        }

        try {
            await queryRagAssistantStream(fullRequest, {
                signal: controller.signal,
                onToken: (t) => {
                    if (streamIdRef.current !== myStreamId || !t) return;
                    setAnswer((prev) => prev + t);
                },
                onDone: (d) => {
                    if (streamIdRef.current !== myStreamId) return;

                    setSources(d.sources);
                    setConfidence(d.confidence);
                    const pendingVariant = pendingVariantRef.current;
                    let nextMessages: ConversationMessage[];

                    if (pendingVariant) {
                        const target = messagesRef.current.find((m) => m.id === pendingVariant.assistantId && m.role === 'assistant');
                        if (!target) {
                            pendingVariantRef.current = null;
                            return;
                        }
                        const existingVariants = getAssistantVariants(target);
                        const newVariant: AnswerVariant = {
                            content: d.answer,
                            sources: d.sources,
                            confidence: d.confidence,
                        };
                        const variants = [...existingVariants, newVariant];
                        const activeVariant = variants.length - 1;
                        nextMessages = messagesRef.current.map((m) =>
                            m.id === target.id
                                ? {
                                    ...m,
                                    content: newVariant.content,
                                    sources: newVariant.sources,
                                    confidence: newVariant.confidence,
                                    variants,
                                    activeVariant,
                                }
                                : m
                        );
                        pendingVariantRef.current = null;
                    } else {
                        const assistantMsg = makeMessage({
                            role: 'assistant',
                            content: d.answer,
                            sources: d.sources,
                            confidence: d.confidence
                        });
                        nextMessages = [...messagesRef.current, assistantMsg];
                    }

                    messagesRef.current = nextMessages;
                    const conv = getActiveConversation();
                    if (conv) {
                        storeUpdateConversation(conv.id, (c) => ({
                            ...c,
                            messages: nextMessages,
                            updatedAt: Date.now()
                        }));
                    }

                    setAnswer('');
                    setStatus('');
                }
            });

            if (streamIdRef.current === myStreamId) setLoading(false);
        } catch (err) {
            if (streamIdRef.current !== myStreamId) return;
            pendingVariantRef.current = null;
            const msg = err instanceof Error ? err.message : String(err);
            if (controller.signal.aborted || msg.toLowerCase().includes('abort')) {
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
        try { abortControllerRef.current?.abort(); } catch { /* ignore */ }
        setLoading(false);
        setStatus('Stopped.');
    }

    async function regenerate(messageId?: string) {
        if (loading) return;

        const messages = messagesRef.current;
        let assistantIndex = messageId
            ? messages.findIndex((m) => m.id === messageId && m.role === 'assistant')
            : -1;
        if (assistantIndex < 0) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                if (messages[i].role === 'assistant') {
                    assistantIndex = i;
                    break;
                }
            }
        }
        if (assistantIndex < 1) return;

        const userMessage = messages[assistantIndex - 1];
        const assistantMessage = messages[assistantIndex];
        if (userMessage.role !== 'user' || assistantMessage.role !== 'assistant') return;

        pendingVariantRef.current = { assistantId: assistantMessage.id };
        await startStream(buildRequest(userMessage.content));
    }

    async function editUserMessage(messageId: string, newContent: string) {
        if (loading || !newContent.trim()) return;
        const index = messagesRef.current.findIndex((m) => m.id === messageId && m.role === 'user');
        if (index < 0) return;

        const editedUser = { ...messagesRef.current[index], content: newContent };
        const nextMessages = [...messagesRef.current.slice(0, index), editedUser];
        messagesRef.current = nextMessages;

        const conv = getActiveConversation();
        if (conv) {
            storeUpdateConversation(conv.id, (c) => ({
                ...c,
                title: index === 0 ? deriveTitle(newContent.trim()) : c.title,
                messages: nextMessages,
                updatedAt: Date.now()
            }));
        }

        setPrompt('');
        await startStream(buildRequest(newContent));
    }

    function setAnswerVariant(messageId: string, variantIndex: number) {
        const target = messagesRef.current.find((m) => m.id === messageId && m.role === 'assistant');
        if (!target) return;
        const variants = getAssistantVariants(target);
        if (variantIndex < 0 || variantIndex >= variants.length) return;
        const variant = variants[variantIndex];
        const nextMessages = messagesRef.current.map((m) =>
            m.id === messageId
                ? {
                    ...m,
                    content: variant.content,
                    sources: variant.sources,
                    confidence: variant.confidence,
                    variants,
                    activeVariant: variantIndex,
                }
                : m
        );
        messagesRef.current = nextMessages;
        const conv = getActiveConversation();
        if (conv) {
            storeUpdateConversation(conv.id, (c) => ({ ...c, messages: nextMessages, updatedAt: Date.now() }));
        }
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

        const request = buildRequest(rawPrompt);
        const userMsg = makeMessage({ role: 'user', content: rawPrompt });
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

    function newChat() {
        if (loading) return;
        storeSetActiveConversationId(null);
        messagesRef.current = [];
        resetLiveState();
        setPrompt('');
    }

    function selectConversation(id: string) {
        if (loading) return;
        const conv = conversations.find((c) => c.id === id);
        if (!conv) return;
        storeSetActiveConversationId(id);
        messagesRef.current = conv.messages;
        restoreDatasetSelection(conv.datasetSelection);
        resetLiveState();
        setPrompt('');
    }

    function deleteConversation(id: string) {
        storeDeleteConversation(id);
        if (activeConversationId === id) {
            messagesRef.current = [];
            resetLiveState();
        }
    }

    function renameConversation(id: string, title: string) { storeRenameConversation(id, title); }
    function togglePin(id: string) { storeTogglePin(id); }

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
        pendingVariantRef.current = null;
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
        editUserMessage,
        setAnswerVariant,
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
