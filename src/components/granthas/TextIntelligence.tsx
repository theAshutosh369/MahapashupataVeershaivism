import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import type { RAGSource } from '../../types/rag';

type Action = 'ask' | 'translate' | 'explain' | 'similar' | 'references';
type Props = { selectedPath: string | null; selectedName: string; paths: string[]; onOpenGrantha: (path: string) => void };
type ConceptResult = { id: string; dataset: string; filename?: string; page?: number; title?: string; author?: string; language?: string; score?: number; text: string };
type TocEntry = { id: string; title: string; level: 1 | 2 | 3; offset: number };
type ApiResult = { answer?: string; sources?: RAGSource[]; confidence?: number; error?: string; retrievedChunks?: Array<{ id: string; dataset: string; filename?: string; page?: number; author?: string; title?: string; language?: string; score?: number; text: string }> };

const LANGUAGES = ['English', 'Hindi', 'Marathi', 'Kannada', 'Sanskrit'];

function displayName(path: string) { return String(path || '').split('/').pop()?.replace(/_/g, ' ').replace(/\.(txt|json)$/i, '') || path; }
function normalizePath(path: string) { return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }
function sourcePath(result: ConceptResult, paths: string[]) {
    const candidates = [result.dataset, result.filename].filter(Boolean).map(normalizePath);
    for (const candidate of candidates) {
        const exact = paths.find((p) => normalizePath(p) === candidate);
        if (exact) return exact;
        const suffix = paths.find((p) => normalizePath(p).endsWith(`/${candidate}`) || normalizePath(p).endsWith(candidate));
        if (suffix) return suffix;
    }
    return null;
}
function detectToc(text: string): TocEntry[] {
    if (!text.trim()) return [];
    const entries: TocEntry[] = [];
    let offset = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim().replace(/[\u200B\uFEFF]/g, '');
        let level: 1 | 2 | 3 | null = null;
        if (/^(?:chapter|adhyaya|adhyāya|kāṇḍa|kanda|sarga|book|part)\b/i.test(line) || /^(?:अध्याय|सर्ग|काण्ड|कांड|खण्ड|खंड)/.test(line)) level = 1;
        else if (/^(?:section|prakaraṇa|prakarana|khaṇḍa|khanda)\b/i.test(line) || /^प्रकरण/.test(line)) level = 2;
        else if (/^(?:(?:verse|śloka|shloka|sloka)\s*(?:no\.?\s*)?\d+|\d+[.)]\s+(?:śloka|shloka|verse)\b)/i.test(line) || /^(?:श्लोक\s*\d+|\d+[.)]\s*श्लोक)/.test(line)) level = 3;
        else if (/^\d+(?:\.\d+){0,2}[.)]?\s+[A-ZĀĪŪṚṜḶŚṢṬḌḤ][^.!?]{2,120}$/.test(line)) level = line.startsWith('1.') && !line.startsWith('1.1') ? 2 : 3;
        if (level && line.length > 1) entries.push({ id: `toc-${entries.length}`, title: line, level, offset });
        offset += raw.length + 1;
    }
    return entries.length > 500 ? entries.filter((e) => e.level < 3).slice(0, 250) : entries;
}
function scrollToOffset(offset: number) {
    const viewer = document.querySelector('.granthas-content-viewer') as HTMLElement | null;
    const content = viewer?.querySelector('.granthas-content-text') as HTMLElement | null;
    if (!viewer || !content) return;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const value = node.textContent || '';
        if (offset <= consumed + value.length) {
            const range = document.createRange();
            range.setStart(node, Math.max(0, Math.min(value.length, offset - consumed)));
            range.collapse(true);
            const rect = range.getBoundingClientRect();
            viewer.scrollTop += rect.top - viewer.getBoundingClientRect().top - 24;
            return;
        }
        consumed += value.length;
    }
}

export default function TextIntelligence({ selectedPath, selectedName, paths, onOpenGrantha }: Props) {
    const [selectedText, setSelectedText] = useState('');
    const [toolbar, setToolbar] = useState({ top: 0, left: 0 });
    const [utilityHost, setUtilityHost] = useState<HTMLElement | null>(null);
    const [panelAnchor, setPanelAnchor] = useState({ top: 0, left: 0, width: 360 });
    const [panel, setPanel] = useState<'contents' | 'concept' | null>(null);
    const [tocSearch, setTocSearch] = useState('');
    const [tocEntries, setTocEntries] = useState<TocEntry[]>([]);
    const [conceptQuery, setConceptQuery] = useState('');
    const [conceptResults, setConceptResults] = useState<ConceptResult[]>([]);
    const [conceptLoading, setConceptLoading] = useState(false);
    const [conceptError, setConceptError] = useState('');
    const conceptAbort = useRef<AbortController | null>(null);
    const conceptRun = useRef(0);
    const [action, setAction] = useState<Action | null>(null);
    const [question, setQuestion] = useState('');
    const [language, setLanguage] = useState('English');
    const [loading, setLoading] = useState(false);
    const [answer, setAnswer] = useState('');
    const [sources, setSources] = useState<RAGSource[]>([]);
    const [confidence, setConfidence] = useState<number | null>(null);
    const [error, setError] = useState('');
    const questionRef = useRef<HTMLInputElement | null>(null);

    const visibleToc = useMemo(() => {
        const q = tocSearch.trim().toLocaleLowerCase();
        return q ? tocEntries.filter((e) => e.title.toLocaleLowerCase().includes(q)) : tocEntries;
    }, [tocEntries, tocSearch]);

    useEffect(() => {
        if (!selectedPath) { setUtilityHost(null); setPanel(null); return; }
        const locate = () => {
            const host = document.querySelector('.granthas-detail-heading-actions') as HTMLElement | null;
            setUtilityHost(host);
            if (host) {
                const rect = host.getBoundingClientRect();
                setPanelAnchor({ top: Math.min(window.innerHeight - 80, rect.bottom + 8), left: Math.max(12, Math.min(window.innerWidth - 380, rect.right - 360)), width: Math.min(650, window.innerWidth - 24) });
            }
        };
        locate();
        window.addEventListener('resize', locate);
        window.addEventListener('scroll', locate, true);
        return () => { window.removeEventListener('resize', locate); window.removeEventListener('scroll', locate, true); };
    }, [selectedPath]);

    useEffect(() => {
        const update = () => {
            const selection = window.getSelection();
            const text = selection?.toString().trim() || '';
            const viewer = document.querySelector('.granthas-content-text');
            const anchor = selection?.anchorNode;
            const focus = selection?.focusNode;
            if (!text || !viewer || !anchor || !focus || !viewer.contains(anchor) || !viewer.contains(focus) || !selection?.rangeCount) { if (!action) setSelectedText(''); return; }
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            if (!rect.width && !rect.height) return;
            setToolbar({ top: Math.max(12, rect.top - 50), left: Math.max(12, Math.min(window.innerWidth - 430, rect.left + rect.width / 2 - 210)) });
            setSelectedText(text);
        };
        document.addEventListener('selectionchange', update);
        document.addEventListener('mouseup', update);
        document.addEventListener('touchend', update);
        window.addEventListener('scroll', update, true);
        return () => { document.removeEventListener('selectionchange', update); document.removeEventListener('mouseup', update); document.removeEventListener('touchend', update); window.removeEventListener('scroll', update, true); };
    }, [action]);

    useEffect(() => {
        setSelectedText(''); setAction(null); setAnswer(''); setSources([]); setError(''); setPanel(null); setTocSearch(''); setConceptQuery(''); setConceptResults([]); setConceptError('');
        conceptAbort.current?.abort();
    }, [selectedPath]);

    useEffect(() => {
        if (!selectedPath) return;
        const viewer = document.querySelector('.granthas-content-viewer');
        if (!viewer) return;
        const rebuild = () => setTocEntries(detectToc(viewer.querySelector('.granthas-content-text')?.textContent || ''));
        rebuild();
        const observer = new MutationObserver(rebuild);
        observer.observe(viewer, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
    }, [selectedPath]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { setPanel(null); setAction(null); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    async function runConceptSearch() {
        const query = conceptQuery.trim();
        if (!query) { setConceptError('Enter a concept or research question.'); setConceptResults([]); return; }
        conceptAbort.current?.abort();
        const controller = new AbortController();
        conceptAbort.current = controller;
        const run = ++conceptRun.current;
        setConceptLoading(true); setConceptError(''); setConceptResults([]);
        try {
            const response = await fetch('/api/rag/concept-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ query, topK: 25 }) });
            const data = await response.json() as ApiResult;
            if (!response.ok || data.error) throw new Error(data.error || 'Concept search failed.');
            if (run !== conceptRun.current) return;
            const seen = new Set<string>();
            const results: ConceptResult[] = [];
            for (const chunk of data.retrievedChunks || []) {
                const key = `${normalizePath(chunk.dataset)}|${chunk.id}`;
                if (seen.has(key) || !chunk.text?.trim()) continue;
                seen.add(key);
                results.push({ ...chunk, score: Number(chunk.score ?? 0) });
            }
            setConceptResults(results);
            if (!results.length) setConceptError('No sufficiently relevant passages were found across the Grantha collection. Try a more specific concept.');
        } catch (err) {
            if ((err as Error)?.name !== 'AbortError') setConceptError(err instanceof Error ? err.message : 'Concept search failed.');
        } finally {
            if (run === conceptRun.current) setConceptLoading(false);
        }
    }

    async function runAction(next: Action) {
        if (!selectedText || !selectedPath) return;
        if (next === 'ask' && !question.trim()) { setAction('ask'); setTimeout(() => questionRef.current?.focus(), 0); return; }
        setAction(next); setLoading(true); setAnswer(''); setSources([]); setConfidence(null); setError('');
        let prompt = '';
        let dataset = selectedPath;
        let topK = 8;
        if (next === 'ask') prompt = `Answer the user's question using the selected passage as primary evidence. If it is insufficient, say so clearly.\n\nGrantha: ${selectedName}\nSelected passage:\n${selectedText}\n\nUser question: ${question.trim()}`;
        if (next === 'translate') prompt = `Translate the selected passage into ${language}. Preserve meaning, terminology, names, Sanskrit/IAST terms, verse structure, and line breaks. Do not summarize or add commentary.\n\nSelected passage:\n${selectedText}`;
        if (next === 'explain') prompt = `Explain the selected passage clearly and accurately. Use the passage as primary evidence and do not invent claims not supported by it.\n\nGrantha: ${selectedName}\nSelected passage:\n${selectedText}`;
        if (next === 'similar') { dataset = '__ALL__'; topK = 12; prompt = `Find passages across all available Granthas that are semantically similar to this passage. Prefer the same doctrine, concept, definition, argument, or teaching. Return source references and brief explanations without fabricating citations.\n\nSelected passage from ${selectedName}:\n${selectedText}`; }
        if (next === 'references') { dataset = '__ALL__'; topK = 15; prompt = `Find cross-Granthas references across the complete collection related to this passage. Prefer other Granthas and passages discussing the same concept, terminology, doctrine, person, practice, or argument. Give exact source references where available and do not fabricate citations.\n\nCurrent Grantha: ${selectedName}\nSelected passage:\n${selectedText}`; }
        try {
            const response = await fetch('/api/rag/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: prompt, selectedDataset: dataset, topK, answerMode: next === 'translate' ? 'concise' : 'detailed', includeConversationMemory: false, conversationHistory: [] }) });
            const data = await response.json() as ApiResult;
            if (!response.ok || data.error) throw new Error(data.error || 'Unable to process the selected passage.');
            setAnswer(String(data.answer || 'No answer was returned.')); setSources(Array.isArray(data.sources) ? data.sources : []); setConfidence(typeof data.confidence === 'number' ? data.confidence : null);
        } catch (err) { setError(err instanceof Error ? err.message : 'Unable to process the selected passage.'); }
        finally { setLoading(false); }
    }

    function closeAction() { setAction(null); setAnswer(''); setSources([]); setError(''); }

    const utilityButton: CSSProperties = { minHeight: 36, border: '1px solid #d8cec8', borderRadius: 7, background: '#fff', color: '#7A1F1F', padding: '0 11px', cursor: 'pointer', fontSize: 12, fontWeight: 650, whiteSpace: 'nowrap' };
    const smallButton: CSSProperties = { ...utilityButton, minHeight: 32, padding: '0 9px' };
    if (!selectedPath) return null;

    return <>
        {utilityHost && createPortal(<>
            <button type="button" className="granthas-reader-button granthas-intelligence-button" style={utilityButton} onClick={() => setPanel((p) => p === 'contents' ? null : 'contents')} aria-expanded={panel === 'contents'}>☷ Contents{tocEntries.length ? ` (${tocEntries.length})` : ''}</button>
            <button type="button" className="granthas-reader-button granthas-intelligence-button" style={utilityButton} onClick={() => setPanel((p) => p === 'concept' ? null : 'concept')} aria-expanded={panel === 'concept'}>⌕ Concept search</button>
        </>, utilityHost)}

        {panel === 'contents' && createPortal(<section className="granthas-intelligence-panel" style={{ top: panelAnchor.top, left: panelAnchor.left, width: Math.min(390, panelAnchor.width) }} role="dialog" aria-label="Grantha contents">
            <header><div><strong>Contents</strong><small>{tocEntries.length ? `${tocEntries.length} detected entries` : 'No headings detected'}</small></div><button type="button" onClick={() => setPanel(null)} aria-label="Close contents">×</button></header>
            <input type="search" value={tocSearch} onChange={(e) => setTocSearch(e.target.value)} placeholder="Filter chapters, sections, verses…" />
            <div className="granthas-intelligence-scroll">{visibleToc.length ? visibleToc.map((entry) => <button type="button" key={entry.id} className={`granthas-toc-entry level-${entry.level}`} onClick={() => { scrollToOffset(entry.offset); setPanel(null); }}>{entry.title}</button>) : <div className="granthas-intelligence-empty">{tocEntries.length ? 'No entries match your filter.' : 'This Grantha has no recognizable headings.'}</div>}</div>
        </section>, document.body)}

        {panel === 'concept' && createPortal(<section className="granthas-intelligence-panel granthas-concept-panel" style={{ top: panelAnchor.top, left: panelAnchor.left, width: panelAnchor.width }} role="dialog" aria-label="Concept search">
            <header><div><strong>Concept search</strong><small>Semantic search across all available Granthas</small></div><button type="button" onClick={() => setPanel(null)} aria-label="Close concept search">×</button></header>
            <div className="granthas-concept-search-row"><input type="search" value={conceptQuery} onChange={(e) => setConceptQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runConceptSearch(); }} placeholder="e.g. initiation eligibility, nature of Śiva, liberation…" autoFocus /><button type="button" onClick={() => void runConceptSearch()} disabled={conceptLoading || !conceptQuery.trim()}>{conceptLoading ? 'Searching…' : 'Search'}</button></div>
            {conceptError && <div className="granthas-intelligence-error">{conceptError}</div>}
            {conceptLoading && <div className="granthas-intelligence-loading"><span className="granthas-spinner" /> Searching the complete Grantha collection…</div>}
            {!conceptLoading && conceptResults.length > 0 && <div className="granthas-concept-summary">Showing {conceptResults.length} most relevant passages across the collection.</div>}
            <div className="granthas-intelligence-scroll concept-results">{conceptResults.map((result, index) => { const path = sourcePath(result, paths); const score = result.score && result.score > 0 ? `${Math.round(Math.min(1, result.score) * 100)}%` : ''; return <article className="granthas-concept-result" key={`${result.id}-${index}`}><button type="button" className="granthas-concept-open" disabled={!path} onClick={() => { if (path) { setPanel(null); onOpenGrantha(path); } }}><div className="granthas-concept-title">{result.title || result.filename || displayName(result.dataset)}</div><div className="granthas-concept-meta">{result.author ? `${result.author} · ` : ''}{result.page != null ? `Page ${result.page} · ` : ''}{result.language || ''}{score ? ` · ${score} relevance` : ''}</div><div className="granthas-concept-text">{result.text.length > 850 ? `${result.text.slice(0, 850)}…` : result.text}</div><span className="granthas-concept-hint">{path ? 'Open Grantha ↗' : 'Source file unavailable'}</span></button></article>; })}</div>
        </section>, document.body)}

        <div className="granthas-text-intelligence-toolbar" style={{ top: toolbar.top, left: toolbar.left, display: selectedText ? 'flex' : 'none' }} role="toolbar" aria-label="Text intelligence">
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => runAction('ask')}>✦ Ask AI</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => runAction('translate')}>⇄ Translate</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => runAction('explain')}>☷ Explain</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => runAction('similar')}>≈ Similar passages</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => runAction('references')}>⌘ Cross-Granthas</button>
        </div>

        {action && <div className="granthas-text-intelligence-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) closeAction(); }}><section className="granthas-intelligence-dialog" role="dialog" aria-modal="true" aria-label="Text intelligence">
            <header><div><span>Text intelligence</span><h3>{action === 'ask' ? 'Ask AI' : action === 'translate' ? 'Translate passage' : action === 'explain' ? 'Explain passage' : action === 'similar' ? 'Similar passages' : 'Cross-Granthas references'}</h3><small>{selectedName}</small></div><button type="button" onClick={closeAction} aria-label="Close">×</button></header>
            <div className="granthas-selected-passage"><div>Selected passage</div><p>{selectedText}</p></div>
            {action === 'ask' && <div className="granthas-ask-row"><input ref={questionRef} value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && question.trim() && !loading) void runAction('ask'); }} placeholder="Ask a question about the selected passage…" autoFocus /><button type="button" disabled={loading || !question.trim()} onClick={() => void runAction('ask')}>Ask</button></div>}
            {action === 'translate' && <label className="granthas-language-select">Translate to <select value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((item) => <option key={item}>{item}</option>)}</select><button type="button" disabled={loading} onClick={() => void runAction('translate')}>{loading ? 'Translating…' : 'Translate'}</button></label>}
            {action !== 'ask' && action !== 'translate' && !loading && !answer && <button type="button" className="granthas-primary-action" onClick={() => void runAction(action)}>Run {action === 'similar' ? 'similarity search' : 'cross-Grantha search'}</button>}
            {loading && <div className="granthas-intelligence-loading"><span className="granthas-spinner" /> Working…</div>}
            {error && <div className="granthas-intelligence-error">{error}</div>}
            {answer && <div className="granthas-intelligence-answer"><div className="granthas-answer-label">Result{confidence != null ? ` · ${confidence}% confidence` : ''}</div><div className="granthas-answer-text">{answer}</div></div>}
            {sources.length > 0 && <div className="granthas-intelligence-sources"><strong>Sources</strong>{sources.slice(0, 12).map((source) => <div key={source.id || `${source.dataset}-${source.page}`}><span>{source.title || source.filename || source.dataset}</span>{source.page != null ? ` · Page ${source.page}` : ''}</div>)}</div>}
        </section></div>}
    </>;
}
