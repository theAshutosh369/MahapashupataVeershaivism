import { useEffect, useRef, useState } from 'react';
import type { RAGLogEntry } from '../../types/rag';

const LogsIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 8h10M7 12h10M7 16h6" />
    </svg>
);

export default function LiveRagLogs() {
    const [logs, setLogs] = useState<RAGLogEntry[]>([]);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(false);
    const [copied, setCopied] = useState(false);
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
        const onStart = () => {
            setLogs([]);
            setOpen(false);
            setCopied(false);
            setActive(true);
        };
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
        if (open && logScrollRef.current) {
            logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
        }
    }, [open, logs]);

    if (!active && !logs.length) return null;

    const handleCopyLogs = async () => {
        const text = logs.map((log) => `[${log.time}] ${log.level.toUpperCase()} ${log.message}`).join('\n');
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard access may be unavailable in some browser contexts.
        }
    };

    return (
        <div className="chat-live-logs">
            <button
                type="button"
                className="chat-message-action-btn chat-live-logs-btn"
                onClick={() => setOpen((value) => !value)}
                title="View live application logs for this question"
                aria-label="View live application logs for this question"
                aria-expanded={open}
            >
                <LogsIcon />
                {open ? 'Hide logs' : 'Logs'}{active ? ' •' : ''}
            </button>
            {open && (
                <div className="chat-live-logs-panel" role="region" aria-label="Live application logs">
                    <div className="chat-live-logs-header">
                        <span className="chat-live-logs-title">Live application logs</span>
                        <div className="chat-live-logs-meta">
                            <span>{logs.length} entries · IST {active ? '· LIVE' : '· COMPLETE'}</span>
                            <button type="button" className="chat-live-logs-copy" onClick={handleCopyLogs}>
                                {copied ? 'Copied' : 'Copy logs'}
                            </button>
                        </div>
                    </div>
                    <div ref={logScrollRef} className="chat-live-logs-body">
                        {logs.length ? logs.map((log, index) => (
                            <div key={`${log.time}-${index}`} className={`chat-live-log-row chat-live-log-${log.level}`}>
                                <span className="chat-live-log-time">{log.time}</span>
                                <span className="chat-live-log-level">{log.level}</span>
                                <span className="chat-live-log-message">{log.message}</span>
                            </div>
                        )) : (
                            <div className="chat-live-logs-empty">Waiting for application logs…</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
