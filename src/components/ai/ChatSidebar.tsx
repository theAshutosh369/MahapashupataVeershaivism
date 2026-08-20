import { useMemo, useState } from 'react';
import type { Conversation } from '../../types/conversation';
import ChatContextMenu from './ChatContextMenu';

type ChatSidebarProps = {
    conversations: Conversation[];
    activeConversationId: string | null;
    mobileOpen: boolean;
    onCloseMobile: () => void;
    onNewChat: () => void;
    onSelect: (id: string) => void;
    onRename: (id: string, title: string) => void;
    onTogglePin: (id: string) => void;
    onDelete: (id: string) => void;
    onClearAll: () => void;
};

function formatRelativeTime(ts: number): string {
    const now = Date.now();
    const diff = now - ts;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diff < minute) return 'Just now';
    if (diff < hour) return `${Math.floor(diff / minute)} ${Math.floor(diff / minute) === 1 ? 'minute' : 'minutes'} ago`;
    if (diff < day) return `${Math.floor(diff / hour)} ${Math.floor(diff / hour) === 1 ? 'hour' : 'hours'} ago`;
    if (diff < 2 * day) return 'Yesterday';

    const days = Math.floor(diff / day);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function ChatRow({
    conversation,
    active,
    onClick,
    onRename,
    onTogglePin,
    onTogglePinHover,
    onDeleteRequest
}: {
    conversation: Conversation;
    active: boolean;
    onClick: () => void;
    onRename: (title: string) => void;
    onTogglePin: () => void;
    onTogglePinHover: () => void;
    onDeleteRequest: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(conversation.title);

    function commitRename() {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== conversation.title) onRename(trimmed);
        setEditing(false);
    }

    return (
        <div className={`chat-row ${active ? 'chat-row-active' : ''}`}>
            {editing ? (
                <input
                    className="chat-row-rename-input"
                    value={draft}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditing(false);
                    }}
                />
            ) : (
                <button
                    type="button"
                    className="chat-row-main"
                    onClick={onClick}
                    title={conversation.title}
                >
                    <span className="chat-row-title">{conversation.title}</span>
                    <span className="chat-row-time">{formatRelativeTime(conversation.updatedAt)}</span>
                </button>
            )}
            {!editing && (
                <>
                    <button
                        type="button"
                        className="chat-row-pin"
                        aria-label={conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}
                        onClick={(e) => {
                            e.stopPropagation();
                            onTogglePin();
                        }}
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill={conversation.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 17v5" />
                            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                        </svg>
                    </button>
                    <ChatContextMenu
                        pinned={conversation.pinned}
                        onRename={() => {
                            setDraft(conversation.title);
                            setEditing(true);
                        }}
                        onTogglePin={onTogglePinHover}
                        onDelete={onDeleteRequest}
                    />
                </>
            )}
        </div>
    );
}

export default function ChatSidebar({
    conversations,
    activeConversationId,
    mobileOpen,
    onCloseMobile,
    onNewChat,
    onSelect,
    onRename,
    onTogglePin,
    onDelete,
    onClearAll
}: ChatSidebarProps) {
    const [search, setSearch] = useState('');
    const [confirmClear, setConfirmClear] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);

    const trimmed = search.trim().toLowerCase();

    const filtered = useMemo(() => {
        if (!trimmed) return conversations;
        return conversations.filter((c) => {
            if (c.title.toLowerCase().includes(trimmed)) return true;
            return c.messages.some((m) => m.content.toLowerCase().includes(trimmed));
        });
    }, [conversations, trimmed]);

    const pinned = filtered.filter((c) => c.pinned);
    const recents = filtered.filter((c) => !c.pinned);

    // Sort recents by most recently updated.
    const recentsSorted = [...recents].sort((a, b) => b.updatedAt - a.updatedAt);

    function handleSelect(id: string) {
        onSelect(id);
        onCloseMobile();
    }

    function requestDelete(conv: Conversation) {
        setPendingDelete(conv);
    }

    function confirmDelete() {
        if (pendingDelete) {
            onDelete(pendingDelete.id);
            setPendingDelete(null);
        }
    }

    return (
        <>
            {/* Mobile overlay backdrop */}
            {mobileOpen && <div className="chat-sidebar-backdrop" onClick={onCloseMobile} aria-hidden="true" />}

            <aside className={`chat-sidebar ${mobileOpen ? 'chat-sidebar-open' : ''}`} aria-label="Chat history">
                <div className="chat-sidebar-header">
                    <div className="chat-sidebar-header-actions">
                        <button type="button" className="chat-new-btn" onClick={() => { onNewChat(); onCloseMobile(); }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 5v14" />
                                <path d="M5 12h14" />
                            </svg>
                            <span>New Chat</span>
                        </button>
                        <button
                            type="button"
                            className="chat-sidebar-close-btn"
                            onClick={onCloseMobile}
                            aria-label="Close chat sidebar"
                            title="Close chat sidebar"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M18 6 6 18" />
                                <path d="m6 6 12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                <div className="chat-sidebar-search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                        type="text"
                        className="chat-sidebar-search-input"
                        placeholder="Search chats..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                        <button type="button" className="chat-sidebar-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                            ✕
                        </button>
                    )}
                </div>

                <div className="chat-sidebar-scroll">
                    {pinned.length > 0 && (
                        <div className="chat-section">
                            <div className="chat-section-title">Pinned</div>
                            {pinned.map((c) => (
                                <ChatRow
                                    key={c.id}
                                    conversation={c}
                                    active={activeConversationId === c.id}
                                    onClick={() => handleSelect(c.id)}
                                    onRename={(title) => onRename(c.id, title)}
                                    onTogglePin={() => onTogglePin(c.id)}
                                    onTogglePinHover={() => onTogglePin(c.id)}
                                    onDeleteRequest={() => requestDelete(c)}
                                />
                            ))}
                        </div>
                    )}

                    <div className="chat-section">
                        {pinned.length > 0 && <div className="chat-section-title">Recents</div>}
                        {recentsSorted.length === 0 && pinned.length === 0 && conversations.length > 0 && (
                            <div className="chat-empty">No chats match your search.</div>
                        )}
                        {conversations.length === 0 && (
                            <div className="chat-empty">No conversations yet. Start a new chat.</div>
                        )}
                        {recentsSorted.map((c) => (
                            <ChatRow
                                key={c.id}
                                conversation={c}
                                active={activeConversationId === c.id}
                                onClick={() => handleSelect(c.id)}
                                onRename={(title) => onRename(c.id, title)}
                                onTogglePin={() => onTogglePin(c.id)}
                                onTogglePinHover={() => onTogglePin(c.id)}
                                onDeleteRequest={() => requestDelete(c)}
                            />
                        ))}
                    </div>
                </div>

                <div className="chat-sidebar-footer">
                    <button
                        type="button"
                        className="chat-clear-btn"
                        onClick={() => setConfirmClear(true)}
                        disabled={conversations.length === 0}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 6h18" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                        <span>Clear conversations</span>
                    </button>
                </div>
            </aside>

            {/* Delete conversation confirmation */}
            {pendingDelete && (
                <div className="chat-confirm-overlay" onClick={() => setPendingDelete(null)}>
                    <div className="chat-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                        <h3>Delete conversation?</h3>
                        <p>"{pendingDelete.title}" will be permanently deleted. This action cannot be undone.</p>
                        <div className="chat-confirm-actions">
                            <button type="button" className="chat-confirm-cancel" onClick={() => setPendingDelete(null)}>
                                Cancel
                            </button>
                            <button type="button" className="chat-confirm-danger" onClick={confirmDelete}>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Clear conversations confirmation */}
            {confirmClear && (
                <div className="chat-confirm-overlay" onClick={() => setConfirmClear(false)}>
                    <div className="chat-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                        <h3>Clear all conversations?</h3>
                        <p>This will permanently delete all saved conversations. This action cannot be undone.</p>
                        <div className="chat-confirm-actions">
                            <button type="button" className="chat-confirm-cancel" onClick={() => setConfirmClear(false)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="chat-confirm-danger"
                                onClick={() => {
                                    onClearAll();
                                    setConfirmClear(false);
                                    onCloseMobile();
                                }}
                            >
                                Clear
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
