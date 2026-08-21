import { useEffect, useRef, useState } from 'react';

type ChatContextMenuProps = {
    pinned: boolean;
    onRename: () => void;
    onTogglePin: () => void;
    onDelete: () => void;
};

const DotsIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="12" cy="19" r="1.6" />
    </svg>
);

const PinIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
);

const RenameIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
);

const TrashIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
);

/**
 * A small three-dot dropdown menu for a single conversation row.
 * Renders Rename / Pin-Unpin / Delete actions.
 */
export default function ChatContextMenu({ pinned, onRename, onTogglePin, onDelete }: ChatContextMenuProps) {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        function onPointerDown(e: PointerEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false);
        }
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    function run(action: () => void) {
        setOpen(false);
        action();
    }

    const triggerStyle: React.CSSProperties = {
        width: 30,
        height: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid #d1d5db',
        borderRadius: 6,
        background: '#fff',
        color: '#4b5563',
        cursor: 'pointer',
        padding: 0
    };

    const itemStyle: React.CSSProperties = {
        width: '100%',
        minHeight: 38,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 11px',
        border: 0,
        borderRadius: 7,
        background: 'transparent',
        color: '#374151',
        fontSize: 13,
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer'
    };

    return (
        <div className="chat-ctx" ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
                type="button"
                className="chat-ctx-trigger"
                aria-label="Conversation options"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                }}
                style={triggerStyle}
                title="Conversation options"
            >
                <DotsIcon />
            </button>
            {open && (
                <div
                    className="chat-ctx-menu"
                    role="menu"
                    style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        zIndex: 10050,
                        width: 150,
                        padding: 5,
                        border: '1px solid #e5e7eb',
                        borderRadius: 10,
                        background: '#fff',
                        boxShadow: '0 10px 28px rgba(0,0,0,.16)'
                    }}
                >
                    <button
                        type="button"
                        role="menuitem"
                        className="chat-ctx-item"
                        style={itemStyle}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#f7f1ed'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={(e) => {
                            e.stopPropagation();
                            run(onRename);
                        }}
                    >
                        <RenameIcon />
                        <span>Rename</span>
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        className="chat-ctx-item"
                        style={itemStyle}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#f7f1ed'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={(e) => {
                            e.stopPropagation();
                            run(onTogglePin);
                        }}
                    >
                        <PinIcon />
                        <span>{pinned ? 'Unpin' : 'Pin'}</span>
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        className="chat-ctx-item chat-ctx-item-danger"
                        style={{ ...itemStyle, color: '#b91c1c' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#fef2f2'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={(e) => {
                            e.stopPropagation();
                            run(onDelete);
                        }}
                    >
                        <TrashIcon />
                        <span>Delete</span>
                    </button>
                </div>
            )}
        </div>
    );
}
