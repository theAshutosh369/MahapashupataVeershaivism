import { useEffect, useRef } from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import useRagAssistant from '../hooks/useRagAssistant';
import QueryControls from '../components/ai/QueryControls';
import AnswerPanel from '../components/ai/AnswerPanel';
import ReferencesPanel from '../components/ai/ReferencesPanel';

function AiAgent() {
    const {
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
    } = useRagAssistant();

    const messagesEndRef = useRef<HTMLDivElement>(null);

    function copyText(text: string) {
        if (!text) return;
        navigator.clipboard.writeText(text).catch(() => { });
    }

    function copySources() {
        const formatted = sources
            .map((source, index) => {
                const parts = [`[${index + 1}] ${source.dataset}`];
                if (source.page !== undefined) parts.push(`Page: ${source.page}`);
                if (source.vachanaNumber !== undefined) parts.push(`Vachana: ${source.vachanaNumber}`);
                if (source.author) parts.push(`Author: ${source.author}`);
                return parts.join(' · ');
            })
            .join('\n');
        copyText(formatted);
    }

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatHistory, answer]);

    return (
        <div className="ai-chat-page">
            <Navbar />
            <main className="ai-chat-main">
                <div className="ai-chat-container">
                    {/* Header info */}
                    <div style={{ padding: '16px 0 8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                            <div>
                                <h1 style={{ margin: 0, fontSize: 'var(--font-h2)', color: '#7A1F1F' }}>AI Agent</h1>
                                <p style={{ marginTop: 8, color: '#555', fontSize: 'var(--font-body)' }}>
                                    Ask questions based on local datasets.
                                </p>
                                {datasetLabel && (
                                    <div style={{ marginTop: 6, fontSize: 13, color: '#6b7280' }}>
                                        Context: <strong>{datasetLabel}</strong>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Scrollable messages area */}
                    <div className="ai-chat-messages">
                        {/* Show chat history */}
                        {chatHistory.map((turn, i) => (
                            <div key={i} className={`ai-message ${turn.role}`}>
                                <div style={{ fontWeight: 700, fontSize: 13, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase' }}>
                                    {turn.role === 'user' ? 'You' : 'AI'}
                                </div>
                                <div className="markdown-content" style={{ fontSize: 'var(--font-body)' }}>
                                    {turn.content}
                                </div>
                            </div>
                        ))}

                        {/* Current answer */}
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

                        {/* Error */}
                        {error && (
                            <div style={{ color: '#b91c1c', padding: 12, fontSize: 'var(--font-body)' }}>
                                {error}
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>

                    {/* Query controls (collapsed as settings) */}
                    <details style={{ marginBottom: 8 }}>
                        <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: 13, padding: '4px 0', userSelect: 'none' }}>
                            Advanced settings
                        </summary>
                        <div style={{ padding: '8px 0' }}>
                            <QueryControls
                                datasets={datasets}
                                selectedDataset={selectedDataset}
                                onDatasetChange={setSelectedDataset}
                                topK={topK}
                                onTopKChange={setTopK}
                                answerMode={answerMode}
                                onAnswerModeChange={setAnswerMode}
                                includeConversationMemory={includeConversationMemory}
                                onIncludeConversationMemoryChange={setIncludeConversationMemory}
                                prompt={prompt}
                                onPromptChange={setPrompt}
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

                    {/* Fixed input area */}
                    <div className="ai-chat-input-area">
                        <div className="ai-chat-input-inner">
                            <div className="ai-chat-input-wrap">
                                <textarea
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            if (prompt.trim() && selectedDataset && !loading) ask();
                                        }
                                    }}
                                    placeholder="Ask a question..."
                                    className="ai-chat-textarea"
                                    rows={1}
                                    disabled={loading}
                                />
                                <button
                                    onClick={ask}
                                    disabled={!selectedDataset || !prompt.trim() || loading}
                                    className="ai-chat-send-btn"
                                    aria-label="Send question"
                                >
                                    ➤
                                </button>
                            </div>
                            {status && (
                                <div style={{ color: '#6b7280', fontSize: 13, marginTop: 6, textAlign: 'center' }}>{status}</div>
                            )}
                        </div>
                    </div>
                </div>

                {/* References below chat */}
                {sources.length > 0 && (
                    <div style={{ maxWidth: 980, margin: '0 auto', width: '100%', padding: '0 16px 20px' }}>
                        <ReferencesPanel sources={sources} />
                    </div>
                )}
            </main>
            <Footer />
        </div>
    );
}

export default AiAgent;

