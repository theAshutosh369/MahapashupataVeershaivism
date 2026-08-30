import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RAGSource } from '../../types/rag';

type Action = 'ask' | 'translate' | 'explain' | 'similar' | 'references';

type Props = {
    selectedPath: string | null;
    selectedName: string;
    paths: string[];
    onOpenGrantha: (path: string) => void;
};

type ApiResult = {
    answer?: string;
    sources?: RAGSource[];
    confidence?: number;
    error?: string;
};

const LANGUAGES = ['English', 'Hindi', 'Marathi', 'Kannada', 'Sanskrit'];

function sourcePath(source: RAGSource, paths: string[]) {
    const candidates = [source.dataset, source.filename].filter(Boolean).map(String);
    for (const candidate of candidates) {
        const exact = paths.find((path) => path === candidate);
        if (exact) return exact;
        const bySuffix = paths.find((path) => path.endsWith(`/${candidate}`) || path.endsWith(candidate));
        if (bySuffix) return bySuffix;
    }
    return null;
}

function sourceLabel(source: RAGSource) {
    return source.title || source.filename || source.dataset || 'Source';
}

function sourceExcerpt(source: RAGSource) {
    return String(source.excerpt || '').replace(/\s+/g, ' ').trim();
}

export default function TextIntelligence({ selectedPath, selectedName, paths, onOpenGrantha }: Props) {
    const [selectedText, setSelectedText] = useState('');
    const [toolbarPosition, setToolbarPosition] = useState({ top: 0, left: 0 });
    const [action, setAction] = useState<Action | null>(null);
    const [question, setQuestion] = useState('');
    const [language, setLanguage] = useState('English');
    const [loading, setLoading] = useState(false);
    const [answer, setAnswer] = useState('');
    const [sources, setSources] = useState<RAGSource[]>([]);
    const [confidence, setConfidence] = useState<number | null>(null);
    const [error, setError] = useState('');

    const visibleSources = useMemo(() => {
        if (action === 'references' || action === 'similar') {
            return sources.filter((source) => {
                const path = sourcePath(source, paths);
                return !selectedPath || path !== selectedPath;
            });
        }
        return sources;
    }, [action, paths, selectedPath, sources]);

    useEffect(() => {
        const updateSelection = () => {
            const selection = window.getSelection();
            const text = selection?.toString().trim() || '';
            const anchor = selection?.anchorNode;
            const focus = selection?.focusNode;
            const viewer = document.querySelector('.granthas-content-text');
            if (!text || !viewer || !anchor || !focus || !viewer.contains(anchor) || !viewer.contains(focus)) {
                if (!action) setSelectedText('');
                return;
            }
            const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
            if (!range || range.collapsed) {
                if (!action) setSelectedText('');
                return;
            }
            const rect = range.getBoundingClientRect();
            if (!rect.width && !rect.height) return;
            const left = Math.max(12, Math.min(window.innerWidth - 360, rect.left + rect.width / 2 - 170));
            const top = Math.max(12, rect.top - 54);
            setToolbarPosition({ top, left });
            setSelectedText(text);
        };

        document.addEventListener('selectionchange', updateSelection);
        document.addEventListener('mouseup', updateSelection);
        document.addEventListener('touchend', updateSelection);
        window.addEventListener('scroll', updateSelection, true);
        return () => {
            document.removeEventListener('selectionchange', updateSelection);
            document.removeEventListener('mouseup', updateSelection);
            document.removeEventListener('touchend', updateSelection);
            window.removeEventListener('scroll', updateSelection, true);
        };
    }, [action]);

    useEffect(() => {
        setSelectedText('');
        setAction(null);
        setAnswer('');
        setSources([]);
        setError('');
    }, [selectedPath]);

    async function runAction(nextAction: Action, customQuestion = question) {
        if (!selectedText || !selectedPath) return;
        setAction(nextAction);
        setLoading(true);
        setAnswer('');
        setSources([]);
        setConfidence(null);
        setError('');

        let prompt = '';
        let dataset = selectedPath;
        let topK = 8;

        if (nextAction === 'ask') {
            prompt = `Answer the user's question using the selected passage as the primary evidence. If the passage is insufficient, say so clearly.\n\nSelected Grantha: ${selectedName}\nSelected passage:\n${selectedText}\n\nUser question: ${customQuestion.trim()}`;
        } else if (nextAction === 'translate') {
            prompt = `Translate the selected passage into ${language}. Preserve the meaning, terminology, names, Sanskrit/IAST terms, verse structure, and line breaks as closely as possible. Do not summarize or add commentary.\n\nSelected passage:\n${selectedText}`;
        } else if (nextAction === 'explain') {
            prompt = `Explain the selected passage clearly and accurately using the source text as the primary evidence. Explain important philosophical or technical terms, but do not invent claims that are not supported by the passage.\n\nSelected Grantha: ${selectedName}\nSelected passage:\n${selectedText}`;
        } else if (nextAction === 'similar') {
            dataset = '__ALL__';
            topK = 10;
            prompt = `Find passages in the available Granthas that are semantically similar to the selected passage. Prefer passages expressing the same doctrine, concept, argument, definition, or teaching. Return the most relevant matches with their source names and brief explanations. Do not fabricate references.\n\nSelected passage from ${selectedName}:\n${selectedText}`;
        } else {
            dataset = '__ALL__';
            topK = 12;
            prompt = `Find cross-Granthas references related to the selected passage. Search across the available Granthas for passages discussing the same concept, terminology, doctrine, person, practice, or argument. Prefer sources other than the current Grantha and give exact source references where available. Do not fabricate citations.\n\nCurrent Grantha: ${selectedName}\nSelected passage:\n${selectedText}`;
        }

        try {
            const response = await fetch('/api/rag/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: prompt,
                    selectedDataset: dataset,
                    topK,
                    answerMode: nextAction === 'translate' ? 'concise' : 'detailed',
                    includeConversationMemory: false,
                    conversationHistory: []
                })
            });
            const data = await response.json() as ApiResult;
            if (!response.ok || data.error) throw new Error(data.error || 'Unable to process the selected passage.');
            setAnswer(String(data.answer || 'No answer was returned.'));
            setSources(Array.isArray(data.sources) ? data.sources : []);
            setConfidence(typeof data.confidence === 'number' ? data.confidence : null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to process the selected passage.');
        } finally {
            setLoading(false);
        }
    }

    function closePanel() {
        setAction(null);
        setAnswer('');
        setSources([]);
        setError('');
        setSelectedText('');
    }

    if (!selectedText && !action) return null;

    const toolbarStyle: CSSProperties = {
        position: 'fixed',
        top: toolbarPosition.top,
        left: toolbarPosition.left,
        zIndex: 1200,
        display: selectedText ? 'flex' : 'none',
        gap: 5,
        alignItems: 'center',
        padding: 6,
        border: '1px solid #d8cec8',
        borderRadius: 10,
        background: '#fff',
        boxShadow: '0 8px 24px rgba(0,0,0,.18)',
        maxWidth: 'calc(100vw - 24px)',
        overflowX: 'auto'
    };

    const buttonStyle: CSSProperties = {
        border: '1px solid #d8cec8',
        borderRadius: 7,
        background: '#fff',
        color: '#7A1F1F',
        padding: '7px 9px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600
    };

    return <>
        <div className="granthas-text-intelligence-toolbar" style={toolbarStyle} role="toolbar" aria-label="Text intelligence">
            <button type="button" style={buttonStyle} onMouseDown={(event) => event.preventDefault()} onClick={() => { setQuestion(''); setAction('ask'); }}>✦ Ask AI</button>
            <button type="button" style={buttonStyle} onMouseDown={(event) => event.preventDefault()} onClick={() => void runAction('translate')}>⇄ Translate</button>
            <button type="button" style={buttonStyle} onMouseDown={(event) => event.preventDefault()} onClick={() => void runAction('explain')}>☷ Explain</button>
            <button type="button" style={buttonStyle} onMouseDown={(event) => event.preventDefault()} onClick={() => void runAction('similar')}>≈ Similar passages</button>
            <button type="button" style={buttonStyle} onMouseDown={(event) => event.preventDefault()} onClick={() => void runAction('references')}>⌘ Cross-Granthas</button>
        </div>

        {action && <div className="granthas-text-intelligence-overlay" style={{ position: 'fixed', inset: 0, zIndex: 1190, background: 'rgba(30,20,16,.28)' }} onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
            <section role="dialog" aria-modal="true" aria-label="Text intelligence" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(820px, calc(100vw - 28px))', maxHeight: 'min(82vh, 760px)', overflow: 'auto', background: '#fff', borderRadius: 14, border: '1px solid #ded2cb', boxShadow: '0 20px 60px rgba(0,0,0,.25)', padding: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
                    <div><div style={{ color: '#7A1F1F', fontSize: 12, fontWeight: 700 }}>Text intelligence</div><h3 style={{ margin: '4px 0 4px', color: '#3b2520' }}>{nextTitle(action)}</h3><div style={{ color: '#777', fontSize: 12 }}>{selectedName}</div></div>
                    <button type="button" onClick={closePanel} style={{ ...buttonStyle, fontSize: 16, padding: '4px 9px' }} aria-label="Close">×</button>
                </div>
                <div style={{ marginTop: 14, padding: 12, borderRadius: 9, background: '#faf7f4', border: '1px solid #eee4de', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto', fontSize: 13, lineHeight: 1.6 }}>{selectedText}</div>

                {action === 'ask' && <div style={{ marginTop: 12 }}><label style={{ display: 'block', color: '#5f514c', fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Ask about this passage</label><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What do you want to know about this passage?" rows={3} style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid #d8cec8', borderRadius: 8, padding: 10, font: 'inherit' }} /><div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}><button type="button" style={{ ...buttonStyle, background: '#7A1F1F', color: '#fff' }} disabled={loading || !question.trim()} onClick={() => void runAction('ask')}>{loading ? 'Asking…' : 'Ask AI'}</button></div></div>}
                {action === 'translate' && <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><label style={{ fontSize: 12, color: '#5f514c' }}>Translate to</label><select value={language} onChange={(event) => setLanguage(event.target.value)} style={{ border: '1px solid #d8cec8', borderRadius: 7, padding: '6px 9px' }}>{LANGUAGES.map((item) => <option key={item}>{item}</option>)}</select><button type="button" style={{ ...buttonStyle, background: '#7A1F1F', color: '#fff' }} disabled={loading} onClick={() => void runAction('translate')}>{loading ? 'Translating…' : 'Translate'}</button></div>}
                {loading && <div style={{ marginTop: 16, color: '#7A1F1F', fontSize: 13 }}>Working with the selected passage…</div>}
                {error && <div style={{ marginTop: 16, padding: 10, borderRadius: 8, background: '#fff0f0', color: '#a32020', border: '1px solid #edcaca', fontSize: 13 }}>{error}</div>}
                {!loading && answer && <div style={{ marginTop: 16 }}><div style={{ color: '#7A1F1F', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{action === 'references' ? 'Cross-Granthas references' : action === 'similar' ? 'Similar passages' : 'Result'}</div><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 14 }}>{answer}</div>{confidence !== null && <div style={{ marginTop: 10, color: '#777', fontSize: 11 }}>Grounding confidence: {confidence}%</div>}</div>}
                {!loading && visibleSources.length > 0 && <div style={{ marginTop: 18 }}><div style={{ color: '#7A1F1F', fontWeight: 700, fontSize: 13, marginBottom: 7 }}>{action === 'references' ? 'Source references' : 'Sources'}</div>{visibleSources.map((source, index) => { const path = sourcePath(source, paths); return <button type="button" key={`${source.id || source.dataset}-${index}`} onClick={() => path && onOpenGrantha(path)} disabled={!path} style={{ display: 'block', width: '100%', textAlign: 'left', border: '1px solid #e5dcd7', borderRadius: 8, background: '#fff', padding: 10, marginBottom: 7, cursor: path ? 'pointer' : 'default' }}><div style={{ color: '#7A1F1F', fontWeight: 650, fontSize: 12 }}>{sourceLabel(source)}</div><div style={{ color: '#777', fontSize: 11, marginTop: 2 }}>{source.dataset}{source.page ? ` · page ${source.page}` : ''}</div>{sourceExcerpt(source) && <div style={{ color: '#4d4541', fontSize: 12, lineHeight: 1.5, marginTop: 5 }}>{sourceExcerpt(source)}</div>}</button>; })}</div>}
            </section>
        </div>}
    </>;
}

function nextTitle(action: Action) {
    if (action === 'ask') return 'Ask AI';
    if (action === 'translate') return 'Translate selection';
    if (action === 'explain') return 'Explain selection';
    if (action === 'similar') return 'Find similar passages';
    return 'Cross-Granthas references';
}
