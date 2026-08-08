import React, { useMemo, useState } from 'react';
import type { RAGDatasetNode } from '../../types/rag';
import { buildDatasetTree, collectLeafPaths, filterTreeBySearch } from '../../services/rag/tree';

type TriState = 'checked' | 'unchecked' | 'indeterminate';

type DatasetTreeProps = {
    /** All leaf dataset paths (relative to public/data). */
    paths: string[];
    /** Set of leaf paths currently explicitly selected. */
    selected: ReadonlySet<string>;
    /** Whether "All Datasets" mode is active (search across everything). */
    allSelected: boolean;
    /** Called whenever selection changes. */
    onChange: (selected: Set<string>, allSelected: boolean) => void;
    disabled?: boolean;
};

type TreeNodeProps = {
    node: RAGDatasetNode;
    depth: number;
    effectiveSelected: ReadonlySet<string>;
    allSelected: boolean;
    expanded: Set<string>;
    searchActive: boolean;
    disabled?: boolean;
    onToggleExpand: (id: string) => void;
    onToggleAll: () => void;
    onToggleFolder: (node: RAGDatasetNode, state: TriState) => void;
    onToggleFile: (path: string) => void;
};

function folderState(node: RAGDatasetNode, effectiveSelected: ReadonlySet<string>): TriState {
    const leaves = collectLeafPaths(node);
    if (leaves.length === 0) return 'unchecked';
    let count = 0;
    for (const p of leaves) {
        if (effectiveSelected.has(p)) count++;
    }
    if (count === 0) return 'unchecked';
    if (count === leaves.length) return 'checked';
    return 'indeterminate';
}

function Checkbox({ state, disabled, onClick }: { state: boolean | 'mixed'; disabled?: boolean; onClick?: (e: React.MouseEvent) => void }) {
    return (
        <span
            className={`ds-tree-check ${state === 'mixed' ? 'ds-tree-check-mixed' : ''} ${disabled ? 'ds-tree-check-disabled' : ''}`}
            role="checkbox"
            aria-checked={state === true ? 'true' : state === 'mixed' ? 'mixed' : 'false'}
            aria-disabled={disabled}
            tabIndex={-1}
            onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (!disabled) onClick?.(e);
            }}
        >
            {state === true ? '☑' : state === 'mixed' ? '◖' : '☐'}
        </span>
    );
}

function TreeNode({
    node,
    depth,
    effectiveSelected,
    allSelected,
    expanded,
    searchActive,
    disabled,
    onToggleExpand,
    onToggleAll,
    onToggleFolder,
    onToggleFile
}: TreeNodeProps) {
    const isFolder = node.type === 'folder' || node.type === 'root';
    const isRoot = node.type === 'root';
    const isExpanded = expanded.has(node.id);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowRight') {
            if (isFolder && !isExpanded) { e.preventDefault(); onToggleExpand(node.id); }
        } else if (e.key === 'ArrowLeft') {
            if (isFolder && isExpanded) { e.preventDefault(); onToggleExpand(node.id); }
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (isRoot) onToggleAll();
            else if (isFolder) onToggleFolder(node, folderState(node, effectiveSelected));
            else if (node.path) onToggleFile(node.path);
        }
    };

    const handleClick = () => {
        if (isFolder) {
            onToggleExpand(node.id);
            return;
        }
        if (node.path) onToggleFile(node.path);
    };

    const handleCheckboxClick = () => {
        if (isRoot) onToggleAll();
        else if (isFolder) onToggleFolder(node, folderState(node, effectiveSelected));
        else if (node.path) onToggleFile(node.path);
    };

    const rawState: TriState | boolean = isRoot
        ? (allSelected ? true : (effectiveSelected.size > 0 ? 'indeterminate' : false))
        : isFolder
            ? folderState(node, effectiveSelected)
            : effectiveSelected.has(node.path || '');

    const state: boolean | 'mixed' = rawState === 'checked'
        ? true
        : rawState === 'unchecked'
            ? false
            : rawState === 'indeterminate'
                ? 'mixed'
                : rawState;

    return (
        <div className="ds-tree-node" style={{ paddingLeft: 8 + depth * 16 }}>
            <div
                className="ds-tree-row"
                role="treeitem"
                aria-expanded={isFolder ? isExpanded : undefined}
                aria-selected={state === true}
                tabIndex={0}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                title={node.path || node.label}
            >
                <Checkbox state={state} disabled={disabled} onClick={handleCheckboxClick} />
                <span
                    className={`ds-tree-caret ${isFolder ? '' : 'ds-tree-caret-empty'}`}
                    aria-hidden="true"
                >
                    {isFolder ? (isExpanded ? '▾' : '▸') : ''}
                </span>
                <span className="ds-tree-label">{node.label}</span>
                {isFolder && !searchActive && (
                    <span className="ds-tree-count">{node.fileCount}</span>
                )}
            </div>
            {isFolder && isExpanded && node.children.length > 0 && (
                <div role="group">
                    {node.children.map((child) => (
                        <TreeNode
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            effectiveSelected={effectiveSelected}
                            allSelected={allSelected}
                            expanded={expanded}
                            searchActive={searchActive}
                            disabled={disabled}
                            onToggleExpand={onToggleExpand}
                            onToggleAll={onToggleAll}
                            onToggleFolder={onToggleFolder}
                            onToggleFile={onToggleFile}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function DatasetTree({
    paths,
    selected,
    allSelected,
    onChange,
    disabled
}: DatasetTreeProps) {
    const tree = useMemo(() => buildDatasetTree(paths), [paths]);

    // Default-expand the root ("All Datasets") and all top-level folders so the
    // user immediately sees the folder/file hierarchy without any clicks.
    const [expanded, setExpanded] = useState<Set<string>>(() => {
        const initial = new Set<string>(['__ALL__']);
        for (const child of tree) {
            if (child.type === 'folder') initial.add(child.id);
        }
        return initial;
    });
    const [search, setSearch] = useState('');

    const allPathsSet = useMemo(() => new Set(paths), [paths]);

    // Effective selection: when "All Datasets" is active, every path is selected.
    const effectiveSelected = useMemo<ReadonlySet<string>>(
        () => (allSelected ? allPathsSet : selected),
        [allSelected, selected, allPathsSet]
    );

    const searchActive = search.trim().length > 0;
    const visibleTree = useMemo(
        () => (searchActive ? filterTreeBySearch(tree, search) : tree),
        [tree, searchActive, search]
    );

    // Auto-expand every folder that has a matching descendant while searching.
    // Always keep the synthetic root ("__ALL__") expanded so the filtered
    // results are actually visible (otherwise the root collapses and hides them).
    const autoExpanded = useMemo(() => {
        if (!searchActive) return expanded;
        const ids = new Set<string>(['__ALL__']);
        function walk(nodes: RAGDatasetNode[]) {
            for (const n of nodes) {
                if (n.type === 'folder') {
                    ids.add(n.id);
                    walk(n.children);
                }
            }
        }
        walk(visibleTree);
        return ids;
    }, [searchActive, visibleTree, expanded]);

    const toggleExpand = (id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        if (disabled) return;
        onChange(new Set(), !allSelected);
    };

    const toggleFolder = (node: RAGDatasetNode, state: TriState) => {
        if (disabled) return;
        const leaves = collectLeafPaths(node);
        const next = new Set([...effectiveSelected]);
        if (state === 'checked') {
            for (const p of leaves) next.delete(p);
        } else {
            for (const p of leaves) next.add(p);
        }
        onChange(next, false);
    };

    const toggleFile = (path: string) => {
        if (disabled) return;
        const next = new Set([...effectiveSelected]);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        onChange(next, false);
    };

    const collapseAll = () => setExpanded(new Set());

    const rootNode: RAGDatasetNode = {
        id: '__ALL__',
        label: 'All Datasets',
        type: 'root',
        children: visibleTree,
        fileCount: paths.length
    };

    return (
        <div className={`ds-tree ${disabled ? 'ds-tree-disabled' : ''}`}>
            <div className="ds-tree-search">
                <input
                    type="text"
                    className="ds-tree-search-input"
                    placeholder="Filter datasets…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    disabled={disabled}
                />
                {searchActive && (
                    <button
                        type="button"
                        className="ds-tree-clear"
                        onClick={() => setSearch('')}
                        aria-label="Clear filter"
                    >
                        ✕
                    </button>
                )}
            </div>
            <button
                type="button"
                className="ds-tree-collapse"
                onClick={collapseAll}
            >
                Collapse all
            </button>
            <div className="ds-tree-scroll" role="tree" aria-label="Dataset tree">
                <TreeNode
                    node={rootNode}
                    depth={0}
                    effectiveSelected={effectiveSelected}
                    allSelected={allSelected}
                    expanded={autoExpanded}
                    searchActive={searchActive}
                    disabled={disabled}
                    onToggleExpand={toggleExpand}
                    onToggleAll={toggleAll}
                    onToggleFolder={toggleFolder}
                    onToggleFile={toggleFile}
                />
            </div>
        </div>
    );
}
