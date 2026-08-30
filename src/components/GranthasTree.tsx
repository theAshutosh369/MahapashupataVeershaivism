import { useEffect, useMemo, useState } from 'react';
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

function TreeNode({ node, depth, expanded, searchActive, selectedPath, onToggle, onSelect }: TreeNodeProps) {
    const isFolder = node.type === 'folder' || node.type === 'root';
    const isExpanded = expanded.has(node.id);
    const isSelected = node.type === 'file' && node.path === selectedPath;

    return (
        <div className="granthas-tree-node">
            <button type="button" className={`granthas-tree-row ${isSelected ? 'is-selected' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => { if (isFolder) onToggle(node.id); else if (node.path) onSelect(node.path); }} title={node.path || node.label}>
                <span className={`granthas-tree-caret ${isFolder ? '' : 'empty'}`} aria-hidden="true">{isFolder ? (isExpanded ? '▾' : '▸') : ''}</span>
                <span className="granthas-tree-icon" aria-hidden="true">{isFolder ? '📁' : '📄'}</span>
                <span className="granthas-tree-label">{node.label}</span>
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

    // The tree is empty during the first render while the API loads. Rebuild
    // the default-expanded top-level folders when the real paths arrive.
    useEffect(() => {
        setExpanded((previous) => {
            if (previous.size > 0 || tree.length === 0) return previous;
            return new Set(tree.filter((node) => node.type === 'folder').map((node) => node.id));
        });
    }, [tree]);

    const searchActive = search.trim().length > 0;
    const visibleTree = useMemo(() => searchActive ? filterTreeBySearch(tree, search) : tree, [tree, searchActive, search]);
    const visibleExpanded = useMemo(() => {
        if (!searchActive) return expanded;
        const ids = new Set<string>();
        const walk = (nodes: RAGDatasetNode[]) => {
            for (const node of nodes) {
                if (node.type === 'folder') { ids.add(node.id); walk(node.children); }
            }
        };
        walk(visibleTree);
        return ids;
    }, [expanded, searchActive, visibleTree]);

    function toggle(id: string) {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }

    function expandAll() {
        const next = new Set<string>();
        const walk = (nodes: RAGDatasetNode[]) => {
            for (const node of nodes) {
                if (node.type === 'folder') { next.add(node.id); walk(node.children); }
            }
        };
        walk(tree);
        setExpanded(next);
    }

    return (
        <aside className="granthas-tree-panel" aria-label="Granthas folder tree">
            <div className="granthas-tree-panel-header">
                <div><h2>Granthas</h2><span>{paths.length} files</span></div>
                <button type="button" className="granthas-tree-expand" onClick={expandAll}>Expand all</button>
            </div>
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
