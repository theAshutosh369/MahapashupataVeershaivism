import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { RAGLogEntry } from '../../types/rag';

const LogsIcon = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>
    </svg>
);

export default function LiveRagLogs() {
    const [logs, setLogs] = useState<RAGLogEntry[]>([]);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(false);
    const [position, setPosition] = useState({ top: 0, right: 16 });
    const logScrollRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const onLog = (event: Event) => {
            const detail = (event as CustomEvent<RAGLogEntry>).detail;
            if (!detail?.message) return;
            setActive(true);
            setLogs((previous) => [...previous, detail]);
        };
        const onComplete = (event: Event) => {
            const detail = (event as CustomEvent<{ logs?: RAGLogEntry[] }>).detail;
            if (Array.isArray(detail?.logs)) setLogs(detail.logs);
            setActive(false);
        };
        const onStart = () => { setLogs([]); setOpen(false); setActive(true); };
        window.addEventListener('rag-query-log-live', onLog);
        window.addEventListener('rag-query-logs-complete', onComplete);
        window.addEventListener('rag-query-log-start', onStart);
        return () => {
            window.removeEventListener('rag-query-log-live', onLog);
            window.removeEventListener('rag-query-logs-complete', onComplete);
            window.removeEventListener('rag-query-log-start', onStart);
        };
    }, []);

    useEffect(() => {
        if (open && logScrollRef.current) logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }, [open, logs]);

    useEffect(() => {
        const updatePosition = () => {
            const bubbles = document.querySelectorAll<HTMLElement>('.user-message-bubble');
            const bubble = bubbles[bubbles.length - 1];
            if (!bubble) return;
            const rect = bubble.getBoundingClientRect();
            setPosition({
                top: Math.max(8, rect.bottom + 6),
                right: Math.max(12, window.innerWidth - rect.right)
            });
        };
        updatePosition();
        const observer = new MutationObserver(updatePosition);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [logs.length, active]);

    if (!active && !logs.length) return null;

    const panel = open ? (
        <div style={{ position: 'fixed', top: Math.min(position.top, Math.max(12, window.innerHeight - 500)), right: position.right, width: 'min(560px, calc(100vw - 24px))', maxHeight: 'min(520px, calc(100vh - 24px))', zIndex: 10000, background: '#111827', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 10, boxShadow: '0 12px 35px rgba(0,0,0,.28)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', background: '#1f2937', borderBottom: '1px solid #374151', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Live application logs</span>
                <span style={{ fontSize: 11, opacity: .7 }}>{logs.length} entries · IST {active ? '· LIVE' : '· COMPLETE'}</span>
            </div>
            <div ref={logScrollRef} style={{ maxHeight: 450, overflowY: 'auto', padding: 10, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5, lineHeight: 1.55 }}>
                {logs.length ? logs.map((log, index) => (
                    <div key={`${log.time}-${index}`} style={{ display: 'grid', gridTemplateColumns: '166px 48px 1fr', gap: 8, padding: '3px 0', color: log.level === 'error' ? '#fca5a5' : log.level === 'warn' ? '#fcd34d' : '#d1d5db' }}>
                        <span style={{ opacity: .78 }}>{log.time}</span>
                        <span style={{ textTransform: 'uppercase' }}>{log.level}</span>
                        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{log.message}</span>
                    </div>
                )) : <div style={{ opacity: .7 }}>Waiting for application logs…</div>}
            </div>
        </div>
    ) : null;

    const button = (
        <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            title="View live application logs for this question"
            aria-label="View live application logs for this question"
            style={{ position: 'fixed', top: position.top, right: position.right, zIndex: 10001, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 9px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.12)' }}
        >
            <LogsIcon /> {open ? 'Hide logs' : 'Logs'}{active ? ' •' : ''}
        </button>
    );

    return createPortal(<>{button}{panel}</>, document.body);
}
