import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import GranthasTree from '../components/GranthasTree';
import { listGranthas } from '../api_granthas';
import '../styles/pages/granthas.css';

function displayGranthaName(fileName: string) {
    return String(fileName || '').replace(/_/g, ' ').replace(/\.(txt|json)$/i, '');
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type SearchMatch = { start: number; end: number };

function Granthas() {
    const [paths, setPaths] = useState<string[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [contentLoading, setContentLoading] = useState(false);
    const [contentError, setContentError] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regexMode, setRegexMode] = useState(false);
    const [activeMatch, setActiveMatch] = useState(0);
    const viewerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setLoading(true);
                setError('');
                const files = await listGranthas();
                if (!cancelled) {
                    setPaths(files);
                    setSelectedPath(files[0] ?? null);
                }
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Granthas.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const selectedParts = useMemo(() => (selectedPath ?? '').split('/').filter(Boolean), [selectedPath]);
    const selectedFileName = selectedParts[selectedParts.length - 1] ?? '';
    const selectedName = displayGranthaName(selectedFileName);
    const selectedFolder = selectedParts.slice(0, -1).map((part) => part.replace(/_/g, ' ')).join(' / ');

    function publicFileUrl(filePath: string) {
        return `/data/${filePath.split('/').map(encodeURIComponent).join('/')}`;
    }

    useEffect(() => {
        if (!selectedPath) {
            setContent('');
            setContentError('');
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                setContentLoading(true);
                setContentError('');
                setContent('');
                setSearch('');
                setActiveMatch(0);

                const response = await fetch(publicFileUrl(selectedPath), { method: 'GET' });
                if (!response.ok) throw new Error(`Unable to load ${selectedName}.`);

                const raw = await response.text();
                if (cancelled) return;

                if (selectedPath.toLowerCase().endsWith('.json')) {
                    try { setContent(JSON.stringify(JSON.parse(raw), null, 2)); }
                    catch { setContent(raw); }
                } else {
                    setContent(raw);
                }
            } catch (err) {
                if (!cancelled) setContentError(err instanceof Error ? err.message : 'Unable to load Grantha content.');
            } finally {
                if (!cancelled) setContentLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [selectedPath, selectedName]);

    const searchState = useMemo(() => {
        const query = search.trim();
        if (!query) return { matches: [] as SearchMatch[], error: '' };

        let pattern = regexMode ? query : escapeRegExp(query);
        if (wholeWord) pattern = `\\b(?:${pattern})\\b`;

        try {
            const expression = new RegExp(pattern, `g${caseSensitive ? '' : 'i'}`);
            const matches: SearchMatch[] = [];
            let match: RegExpExecArray | null;
            while ((match = expression.exec(content)) !== null) {
                matches.push({ start: match.index, end: match.index + match[0].length });
                if (match[0].length === 0) expression.lastIndex += 1;
            }
            return { matches, error: '' };
        } catch (err) {
            return { matches: [] as SearchMatch[], error: err instanceof Error ? err.message : 'Invalid regular expression.' };
        }
    }, [content, search, caseSensitive, wholeWord, regexMode]);

    const matches = searchState.matches;
    useEffect(() => {
        if (activeMatch >= matches.length) setActiveMatch(Math.max(0, matches.length - 1));
    }, [matches.length, activeMatch]);

    useEffect(() => {
        if (!search || matches.length === 0) return;
        const target = viewerRef.current?.querySelector<HTMLElement>(`[data-search-match="${activeMatch}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [activeMatch, matches.length, search]);

    function nextMatch() {
        if (matches.length > 0) setActiveMatch((value) => (value + 1) % matches.length);
    }

    function previousMatch() {
        if (matches.length > 0) setActiveMatch((value) => (value - 1 + matches.length) % matches.length);
    }

    function renderContent() {
        if (!search.trim() || matches.length === 0 || searchState.error) return <pre>{content}</pre>;

        const parts: ReactNode[] = [];
        let cursor = 0;
        matches.forEach((match, index) => {
            if (match.start > cursor) parts.push(content.slice(cursor, match.start));
            parts.push(<mark key={`${match.start}-${match.end}-${index}`} className={index === activeMatch ? 'granthas-search-match is-active' : 'granthas-search-match'} data-search-match={index}>{content.slice(match.start, match.end)}</mark>);
            cursor = match.end;
        });
        if (cursor < content.length) parts.push(content.slice(cursor));
        return <pre>{parts}</pre>;
    }

    return (
        <>
            <Navbar />
            <main className="container granthas-page">
                <div className="granthas-page-header">
                    <div>
                        <h1>Granthas</h1>
                        <p>Explore the complete collection of sacred texts and works available in the application.</p>
                    </div>
                    <div className="granthas-actions">
                        <Link className="granthas-action secondary" to="/dataset?mode=existing">Edit Dataset</Link>
                        <Link className="granthas-action primary" to="/dataset?mode=new">+ Create Dataset</Link>
                    </div>
                </div>

                {error && <div className="granthas-error">{error}</div>}

                <section className="granthas-layout">
                    <GranthasTree paths={paths} selectedPath={selectedPath} onSelect={setSelectedPath} />
                    <div className="granthas-detail">
                        {loading ? (
                            <div className="granthas-empty-state">Loading Granthas…</div>
                        ) : selectedPath ? (
                            <>
                                <div className="granthas-detail-topline">{selectedFolder || 'Granthas'}</div>
                                <div className="granthas-detail-heading">
                                    <div>
                                        <h2>{selectedName}</h2>
                                        <p className="granthas-detail-path">public/data/{selectedPath}</p>
                                    </div>
                                </div>

                                <div className="granthas-advanced-search" aria-label="Advanced search in current Grantha">
                                    <div className="granthas-search-main">
                                        <span className="granthas-search-icon" aria-hidden="true">⌕</span>
                                        <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setActiveMatch(0); }} placeholder="Search in this Grantha…" aria-label="Search in current Grantha" />
                                        {search && <button type="button" className="granthas-search-clear" onClick={() => { setSearch(''); setActiveMatch(0); }} aria-label="Clear search">✕</button>}
                                    </div>
                                    <div className="granthas-search-options">
                                        <label><input type="checkbox" checked={caseSensitive} onChange={(event) => { setCaseSensitive(event.target.checked); setActiveMatch(0); }} /> Case sensitive</label>
                                        <label><input type="checkbox" checked={wholeWord} onChange={(event) => { setWholeWord(event.target.checked); setActiveMatch(0); }} /> Whole word</label>
                                        <label><input type="checkbox" checked={regexMode} onChange={(event) => { setRegexMode(event.target.checked); setActiveMatch(0); }} /> Regex</label>
                                        <span className="granthas-search-count">{searchState.error ? 'Invalid search' : search.trim() ? `${matches.length ? activeMatch + 1 : 0} of ${matches.length}` : 'Search current Grantha'}</span>
                                        <button type="button" onClick={previousMatch} disabled={matches.length === 0} aria-label="Previous match">↑</button>
                                        <button type="button" onClick={nextMatch} disabled={matches.length === 0} aria-label="Next match">↓</button>
                                    </div>
                                    {searchState.error && <div className="granthas-search-error">{searchState.error}</div>}
                                </div>

                                <div className="granthas-content-viewer" ref={viewerRef}>
                                    {contentLoading ? (
                                        <div className="granthas-content-state">Loading Grantha…</div>
                                    ) : contentError ? (
                                        <div className="granthas-content-state is-error">{contentError}</div>
                                    ) : renderContent()}
                                </div>
                            </>
                        ) : (
                            <div className="granthas-empty-state">Select a Grantha from the left panel.</div>
                        )}
                    </div>
                </section>
            </main>
            <Footer />
        </>
    );
}

export default Granthas;
