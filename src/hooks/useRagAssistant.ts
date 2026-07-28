import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnswerMode, RAGDataset, RAGSource } from '../types/rag';
import type { RAGQueryRequest } from '../types/rag';
import { listRagDatasets, queryRagAssistantStream } from '../services/rag/retriever';

export type ChatTurn = { role: 'user' | 'assistant'; content: string; sources?: RAGSource[]; confidence?: number };

export default function useRagAssistant() {
    const [datasets, setDatasets] = useState<RAGDataset[]>([]);
    const [selectedDataset, setSelectedDataset] = useState<string>('__ALL__');
    const [prompt, setPrompt] = useState('');
    const [answer, setAnswer] = useState('');
    const [sources, setSources] = useState<RAGSource[]>([]);
    const [confidence, setConfidence] = useState(0);
    const [topK, setTopK] = useState(10);
    const [answerMode, setAnswerMode] = useState<AnswerMode>('detailed');
    const [includeConversationMemory, setIncludeConversationMemory] = useState(true);
    const [chatHistory, setChatHistory] = useState<ChatTurn[]>([]);
    const [loading, setLoading] = useState(false);

    const [status, setStatus] = useState('');
    const [error, setError] = useState('');

    const abortControllerRef = useRef<AbortController | null>(null);
    const lastRequestRef = useRef<RAGQueryRequest | null>(null);
    const streamIdRef = useRef(0);

    useEffect(() => {
        async function loadDatasets() {
            setStatus('Loading datasets...');
            try {
                const list = await listRagDatasets();
                setDatasets(list);
                setSelectedDataset(list.length ? list[0].value : '__ALL__');
                setStatus('');
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStatus('Unable to load datasets.');
            }
        }

        loadDatasets();
    }, []);

    const datasetLabel = useMemo(() => {
        if (!selectedDataset) return '';
        if (selectedDataset === '__ALL__') return 'All datasets';
        return datasets.find((dataset) => dataset.value === selectedDataset)?.name ?? selectedDataset;
    }, [datasets, selectedDataset]);

    async function startStream(request: RAGQueryRequest) {
        setLoading(true);
        setError('');
        setStatus('Searching for the most relevant context...');
        setAnswer('');
        setSources([]);

        const conversationHistory = includeConversationMemory
            ? chatHistory
                .filter((turn) => turn.role === 'user')
                .map((turn) => turn.content)
                .slice(-5)
            : [];

        const fullRequest: RAGQueryRequest = {
            query: request.query,
            selectedDataset: request.selectedDataset,
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
        console.log('[RAG client] startStream: timeoutMs=', timeoutMs, 'signal.aborted=', controller.signal.aborted);

        let timeout: number | undefined;
        if (timeoutMs > 0) {
            timeout = window.setTimeout(() => {
                console.warn('[RAG client] stream timeout fired -> aborting');
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
                    if (answer.length === 0) console.log('[RAG client] first token received');
                    setAnswer((prev) => prev + t);
                },
                onDone: (d) => {
                    if (streamIdRef.current !== myStreamId) return;
                    console.log('[RAG client] done received:', {
                        answerLen: d?.answer?.length ?? 0,
                        sourcesCount: d?.sources?.length ?? 0,
                        confidence: d?.confidence
                    });
                    setSources(d.sources);
                    setConfidence(d.confidence);

                    // Push assistant response with metadata into history (user message was added in ask())
                    setChatHistory((prev) => [
                        ...prev,
                        { role: 'assistant' as const, content: d.answer, sources: d.sources, confidence: d.confidence }
                    ].slice(-12));

                    // Clear live answer state so only chatHistory renders it
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
        // Remove the last assistant entry so the regenerated response replaces it cleanly
        setChatHistory((prev) => {
            if (prev.length === 0) return prev;
            // If last entry is assistant, remove it together with its preceding user message
            const last = prev[prev.length - 1];
            if (last.role === 'assistant') {
                // Remove both the user query and the assistant response
                return prev.slice(0, -2);
            }
            return prev;
        });
        await startStream(req);
    }

    async function ask() {
        if (!prompt.trim()) {
            setError('Please enter a prompt.');
            return;
        }
        if (!selectedDataset) {
            setError('Please select a dataset.');
            return;
        }

        const request: RAGQueryRequest = {
            query: prompt,
            selectedDataset,
            topK,
            answerMode,
            includeConversationMemory,
            conversationHistory: []
        };

        // Add user message to chat history immediately
        setChatHistory((prev) => [...prev, { role: 'user', content: prompt.trim() }]);
        setPrompt('');

        await startStream(request);
    }

    return {
        datasets,
        selectedDataset,
        setSelectedDataset,
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
        regenerate
    };
}
