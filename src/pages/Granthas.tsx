import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import GranthasTree from '../components/GranthasTree';
import IASTSearchInput from '../components/IASTSearchInput';
import { listGranthas } from '../api_granthas';
import '../styles/pages/granthas.css';

function displayGranthaName(fileName: string) { return String(fileName || '').replace(/_/g, ' ').replace(/\.(txt|json)$/i, ''); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
type SearchMatch = { start: number; end: number };
type GlobalResult = { path: string; name: string; matches: number; snippets: string[] };
type GlobalSearchState = { open: boolean; query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; results: GlobalResult[]; error: string; searching: boolean; selectedPath: string | null };

const RECENT_KEY = 'granthas-recently-opened-v1';
const BOOKMARKS_KEY = 'granthas-bookmarks-v1';
const POSITIONS_KEY = 'granthas-reading-positions-v1';
const FONT_SIZE_KEY = 'granthas-font-size-v1';
const LINE_HEIGHT_KEY = 'granthas-line-height-v1';

function readStorage<T>(key: string, fallback: T): T {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

function Granthas() {
    const [paths, setPaths] = useState<string[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [contentLoading, setContentLoading] = useState(false);
    const [contentError, setContentError] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [currentSearchOpen, setCurrentSearchOpen] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regexMode, setRegexMode] = useState(false);
    const [activeMatch, setActiveMatch] = useState(0);
    const [globalOpen, setGlobalOpen] = useState(false);
    const [globalSearch, setGlobalSearch] = useState('');
    const [globalCaseSensitive, setGlobalCaseSensitive] = useState(false);
    const [globalWholeWord, setGlobalWholeWord] = useState(false);
    const [globalRegex, setGlobalRegex] = useState(false);
    const [globalResults, setGlobalResults] = useState<GlobalResult[]>([]);
    const [globalSearching, setGlobalSearching] = useState(false);
    const [globalError, setGlobalError] = useState('');
    const [previousGlobalState, setPreviousGlobalState] = useState<GlobalSearchState | null>(null);
    const [recentPaths, setRecentPaths] = useState<string[]>(() => readStorage<string[]>(RECENT_KEY, []));
    const [bookmarks, setBookmarks] = useState<string[]>(() => readStorage<string[]>(BOOKMARKS_KEY, []));
    const [readingPositions, setReadingPositions] = useState<Record<string, number>>(() => readStorage<Record<string, number>>(POSITIONS_KEY, {}));
    const [fontSize, setFontSize] = useState<number>(() => readStorage<number>(FONT_SIZE_KEY, 13));
    const [lineHeight, setLineHeight] = useState<number>(() => readStorage<number>(LINE_HEIGHT_KEY, 1.65));
    const [showRecent, setShowRecent] = useState(false);
    const [showBookmarks, setShowBookmarks] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const viewerRef = useRef<HTMLDivElement>(null);
    const detailRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => { try { setLoading(true); setError(''); const files = await listGranthas(); if (!cancelled) { setPaths(files); setSelectedPath(null); } } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Granthas.'); } finally { if (!cancelled) setLoading(false); } })();
        return () => { cancelled = true; };
    }, []);

    const selectedParts = useMemo(() => (selectedPath ?? '').split('/').filter(Boolean), [selectedPath]);
    const selectedFileName = selectedParts[selectedParts.length - 1] ?? '';
    const selectedName = displayGranthaName(selectedFileName);
    const selectedFolder = selectedParts.slice(0, -1).map((part) => part.replace(/_/g, ' ')).join(' / ');
    const selectedIndex = selectedPath ? paths.indexOf(selectedPath) : -1;
    const isBookmarked = selectedPath ? bookmarks.includes(selectedPath) : false;
    const recentVisible = recentPaths.filter((path) => paths.includes(path));
    const bookmarkedVisible = bookmarks.filter((path) => paths.includes(path));
    function publicFileUrl(filePath: string) { return `/data/${filePath.split('/').map(encodeURIComponent).join('/')}`; }

    function persistRecent(path: string) {
        setRecentPaths((previous) => { const next = [path, ...previous.filter((item) => item !== path)].slice(0, 10); localStorage.setItem(RECENT_KEY, JSON.stringify(next)); return next; });
    }
    function toggleBookmark(path: string) {
        setBookmarks((previous) => { const next = previous.includes(path) ? previous.filter((item) => item !== path) : [path, ...previous]; localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next)); return next; });
    }
    function updatePosition(path: string, position: number) {
        setReadingPositions((previous) => { const next = { ...previous, [path]: position }; localStorage.setItem(POSITIONS_KEY, JSON.stringify(next)); return next; });
    }
    function changeFontSize(delta: number) {
        setFontSize((value) => { const next = Math.min(22, Math.max(10, Number((value + delta).toFixed(1)))); localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(next)); return next; });
    }
    function changeLineHeight(delta: number) {
        setLineHeight((value) => { const next = Math.min(2.2, Math.max(1.3, Number((value + delta).toFixed(1)))); localStorage.setItem(LINE_HEIGHT_KEY, JSON.stringify(next)); return next; });
    }
    function resetReadingControls() {
        setFontSize(13); setLineHeight(1.65); localStorage.setItem(FONT_SIZE_KEY, '13'); localStorage.setItem(LINE_HEIGHT_KEY, '1.65');
    }
    function selectGrantha(path: string, fromGlobalResult = false) {
        if (fromGlobalResult) {
            setPreviousGlobalState({ open: globalOpen, query: globalSearch, caseSensitive: globalCaseSensitive, wholeWord: globalWholeWord, regex: globalRegex, results: globalResults, error: globalError, searching: globalSearching, selectedPath });
            setGlobalOpen(false);
        } else setPreviousGlobalState(null);
        setSelectedPath(path); persistRecent(path); setShowRecent(false); setShowBookmarks(false);
    }
    function selectAdjacent(direction: -1 | 1) { const nextIndex = selectedIndex + direction; if (nextIndex >= 0 && nextIndex < paths.length) selectGrantha(paths[nextIndex]); }

    useEffect(() => {
        if (!selectedPath) { setContent(''); setContentError(''); setCurrentSearchOpen(false); return; }
        let cancelled = false;
        (async () => { try { setContentLoading(true); setContentError(''); setContent(''); setActiveMatch(0); const response = await fetch(publicFileUrl(selectedPath)); if (!response.ok) throw new Error(`Unable to load ${selectedName}.`); const raw = await response.text(); if (cancelled) return; if (selectedPath.toLowerCase().endsWith('.json')) { try { setContent(JSON.stringify(JSON.parse(raw), null, 2)); } catch { setContent(raw); } } else setContent(raw); } catch (err) { if (!cancelled) setContentError(err instanceof Error ? err.message : 'Unable to load Grantha content.'); } finally { if (!cancelled) setContentLoading(false); } })();
        return () => { cancelled = true; };
    }, [selectedPath, selectedName]);

    useEffect(() => {
        if (!selectedPath || contentLoading || !content || !viewerRef.current) return;
        const position = readingPositions[selectedPath] ?? 0;
        requestAnimationFrame(() => { if (viewerRef.current) viewerRef.current.scrollTop = position; });
    }, [selectedPath, contentLoading, content, readingPositions]);

    useEffect(() => {
        function handleFullscreenChange() { setIsFullscreen(Boolean(document.fullscreenElement)); }
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    function handleViewerScroll() { if (selectedPath && viewerRef.current) updatePosition(selectedPath, viewerRef.current.scrollTop); }
    async function toggleFullscreen() {
        if (!detailRef.current) return;
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await detailRef.current.requestFullscreen(); } catch { /* Fullscreen may be unavailable in embedded browsers. */ }
    }

    const searchState = useMemo(() => {
        const query = search.trim(); if (!query) return { matches: [] as SearchMatch[], error: '' };
        let pattern = regexMode ? query : escapeRegExp(query); if (wholeWord) pattern = `\\b(?:${pattern})\\b`;
        try { const expression = new RegExp(pattern, `g${caseSensitive ? '' : 'i'}`); const matches: SearchMatch[] = []; let match: RegExpExecArray | null; while ((match = expression.exec(content)) !== null) { matches.push({ start: match.index, end: match.index + match[0].length }); if (match[0].length === 0) expression.lastIndex += 1; } return { matches, error: '' }; } catch (err) { return { matches: [] as SearchMatch[], error: err instanceof Error ? err.message : 'Invalid regular expression.' }; }
    }, [content, search, caseSensitive, wholeWord, regexMode]);
    const matches = searchState.matches;
    useEffect(() => { if (activeMatch >= matches.length) setActiveMatch(Math.max(0, matches.length - 1)); }, [matches.length, activeMatch]);
    useEffect(() => { if (!currentSearchOpen || !search || matches.length === 0) return; viewerRef.current?.querySelector<HTMLElement>(`[data-search-match="${activeMatch}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [activeMatch, matches.length, search, content, currentSearchOpen]);
    function nextMatch() { if (matches.length) setActiveMatch((value) => (value + 1) % matches.length); }
    function previousMatch() { if (matches.length) setActiveMatch((value) => (value - 1 + matches.length) % matches.length); }
    function renderContent() { if (!currentSearchOpen || !search.trim() || matches.length === 0 || searchState.error) return <pre>{content}</pre>; const parts: ReactNode[] = []; let cursor = 0; matches.forEach((match, index) => { if (match.start > cursor) parts.push(content.slice(cursor, match.start)); parts.push(<mark key={`${match.start}-${match.end}-${index}`} className={index === activeMatch ? 'granthas-search-match is-active' : 'granthas-search-match'} data-search-match={index}>{content.slice(match.start, match.end)}</mark>); cursor = match.end; }); if (cursor < content.length) parts.push(content.slice(cursor)); return <pre>{parts}</pre>; }

    async function runGlobalSearch() {
        const query = globalSearch.trim(); if (!query) { setGlobalResults([]); setGlobalError(''); return; }
        let pattern = globalRegex ? query : escapeRegExp(query); if (globalWholeWord) pattern = `\\b(?:${pattern})\\b`;
        let expression: RegExp; try { expression = new RegExp(pattern, `g${globalCaseSensitive ? '' : 'i'}`); } catch (err) { setGlobalError(err instanceof Error ? err.message : 'Invalid regular expression.'); setGlobalResults([]); return; }
        setGlobalSearching(true); setGlobalError(''); setGlobalResults([]);
        try {
            const results: GlobalResult[] = [];
            const batchSize = 8;
            for (let i = 0; i < paths.length; i += batchSize) {
                const batch = paths.slice(i, i + batchSize);
                const found = await Promise.all(batch.map(async (path) => {
                    try { const response = await fetch(publicFileUrl(path)); if (!response.ok) return null; const text = await response.text(); expression.lastIndex = 0; let match: RegExpExecArray | null; let count = 0; const snippets: string[] = []; while ((match = expression.exec(text)) !== null) { count++; if (snippets.length < 3) { const start = Math.max(0, match.index - 70); const end = Math.min(text.length, match.index + match[0].length + 110); snippets.push(text.slice(start, end).replace(/\s+/g, ' ').trim()); } if (match[0].length === 0) expression.lastIndex++; } return count ? { path, name: displayGranthaName(path.split('/').pop() || path), matches: count, snippets } : null; } catch { return null; }
                }));
                results.push(...found.filter((item): item is GlobalResult => Boolean(item)));
                setGlobalResults([...results]);
            }
        } finally { setGlobalSearching(false); }
    }

    function openGlobalResult(path: string) {
        setSearch(globalSearch); setCaseSensitive(globalCaseSensitive); setWholeWord(globalWholeWord); setRegexMode(globalRegex); setActiveMatch(0); setCurrentSearchOpen(true); selectGrantha(path, true);
    }
    function returnToSearchResults() {
        if (!previousGlobalState) return;
        const state = previousGlobalState;
        setSelectedPath(state.selectedPath); setGlobalSearch(state.query); setGlobalCaseSensitive(state.caseSensitive); setGlobalWholeWord(state.wholeWord); setGlobalRegex(state.regex); setGlobalResults(state.results); setGlobalError(state.error); setGlobalSearching(state.searching); setGlobalOpen(true); setSearch(''); setCaseSensitive(false); setWholeWord(false); setRegexMode(false); setActiveMatch(0); setCurrentSearchOpen(false); setPreviousGlobalState(null);
    }

    return (<><Navbar /><main className="container granthas-page">
        <div className="granthas-page-header"><div><h1>Granthas</h1><p>Explore the complete collection of sacred texts and works available in the application.</p></div><div className="granthas-actions"><button className="granthas-action secondary" type="button" onClick={() => { setGlobalOpen((v) => !v); if (globalOpen) setGlobalResults([]); }}>⌕ Advanced Global Search</button><Link className="granthas-action secondary" to="/dataset?mode=existing">Edit Dataset</Link><Link className="granthas-action primary" to="/dataset?mode=new">+ Create Dataset</Link></div></div>
        {error && <div className="granthas-error">{error}</div>}
        {globalOpen && <section className="granthas-global-search">
            <div className="granthas-global-search-header"><div><h2>Advanced Global Search</h2><p>Search across every available Grantha.</p></div><button type="button" onClick={() => setGlobalOpen(false)} aria-label="Close global search">✕</button></div>
            <div className="granthas-global-search-controls"><IASTSearchInput value={globalSearch} onChange={setGlobalSearch} onSubmit={runGlobalSearch} content={paths.join(' ')} placeholder="Search all Granthas…" ariaLabel="Search all Granthas" /><button type="button" className="granthas-global-run" onClick={runGlobalSearch} disabled={globalSearching || !globalSearch.trim()}>{globalSearching ? 'Searching…' : 'Search'}</button></div>
            <div className="granthas-search-options"><label><input type="checkbox" checked={globalCaseSensitive} onChange={(e) => setGlobalCaseSensitive(e.target.checked)} /> Case sensitive</label><label><input type="checkbox" checked={globalWholeWord} onChange={(e) => setGlobalWholeWord(e.target.checked)} /> Whole word</label><label><input type="checkbox" checked={globalRegex} onChange={(e) => setGlobalRegex(e.target.checked)} /> Regex</label><span className="granthas-search-count">{globalResults.length} Granthas matched</span></div>
            {globalError && <div className="granthas-search-error">{globalError}</div>}
            <div className="granthas-global-results">{globalSearching && globalResults.length === 0 ? <div className="granthas-content-state">Searching Granthas…</div> : globalResults.length ? globalResults.map((result) => <button type="button" className="granthas-global-result" key={result.path} onClick={() => openGlobalResult(result.path)}><div className="granthas-global-result-title"><span>{result.name}</span><small>{result.matches} match{result.matches === 1 ? '' : 'es'}</small></div>{result.snippets.map((snippet, i) => <div className="granthas-global-snippet" key={i}>{snippet}</div>)}</button>) : !globalSearching && globalSearch.trim() ? <div className="granthas-tree-empty">No matches found.</div> : <div className="granthas-tree-empty">Enter a word to search all Granthas.</div>}</div>
        </section>}
        <section className="granthas-layout"><GranthasTree paths={paths} selectedPath={selectedPath} onSelect={(path) => selectGrantha(path)} /><div className="granthas-detail" ref={detailRef}>{loading ? <div className="granthas-empty-state">Loading Granthas…</div> : selectedPath ? <><div className="granthas-detail-topline">{selectedFolder || 'Granthas'}</div><div className="granthas-detail-heading"><div><h2>{selectedName}</h2><p className="granthas-detail-path">public/data/{selectedPath}</p></div><div className="granthas-detail-heading-actions">
            <div className="granthas-popover-wrap"><button type="button" className="granthas-reader-button" onClick={() => { setShowRecent((v) => !v); setShowBookmarks(false); }}>◷ Recently opened</button>{showRecent && <div className="granthas-popover">{recentVisible.length ? recentVisible.map((path) => <button type="button" key={path} onClick={() => selectGrantha(path)}>{displayGranthaName(path.split('/').pop() || path)}</button>) : <span>No recently opened Granthas.</span>}</div>}</div>
            <div className="granthas-popover-wrap"><button type="button" className={`granthas-reader-button ${isBookmarked ? 'is-active' : ''}`} onClick={() => { if (selectedPath) toggleBookmark(selectedPath); setShowBookmarks((v) => !v); setShowRecent(false); }}>{isBookmarked ? '★ Bookmarked' : '☆ Bookmark'}</button>{showBookmarks && <div className="granthas-popover">{bookmarkedVisible.length ? bookmarkedVisible.map((path) => <button type="button" key={path} onClick={() => selectGrantha(path)}>{displayGranthaName(path.split('/').pop() || path)}</button>) : <span>No bookmarks yet.</span>}</div>}</div>
            <button type="button" className="granthas-reader-button" onClick={() => selectAdjacent(-1)} disabled={selectedIndex <= 0} aria-label="Previous Grantha">← Previous</button><button type="button" className="granthas-reader-button" onClick={() => selectAdjacent(1)} disabled={selectedIndex < 0 || selectedIndex >= paths.length - 1} aria-label="Next Grantha">Next →</button>
            {previousGlobalState && <button type="button" className="granthas-back-button" onClick={returnToSearchResults}>← Back to search result</button>}<button type="button" className={`granthas-search-toggle ${currentSearchOpen ? 'is-active' : ''}`} onClick={() => setCurrentSearchOpen((value) => !value)} aria-expanded={currentSearchOpen} aria-controls="current-grantha-search">⌕ {currentSearchOpen ? 'Hide search' : 'Search in this Grantha'}</button><button type="button" className="granthas-reader-button" onClick={toggleFullscreen}>{isFullscreen ? '⛶ Exit full screen' : '⛶ Full screen'}</button>
        </div></div>{currentSearchOpen && <div id="current-grantha-search" className="granthas-advanced-search" aria-label="Advanced search in current Grantha"><IASTSearchInput value={search} onChange={(value) => { setSearch(value); setActiveMatch(0); }} content={content} /><div className="granthas-search-options"><label><input type="checkbox" checked={caseSensitive} onChange={(e) => { setCaseSensitive(e.target.checked); setActiveMatch(0); }} /> Case sensitive</label><label><input type="checkbox" checked={wholeWord} onChange={(e) => { setWholeWord(e.target.checked); setActiveMatch(0); }} /> Whole word</label><label><input type="checkbox" checked={regexMode} onChange={(e) => { setRegexMode(e.target.checked); setActiveMatch(0); }} /> Regex</label><span className="granthas-search-count">{searchState.error ? 'Invalid search' : search.trim() ? `${matches.length ? activeMatch + 1 : 0} of ${matches.length}` : 'Search current Grantha'}</span><button type="button" onClick={previousMatch} disabled={!matches.length} aria-label="Previous match">↑</button><button type="button" onClick={nextMatch} disabled={!matches.length} aria-label="Next match">↓</button></div>{searchState.error && <div className="granthas-search-error">{searchState.error}</div>}</div>}
        <div className="granthas-reading-toolbar"><span>Reading controls</span><button type="button" onClick={() => changeFontSize(-1)} aria-label="Decrease font size">A−</button><button type="button" onClick={resetReadingControls} aria-label="Reset reading controls">A</button><button type="button" onClick={() => changeFontSize(1)} aria-label="Increase font size">A+</button><span className="granthas-toolbar-divider" aria-hidden="true" /> <button type="button" onClick={() => changeLineHeight(-0.1)} aria-label="Decrease line spacing">− spacing</button><button type="button" onClick={() => changeLineHeight(0.1)} aria-label="Increase line spacing">+ spacing</button><span className="granthas-reading-value">{fontSize}px · {lineHeight.toFixed(1)}×</span></div>
        <div className="granthas-content-viewer" ref={viewerRef} onScroll={handleViewerScroll}>{contentLoading ? <div className="granthas-content-state">Loading Grantha…</div> : contentError ? <div className="granthas-content-state is-error">{contentError}</div> : <div className="granthas-content-text" style={{ '--granthas-font-size': `${fontSize}px`, '--granthas-line-height': lineHeight } as React.CSSProperties}>{renderContent()}</div>}</div></> : null}</div></section>
    </main><Footer /></>);
}
export default Granthas;
