import { useEffect, useMemo, useRef, useState } from 'react';
import type { RAGDatasetNode } from '../types/rag';
import { buildDatasetTree, filterTreeBySearch } from '../services/rag/tree';

type GranthasTreeProps = {
    paths: string[];
    selectedPath: string | null;
    onSelect: (path: string) => void;
};

type TreeNodeProps = {
    node: RAGDatasetNode;
    depth: number;
    expanded: ReadonlySet<string>;
    searchActive: boolean;
    selectedPath: string | null;
    onToggle: (id: string) => void;
    onSelect: (path: string) => void;
};

function displayName(label: string, isFile: boolean) {
    let value = String(label || '').replace(/_/g, ' ');
    if (isFile) value = value.replace(/\.(txt|json)$/i, '');
    return value;
}

function normalizeText(value: string) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function findAndScrollToPassage(query: string) {
    const target = normalizeText(query);
    if (!target) return false;
    const viewer = document.querySelector<HTMLElement>('.granthas-content-viewer');
    if (!viewer) return false;
    const pre = viewer.querySelector<HTMLElement>('pre');
    if (!pre) return false;

    const fullText = normalizeText(pre.textContent || '');
    if (!fullText) return false;
    const phrase = target.length > 180 ? target.slice(0, 180) : target;
    if (!fullText.includes(phrase)) {
        const words = phrase.split(/\s+/).filter((word) => word.length >= 3);
        if (!words.length) return false;
        const distinctive = words.slice(0, 12).join(' ');
        if (!fullText.includes(distinctive)) return false;
    }

    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let bestNode: Text | null = null;
    let bestIndex = -1;
    while ((node = walker.nextNode())) {
        const value = normalizeText(node.textContent || '');
        const index = value.indexOf(phrase);
        if (index >= 0) { bestNode = node as Text; bestIndex = index; break; }
        const words = phrase.split(/\s+/).filter((word) => word.length >= 3).slice(0, 12).join(' ');
        const fallbackIndex = words ? value.indexOf(words) : -1;
        if (fallbackIndex >= 0) { bestNode = node as Text; bestIndex = fallbackIndex; break; }
    }
    if (!bestNode || bestIndex < 0) return false;

    const range = document.createRange();
    range.setStart(bestNode, Math.min(bestIndex, bestNode.textContent?.length ?? 0));
    range.setEnd(bestNode, Math.min((bestIndex + Math.max(1, phrase.length)), bestNode.textContent?.length ?? 0));
    const rect = range.getBoundingClientRect();
    const viewerRect = viewer.getBoundingClientRect();
    viewer.scrollTop += rect.top - viewerRect.top - (viewer.clientHeight / 2) + (rect.height / 2);
    return true;
}

function TreeNode({ node, depth, expanded, searchActive, selectedPath, onToggle, onSelect }: TreeNodeProps) {
    const isFolder = node.type === 'folder' || node.type === 'root';
    const isExpanded = expanded.has(node.id);
    const isSelected = node.type === 'file' && node.path === selectedPath;

    return (
        <div className="granthas-tree-node">
            <button type="button" className={`granthas-tree-row ${isSelected ? 'is-selected' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => { if (isFolder) onToggle(node.id); else if (node.path) onSelect(node.path); }} title={node.path || node.label}>
                <span className={`granthas-tree-caret ${isFolder ? '' : 'empty'}`} aria-hidden="true">{isFolder ? (isExpanded ? '▾' : '▸') : ''}</span>
                <span className="granthas-tree-icon" aria-hidden="true">{isFolder ? '📁' : '📄'}</span>
                <span className="granthas-tree-label">{displayName(node.label, node.type === 'file')}</span>
                {isFolder && !searchActive && <span className="granthas-tree-count">{node.fileCount}</span>}
            </button>
            {isFolder && isExpanded && node.children.length > 0 && (
                <div>{node.children.map((child) => <TreeNode key={child.id} node={child} depth={depth + 1} expanded={expanded} searchActive={searchActive} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} />)}</div>
            )}
        </div>
    );
}

export default function GranthasTree({ paths, selectedPath, onSelect }: GranthasTreeProps) {
    const tree = useMemo(() => buildDatasetTree(paths), [paths]);
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const deepLinkHandledRef = useRef(false);

    const query = useMemo(() => new URLSearchParams(window.location.search), []);
    const deepLinkPath = query.get('open') || '';
    const deepLinkMatch = query.get('match') || '';
    const fromAgent = query.get('from') === '/agent';

    useEffect(() => {
        if (deepLinkHandledRef.current || !paths.length || !deepLinkPath) return;
        const normalized = deepLinkPath.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
        const matchedPath = paths.find((path) => path.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/') === normalized);
        if (!matchedPath) return;
        deepLinkHandledRef.current = true;
        onSelect(matchedPath);

        // Granthas loads the selected file asynchronously. Keep trying briefly
        // so a source click lands at the retrieved passage instead of page top.
        if (deepLinkMatch) {
            let attempts = 0;
            const timer = window.setInterval(() => {
                attempts += 1;
                if (findAndScrollToPassage(deepLinkMatch) || attempts >= 60) window.clearInterval(timer);
            }, 100);
            return () => window.clearInterval(timer);
        }
    }, [paths, deepLinkPath, deepLinkMatch, onSelect]);

    const searchActive = search.trim().length > 0;
    const visibleTree = useMemo(() => searchActive ? filterTreeBySearch(tree, search) : tree, [tree, searchActive, search]);
    const visibleExpanded = useMemo(() => {
        if (!searchActive) return expanded;
        const ids = new Set<string>();
        const walk = (nodes: RAGDatasetNode[]) => nodes.forEach((node) => { if (node.type === 'folder') { ids.add(node.id); walk(node.children); } });
        walk(visibleTree);
        return ids;
    }, [expanded, searchActive, visibleTree]);

    const folderIds = useMemo(() => {
        const ids: string[] = [];
        const walk = (nodes: RAGDatasetNode[]) => nodes.forEach((node) => { if (node.type === 'folder') { ids.push(node.id); walk(node.children); } });
        walk(tree);
        return ids;
    }, [tree]);

    const allExpanded = folderIds.length > 0 && folderIds.every((id) => expanded.has(id));

    function toggle(id: string) {
        setExpanded((previous) => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
    }

    function toggleAll() {
        setExpanded(allExpanded ? new Set() : new Set(folderIds));
    }

    function returnToAgent() {
        if (window.history.length > 1) window.history.back();
        else window.location.assign('/agent');
    }

    return (
        <aside className="granthas-tree-panel" aria-label="Granthas folder tree">
            <div className="granthas-tree-panel-header">
                <div><h2>Granthas</h2><span>{paths.length} files</span></div>
                <button type="button" className="granthas-tree-expand" onClick={toggleAll} disabled={folderIds.length === 0}>{allExpanded ? 'Collapse all' : 'Expand all'}</button>
            </div>
            {fromAgent && <button type="button" className="granthas-back-to-agent" onClick={returnToAgent}>← Back to AI Agent</button>}
            <div className="granthas-tree-search">
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Granthas…" aria-label="Search Granthas" />
                {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search">✕</button>}
            </div>
            <div className="granthas-tree-scroll" role="tree">
                {visibleTree.length > 0 ? visibleTree.map((node) => <TreeNode key={node.id} node={node} depth={0} expanded={visibleExpanded} searchActive={searchActive} selectedPath={selectedPath} onToggle={toggle} onSelect={onSelect} />) : <div className="granthas-tree-empty">No Granthas found.</div>}
            </div>
        </aside>
    );
}
