import type { RAGDatasetNode } from '../../types/rag';

/**
 * Build a hierarchical dataset tree from a flat list of relative dataset paths.
 *
 * The backend exposes dataset paths relative to `public/data`, e.g.:
 *   "authors/akkamahādēvi.json"
 *   "datasets/Hariharataratamyam.json"
 *   "Veershaiv Granthas/SomeBook.pdf"
 *   "Basava_Purāṇa.pdf"
 *
 * This function groups these paths into nested "folder" nodes and "file" nodes,
 * deduplicating shared directory segments. Folder nodes carry a `fileCount`
 * (number of file leaves under them, including descendants).
 */
export function buildDatasetTree(paths: string[]): RAGDatasetNode[] {
    const rootChildren: RAGDatasetNode[] = [];

    // Map of folder id -> node, used to dedupe shared directory segments.
    const folderMap = new Map<string, RAGDatasetNode>();

    // Sort for deterministic, stable ordering (folders and files interleaved
    // alphabetically, matching a typical file explorer).
    const sorted = paths.slice().sort((a, b) => a.localeCompare(b));

    for (const full of sorted) {
        const trimmed = String(full || '');
        if (!trimmed || trimmed.trim().length === 0) continue;

        const segments = trimmed.split('/').filter((s) => s.length > 0);
        if (segments.length === 0) continue;

        // Ensure the top-level folder children array exists.
        let parentChildren = rootChildren;

        // Walk every segment except the last (which is always a file).
        for (let i = 0; i < segments.length - 1; i++) {
            const seg = segments[i];
            const folderId = segments.slice(0, i + 1).join('/') + '/';

            let folder = folderMap.get(folderId);
            if (!folder) {
                folder = {
                    id: folderId,
                    label: seg,
                    type: 'folder',
                    children: [],
                    fileCount: 0
                };
                folderMap.set(folderId, folder);
                parentChildren.push(folder);
            }
            parentChildren = folder.children;
        }

        // The last segment is the file itself.
        const fileName = segments[segments.length - 1];
        const fileNode: RAGDatasetNode = {
            id: trimmed,
            label: fileName,
            type: 'file',
            path: trimmed,
            children: [],
            fileCount: 1
        };
        parentChildren.push(fileNode);
    }

    // Recursively compute fileCount for every folder (sum of descendant leaves).
    function recount(node: RAGDatasetNode): number {
        if (node.type === 'file') {
            node.fileCount = 1;
            return 1;
        }
        let count = 0;
        for (const child of node.children) count += recount(child);
        node.fileCount = count;
        return count;
    }
    for (const child of rootChildren) recount(child);

    return rootChildren;
}

/**
 * Collect every file leaf path from a node and its descendants.
 * Returns an array of the absolute dataset paths (relative to public/data).
 */
export function collectLeafPaths(node: RAGDatasetNode): string[] {
    const out: string[] = [];
    if (node.type === 'file' && node.path) {
        out.push(node.path);
        return out;
    }
    for (const child of node.children) {
        for (const p of collectLeafPaths(child)) out.push(p);
    }
    return out;
}

/**
 * Flatten the tree into a single list of all nodes (folders + files), in
 * depth-first order. Useful for keyboard navigation and search filtering.
 */
export function flattenNodes(nodes: RAGDatasetNode[]): RAGDatasetNode[] {
    const out: RAGDatasetNode[] = [];
    function walk(list: RAGDatasetNode[]) {
        for (const node of list) {
            out.push(node);
            if (node.children.length > 0) walk(node.children);
        }
    }
    walk(nodes);
    return out;
}

/**
 * Recursively match a node (and its subtree) against a search query.
 * A node matches if its own label matches, OR any descendant matches.
 * Returns a deep-ish copy of matching subtrees (children pruned to matches).
 */
export function filterTreeBySearch(
    nodes: RAGDatasetNode[],
    query: string
): RAGDatasetNode[] {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return nodes;

    const result: RAGDatasetNode[] = [];
    for (const node of nodes) {
        const labelMatch = node.label.toLowerCase().includes(q);

        if (node.type === 'file') {
            if (labelMatch) result.push(node);
            continue;
        }

        const children = filterTreeBySearch(node.children, q);
        if (labelMatch || children.length > 0) {
            result.push({
                ...node,
                children
            });
        }
    }
    return result;
}
