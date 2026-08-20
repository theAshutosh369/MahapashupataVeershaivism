import { useEffect, useRef, useState } from 'react';
import Navbar from '../components/Navbar';
import '../styles/pages/ai-agent.css';
import useRagAssistant from '../hooks/useRagAssistant';
import QueryControls from '../components/ai/QueryControls';
import AnswerPanel from '../components/ai/AnswerPanel';
import ChatSidebar from '../components/ai/ChatSidebar';
import { formatCitationLines } from '../components/ai/formatCitation';

function AiAgent() {
    const {
        datasetPathList,
        selectedPaths,
        allSelected,
        handleDatasetChange,
        selectedDataset,
        prompt,
        setPrompt,
        answer,
        sources,
        confidence,
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
        conversations,
        activeConversationId,
        newChat,
        selectConversation,
        deleteConversation,
        renameConversation,
        togglePin,
        clearConversations
    } = useRagAssistant();

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [sidebarOpen, setSidebarOpen] = useState(false);

    // Auto-resize textarea as user types
    function autoResizeTextarea() {
        const textarea = inputRef.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 360) + 'px';
    }

    // Conversation search state
    const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
    const [conversationSearch, setConversationSearch] = useState('');
    const [activeMatchIndex, setActiveMatchIndex] = useState(0);
    const messageRefs = useRef<Array<HTMLDivElement | null>>([]);

    const wasNearBottomRef = useRef(true);

    type ConversationMatch = {
        turnIndex: number;
        start: number;
        end: number;
        matchedText: string;
    };

    function copyText(text: string) {
        if (!text) return;
        navigator.clipboard.writeText(text).catch(() => { });
    }

    function copySources() {
        copyText(formatCitationLines(sources));
    }

    // Escape regex special characters for safe searching
    function escapeRegExp(s: string) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const conversationMatches = chatHistory.flatMap((turn, turnIndex) => {
        const content = typeof turn.content === 'string' ? turn.content : String(turn.content ?? '');
        const query = conversationSearch.trim();
        if (!query) return [] as ConversationMatch[];
        const pattern = new RegExp(escapeRegExp(query), 'gi');
        const matches: ConversationMatch[] = [];
        for (const match of content.matchAll(pattern)) {
            const start = match.index ?? 0;
            matches.push({
                turnIndex,
                start,
                end: start + match[0].length,
                matchedText: match[0],
            });
        }
        return matches;
    });

    function renderHighlighted(
        text: string,
        query: string,
        activeRange?: { start: number; end: number }
    ) {
        if (!query) return text;
        try {
            const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
            const segments: Array<string | React.ReactNode> = [];
            let lastIndex = 0;
            let matchCounter = 0;

            for (const match of text.matchAll(regex)) {
                const start = match.index ?? 0;
                const end = start + match[0].length;

                if (start > lastIndex) {
                    segments.push(text.slice(lastIndex, start));
                }

                const isActive = !!activeRange && start === activeRange.start && end === activeRange.end;
                segments.push(
                    <mark
                        key={`${start}-${end}-${matchCounter}`}
                        className={isActive ? 'chat-highlight chat-highlight-active' : 'chat-highlight'}
                    >
                        {match[0]}
                    </mark>
                );

                lastIndex = end;
                matchCounter += 1;
            }

            if (lastIndex < text.length) {
                segments.push(text.slice(lastIndex));
            }

            return segments.length ? segments : text;
        } catch (e) {
            console.log('exception in renderHighlighted', e);
            return text;
        }
    }

    function getSnippet(text: string, query: string, radius = 60, start = -1, end = -1) {
        if (!query) return '';
        const pattern = new RegExp(escapeRegExp(query), 'i');
        const match = pattern.exec(text);
        if (!match) return '';
        const hitStart = start >= 0 ? start : match.index;
        const hitEnd = end >= 0 ? end : hitStart + match[0].length;
        const snippetStart = Math.max(0, hitStart - radius);
        const snippetEnd = Math.min(text.length, hitEnd + radius);
        let snippet = text.slice(snippetStart, snippetEnd).trim();
        if (snippetStart > 0) snippet = '…' + snippet;
        if (snippetEnd < text.length) snippet = snippet + '…';
        return snippet;
    }

    function jumpToMatch(index: number) {
        if (!conversationMatches.length) return;
        const boundedIndex = (index + conversationMatches.length) % conversationMatches.length;
        setActiveMatchIndex(boundedIndex);
        const targetMatch = conversationMatches[boundedIndex];
        const targetMessage = messageRefs.current[targetMatch.turnIndex];
        if (targetMessage) {
            targetMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // useEffect(() => {
    //     if (activeMatchIndex >= conversationMatches.length) {
    //         setActiveMatchIndex(0);
    //     }
    // }, [conversationMatches.length, activeMatchIndex]);


    // Auto-scroll to the newest message when a new message arrives or during streaming.
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        // Only scroll if the user is near the bottom (or there is little content).
        const distanceFromBottom =
            container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom < 160) {
            wasNearBottomRef.current = true;
        }
        if (wasNearBottomRef.current) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [chatHistory, answer]);

    // Never force-scroll while the user scrolls upward.
    function handleScroll() {
        const container = messagesContainerRef.current;
        if (!container) return;
        const distanceFromBottom =
            container.scrollHeight - container.scrollTop - container.clientHeight;
        wasNearBottomRef.current = distanceFromBottom < 160;
    }

    function handleNewChat() {
        newChat();
        setSidebarOpen(false);
        inputRef.current?.focus();
    }

    function handleAsk() {
        ask();
        // Reset textarea to compact state after sending
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = '1.5rem';
        }
    }

    return (
        <div className="ai-chat-page">
            <Navbar />
            <main className="ai-chat-main">
                <div className="ai-chat-layout">
                    <ChatSidebar
                        conversations={conversations}
                        activeConversationId={activeConversationId}
                        mobileOpen={sidebarOpen}
                        onCloseMobile={() => setSidebarOpen(false)}
                        onNewChat={handleNewChat}
                        onSelect={selectConversation}
                        onRename={renameConversation}
                        onTogglePin={togglePin}
                        onDelete={deleteConversation}
                        onClearAll={clearConversations}
                    />

                    <div className="ai-chat-content">
                        {/* Mobile header with hamburger */}
                        <div className="ai-chat-mobile-bar">
                            <button
                                type="button"
                                className="ai-chat-hamburger"
                                onClick={() => setSidebarOpen((v) => !v)}
                                aria-label="Toggle chat history"
                                aria-expanded={sidebarOpen}
                            >
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M3 12h18" />
                                    <path d="M3 6h18" />
                                    <path d="M3 18h18" />
                                </svg>
                            </button>
                            <h1 className="ai-chat-mobile-title">AI Agent</h1>
                        </div>

                        {conversationSearchOpen && (
                            <div className="chat-in-conv-search-wrap">
                                 <div className="chat-in-conv-search">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <circle cx="11" cy="11" r="8" />
                                                <path d="m21 21-4.3-4.3" />
                                            </svg>
                                            <input
                                                type="text"
                                                placeholder="Search phrase in conversations..."
                                                className="chat-in-conv-search-input"
                                                value={conversationSearch}
                                                onChange={(e) => {
                                                    setConversationSearch(e.target.value);
                                                    setActiveMatchIndex(0);
                                                }}
                                            />
                                            {conversationSearch && (
                                                <>
                                                    <span className="chat-match-count">
                                                        {conversationMatches.length > 0 ? `${activeMatchIndex + 1}/${conversationMatches.length}` : '0/0'}
                                                    </span>
                                                    <button type="button" className="chat-in-conv-prev" onClick={() => jumpToMatch(activeMatchIndex - 1)} aria-label="Previous occurrence">◀</button>
                                                    <button type="button" className="chat-in-conv-next" onClick={() => jumpToMatch(activeMatchIndex + 1)} aria-label="Next occurrence">▶</button>
                                                    <button type="button" className="chat-in-conv-clear" onClick={() => { setConversationSearch(''); setActiveMatchIndex(0); }} aria-label="Clear search">✕</button>
                                                </>
                                            )}
                                        </div>
                            </div>
                        )}

                        {/* Scrollable messages area */}
                        <div className="ai-chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
                            <div className="ai-chat-messages-inner">
                                <div className="ai-chat-heading">
                                    <h1>AI Agent</h1>
                                    <p className="ai-chat-subheading">
                                        A scholarly research assistant grounded in the Mahapashupata Veershaivam corpus.
                                    </p>
                                </div>

                                {/* Floating search toggle button at top-right */}
                                <div className={`chat-search-floating ${conversationSearchOpen ? 'chat-search-floating--open' : ''}`}>
                                    <button
                                        type="button"
                                        className="chat-search-floating-btn"
                                        onClick={() => {
                                            const nextState = !conversationSearchOpen;
                                            setConversationSearchOpen(nextState);
                                            if (!nextState) {
                                                setConversationSearch('');
                                                setActiveMatchIndex(0);
                                            }
                                        }}
                                        aria-label="Search in conversations"
                                        aria-pressed={conversationSearchOpen}
                                        title="Search in conversations"
                                    >
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <circle cx="11" cy="11" r="8" />
                                            <path d="m21 21-4.3-4.3" />
                                        </svg>
                                    </button>
                                </div>

                                {chatHistory.map((turn, i) => {
                                    const query = conversationSearch.trim();
                                    const turnMatches = conversationMatches.filter((match) => match.turnIndex === i);
                                    const activeTurnMatch = turnMatches.find((match) => {
                                        const activeMatch = conversationMatches[activeMatchIndex];
                                        return activeMatch && activeMatch.turnIndex === i && activeMatch.start === match.start && activeMatch.end === match.end;
                                    });
                                    const isMatch = Boolean(query && turnMatches.length > 0);
                                    return (
                                        <div
                                            key={i}
                                            ref={(el) => { if (el) messageRefs.current[i] = el; }}
                                            className={`ai-message ${turn.role}`}
                                            style={{
                                                display: 'flex',
                                                justifyContent: turn.role === 'user' ? 'flex-end' : 'flex-start',
                                            }}
                                        >
                                            {turn.role === 'user' ? (
                                                <div className="message-bubble user-message-bubble">
                                                    <div className="message-bubble-label">You</div>
                                                    <div className="message-bubble-text">
                                                        {typeof turn.content === 'string' ? renderHighlighted(turn.content, conversationSearch, activeTurnMatch ? { start: activeTurnMatch.start, end: activeTurnMatch.end } : undefined) : turn.content}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '100%' }}>
                                                    <AnswerPanel
                                                        answer={turn.content}
                                                        sources={turn.sources || []}
                                                        confidence={turn.confidence || 0}
                                                        loading={false}
                                                        onCopyAnswer={() => copyText(turn.content)}
                                                        onCopyReferences={() => copyText(formatCitationLines(turn.sources || []))}
                                                    />
                                                    {isMatch && (
                                                        <div className="chat-match-snippet">
                                                            {renderHighlighted(
                                                                getSnippet(turn.content, conversationSearch, 70, activeTurnMatch?.start ?? -1, activeTurnMatch?.end ?? -1) || turn.content,
                                                                conversationSearch,
                                                                activeTurnMatch ? { start: activeTurnMatch.start, end: activeTurnMatch.end } : undefined
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}

                                {/* Current answer (live streaming — not yet in chatHistory) */}
                                {(answer || loading) && (
                                    <div className="ai-message assistant">
                                        <AnswerPanel
                                            answer={answer}
                                            sources={sources}
                                            confidence={confidence}
                                            loading={loading}
                                            onCopyAnswer={() => copyText(answer)}
                                            onCopyReferences={copySources}
                                        />
                                    </div>
                                )}

                                {error && (
                                    <div style={{ color: '#b91c1c', padding: 12, fontSize: 'var(--font-body)' }}>
                                        {error}
                                    </div>
                                )}

                                <div ref={messagesEndRef} />
                            </div>
                        </div>

                        {/* Fixed bottom composer */}
                        <div className="ai-chat-composer">
                            <div className="ai-chat-composer-inner">
                                <details className="ai-chat-advanced">
                                    <summary>Advanced settings</summary>
                                    <div className="ai-chat-advanced-body">
                                        <QueryControls
                                            paths={datasetPathList}
                                            selected={selectedPaths}
                                            allSelected={allSelected}
                                            onDatasetChange={handleDatasetChange}
                                            topK={topK}
                                            onTopKChange={setTopK}
                                            answerMode={answerMode}
                                            onAnswerModeChange={setAnswerMode}
                                            includeConversationMemory={includeConversationMemory}
                                            onIncludeConversationMemoryChange={setIncludeConversationMemory}
                                            onAsk={ask}
                                            onStop={stop}
                                            onRegenerate={regenerate}
                                            hasGeneration={Boolean(answer && answer.trim()) || sources.length > 0}
                                            loading={loading}
                                            status={status}
                                            error={error}
                                        />
                                    </div>
                                </details>

                                <div className="ai-chat-input-wrap">
                                    <textarea
                                        ref={inputRef}
                                        value={prompt}
                                        onChange={(e) => {
                                            setPrompt(e.target.value);
                                            autoResizeTextarea();
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                if (prompt.trim() && selectedDataset && !loading) handleAsk();
                                            }
                                        }}
                                        placeholder="Ask a question..."
                                        className="ai-chat-textarea"
                                        disabled={loading}
                                    />
                                    {loading ? (
                                        <button
                                            onClick={stop}
                                            className="ai-chat-send-btn ai-chat-stop-btn"
                                            aria-label="Stop generating"
                                        >
                                            ■
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleAsk}
                                            disabled={!selectedDataset || !prompt.trim() || loading}
                                            className="ai-chat-send-btn"
                                            aria-label="Send question"
                                        >
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <path d="M12 19V5" />
                                                <path d="m5 12 7-7 7 7" />
                                            </svg>
                                        </button>
                                    )}
                                </div>

                                {status && (
                                    <div className="ai-chat-status">{status}</div>
                                )}

                                <div className="ai-chat-disclaimer">
                                    AI can make mistakes. Verify important information against the source texts.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}

export default AiAgent;
