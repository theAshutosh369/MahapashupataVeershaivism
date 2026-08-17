import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { getAuthor, getAuthors, updateVachanaField, updateVachanaTranslation } from "../api";
import Footer from "../components/Footer";
import HighlightText from "../components/HighlightText";
import Navbar from "../components/Navbar";

import type { Author, Vachana } from "../types";
import type { ReactNode } from "react";

type PageSize = 10 | 50 | 100;
const DEFAULT_PAGE_SIZE: PageSize = 10;

type ColumnKey = "number" | "kannada" | "transliteration" | "translation";

type EditField = "translation" | "kannada" | "transliteration";

type EditState = {
    editingVachanaNumber: number | null;
    editingField: EditField | null;
    draft: string;
    isSaving: boolean;
};

const columnLabels: Record<ColumnKey, string> = {
    number: "Vachana No.",
    kannada: "Kannada Vachana",
    transliteration: "Transliteration",
    translation: "Translation"
};

type PageSizeOptionsProps = {
    pageSize: PageSize;
    onChange: (value: PageSize) => void;
};

function PageSizeOptions({ pageSize, onChange }: PageSizeOptionsProps) {
    const options: PageSize[] = [10, 50, 100];

    return (
        <details>
            <summary
                style={{
                    display: "inline-flex",
                    padding: "10px 14px",
                    border: "1px solid #7A1F1F",
                    borderRadius: 8,
                    color: "#7A1F1F",
                    background: "#fff",
                    cursor: "pointer"
                }}
            >
                Results per page
            </summary>

            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    marginTop: 12,
                    padding: 14,
                    background: "#fff",
                    borderRadius: 8,
                    boxShadow: "0 2px 10px rgba(0,0,0,.08)"
                }}
            >
                {options.map(option => (
                    <label
                        key={option}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px"
                        }}
                    >
                        <input
                            type="radio"
                            name="pageSize"
                            checked={pageSize === option}
                            onChange={() => onChange(option)}
                        />
                        {option.toLocaleString()}
                    </label>
                ))}
            </div>
        </details>
    );
}

type ColumnOptionsProps = {
    visibleColumns: Record<ColumnKey, boolean>;
    onToggleColumn: (column: ColumnKey) => void;
};

function ColumnOptions({ visibleColumns, onToggleColumn }: ColumnOptionsProps) {
    const columns = Object.keys(columnLabels) as ColumnKey[];

    return (
        <details>
            <summary
                style={{
                    display: "inline-flex",
                    padding: "10px 14px",
                    border: "1px solid #7A1F1F",
                    borderRadius: 8,
                    color: "#7A1F1F",
                    background: "#fff",
                    cursor: "pointer"
                }}
            >
                Show / hide columns
            </summary>

            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    marginTop: 12,
                    padding: 14,
                    background: "#fff",
                    borderRadius: 8,
                    boxShadow: "0 2px 10px rgba(0,0,0,.08)"
                }}
            >
                {columns.map(column => (
                    <label
                        key={column}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px"
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={visibleColumns[column]}
                            onChange={() => onToggleColumn(column)}
                        />
                        {columnLabels[column]}
                    </label>
                ))}
            </div>
        </details>
    );
}

type PaginationStatusProps = {
    currentPage: number;
    totalPages: number;
    totalResults: number;
    pageStart: number;
    pageResultCount: number;
};

function PaginationStatus({ currentPage, totalPages, totalResults, pageStart, pageResultCount }: PaginationStatusProps) {
    const firstResult = pageStart + 1;
    const lastResult = pageStart + pageResultCount;

    return (
        <p style={{ color: "#666" }}>
            Showing {firstResult.toLocaleString()}-{lastResult.toLocaleString()} of {totalResults.toLocaleString()} result(s). Page {currentPage.toLocaleString()} of {totalPages.toLocaleString()}.
        </p>
    );
}

type PaginationControlsProps = {
    currentPage: number;
    totalPages: number;
    onPrevious: () => void;
    onNext: () => void;
};

function PaginationControls({ currentPage, totalPages, onPrevious, onNext }: PaginationControlsProps) {
    return (
        <div
            style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
                margin: "4px 0 10px"
            }}
        >
            <button
                type="button"
                onClick={onPrevious}
                disabled={currentPage === 1}
                style={{
                    border: "1px solid #7A1F1F",
                    borderRadius: 8,
                    padding: "10px 14px",
                    background: currentPage === 1 ? "#eee" : "#fff",
                    color: currentPage === 1 ? "#777" : "#7A1F1F"
                }}
            >
                Previous page
            </button>

            <span style={{ color: "#555" }}>
                Page {currentPage.toLocaleString()} / {totalPages.toLocaleString()}
            </span>

            <button
                type="button"
                onClick={onNext}
                disabled={currentPage === totalPages}
                style={{
                    border: "1px solid #7A1F1F",
                    borderRadius: 8,
                    padding: "10px 14px",
                    background: currentPage === totalPages ? "#eee" : "#7A1F1F",
                    color: currentPage === totalPages ? "#777" : "#fff"
                }}
            >
                Next page
            </button>
        </div>
    );
}

function TableHeader({ children, width }: { children: ReactNode; width?: string }) {
    return (
        <th
            style={{
                padding: 12,
                width,
                overflowWrap: "anywhere",
                wordBreak: "break-word"
            }}
        >
            {children}
        </th>
    );
}

function TableCell({ children }: { children: ReactNode }) {
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

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);

    async function onCopy() {
        setCopied(false);

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                return;
            }
        } catch {
            // ignore
        }

        const el = document.createElement("textarea");
        el.value = text;
        el.setAttribute("readonly", "true");
        el.style.position = "absolute";
        el.style.left = "-9999px";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        setCopied(true);
    }

    return (
        <button
            type="button"
            onClick={onCopy}
            onBlur={() => setTimeout(() => setCopied(false), 0)}
            style={{
                marginLeft: 10,
                border: "1px solid #a74040ff",
                borderRadius: 6,
                padding: "3px 8px",
                background: "#fff",
                color: "#7A1F1F",
                cursor: "pointer",
                fontSize: 12,
                flex: "0 0 auto"
            }}
            aria-label="Copy text"
        >
            {copied ? "copied" : "copy"}
        </button>
    );
}

function SearchText({ text, search, showCopy = true }: { text: string; search: string; showCopy?: boolean }) {
    return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            <pre
                style={{
                    whiteSpace: "pre-wrap",
                    fontFamily: "Noto Sans Kannada, sans-serif",
                    fontSize: 15,
                    lineHeight: 1.6,
                    margin: 0,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    flex: "1 1 auto"
                }}
            >
                <HighlightText text={text} search={search} />
            </pre>
            {showCopy && <CopyButton text={text} />}
        </div>
    );
}

type ResultsTableProps = {
    results: Vachana[];
    search: string;
    visibleColumns: Record<ColumnKey, boolean>;
    authorFile: string;
    editState: EditState;
    setEditState: React.Dispatch<React.SetStateAction<EditState>>;
    onStartEditField: (vachana: Vachana, field: EditField) => void;
    onCancelEdit: () => void;
    onSaveEdit: (vachanaNumber: number, field: EditField) => void;
};

function ResultsTable({
    results,
    search,
    visibleColumns,
    authorFile,
    editState,
    setEditState,
    onStartEditField,
    onCancelEdit,
    onSaveEdit
}: ResultsTableProps) {
    const { editingVachanaNumber, editingField, draft, isSaving } = editState;

    if (!authorFile) return null;
    if (results.length === 0) return null;

    const hasVisibleColumn = Object.values(visibleColumns).some(Boolean);
    if (!hasVisibleColumn) return null;

    function setDraft(v: string) {
        setEditState(prev => ({ ...prev, draft: v }));
    }

    function getVachanaValue(v: Vachana, field: EditField) {
        if (field === "translation") return v.translation ?? "";
        if (field === "kannada") return v.kannada ?? "";
        return v.transliteration ?? "";
    }

    function renderEditableCell(vachana: Vachana, field: EditField) {
        const isEditing = editingVachanaNumber === vachana.number && editingField === field;
        const value = getVachanaValue(vachana, field);
        const label = field === "translation" ? "Translation" : field === "kannada" ? "Kannada" : "Transliteration";

        return (
            <div style={{ position: "relative", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ flex: "1 1 auto", position: "relative", paddingRight: 70 }}>
                    <SearchText text={value} search={search} showCopy={false} />
                </div>

                <div style={{ position: "absolute", top: 0, right: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                    <CopyButton text={value} />

                    <button
                        type="button"
                        onClick={() => onStartEditField(vachana, field)}
                        style={{
                            width: 44,
                            height: 22,
                            border: "1px solid #a74040",
                            borderRadius: 6,
                            background: "#fff",
                            color: "#7A1F1F",
                            cursor: "pointer",
                            fontSize: 12,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            marginLeft: "auto"
                        }}
                        aria-label={`Edit ${label}`}
                        title={`Edit ${label}`}
                    >
                        Edit
                    </button>
                </div>

                {isEditing ? (
                    <div
                        style={{
                            position: "fixed",
                            inset: 0,
                            background: "rgba(0,0,0,0.45)",
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "center",
                            paddingTop: 90,
                            zIndex: 9999
                        }}
                        role="dialog"
                        aria-modal="true"
                    >
                        <div
                            style={{
                                width: "min(900px, calc(100% - 24px))",
                                height: "min(900px, calc(100% - 24px))",
                                background: "#fff",
                                borderRadius: 12,
                                boxShadow: "0 10px 30px rgba(0,0,0,.25)",
                                border: "1px solid #eee",
                                overflow: "hidden",
                                display: "flex",
                                flexDirection: "column"
                            }}
                        >
                            <div style={{ padding: 16, borderBottom: "1px solid #f0f0f0" }}>
                                <div style={{ fontSize: 18, color: "#7A1F1F", fontWeight: 700 }}>
                                    Edit {label} (Vachana {vachana.number})
                                </div>
                            </div>

                            <div
                                style={{
                                    padding: 16,
                                    flex: 1,
                                    display: "flex",
                                    flexDirection: "column",
                                    overflow: "hidden"
                                }}
                            >
                                <textarea
                                    value={draft}
                                    onChange={e => setDraft(e.target.value)}
                                    rows={6}
                                    style={{
                                        flex: 1,
                                        width: "100%",
                                        padding: 12,
                                        borderRadius: 10,
                                        border: "1px solid #ddd",
                                        fontSize: 15,
                                        background: "#fff",
                                        resize: "none",
                                        boxSizing: "border-box"
                                    }}
                                />

                                <div
                                    style={{
                                        display: "flex",
                                        gap: 10,
                                        justifyContent: "flex-end",
                                        flexWrap: "wrap",
                                        marginTop: 14
                                    }}
                                >
                                    <button
                                        type="button"
                                        onClick={onCancelEdit}
                                        disabled={isSaving}
                                        style={{
                                            border: "1px solid #777",
                                            borderRadius: 8,
                                            padding: "10px 14px",
                                            background: "#fff",
                                            color: "#333",
                                            cursor: "pointer"
                                        }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onSaveEdit(vachana.number, field)}
                                        disabled={isSaving}
                                        style={{
                                            border: "1px solid #7A1F1F",
                                            borderRadius: 8,
                                            padding: "10px 14px",
                                            background: "#7A1F1F",
                                            color: "#fff",
                                            cursor: "pointer",
                                            opacity: isSaving ? 0.7 : 1
                                        }}
                                    >
                                        {isSaving ? "Saving..." : "Save"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div style={{ background: "#fff", borderRadius: 8, boxShadow: "0 2px 10px rgba(0,0,0,.08)", overflow: "visible" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <thead>
                    <tr style={{ background: "#7A1F1F", color: "#fff", textAlign: "left" }}>
                        {visibleColumns.number ? <TableHeader width="7%">Vachana No.</TableHeader> : null}
                        {visibleColumns.kannada ? <TableHeader>Kannada Vachana</TableHeader> : null}
                        {visibleColumns.transliteration ? <TableHeader>Transliteration</TableHeader> : null}
                        {visibleColumns.translation ? <TableHeader>Translation</TableHeader> : null}
                    </tr>
                </thead>

                <tbody>
                    {results.map(vachana => (
                        <tr key={vachana.number} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                            {visibleColumns.number ? <TableCell>{vachana.number}</TableCell> : null}

                            {visibleColumns.kannada ? <TableCell>{renderEditableCell(vachana, "kannada")}</TableCell> : null}
                            {visibleColumns.transliteration ? <TableCell>{renderEditableCell(vachana, "transliteration")}</TableCell> : null}
                            {visibleColumns.translation ? <TableCell>{renderEditableCell(vachana, "translation")}</TableCell> : null}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function AuthorPage() {
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const { id } = useParams();
    const navigate = useNavigate();

    const [author, setAuthor] = useState<Author | null>(null);
    const [loading, setLoading] = useState(true);
    const [authorFile, setAuthorFile] = useState<string>("");

    const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>({
        number: true,
        kannada: true,
        transliteration: true,
        translation: true
    });

    const [editState, setEditState] = useState<EditState>({
        editingVachanaNumber: null,
        editingField: null,
        draft: "",
        isSaving: false
    });

    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

    useEffect(() => {
        async function load() {
            try {
                const authors = await getAuthors();
                const summary = authors.find(a => a.id === Number(id));

                if (!summary) {
                    setLoading(false);
                    return;
                }

                setAuthorFile(summary.file);
                const data = await getAuthor(summary.file);
                setAuthor(data);
            } finally {
                setLoading(false);
            }
        }

        load();
    }, [id]);

    const filteredVachanas = useMemo(() => {
        if (!author) return [];
        const q = deferredSearch.trim();
        if (!q) return author.vachanas;

        const qLower = q.toLowerCase();
        return author.vachanas.filter(v =>
            v.kannada.includes(q) ||
            v.transliteration.toLowerCase().includes(qLower) ||
            (v.translation ?? "").toLowerCase().includes(qLower)
        );
    }, [author, deferredSearch]);

    const totalPages = Math.max(1, Math.ceil(filteredVachanas.length / pageSize));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const pageStart = (currentPage - 1) * pageSize;
    const pageResults = filteredVachanas.slice(pageStart, pageStart + pageSize);

    function toggleColumn(column: ColumnKey) {
        setVisibleColumns(current => ({ ...current, [column]: !current[column] }));
    }

    function onStartEditField(vachana: Vachana, field: EditField) {
        const value = field === "translation" ? vachana.translation ?? "" : field === "kannada" ? vachana.kannada ?? "" : vachana.transliteration ?? "";
        setEditState({ editingVachanaNumber: vachana.number, editingField: field, draft: value, isSaving: false });
    }

    function onCancelEdit() {
        setEditState({ editingVachanaNumber: null, editingField: null, draft: "", isSaving: false });
    }

    async function onSaveEdit(vachanaNumber: number, field: EditField) {
        if (!authorFile) return;

        const draft = editState.draft;
        setEditState(prev => ({ ...prev, isSaving: true }));

        try {
            const nextValue = draft === "" ? null : draft;

            if (field === "translation") {
                // Keep old helper consistent (though it delegates to updateVachanaField).
                const nextTranslation = draft === "" ? null : draft;
                await updateVachanaTranslation(authorFile, vachanaNumber, nextTranslation);
            } else {
                await updateVachanaField(authorFile, vachanaNumber, field, nextValue);
            }

            setAuthor(prev => {
                if (!prev) return prev;
                return {
                    ...prev,
                    vachanas: prev.vachanas.map(v =>
                        v.number === vachanaNumber
                            ? field === "translation"
                                ? { ...v, translation: nextValue }
                                : field === "kannada"
                                    ? { ...v, kannada: (nextValue ?? "") }
                                    : { ...v, transliteration: (nextValue ?? "") }
                            : v
                    )
                };
            });
        } finally {
            setEditState({ editingVachanaNumber: null, editingField: null, draft: "", isSaving: false });
        }
    }

    if (loading) return <h2 style={{ padding: 40 }}>Loading...</h2>;
    if (!author) return <h2 style={{ padding: 40 }}>Author not found.</h2>;

    const isSearching = search !== deferredSearch;

    return (
        <>
            <Navbar />

            <main className="container" style={{ paddingTop: 45, width: "min(1800px, calc(100% - 24px))" }}>
                <section style={{ marginBottom: 35 }}>
                    <button
                        type="button"
                        onClick={() => {
                            // Read navigation state passed from Home when user clicked an author.
                            // (This is tied to the navigation action, not a global history mutation.)
                            const locationState = window.history.state as {
                                __vachana_back_from?: unknown;
                                __vachana_preserve_page_number?: unknown;
                            } | null;

                            const backFrom = locationState?.__vachana_back_from;
                            const pageNo = locationState?.__vachana_preserve_page_number;


                            if (typeof backFrom === "string" && backFrom.length > 0) {
                                // Always restore page number when available.
                                if (typeof pageNo === "number" && Number.isFinite(pageNo) && pageNo >= 1) {
                                    navigate(backFrom, {
                                        state: {
                                            __vachana_preserve_page: true,
                                            __vachana_preserve_page_number: pageNo,
                                        },
                                    });
                                } else {
                                    navigate(backFrom, {
                                        state: { __vachana_preserve_page: true },
                                    });
                                }
                                return;
                            }

                            // Fallback: go back one step.
                            navigate(-1);
                        }}



                        style={{
                            border: "1px solid #7A1F1F",
                            borderRadius: 8,
                            padding: "10px 14px",
                            background: "#fff",
                            color: "#7A1F1F",
                            cursor: "pointer",
                            marginBottom: 16
                        }}
                    >
                        ← Back
                    </button>

                    <h1 style={{ color: "#7A1F1F", fontSize: 42, marginBottom: 12 }}>{author.englishName}</h1>

                    <p style={{ color: "#555", fontSize: 18, maxWidth: 760 }}>{author.vachanas.length} Vachanas</p>

                    <input
                        type="text"
                        value={search}
                        placeholder="Search within this author's vachanas..."
                        onChange={e => setSearch(e.target.value)}
                        autoFocus
                        style={{
                            width: "100%",
                            marginTop: 28,
                            padding: 16,
                            fontSize: 18,
                            borderRadius: 8,
                            border: "1px solid #ccc",
                            background: "#fff"
                        }}
                    />
                </section>

                <section style={{ display: "grid", gap: 18 }}>
                    <h2 style={{ color: "#7A1F1F" }}>Results</h2>

                    <PageSizeOptions
                        pageSize={pageSize}
                        onChange={value => {
                            setPageSize(value);
                            setPage(1);
                        }}
                    />

                    <ColumnOptions visibleColumns={visibleColumns} onToggleColumn={toggleColumn} />

                    {filteredVachanas.length ? (
                        <>
                            {isSearching ? <p style={{ color: "#666", marginBottom: 20 }}>Updating results...</p> : null}

                            <PaginationStatus
                                currentPage={currentPage}
                                totalPages={totalPages}
                                totalResults={filteredVachanas.length}
                                pageStart={pageStart}
                                pageResultCount={pageResults.length}
                            />

                            {totalPages > 1 ? (
                                <PaginationControls
                                    currentPage={currentPage}
                                    totalPages={totalPages}
                                    onPrevious={() => setPage(v => Math.max(1, v - 1))}
                                    onNext={() => setPage(v => Math.min(totalPages, v + 1))}
                                />
                            ) : null}

                            <ResultsTable
                                results={pageResults}
                                search={deferredSearch.trim()}
                                visibleColumns={visibleColumns}
                                authorFile={authorFile}
                                editState={editState}
                                setEditState={setEditState}
                                onStartEditField={onStartEditField}
                                onCancelEdit={onCancelEdit}
                                onSaveEdit={onSaveEdit}
                            />

                            {totalPages > 1 ? (
                                <PaginationControls
                                    currentPage={currentPage}
                                    totalPages={totalPages}
                                    onPrevious={() => setPage(v => Math.max(1, v - 1))}
                                    onNext={() => setPage(v => Math.min(totalPages, v + 1))}
                                />
                            ) : null}
                        </>
                    ) : (
                        <p style={{ color: "#666", fontSize: 18 }}>No vachanas matched this filter.</p>
                    )}
                </section>
            </main>

            <Footer />
        </>
    );
}

export default AuthorPage;

