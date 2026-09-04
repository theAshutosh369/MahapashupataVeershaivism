import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import GranthasTree from '../components/GranthasTree';
import IASTSearchInput from '../components/IASTSearchInput';
import TextIntelligence from '../components/granthas/TextIntelligence';
import { listGranthas } from '../api_granthas';
import '../styles/pages/granthas.css';
import '../styles/pages/granthas-enhancements.css';

function displayGranthaName(fileName: string) { return String(fileName || '').replace(/_/g, ' ').replace(/\.(txt|json)$/i, ''); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizeGranthaPath(value: string | null | undefined) { return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }
function folderPrefixForPath(value: string | null | undefined) {
    const normalized = normalizeGranthaPath(value);
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}
type SearchMatch = { start: number; end: number };
type SearchMode = 'current' | 'folder' | 'all';
type SearchHistoryEntry = { id: string; query: string; mode: SearchMode; caseSensitive: boolean; wholeWord: boolean; regex: boolean; createdAt: number; scopePath?: string };
type GlobalResult = { path: string; name: string; matches: number; snippets: string[]; firstMatch: number };
type GlobalSearchState = { open: boolean; mode: SearchMode; scopePath: string | null; query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; results: GlobalResult[]; error: string; searching: boolean; selectedPath: string | null };
type OpenTab = { path: string };

const RECENT_KEY = 'granthas-recently-opened-v1';
const BOOKMARKS_KEY = 'granthas-bookmarks-v1';
const POSITIONS_KEY = 'granthas-reading-positions-v1';
const FONT_SIZE_KEY = 'granthas-font-size-v1';
const LINE_HEIGHT_KEY = 'granthas-line-height-v1';
const SEARCH_HISTORY_KEY = 'granthas-search-history-v1';

function readStorage<T>(key: string, fallback: T): T {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

function makeSearchPattern(query: string, wholeWord: boolean, regex: boolean) {
    let pattern = regex ? query : escapeRegExp(query);
    if (wholeWord) pattern = `\\b(?:${pattern})\\b`;
    return pattern;
}

function findMatches(text: string, query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean): { matches: SearchMatch[]; error: string } {
    if (!query.trim()) return { matches: [], error: '' };
    try {
        const expression = new RegExp(makeSearchPattern(query, wholeWord, regex), `g${caseSensitive ? '' : 'i'}`);
        const matches: SearchMatch[] = [];
        let match: RegExpExecArray | null;
        while ((match = expression.exec(text)) !== null) {
            matches.push({ start: match.index, end: match.index + match[0].length });
            if (match[0].length === 0) expression.lastIndex += 1;
        }
        return { matches, error: '' };
    } catch (err) {
        return { matches: [], error: err instanceof Error ? err.message : 'Invalid regular expression.' };
    }
}

function getGranthaStats(content: string, path: string) {
    const characters = content.length;
    const words = content.trim() ? content.trim().split(/\s+/u).length : 0;
    const lines = content ? content.split(/\r?\n/).length : 0;
    let sections = 0;
    if (path.toLowerCase().endsWith('.json')) {
        try {
            const parsed = JSON.parse(content) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sections = Object.keys(parsed as Record<string, unknown>).length;
        } catch { sections = 0; }
    }
    if (!sections) sections = content.split(/\r?\n/).filter((line) => /^\s*(?:#{1,6}\s+|(?:chapter|adhyaya|अध्याय|खंड|section)\b|\d{1,4}[.)]\s+)/iu.test(line)).length;
    return { characters, words, lines, sections };
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
    const [searchMode, setSearchMode] = useState<SearchMode>('current');
    const [searchMenuOpen, setSearchMenuOpen] = useState(false);
    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [searchWholeWord, setSearchWholeWord] = useState(false);
    const [searchRegex, setSearchRegex] = useState(false);
    const [activeMatch, setActiveMatch] = useState(0);
    const [folderResults, setFolderResults] = useState<GlobalResult[]>([]);
    const [folderSearching, setFolderSearching] = useState(false);
    const [folderError, setFolderError] = useState('');
    const [globalOpen, setGlobalOpen] = useState(false);
    const [globalSearchMode, setGlobalSearchMode] = useState<SearchMode>('all');
    const [globalScopePath, setGlobalScopePath] = useState<string | null>(null);
    const [globalSearch, setGlobalSearch] = useState('');
    const [globalCaseSensitive, setGlobalCaseSensitive] = useState(false);
    const [globalWholeWord, setGlobalWholeWord] = useState(false);
    const [globalRegex, setGlobalRegex] = useState(false);
    const [globalResults, setGlobalResults] = useState<GlobalResult[]>([]);
    const [globalSearching, setGlobalSearching] = useState(false);
    const [globalError, setGlobalError] = useState('');
    const [previousGlobalState, setPreviousGlobalState] = useState<GlobalSearchState | null>(null);
    const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>(() => readStorage<SearchHistoryEntry[]>(SEARCH_HISTORY_KEY, []));
    const [showSearchHistory, setShowSearchHistory] = useState(false);
    const [recentPaths, setRecentPaths] = useState<string[]>(() => readStorage<string[]>(RECENT_KEY, []));
    const [bookmarks, setBookmarks] = useState<string[]>(() => readStorage<string[]>(BOOKMARKS_KEY, []));
    const [readingPositions, setReadingPositions] = useState<Record<string, number>>(() => readStorage<Record<string, number>>(POSITIONS_KEY, {}));
    const [fontSize, setFontSize] = useState<number>(() => readStorage<number>(FONT_SIZE_KEY, 13));
    const [lineHeight, setLineHeight] = useState<number>(() => readStorage<number>(LINE_HEIGHT_KEY, 1.65));
    const [showRecent, setShowRecent] = useState(false);
    const [showBookmarks, setShowBookmarks] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
    const viewerRef = useRef<HTMLDivElement>(null);
    const detailRef = useRef<HTMLDivElement>(null);
    const readingPositionsRef = useRef<Record<string, number>>(readingPositions);
    const positionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchRunRef = useRef(0);

    useEffect(() => {
        let cancelled = false;
        (async () => { try { setLoading(true); setError(''); const files = await listGranthas(); if (!cancelled) { setPaths(files); setSelectedPath(null); setOpenTabs([]); } } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Granthas.'); } finally { if (!cancelled) setLoading(false); } })();
        return () => { cancelled = true; };
    }, []);

    const selectedParts = useMemo(() => normalizeGranthaPath(selectedPath).split('/').filter(Boolean), [selectedPath]);
    const selectedFileName = selectedParts[selectedParts.length - 1] ?? '';
    const selectedName = displayGranthaName(selectedFileName);
    const selectedFolder = selectedParts.slice(0, -1).map((part) => part.replace(/_/g, ' ')).join(' / ');
    const selectedIndex = selectedPath ? paths.indexOf(selectedPath) : -1;
    const isBookmarked = selectedPath ? bookmarks.includes(selectedPath) : false;
    const recentVisible = recentPaths.filter((path) => paths.includes(path));
    const bookmarkedVisible = bookmarks.filter((path) => paths.includes(path));
    const folderPrefix = folderPrefixForPath(selectedPath);
    const folderPaths = useMemo(() => folderPrefix ? paths.filter((path) => normalizeGranthaPath(path).startsWith(`${folderPrefix}/`)) : [], [paths, folderPrefix]);
    const currentSearchState = useMemo(() => findMatches(content, search.trim(), searchCaseSensitive, searchWholeWord, searchRegex), [content, search, searchCaseSensitive, searchWholeWord, searchRegex]);
    const matches = currentSearchState.matches;
    const stats = useMemo(() => getGranthaStats(content, selectedPath ?? ''), [content, selectedPath]);

    function publicFileUrl(filePath: string) { return `/data/${normalizeGranthaPath(filePath).split('/').map(encodeURIComponent).join('/')}`; }
    function persistSearchHistory(query: string, mode: SearchMode, caseSensitive: boolean, wholeWord: boolean, regex: boolean, scopePath = selectedPath ?? undefined) {
        const normalized = query.trim(); if (!normalized) return;
        setSearchHistory((previous) => {
            const nextEntry: SearchHistoryEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, query: normalized, mode, caseSensitive, wholeWord, regex, scopePath, createdAt: Date.now() };
            const next = [nextEntry, ...previous.filter((item) => !(item.query === normalized && item.mode === mode && item.caseSensitive === caseSensitive && item.wholeWord === wholeWord && item.regex === regex && item.scopePath === scopePath))].slice(0, 20);
            localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
            return next;
        });
    }
    function clearSearchHistory() { setSearchHistory([]); localStorage.removeItem(SEARCH_HISTORY_KEY); }
    function applyHistory(entry: SearchHistoryEntry) {
        setShowSearchHistory(false); setSearchMenuOpen(false); setActiveMatch(0);
        if (entry.mode === 'current') {
            if (entry.scopePath && paths.includes(entry.scopePath) && entry.scopePath !== selectedPath) selectGrantha(entry.scopePath);
            setSearch(entry.query); setSearchMode('current'); setSearchCaseSensitive(entry.caseSensitive); setSearchWholeWord(entry.wholeWord); setSearchRegex(entry.regex); setCurrentSearchOpen(true); return;
        }
        setGlobalSearchMode(entry.mode); setGlobalScopePath(entry.scopePath ?? selectedPath); setGlobalSearch(entry.query); setGlobalCaseSensitive(entry.caseSensitive); setGlobalWholeWord(entry.wholeWord); setGlobalRegex(entry.regex); setGlobalResults([]); setGlobalError(''); setCurrentSearchOpen(false); setGlobalOpen(true);
        if (entry.mode === 'folder') void runFolderSearch(entry.query, entry.caseSensitive, entry.wholeWord, entry.regex, entry.scopePath);
        else void runGlobalSearch(entry.query, entry.caseSensitive, entry.wholeWord, entry.regex);
    }
    function persistRecent(path: string) {
        setRecentPaths((previous) => { const next = [path, ...previous.filter((item) => item !== path)].slice(0, 10); localStorage.setItem(RECENT_KEY, JSON.stringify(next)); return next; });
    }
    function toggleBookmark(path: string) {
        setBookmarks((previous) => { const next = previous.includes(path) ? previous.filter((item) => item !== path) : [path, ...previous]; localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next)); return next; });
    }
    function updatePosition(path: string, position: number) {
        readingPositionsRef.current = { ...readingPositionsRef.current, [path]: position };
        if (positionSaveTimerRef.current) clearTimeout(positionSaveTimerRef.current);
        positionSaveTimerRef.current = setTimeout(() => {
            localStorage.setItem(POSITIONS_KEY, JSON.stringify(readingPositionsRef.current));
            positionSaveTimerRef.current = null;
        }, 150);
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
    function selectGrantha(path: string, fromGlobalResult = false, matchIndex = 0) {
        const normalizedPath = normalizeGranthaPath(path);
        setOpenTabs((previous) => previous.some((tab) => tab.path === normalizedPath) ? previous : [...previous, { path: normalizedPath }]);
        if (fromGlobalResult) {
            setPreviousGlobalState({ open: globalOpen, mode: globalSearchMode, scopePath: globalScopePath, query: globalSearch, caseSensitive: globalCaseSensitive, wholeWord: globalWholeWord, regex: globalRegex, results: globalResults, error: globalError, searching: globalSearching, selectedPath });
            setGlobalOpen(false);
        } else setPreviousGlobalState(null);
        setSelectedPath(normalizedPath); setActiveMatch(matchIndex); persistRecent(normalizedPath); setShowRecent(false); setShowBookmarks(false);
    }
    function closeGranthaTab(path: string) {
        setOpenTabs((previous) => {
            const index = previous.findIndex((tab) => tab.path === path);
            const next = previous.filter((tab) => tab.path !== path);
            if (selectedPath === path) {
                const fallback = next[index] ?? next[index - 1] ?? null;
                if (fallback) {
                    setSelectedPath(fallback.path);
                    setActiveMatch(0);
                    persistRecent(fallback.path);
                } else {
                    setSelectedPath(null);
                    setContent('');
                }
            }
            return next;
        });
    }
    function selectAdjacent(direction: -1 | 1) { const nextIndex = selectedIndex + direction; if (nextIndex >= 0 && nextIndex < paths.length) selectGrantha(paths[nextIndex]); }

    useEffect(() => {
        readingPositionsRef.current = readingPositions;
    }, [readingPositions]);

    useEffect(() => {
        return () => { if (positionSaveTimerRef.current) clearTimeout(positionSaveTimerRef.current); };
    }, []);

    useEffect(() => {
        if (!selectedPath) { setContent(''); setContentError(''); setCurrentSearchOpen(false); return; }
        let cancelled = false;
        (async () => { try { setContentLoading(true); setContentError(''); setContent(''); setActiveMatch(0); const response = await fetch(publicFileUrl(selectedPath)); if (!response.ok) throw new Error(`Unable to load ${selectedName}.`); const raw = await response.text(); if (cancelled) return; if (selectedPath.toLowerCase().endsWith('.json')) { try { setContent(JSON.stringify(JSON.parse(raw), null, 2)); } catch { setContent(raw); } } else setContent(raw); } catch (err) { if (!cancelled) setContentError(err instanceof Error ? err.message : 'Unable to load Grantha content.'); } finally { if (!cancelled) setContentLoading(false); } })();
        return () => { cancelled = true; };
    }, [selectedPath, selectedName]);

    useEffect(() => {
        if (!selectedPath || contentLoading || !content || !viewerRef.current) return;
        const position = readingPositionsRef.current[selectedPath] ?? 0;
        requestAnimationFrame(() => {
            if (viewerRef.current) viewerRef.current.scrollTop = Math.min(position, Math.max(0, viewerRef.current.scrollHeight - viewerRef.current.clientHeight));
        });
    }, [selectedPath, contentLoading, content]);

    useEffect(() => {
        function handleFullscreenChange() { setIsFullscreen(Boolean(document.fullscreenElement)); }
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    useEffect(() => { if (activeMatch >= matches.length) setActiveMatch(Math.max(0, matches.length - 1)); }, [matches.length, activeMatch]);
    useEffect(() => { if (!currentSearchOpen || !search || matches.length === 0) return; viewerRef.current?.querySelector<HTMLElement>(`[data-search-match="${activeMatch}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [activeMatch, matches.length, search, content, currentSearchOpen]);

    function handleViewerScroll() { if (selectedPath && viewerRef.current) updatePosition(selectedPath, viewerRef.current.scrollTop); }
    async function toggleFullscreen() {
        if (!detailRef.current) return;
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await detailRef.current.requestFullscreen(); } catch { /* Fullscreen may be unavailable in embedded browsers. */ }
    }
    function nextMatch() { if (matches.length) setActiveMatch((value) => (value + 1) % matches.length); }
    function previousMatch() { if (matches.length) setActiveMatch((value) => (value - 1 + matches.length) % matches.length); }
    function renderContent() {
        if (!currentSearchOpen || !search.trim() || matches.length === 0 || currentSearchState.error) return <pre>{content}</pre>;
        const parts: ReactNode[] = []; let cursor = 0;
        matches.forEach((match, index) => { if (match.start > cursor) parts.push(content.slice(cursor, match.start)); parts.push(<mark key={`${match.start}-${match.end}-${index}`} className={index === activeMatch ? 'granthas-search-match is-active' : 'granthas-search-match'} data-search-match={index}>{content.slice(match.start, match.end)}</mark>); cursor = match.end; });
        if (cursor < content.length) parts.push(content.slice(cursor));
        return <pre>{parts}</pre>;
    }

    async function searchPaths(candidatePaths: string[], query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean, update: (results: GlobalResult[]) => void, runId: number) {
        const results: GlobalResult[] = [];
        const uniquePaths = Array.from(new Set(candidatePaths.map(normalizeGranthaPath).filter(Boolean)));
        const batchSize = 8;
        for (let i = 0; i < uniquePaths.length; i += batchSize) {
            if (runId !== searchRunRef.current) return results;
            const batch = uniquePaths.slice(i, i + batchSize);
            const found = await Promise.all(batch.map(async (path) => {
                try {
                    const response = await fetch(publicFileUrl(path)); if (!response.ok) return null;
                    const text = await response.text(); const state = findMatches(text, query, caseSensitive, wholeWord, regex); if (state.error || !state.matches.length) return null;
                    const snippets = state.matches.slice(0, 3).map((match) => text.slice(Math.max(0, match.start - 90), Math.min(text.length, match.end + 130)).replace(/\s+/g, ' ').trim());
                    return { path, name: displayGranthaName(path.split('/').pop() || path), matches: state.matches.length, snippets, firstMatch: state.matches[0].start };
                } catch { return null; }
            }));
            if (runId !== searchRunRef.current) return results;
            results.push(...found.filter((item): item is GlobalResult => Boolean(item)));
            update([...results]);
        }
        return results;
    }

    async function runFolderSearch(queryOverride = search, caseSensitive = searchCaseSensitive, wholeWord = searchWholeWord, regex = searchRegex, scopePath = globalScopePath ?? selectedPath) {
        const query = queryOverride.trim(); if (!query) { setFolderResults([]); setFolderError(''); return; }
        const prefix = folderPrefixForPath(scopePath);
        const normalizedPaths = paths.map(normalizeGranthaPath).filter(Boolean);
        const candidatePaths = prefix
            ? normalizedPaths.filter((path) => path.startsWith(`${prefix}/`))
            : normalizedPaths;
        const test = findMatches('', query, caseSensitive, wholeWord, regex); if (test.error) { setFolderError(test.error); setFolderResults([]); return; }
        const runId = ++searchRunRef.current;
        setFolderSearching(true); setFolderError(''); setFolderResults([]); persistSearchHistory(query, 'folder', caseSensitive, wholeWord, regex, scopePath);
        try { await searchPaths(candidatePaths, query, caseSensitive, wholeWord, regex, setFolderResults, runId); } finally { if (runId === searchRunRef.current) setFolderSearching(false); }
    }

    async function runGlobalSearch(queryOverride = globalSearch, caseSensitive = globalCaseSensitive, wholeWord = globalWholeWord, regex = globalRegex) {
        const query = queryOverride.trim(); if (!query) { setGlobalResults([]); setGlobalError(''); return; }
        const test = findMatches('', query, caseSensitive, wholeWord, regex); if (test.error) { setGlobalError(test.error); setGlobalResults([]); return; }
        const runId = ++searchRunRef.current;
        setGlobalSearching(true); setGlobalError(''); setGlobalResults([]); persistSearchHistory(query, 'all', caseSensitive, wholeWord, regex, selectedPath ?? undefined);
        try { await searchPaths(paths, query, caseSensitive, wholeWord, regex, setGlobalResults, runId); } finally { if (runId === searchRunRef.current) setGlobalSearching(false); }
    }

    function openSearchMode(mode: SearchMode) {
        setSearchMode(mode); setSearchMenuOpen(false); setShowSearchHistory(false); setActiveMatch(0);
        if (mode === 'current') { setCurrentSearchOpen(true); return; }
        setCurrentSearchOpen(false);
        setGlobalSearchMode(mode); setGlobalScopePath(selectedPath); setGlobalSearch(search); setGlobalCaseSensitive(searchCaseSensitive); setGlobalWholeWord(searchWholeWord); setGlobalRegex(searchRegex); setGlobalError('');
        if (mode === 'folder') { setFolderResults([]); setGlobalOpen(true); return; }
        setGlobalResults([]); setGlobalOpen(true);
    }
    function submitActiveSearch() {
        if (searchMode === 'current') { persistSearchHistory(search, 'current', searchCaseSensitive, searchWholeWord, searchRegex, selectedPath ?? undefined); setActiveMatch(0); return; }
        const scopePath = selectedPath;
        setCurrentSearchOpen(false); setGlobalSearch(search); setGlobalCaseSensitive(searchCaseSensitive); setGlobalWholeWord(searchWholeWord); setGlobalRegex(searchRegex); setGlobalSearchMode(searchMode); setGlobalScopePath(scopePath);
        setGlobalOpen(true);
        if (searchMode === 'folder') { void runFolderSearch(search, searchCaseSensitive, searchWholeWord, searchRegex, scopePath); return; }
        void runGlobalSearch(search, searchCaseSensitive, searchWholeWord, searchRegex);
    }
    function openFolderResult(result: GlobalResult) {
        setSearch(globalSearch); setSearchCaseSensitive(globalCaseSensitive); setSearchWholeWord(globalWholeWord); setSearchRegex(globalRegex); setSearchMode('current'); setCurrentSearchOpen(true); setActiveMatch(0); selectGrantha(result.path, true, 0);
    }
    function openGlobalResult(path: string, matchIndex = 0) {
        setSearch(globalSearch); setSearchCaseSensitive(globalCaseSensitive); setSearchWholeWord(globalWholeWord); setSearchRegex(globalRegex); setSearchMode('current'); setCurrentSearchOpen(true); setActiveMatch(matchIndex); selectGrantha(path, true, matchIndex);
    }
    function returnToSearchResults() {
        if (!previousGlobalState) return;
        const state = previousGlobalState;
        setSelectedPath(state.selectedPath); setGlobalSearch(state.query); setGlobalCaseSensitive(state.caseSensitive); setGlobalWholeWord(state.wholeWord); setGlobalRegex(state.regex); setGlobalResults(state.results); setGlobalError(state.error); setGlobalSearching(state.searching); setGlobalSearchMode(state.mode); setGlobalScopePath(state.scopePath); setGlobalOpen(true); setSearch(''); setSearchMode('current'); setSearchCaseSensitive(false); setSearchWholeWord(false); setSearchRegex(false); setActiveMatch(0); setCurrentSearchOpen(false); setPreviousGlobalState(null);
    }

    const topSearchResults = globalSearchMode === 'folder' ? folderResults : globalResults;
    const topSearchSearching = globalSearchMode === 'folder' ? folderSearching : globalSearching;
    const topSearchError = globalSearchMode === 'folder' ? folderError : globalError;
    const topSearchLabel = globalSearchMode === 'folder' ? `Search current folder${selectedFolder ? ` · ${selectedFolder}` : ''}` : 'Advanced Global Search';
    const topSearchPlaceholder = globalSearchMode === 'folder' ? 'Search current folder…' : 'Search all Granthas…';
    const topSearchCount = globalSearchMode === 'folder' ? `${folderResults.length} Granthas matched` : `${globalResults.length} Granthas matched`;

    return (<><Navbar /><main className="container granthas-page">
        <div className="granthas-page-header"><div><h1>Granthas</h1><p>Explore the complete collection of sacred texts and works available in the application.</p></div><div className="granthas-actions"><button className="granthas-action secondary" type="button" onClick={() => { setGlobalSearchMode('all'); setGlobalScopePath(selectedPath); setGlobalOpen((v) => !v); setCurrentSearchOpen(false); if (globalOpen) setGlobalResults([]); }}>⌕ Advanced Global Search</button><Link className="granthas-action secondary" to="/dataset?mode=existing">Edit Dataset</Link><Link className="granthas-action primary" to="/dataset?mode=new">+ Create Dataset</Link></div></div>
        {error && <div className="granthas-error">{error}</div>}
        {globalOpen && <section className="granthas-global-search">
            <div className="granthas-global-search-header"><div><h2>{topSearchLabel}</h2><p>{globalSearchMode === 'folder' ? 'Search every Grantha in the currently opened folder.' : 'Search across every available Grantha.'}</p></div><button type="button" onClick={() => setGlobalOpen(false)} aria-label="Close search">✕</button></div>
            <div className="granthas-global-search-controls"><IASTSearchInput value={globalSearch} onChange={setGlobalSearch} onSubmit={() => { if (globalSearchMode === 'folder') void runFolderSearch(); else void runGlobalSearch(); }} content={paths.join(' ')} placeholder={topSearchPlaceholder} ariaLabel={topSearchLabel} /><button type="button" className="granthas-global-run" onClick={() => { if (globalSearchMode === 'folder') void runFolderSearch(); else void runGlobalSearch(); }} disabled={topSearchSearching || !globalSearch.trim()}>{topSearchSearching ? 'Searching…' : 'Search'}</button></div>
            <div className="granthas-search-options"><label><input type="checkbox" checked={globalCaseSensitive} onChange={(e) => setGlobalCaseSensitive(e.target.checked)} /> Case sensitive</label><label><input type="checkbox" checked={globalWholeWord} onChange={(e) => setGlobalWholeWord(e.target.checked)} /> Whole word</label><label><input type="checkbox" checked={globalRegex} onChange={(e) => setGlobalRegex(e.target.checked)} /> Regex</label><span className="granthas-search-count">{topSearchCount}</span></div>
            {topSearchError && <div className="granthas-search-error">{topSearchError}</div>}
            <div className="granthas-global-results">{topSearchSearching && topSearchResults.length === 0 ? <div className="granthas-content-state">Searching {globalSearchMode === 'folder' ? 'current folder' : 'Granthas'}…</div> : topSearchResults.length ? topSearchResults.map((result) => <button type="button" className="granthas-global-result" key={result.path} onClick={() => globalSearchMode === 'folder' ? openFolderResult(result) : openGlobalResult(result.path)}><div className="granthas-global-result-title"><span>{result.name}</span><small>{result.matches} match{result.matches === 1 ? '' : 'es'}</small></div>{result.snippets.map((snippet, i) => <div className="granthas-global-snippet" key={i}>{snippet}</div>)}</button>) : !topSearchSearching && globalSearch.trim() ? <div className="granthas-tree-empty">No matches found.</div> : <div className="granthas-tree-empty">Enter a word to search {globalSearchMode === 'folder' ? 'the current folder' : 'all Granthas'}.</div>}</div>
        </section>}
        {openTabs.length > 0 && <div className="granthas-tabs" role="tablist" aria-label="Opened Granthas">{openTabs.map((tab) => { const name = displayGranthaName(tab.path.split('/').pop() || tab.path); const active = tab.path === selectedPath; return <div className={`granthas-tab ${active ? 'is-active' : ''}`} key={tab.path}><button type="button" role="tab" aria-selected={active} className="granthas-tab-main" onClick={() => selectGrantha(tab.path)} title={name}>{name}</button><button type="button" className="granthas-tab-close" onClick={() => closeGranthaTab(tab.path)} aria-label={`Close ${name}`}>×</button></div>; })}</div>}
        <section className="granthas-layout"><GranthasTree paths={paths} selectedPath={selectedPath} onSelect={(path) => selectGrantha(path)} /><div className="granthas-detail" ref={detailRef}>{loading ? <div className="granthas-empty-state">Loading Granthas…</div> : selectedPath ? <><div className="granthas-detail-topline">{selectedFolder || 'Granthas'}</div><div className="granthas-detail-heading"><div><h2>{selectedName}</h2><p className="granthas-detail-path">public/data/{selectedPath}</p></div><div className="granthas-detail-heading-actions">
            <div className="granthas-popover-wrap"><button type="button" className="granthas-reader-button" onClick={() => { setShowRecent((v) => !v); setShowBookmarks(false); }}>{'◷ Recently opened'}</button>{showRecent && <div className="granthas-popover">{recentVisible.length ? recentVisible.map((path) => <button type="button" key={path} onClick={() => selectGrantha(path)}>{displayGranthaName(path.split('/').pop() || path)}</button>) : <span>No recently opened Granthas.</span>}</div>}</div>
            <div className="granthas-popover-wrap"><button type="button" className={`granthas-reader-button ${isBookmarked ? 'is-active' : ''}`} onClick={() => { if (selectedPath) toggleBookmark(selectedPath); setShowBookmarks((v) => !v); setShowRecent(false); }}>{isBookmarked ? '★ Bookmarked' : '☆ Bookmark'}</button>{showBookmarks && <div className="granthas-popover">{bookmarkedVisible.length ? bookmarkedVisible.map((path) => <button type="button" key={path} onClick={() => selectGrantha(path)}>{displayGranthaName(path.split('/').pop() || path)}</button>) : <span>No bookmarks yet.</span>}</div>}</div>
            <button type="button" className="granthas-reader-button" onClick={() => selectAdjacent(-1)} disabled={selectedIndex <= 0} aria-label="Previous Grantha">← Previous</button><button type="button" className="granthas-reader-button" onClick={() => selectAdjacent(1)} disabled={selectedIndex < 0 || selectedIndex >= paths.length - 1} aria-label="Next Grantha">Next →</button>
            {previousGlobalState && <button type="button" className="granthas-back-button" onClick={returnToSearchResults}>← Back to search result</button>}
            <div className="granthas-search-menu-wrap"><button type="button" className={`granthas-search-toggle ${currentSearchOpen ? 'is-active' : ''}`} onClick={() => { setSearchMenuOpen((v) => !v); setShowSearchHistory(false); }} aria-expanded={searchMenuOpen || currentSearchOpen} aria-haspopup="menu">⌕ Search</button>{searchMenuOpen && <div className="granthas-search-menu" role="menu"><button type="button" onClick={() => openSearchMode('current')} role="menuitem"><strong>⌕ Search in current Grantha</strong><small>{selectedName}</small></button><button type="button" onClick={() => openSearchMode('folder')} role="menuitem"><strong>⌕ Search current folder</strong><small>{selectedFolder || 'No folder selected'}</small></button><button type="button" onClick={() => openSearchMode('all')} role="menuitem"><strong>⌕ Search in all Granthas</strong><small>{paths.length} files</small></button></div>}</div>
            <div className="granthas-popover-wrap"><button type="button" className="granthas-reader-button" onClick={() => { setShowSearchHistory((v) => !v); setSearchMenuOpen(false); setShowRecent(false); setShowBookmarks(false); }}>◷ Search history</button>{showSearchHistory && <div className="granthas-popover granthas-history-popover">{searchHistory.length ? <>{searchHistory.map((entry) => <button type="button" key={entry.id} onClick={() => applyHistory(entry)}><strong>{entry.query}</strong><small>{entry.mode === 'current' ? `Current Grantha${entry.scopePath ? ` · ${displayGranthaName(entry.scopePath.split('/').pop() || entry.scopePath)}` : ''}` : entry.mode === 'folder' ? `Current folder${entry.scopePath ? ` · ${entry.scopePath.split('/').slice(0, -1).map((part) => part.replace(/_/g, ' ')).join(' / ')}` : ''}` : 'All Granthas'} · {new Date(entry.createdAt).toLocaleString('en-IN')}</small></button>)}<button type="button" className="granthas-history-clear" onClick={clearSearchHistory}>Clear history</button></> : <span>No search history yet.</span>}</div>}</div>
            <button type="button" className="granthas-reader-button" onClick={toggleFullscreen}>{isFullscreen ? '⛶ Exit full screen' : '⛶ Full screen'}</button>
        </div></div>
        {currentSearchOpen && <div id="current-grantha-search" className="granthas-advanced-search" aria-label="Advanced Grantha search">
            <div className="granthas-search-mode-heading"><strong>Search in current Grantha</strong><button type="button" onClick={() => setCurrentSearchOpen(false)}>Close</button></div>
            <IASTSearchInput value={search} onChange={(value) => { setSearch(value); setActiveMatch(0); }} onSubmit={submitActiveSearch} content={content} />
            <div className="granthas-search-options"><label><input type="checkbox" checked={searchCaseSensitive} onChange={(e) => { setSearchCaseSensitive(e.target.checked); setActiveMatch(0); }} /> Case sensitive</label><label><input type="checkbox" checked={searchWholeWord} onChange={(e) => { setSearchWholeWord(e.target.checked); setActiveMatch(0); }} /> Whole word</label><label><input type="checkbox" checked={searchRegex} onChange={(e) => { setSearchRegex(e.target.checked); setActiveMatch(0); }} /> Regex</label><span className="granthas-search-count">{currentSearchState.error ? 'Invalid search' : search.trim() ? `${matches.length ? activeMatch + 1 : 0} of ${matches.length}` : 'Enter a search term'}</span><button type="button" onClick={previousMatch} disabled={!matches.length} aria-label="Previous match">↑</button><button type="button" onClick={nextMatch} disabled={!matches.length} aria-label="Next match">↓</button></div>
            {currentSearchState.error && <div className="granthas-search-error">{currentSearchState.error}</div>}
        </div>}
        <div className="granthas-reading-toolbar"><span>Reading controls</span><button type="button" onClick={() => changeFontSize(-1)} aria-label="Decrease font size">A−</button><button type="button" onClick={resetReadingControls} aria-label="Reset reading controls">A</button><button type="button" onClick={() => changeFontSize(1)} aria-label="Increase font size">A+</button><span className="granthas-toolbar-divider" aria-hidden="true" /><button type="button" onClick={() => changeLineHeight(-0.1)} aria-label="Decrease line spacing">− spacing</button><button type="button" onClick={() => changeLineHeight(0.1)} aria-label="Increase line spacing">+ spacing</button><span className="granthas-reading-value">{fontSize}px · {lineHeight.toFixed(1)}×</span></div>
        <div className="granthas-statistics" aria-label="Grantha statistics"><div><span>Characters</span><strong>{stats.characters.toLocaleString('en-IN')}</strong></div><div><span>Words</span><strong>{stats.words.toLocaleString('en-IN')}</strong></div><div><span>Lines</span><strong>{stats.lines.toLocaleString('en-IN')}</strong></div><div><span>Sections</span><strong>{stats.sections.toLocaleString('en-IN')}</strong></div><div><span>Searchable</span><strong className="is-yes">Yes</strong></div><div><span>Semantic index</span><strong className="is-yes">Yes</strong></div></div>
        <div className="granthas-content-viewer" ref={viewerRef} onScroll={handleViewerScroll}>{contentLoading ? <div className="granthas-content-state">Loading Grantha…</div> : contentError ? <div className="granthas-content-state is-error">{contentError}</div> : <div className="granthas-content-text" style={{ '--granthas-font-size': `${fontSize}px`, '--granthas-line-height': lineHeight } as React.CSSProperties}>{renderContent()}</div>}</div>
        <TextIntelligence selectedPath={selectedPath} selectedName={selectedName} paths={paths} onOpenGrantha={(path) => selectGrantha(path)} />
        </> : null}</div></section>
    </main><Footer />
    <style>{`\
      .granthas-search-menu-wrap { position: relative; flex: 0 0 auto; }\
      .granthas-search-menu { position:absolute; z-index:50; top:calc(100% + 6px); right:0; width:min(340px, 78vw); padding:6px; border:1px solid #d8cec8; border-radius:9px; background:#fff; box-shadow:0 10px 28px rgba(0,0,0,.16); }\
      .granthas-search-menu button { display:block; width:100%; border:0; background:transparent; border-radius:7px; padding:10px; text-align:left; color:#302b28; cursor:pointer; font:inherit; }\
      .granthas-search-menu button:hover { background:#f4ebe6; color:#7A1F1F; }\
      .granthas-search-menu strong { display:block; font-size:13px; }\
      .granthas-search-menu small { display:block; margin-top:3px; color:#888; font-size:11px; overflow-wrap:anywhere; }\
      .granthas-search-mode-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; color:#7A1F1F; font-size:13px; }\
      .granthas-search-mode-heading button { border:1px solid #d8cec8; background:#faf8f6; border-radius:5px; padding:4px 8px; color:#7A1F1F; cursor:pointer; font:inherit; font-size:11px; }\
      .granthas-history-popover { width:min(390px, 82vw); }\
      .granthas-history-popover button { display:block; width:100%; }\
      .granthas-history-popover strong { display:block; color:#7A1F1F; font-size:13px; }\
      .granthas-history-popover small { display:block; margin-top:3px; color:#888; font-size:10px; }\
      .granthas-history-clear { border-top:1px solid #eee8e3 !important; margin-top:4px; color:#a32020 !important; }\
      @media (max-width:800px) { .granthas-search-menu { left:0; right:auto; } .granthas-history-popover { left:auto; right:0; } }\
    `}</style></>);
}
export default Granthas;
