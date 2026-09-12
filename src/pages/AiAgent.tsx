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

    const wasNearBottomRef = useRef(true);

    function copyText(text: string) {
        if (!text) return;
        navigator.clipboard.writeText(text).catch(() => { });
    }

    function copySources() {
        copyText(formatCitationLines(sources));
    }

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
        // Focus remains on input for follow-ups.
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

                        {/* Scrollable messages area */}
                        <div className="ai-chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
                            <div className="ai-chat-messages-inner">
                                <div className="ai-chat-heading">
                                    <h1>AI Agent</h1>
                                    <p className="ai-chat-subheading">
                                        A scholarly research assistant grounded in the Mahapashupata Veershaivam corpus.
                                    </p>
                                </div>

                                {chatHistory.map((turn, i) => (
                                    <div
                                        key={i}
                                        className={`ai-message ${turn.role}`}
                                        style={{
                                            display: 'flex',
                                            justifyContent: turn.role === 'user' ? 'flex-end' : 'flex-start',
                                        }}
                                    >
                                        {turn.role === 'user' ? (
                                            <div className="message-bubble">
                                                <div className="message-bubble-label">You</div>
                                                {turn.content}
                                            </div>
                                        ) : (
                                            <AnswerPanel
                                                answer={turn.content}
                                                sources={turn.sources || []}
                                                confidence={turn.confidence || 0}
                                                loading={false}
                                                onCopyAnswer={() => copyText(turn.content)}
                                                onCopyReferences={() => copyText(formatCitationLines(turn.sources || []))}
                                            />
                                        )}
                                    </div>
                                ))}

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
                                        onChange={(e) => setPrompt(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                if (prompt.trim() && selectedDataset && !loading) handleAsk();
                                            }
                                        }}
                                        placeholder="Ask a question..."
                                        className="ai-chat-textarea"
                                        rows={1}
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
