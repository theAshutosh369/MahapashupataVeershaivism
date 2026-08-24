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
        <details style={{ position: "relative" }}>
            <summary className="filter-summary">Results per page</summary>
            <div className="filter-dropdown">
                {options.map(option => (
                    <label key={option} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer" }}>
                        <input type="radio" name="pageSize" checked={pageSize === option} onChange={() => onChange(option)} />
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
        <details style={{ position: "relative" }}>
            <summary className="filter-summary">Show / hide columns</summary>
            <div className="filter-dropdown">
                {columns.map(column => (
                    <label key={column} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer" }}>
                        <input type="checkbox" checked={visibleColumns[column]} onChange={() => onToggleColumn(column)} />
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
    return (
        <p style={{ color: "#666", fontSize: "var(--font-body)" }}>
            Showing {pageStart + 1}-{pageStart + pageResultCount} of {totalResults} result(s). Page {currentPage} of {totalPages}.
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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "4px 0 10px" }}>
            <button type="button" onClick={onPrevious} disabled={currentPage === 1}
                className="btn btn-outline" style={{ opacity: currentPage === 1 ? 0.6 : 1 }}>
                Previous page
            </button>
            <span style={{ color: "#555", fontSize: "var(--font-body)" }}>
                Page {currentPage} / {totalPages}
            </span>
            <button type="button" onClick={onNext} disabled={currentPage === totalPages}
                className="btn btn-primary" style={{ opacity: currentPage === totalPages ? 0.6 : 1 }}>
                Next page
            </button>
        </div>
    );
}

function TableHeader({ children, width }: { children: ReactNode; width?: string }) {
    return <th style={{ padding: 12, width, overflowWrap: "anywhere", wordBreak: "break-word", fontSize: "var(--font-table)" }}>{children}</th>;
}

function TableCell({ children, label }: { children: ReactNode; label?: string }) {
    return <td data-label={label ?? ""} style={{ padding: 10, borderRight: "1px solid #eee", overflowWrap: "anywhere", wordBreak: "break-word", fontSize: "var(--font-table)" }}>{children}</td>;
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);

    async function onCopy() {
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                return;
            }
        } catch { /* fallback */ }
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
        <button type="button" onClick={onCopy} onBlur={() => setTimeout(() => setCopied(false), 0)}
            style={{ border: "1px solid #a74040ff", borderRadius: 6, padding: "3px 8px", background: "#fff", color: "#7A1F1F", cursor: "pointer", fontSize: 12, minHeight: 28, flexShrink: 0 }} aria-label="Copy text">
            {copied ? "copied" : "copy"}
        </button>
    );
}

function SearchText({ text, search, showCopy = true }: { text: string; search: string; showCopy?: boolean }) {
    return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "Noto Sans Kannada, sans-serif", fontSize: "var(--font-table)", lineHeight: 1.6, margin: 0, overflowWrap: "anywhere", wordBreak: "break-word", flex: "1 1 auto" }}>
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
    results, search, visibleColumns, authorFile, editState, setEditState,
    onStartEditField, onCancelEdit, onSaveEdit
}: ResultsTableProps) {
    const { editingVachanaNumber, editingField, draft, isSaving } = editState;

    if (!authorFile || results.length === 0) return null;
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
            <div style={{ position: "relative", display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: "1 1 auto" }}>
                    <SearchText text={value} search={search} showCopy={false} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                    <CopyButton text={value} />
                    <button type="button" onClick={() => onStartEditField(vachana, field)}
                        style={{ width: 44, height: 28, border: "1px solid #a74040", borderRadius: 6, background: "#fff", color: "#7A1F1F", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}
                        aria-label={`Edit ${label}`} title={`Edit ${label}`}>
                        Edit
                    </button>
                </div>

                {isEditing && (
                    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancelEdit(); }}>
                        <div className="modal-content" style={{ maxHeight: "85vh" }} onClick={(e) => e.stopPropagation()}>
                            <div style={{ padding: 16, borderBottom: "1px solid #f0f0f0" }}>
                                <div style={{ fontSize: "clamp(16px, 2vw, 18px)", color: "#7A1F1F", fontWeight: 700 }}>
                                    Edit {label} (Vachana {vachana.number})
                                </div>
                            </div>
                            <div style={{ padding: 16, flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                                <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={6}
                                    className="form-input" style={{ flex: 1, resize: "none", minHeight: 200, fontFamily: "inherit" }} />
                                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 14 }}>
                                    <button type="button" onClick={onCancelEdit} disabled={isSaving} className="btn">Cancel</button>
                                    <button type="button" onClick={() => onSaveEdit(vachana.number, field)} disabled={isSaving}
                                        className="btn btn-primary">{isSaving ? "Saving..." : "Save"}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="table-responsive" style={{ background: "#fff", borderRadius: 8, boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
            <table style={{ minWidth: 600 }}>
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
                            {visibleColumns.number ? <TableCell label="No.">{vachana.number}</TableCell> : null}
                            {visibleColumns.kannada ? <TableCell label="Kannada">{renderEditableCell(vachana, "kannada")}</TableCell> : null}
                            {visibleColumns.transliteration ? <TableCell label="Transliteration">{renderEditableCell(vachana, "transliteration")}</TableCell> : null}
                            {visibleColumns.translation ? <TableCell label="Translation">{renderEditableCell(vachana, "translation")}</TableCell> : null}
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
        number: true, kannada: true, transliteration: true, translation: true
    });

    const [editState, setEditState] = useState<EditState>({
        editingVachanaNumber: null, editingField: null, draft: "", isSaving: false
    });

    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

    useEffect(() => {
        async function load() {
            try {
                const authors = await getAuthors();
                const summary = authors.find(a => a.id === Number(id));
                if (!summary) { setLoading(false); return; }
                setAuthorFile(summary.file);
                const data = await getAuthor(summary.file);
                setAuthor(data);
            } finally { setLoading(false); }
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
        const draftValue = editState.draft;
        setEditState(prev => ({ ...prev, isSaving: true }));
        try {
            const nextValue = draftValue === "" ? null : draftValue;
            if (field === "translation") {
                await updateVachanaTranslation(authorFile, vachanaNumber, nextValue);
            } else {
                await updateVachanaField(authorFile, vachanaNumber, field, nextValue);
            }
            setAuthor(prev => {
                if (!prev) return prev;
                return {
                    ...prev, vachanas: prev.vachanas.map(v =>
                        v.number === vachanaNumber
                            ? field === "translation" ? { ...v, translation: nextValue }
                                : field === "kannada" ? { ...v, kannada: nextValue ?? "" }
                                    : { ...v, transliteration: nextValue ?? "" }
                            : v
                    )
                };
            });
        } finally {
            setEditState({ editingVachanaNumber: null, editingField: null, draft: "", isSaving: false });
        }
    }

    if (loading) return <h2 style={{ padding: 40, fontSize: "var(--font-h2)" }}>Loading...</h2>;
    if (!author) return <h2 style={{ padding: 40, fontSize: "var(--font-h2)" }}>Author not found.</h2>;

    const isSearching = search !== deferredSearch;

    return (
        <>
            <Navbar />
            <main className="container-wide" style={{ paddingTop: 45, margin: "0 auto" }}>
                <section style={{ marginBottom: 35 }}>
                    <button type="button" onClick={() => {
                        const locationState = window.history.state as { __vachana_back_from?: unknown; __vachana_preserve_page_number?: unknown; } | null;
                        const backFrom = locationState?.__vachana_back_from;
                        const pageNo = locationState?.__vachana_preserve_page_number;
                        if (typeof backFrom === "string" && backFrom.length > 0) {
                            navigate(backFrom, { state: { __vachana_preserve_page: true, __vachana_preserve_page_number: pageNo } });
                        } else { navigate(-1); }
                    }} className="btn btn-outline" style={{ marginBottom: 16 }}>
                        ← Back
                    </button>

                    <h1 style={{ color: "#7A1F1F", fontSize: "var(--font-h1)", marginBottom: 12 }}>{author.englishName}</h1>
                    <p style={{ color: "#555", fontSize: "var(--font-body)" }}>{author.vachanas.length} Vachanas</p>

                    <input type="text" value={search} placeholder="Search within this author's vachanas..."
                        onChange={e => setSearch(e.target.value)} autoFocus className="form-input" style={{ marginTop: 28 }} />
                </section>

                <section style={{ display: "grid", gap: 18 }}>
                    <h2 style={{ color: "#7A1F1F", fontSize: "var(--font-h2)" }}>Results</h2>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                        <PageSizeOptions pageSize={pageSize} onChange={value => { setPageSize(value); setPage(1); }} />
                        <ColumnOptions visibleColumns={visibleColumns} onToggleColumn={toggleColumn} />
                    </div>

                    {filteredVachanas.length ? (
                        <>
                            {isSearching ? <p style={{ color: "#666", fontSize: "var(--font-body)" }}>Updating results...</p> : null}
                            <PaginationStatus currentPage={currentPage} totalPages={totalPages} totalResults={filteredVachanas.length} pageStart={pageStart} pageResultCount={pageResults.length} />
                            {totalPages > 1 && <PaginationControls currentPage={currentPage} totalPages={totalPages} onPrevious={() => setPage(v => Math.max(1, v - 1))} onNext={() => setPage(v => Math.min(totalPages, v + 1))} />}
                            <ResultsTable results={pageResults} search={deferredSearch.trim()} visibleColumns={visibleColumns} authorFile={authorFile} editState={editState} setEditState={setEditState} onStartEditField={onStartEditField} onCancelEdit={onCancelEdit} onSaveEdit={onSaveEdit} />
                            {totalPages > 1 && <PaginationControls currentPage={currentPage} totalPages={totalPages} onPrevious={() => setPage(v => Math.max(1, v - 1))} onNext={() => setPage(v => Math.min(totalPages, v + 1))} />}
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

