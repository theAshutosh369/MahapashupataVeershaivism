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
    retrievedChunks?: Array<{
        id: string;
        dataset: string;
        sourceType?: 'pdf' | 'txt' | 'json';
        filename?: string;
        page?: number;
        author?: string;
        title?: string;
        language?: string;
        text: string;
    }>;
};

type TocEntry = {
    id: string;
    title: string;
    level: 1 | 2 | 3;
    offset: number;
};

type ConceptResult = {
    id: string;
    dataset: string;
    filename?: string;
    page?: number;
    title?: string;
    author?: string;
    language?: string;
    text: string;
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

function cleanHeading(value: string) {
    return value.replace(/^\s+|\s+$/g, '').replace(/[\u200B\uFEFF]/g, '');
}

function detectToc(text: string): TocEntry[] {
    if (!text.trim()) return [];

    const entries: TocEntry[] = [];
    const lines = text.split(/\r?\n/);
    let offset = 0;

    const chapterPattern = /^(?:chapter|adhyaya|adhyāya|adhyāyaḥ|kāṇḍa|kanda|sarga|sargaḥ|book|part)\b/i;
    const sectionPattern = /^(?:section|prakaraṇa|prakarana|prakaraṇam|khaṇḍa|khanda)\b/i;
    const versePattern = /^(?:(?:verse|śloka|shloka|sloka|ślokaḥ|shlokaḥ)\s*(?:no\.?\s*)?\d+|\d+[.)]\s+(?:śloka|shloka|verse)\b)/i;
    const sanskritChapterPattern = /^(?:अध्याय(?:ः|म्)?|सर्ग(?:ः|म्)?|काण्ड(?:ः|म्)?|खण्ड(?:ः|म्)?|प्रकरण(?:म्|ः)?)/;
    const sanskritVersePattern = /^(?:श्लोक(?:ः|म्)?\s*\d+|\d+[.)]\s*श्लोक)/;
    const numberedHeadingPattern = /^\d+(?:\.\d+){0,2}[.)]?\s+[A-ZĀĪŪṚṜḶḹŚṢṬḌḤĪŌ][^.!?]{2,120}$/;

    for (const rawLine of lines) {
        const line = cleanHeading(rawLine);
        const lower = line.toLowerCase();
        let level: 1 | 2 | 3 | null = null;

        if (chapterPattern.test(line) || sanskritChapterPattern.test(line)) {
            level = 1;
        } else if (sectionPattern.test(line)) {
            level = 2;
        } else if (versePattern.test(line) || sanskritVersePattern.test(line)) {
            level = 3;
        } else if (numberedHeadingPattern.test(line) && !/^(?:19|20)\d{2}\b/.test(line)) {
            level = /^(?:\d+\.){2}/.test(line) ? 3 : /^(?:\d+\.)/.test(line) ? 2 : 1;
        } else if (line.length >= 4 && line.length <= 110 && /^(?:[A-ZĀĪŪṚṜḶḹŚṢṬḌḤ][A-ZĀĪŪṚṜḶḹŚṢṬḌḤ\s,:;()'’'\-–—0-9]+)$/.test(line) && !lower.includes('page')) {
            level = 2;
        }

        if (level !== null && line.length > 1) {
            entries.push({ id: `toc-${entries.length}`, title: line, level, offset });
        }

        offset += rawLine.length + 1;
    }

    // Avoid turning noisy OCR into an enormous navigation tree.
    if (entries.length > 500) {
        return entries.filter((entry) => entry.level < 3).slice(0, 250);
    }
    return entries;
}

function scrollViewerToOffset(offset: number) {
    const viewer = document.querySelector('.granthas-content-viewer') as HTMLElement | null;
    const content = viewer?.querySelector('.granthas-content-text') as HTMLElement | null;
    if (!viewer || !content) return;

    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const end = consumed + text.length;
        if (offset <= end) {
            const range = document.createRange();
            range.setStart(node, Math.max(0, Math.min(text.length, offset - consumed)));
            range.collapse(true);
            const rect = range.getBoundingClientRect();
            const viewerRect = viewer.getBoundingClientRect();
            if (rect.height || rect.top) viewer.scrollTop += rect.top - viewerRect.top - 28;
            return;
        }
        consumed = end;
    }
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

    const [tocOpen, setTocOpen] = useState(false);
    const [tocSearch, setTocSearch] = useState('');
    const [tocEntries, setTocEntries] = useState<TocEntry[]>([]);
    const [conceptOpen, setConceptOpen] = useState(false);
    const [conceptQuery, setConceptQuery] = useState('');
    const [conceptLoading, setConceptLoading] = useState(false);
    const [conceptError, setConceptError] = useState('');
    const [conceptResults, setConceptResults] = useState<ConceptResult[]>([]);

    const visibleSources = useMemo(() => {
        if (action === 'references' || action === 'similar') {
            return sources.filter((source) => {
                const path = sourcePath(source, paths);
                return !selectedPath || path !== selectedPath;
            });
        }
        return sources;
    }, [action, paths, selectedPath, sources]);

    const visibleTocEntries = useMemo(() => {
        const query = tocSearch.trim().toLowerCase();
        if (!query) return tocEntries;
        return tocEntries.filter((entry) => entry.title.toLowerCase().includes(query));
    }, [tocEntries, tocSearch]);

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
        setTocOpen(false);
        setTocSearch('');
        setTocEntries([]);
        setConceptOpen(false);
        setConceptQuery('');
        setConceptError('');
        setConceptResults([]);
    }, [selectedPath]);

    useEffect(() => {
        if (!selectedPath) return;
        const viewer = document.querySelector('.granthas-content-viewer');
        if (!viewer) return;

        const rebuild = () => {
            const text = viewer.querySelector('.granthas-content-text')?.textContent || '';
            setTocEntries(detectToc(text));
        };
        rebuild();
        const observer = new MutationObserver(rebuild);
        observer.observe(viewer, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
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

    async function runConceptSearch() {
        const query = conceptQuery.trim();
        if (!query) {
            setConceptResults([]);
            setConceptError('Enter a concept or research question.');
            return;
        }

        setConceptLoading(true);
        setConceptError('');
        setConceptResults([]);
        try {
            const response = await fetch('/api/rag/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    selectedDataset: '__ALL__',
                    topK: 15,
                    answerMode: 'concise',
                    includeConversationMemory: false,
                    conversationHistory: []
                })
            });
            const data = await response.json() as ApiResult;
            if (!response.ok || data.error) throw new Error(data.error || 'Concept search failed.');

            const chunks = Array.isArray(data.retrievedChunks) ? data.retrievedChunks : [];
            const unique = new Set<string>();
            const results: ConceptResult[] = [];
            for (const chunk of chunks) {
                const key = `${chunk.dataset}|${chunk.id}`;
                if (unique.has(key) || !chunk.text?.trim()) continue;
                unique.add(key);
                results.push({
                    id: chunk.id,
                    dataset: chunk.dataset,
                    filename: chunk.filename,
                    page: chunk.page,
                    title: chunk.title,
                    author: chunk.author,
                    language: chunk.language,
                    text: chunk.text
                });
            }
            setConceptResults(results);
            if (!results.length) setConceptError('No conceptually related passages were found in the available Granthas.');
        } catch (err) {
            setConceptError(err instanceof Error ? err.message : 'Concept search failed.');
        } finally {
            setConceptLoading(false);
        }
    }

    function closePanel() {
        setAction(null);
        setAnswer('');
        setSources([]);
        setError('');
        setSelectedText('');
    }

    const utilityButtonStyle: CSSProperties = {
        border: '1px solid #d8cec8',
        borderRadius: 7,
        background: '#fff',
        color: '#7A1F1F',
        padding: '7px 10px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 650,
        boxShadow: '0 3px 12px rgba(0,0,0,.08)'
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

    if (!selectedPath && !selectedText && !action) return null;

    return <>
        {selectedPath && <div className="granthas-reading-utilities" style={{ position: 'fixed', right: 18, top: 82, zIndex: 1100, display: 'flex', gap: 6, flexDirection: 'column', alignItems: 'stretch' }}>
            <button type="button" style={utilityButtonStyle} onClick={() => { setTocOpen((value) => !value); setConceptOpen(false); }}>☷ Contents{tocEntries.length ? ` (${tocEntries.length})` : ''}</button>
            <button type="button" style={utilityButtonStyle} onClick={() => { setConceptOpen((value) => !value); setTocOpen(false); }}>⌕ Concept search</button>
        </div>}

        {tocOpen && <div style={{ position: 'fixed', top: 120, right: 18, zIndex: 1090, width: 'min(390px, calc(100vw - 36px))', maxHeight: 'calc(100vh - 150px)', overflow: 'hidden', background: '#fff', border: '1px solid #d8cec8', borderRadius: 12, boxShadow: '0 16px 45px rgba(0,0,0,.20)' }}>
            <div style={{ padding: 13, borderBottom: '1px solid #eee5df' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div><strong style={{ color: '#7A1F1F', fontSize: 14 }}>Contents</strong><div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>{tocEntries.length ? `${tocEntries.length} detected sections` : 'No headings detected'}</div></div>
                    <button type="button" style={{ ...buttonStyle, padding: '4px 8px', fontSize: 15 }} onClick={() => setTocOpen(false)} aria-label="Close contents">×</button>
                </div>
                <input type="search" value={tocSearch} onChange={(event) => setTocSearch(event.target.value)} placeholder="Filter contents…" style={{ width: '100%', boxSizing: 'border-box', marginTop: 9, border: '1px solid #d8cec8', borderRadius: 7, padding: '8px 9px', outline: 'none', font: 'inherit' }} />
            </div>
            <div style={{ maxHeight: 'calc(100vh - 270px)', overflow: 'auto', padding: 6 }}>
                {visibleTocEntries.length ? visibleTocEntries.map((entry) => <button key={entry.id} type="button" onClick={() => { scrollViewerToOffset(entry.offset); setTocOpen(false); }} style={{ display: 'block', width: '100%', border: 0, borderRadius: 7, background: 'transparent', color: '#403936', textAlign: 'left', cursor: 'pointer', padding: `7px 8px 7px ${8 + (entry.level - 1) * 18}px`, font: 'inherit', fontSize: entry.level === 1 ? 13 : 12, fontWeight: entry.level === 1 ? 700 : entry.level === 2 ? 600 : 450 }}>{entry.title}</button>) : <div style={{ padding: 14, color: '#777', fontSize: 12 }}>{tocEntries.length ? 'No contents entries match the filter.' : 'This Grantha does not contain recognizable chapter, section, or verse headings.'}</div>}
            </div>
        </div>}

        {conceptOpen && <div style={{ position: 'fixed', top: 120, right: 18, zIndex: 1090, width: 'min(650px, calc(100vw - 36px))', maxHeight: 'calc(100vh - 150px)', overflow: 'hidden', background: '#fff', border: '1px solid #d8cec8', borderRadius: 12, boxShadow: '0 16px 45px rgba(0,0,0,.20)' }}>
            <div style={{ padding: 14, borderBottom: '1px solid #eee5df' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div><strong style={{ color: '#7A1F1F', fontSize: 14 }}>Concept search</strong><div style={{ color: '#777', fontSize: 11, marginTop: 2 }}>Find passages related by meaning, doctrine, argument, or concept.</div></div>
                    <button type="button" style={{ ...buttonStyle, padding: '4px 8px', fontSize: 15 }} onClick={() => setConceptOpen(false)} aria-label="Close concept search">×</button>
                </div>
                <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                    <input type="search" value={conceptQuery} onChange={(event) => setConceptQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runConceptSearch(); }} placeholder="e.g. Who can perform initiation?" style={{ flex: 1, minWidth: 0, border: '1px solid #d8cec8', borderRadius: 7, padding: '9px 10px', outline: 'none', font: 'inherit' }} />
                    <button type="button" style={{ ...buttonStyle, background: '#7A1F1F', color: '#fff' }} disabled={conceptLoading || !conceptQuery.trim()} onClick={() => void runConceptSearch()}>{conceptLoading ? 'Searching…' : 'Search'}</button>
                </div>
            </div>
            <div style={{ maxHeight: 'calc(100vh - 275px)', overflow: 'auto', padding: 10 }}>
                {conceptError && <div style={{ padding: 10, borderRadius: 8, background: '#fff3f3', border: '1px solid #edcccc', color: '#a32020', fontSize: 12 }}>{conceptError}</div>}
                {!conceptLoading && conceptResults.length > 0 && <div style={{ color: '#777', fontSize: 11, marginBottom: 7 }}>{conceptResults.length} related passages</div>}
                {conceptResults.map((result, index) => {
                    const path = paths.find((candidate) => candidate === result.dataset) || paths.find((candidate) => candidate.endsWith(`/${result.dataset}`) || (result.filename && candidate.endsWith(`/${result.filename}`)));
                    return <button key={`${result.id}-${index}`} type="button" disabled={!path} onClick={() => path && onOpenGrantha(path)} style={{ display: 'block', width: '100%', textAlign: 'left', border: '1px solid #e5dcd7', borderRadius: 9, background: '#fff', padding: 11, marginBottom: 8, cursor: path ? 'pointer' : 'default' }}>
                        <div style={{ color: '#7A1F1F', fontWeight: 700, fontSize: 12 }}>{result.title || result.filename || result.dataset}</div>
                        <div style={{ color: '#888', fontSize: 10, marginTop: 2 }}>{result.author ? `${result.author} · ` : ''}{result.page ? `page ${result.page}` : ''}{result.language ? ` · ${result.language}` : ''}</div>
                        <div style={{ color: '#4d4541', fontSize: 12, lineHeight: 1.55, marginTop: 6, whiteSpace: 'pre-wrap' }}>{result.text.length > 700 ? `${result.text.slice(0, 700)}…` : result.text}</div>
                    </button>;
                })}
            </div>
        </div>}

        <div className="granthas-text-intelligence-toolbar" style={{ position: 'fixed', top: toolbarPosition.top, left: toolbarPosition.left, zIndex: 1200, display: selectedText ? 'flex' : 'none', gap: 5, alignItems: 'center', padding: 6, border: '1px solid #d8cec8', borderRadius: 10, background: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,.18)', maxWidth: 'calc(100vw - 24px)', overflowX: 'auto' }} role="toolbar" aria-label="Text intelligence">
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
