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
        loading,
        status,
        error,
        ask,
        stop,
        regenerate
    } = useRagAssistant();

    function copyText(text: string) {
        if (!text) return;
        navigator.clipboard.writeText(text).catch(() => {
            // ignore copy failures in the UI
        });
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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
            <Navbar />
            <main style={{ flex: 1, padding: '20px' }}>
                <div
                    className="ai-agent-wrap"
                    style={{
                        maxWidth: 980,
                        margin: '0 auto',
                        padding: '18px',
                        border: '1px solid rgba(0,0,0,0.06)',
                        borderRadius: 16,
                        background: 'linear-gradient(180deg, rgba(122,31,31,0.05), rgba(255,255,255,1) 220px)'
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                        <div>
                            <h1 style={{ margin: 0 }}>AI Agent</h1>
                            <p style={{ marginTop: 8, color: '#555' }}>
                                Ask questions based on local datasets. The assistant retrieves the most relevant chunks and answers using only supplied context.
                            </p>
                            {datasetLabel && (
                                <div style={{ marginTop: 10, fontSize: 13, color: '#6b7280' }}>
                                    Context: <strong>{datasetLabel}</strong>
                                </div>
                            )}
                        </div>
                    </div>

                    <div style={{ height: 14 }} />

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

                    <AnswerPanel
                        answer={answer}
                        sources={sources}
                        confidence={confidence}
                        loading={loading}
                        onCopyAnswer={() => copyText(answer)}
                        onCopyReferences={copySources}
                    />

                    <ReferencesPanel sources={sources} />
                </div>
            </main>
            <Footer />
        </div>
    );
}

export default AiAgent;

