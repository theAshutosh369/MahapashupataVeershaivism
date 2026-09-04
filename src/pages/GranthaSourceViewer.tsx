import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

function cleanName(value: string) {
    return decodeURIComponent(value).split('/').pop()?.replace(/\.[^.]+$/, '').replace(/_/g, ' ') || value;
}

function normalize(value: string) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function firstSearchPhrase(value: string) {
    const normalized = normalize(value);
    if (!normalized) return '';
    return normalized.length > 90 ? normalized.slice(0, 90) : normalized;
}

export default function GranthaSourceViewer() {
    const [params] = useSearchParams();
    const path = params.get('path') || '';
    const match = params.get('match') || '';
    const [text, setText] = useState('');
    const [error, setError] = useState('');
    const matchRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        setText('');
        setError('');
        if (!path) {
            setError('No Grantha source was supplied.');
            return;
        }
        const cleanPath = path.replace(/^\/+/, '').replace(/^data\//, '');
        fetch(`/data/${cleanPath}`)
            .then(async (response) => {
                if (!response.ok) throw new Error(`Unable to load the source (${response.status}).`);
                return response.text();
            })
            .then((value) => { if (!cancelled) setText(value); })
            .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load the source.'); });
        return () => { cancelled = true; };
    }, [path]);

    const displayText = useMemo(() => {
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
        } catch {
            return text;
        }
    }, [text]);

    const highlighted = useMemo(() => {
        if (!displayText || !match) return null;
        const target = firstSearchPhrase(match);
        if (!target) return null;
        const lines = displayText.split(/\r?\n/);
        const normalizedLines = lines.map(normalize);
        let matchLine = normalizedLines.findIndex((line) => line.includes(target));

        // If the evidence spans line breaks, locate its first distinctive phrase.
        if (matchLine < 0) {
            const words = target.split(/\s+/).filter((word) => word.length >= 3);
            const phrase = words.slice(0, 10).join(' ');
            if (phrase) matchLine = normalizedLines.findIndex((line) => line.includes(phrase));
        }
        if (matchLine < 0) return null;
        return { lines, matchLine };
    }, [displayText, match]);

    useEffect(() => {
        if (!highlighted) return;
        requestAnimationFrame(() => matchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }, [highlighted]);

    return (
        <div style={{ minHeight: '100vh', background: '#f8f5f2', color: '#332a27' }}>
            <header style={{ position: 'sticky', top: 0, zIndex: 10, background: '#fff', borderBottom: '1px solid #e3dad4', padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                <Link to="/granthas" style={{ textDecoration: 'none', color: '#7A1F1F', fontWeight: 700 }}>← Granthas</Link>
                <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cleanName(path)}</div>
                    {match && <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>Showing exact evidence match</div>}
                </div>
            </header>

            <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 18px 50px' }}>
                {error && <div style={{ padding: 14, border: '1px solid #edcaca', borderRadius: 10, background: '#fff1f1', color: '#9c2525' }}>{error}</div>}

                {match && highlighted && <section style={{ marginBottom: 18, padding: 16, border: '1px solid #e0c8b9', borderRadius: 12, background: '#fffaf6', boxShadow: '0 5px 20px rgba(60,40,30,.07)' }}>
                    <div style={{ color: '#7A1F1F', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Exact evidence used by the AI</div>
                    <div ref={(node) => { matchRef.current = node; }} style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                        {highlighted.lines[highlighted.matchLine]}
                    </div>
                </section>}

                {match && !highlighted && displayText && <div style={{ marginBottom: 16, padding: 12, borderRadius: 9, background: '#fff8e5', border: '1px solid #ead7a5', color: '#765b1e', fontSize: 12 }}>The source was loaded, but the retrieved excerpt could not be located verbatim in the displayed text.</div>}

                {displayText && <section style={{ border: '1px solid #e0d8d3', borderRadius: 12, background: '#fff', overflow: 'hidden', boxShadow: '0 6px 22px rgba(50,35,25,.06)' }}>
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid #eee7e2', color: '#777', fontSize: 11 }}>Full source text · {displayText.length.toLocaleString()} characters</div>
                    <pre style={{ margin: 0, padding: 18, maxHeight: 'calc(100vh - 160px)', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.7 }}>
                        {highlighted ? highlighted.lines.map((line, index) => {
                            const isMatch = index === highlighted.matchLine;
                            return <span key={index} ref={isMatch ? (node) => { matchRef.current = node; } : undefined} style={isMatch ? { display: 'block', background: '#fff0a8', borderLeft: '4px solid #7A1F1F', padding: '5px 9px', margin: '0 -9px' } : undefined}>{line}{index < highlighted.lines.length - 1 ? '\n' : ''}</span>;
                        }) : displayText}
                    </pre>
                </section>}
            </main>
        </div>
    );
}
