import React from "react";

import type { ColumnKey } from "../pages/HomeTableTypes";

export function HomeTh({
    column,
    width,
    active,
    sortDir,
    onSort,
    children,
    getSortIndicator,
    columnLabels
}: {
    column: ColumnKey;
    width?: string;
    active: boolean;
    sortDir: "asc" | "desc";
    onSort: (key: ColumnKey) => void;
    children: React.ReactNode;
    getSortIndicator: (key: ColumnKey) => string;
    columnLabels: Record<ColumnKey, string>;
}) {
    return (
        <th
            style={{
                padding: 12,
                width,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                userSelect: "none",
                cursor: "pointer"
            }}
            onClick={() => onSort(column)}
            aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            title={`Sort by ${columnLabels[column]} (${active ? sortDir : "asc"})`}
        >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {children}
                {active ? getSortIndicator(column) : ""}
            </span>
        </th>
    );
}

export function HomeTd({ children }: { children: React.ReactNode }) {
    return (
        <td
            style={{
                padding: 10,
                borderRight: "1px solid #eee",
                overflowWrap: "anywhere",
                wordBreak: "break-word"
            }}
        >
            {children}
        </td>
    );
}

