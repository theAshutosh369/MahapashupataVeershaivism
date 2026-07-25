import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { getAuthor, getAuthors } from "../api";
import Footer from "../components/Footer";
import HighlightText from "../components/HighlightText";
import Navbar from "../components/Navbar";

import type { Author, AuthorSummary, Vachana } from "../types";
import type { ReactNode } from "react";

type PageSize = 10 | 50 | 100;

const DEFAULT_PAGE_SIZE: PageSize = 100;

type FlatResult = {
    author: Author;
    vachana: Vachana;
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
                    <label
                        key={option}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer" }}
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

type AuthorCount = {
    author: Author;
    count: number;
};

type ColumnKey =
    | "serial"
    | "author"
    | "number"
    | "kannada"
    | "transliteration"
    | "translation";

const columnLabels: Record<ColumnKey, string> = {
    serial: "Sr. No.",
    author: "Vachanakar Name",
    number: "Vachana No.",
    kannada: "Kannada Vachana",
    transliteration: "Transliteration",
    translation: "Translation"
};

function GlobalSearch() {
    const [search, setSearch] = useState("");
    const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
    const deferredSearch = useDeferredValue(search);
    const [authors, setAuthors] = useState<Author[]>([]);
    const [summaries, setSummaries] = useState<AuthorSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [selectedAuthorIds, setSelectedAuthorIds] = useState<number[]>([]);
    const [page, setPage] = useState(1);
    const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>({
        serial: true,
        author: true,
        number: true,
        kannada: true,
        transliteration: true,
        translation: true
    });
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

    useEffect(() => {
        const mq = window.matchMedia("(max-width: 767px)");
        const handler = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);
        handler(mq);
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, []);

    useEffect(() => {
        async function load() {
            try {
                const authorSummaries = await getAuthors();
                setSummaries(authorSummaries);

                const authorData = await Promise.all(
                    authorSummaries.map(summary => getAuthor(summary.file))
                );

                setAuthors(authorData);
            } catch {
                setError("Unable to load vachanas for global search.");
            } finally {
                setLoading(false);
            }
        }

        load();
    }, []);

    const scopedAuthors = useMemo(() => {
        if (selectedAuthorIds.length === 0) return authors;

        const selectedIds = new Set(selectedAuthorIds);
        return authors.filter(author => selectedIds.has(author.id));
    }, [authors, selectedAuthorIds]);

    const searchData = useMemo(() => {
        const query = deferredSearch.trim();
        const q = query.toLowerCase();
        const matches: FlatResult[] = [];
        const authorCountMap: Map<number, number> = new Map();
        const authorCounts: AuthorCount[] = [];

        if (!q)
            return { query, matches, authorCounts };

        for (const author of scopedAuthors) {
            let count = 0;

            for (const vachana of author.vachanas) {
                const matched =
                    vachana.kannada.includes(query) ||
                    vachana.transliteration.toLowerCase().includes(q) ||
                    (vachana.translation ?? "").toLowerCase().includes(q);

                if (matched) {
                    matches.push({ author, vachana });
                    count++;
                }
            }

            authorCountMap.set(author.id, count);
        }

        for (const author of scopedAuthors) {
            const count = authorCountMap.get(author.id) ?? 0;
            if (count > 0) {
                authorCounts.push({ author, count });
            }
        }

        authorCounts.sort((a, b) => b.count - a.count);

        return { query, matches, authorCounts };
    }, [scopedAuthors, deferredSearch]);

    const totalResultCount = searchData.authorCounts.reduce(
        (sum, result) => sum + result.count, 0
    );

    const totalVachanaCount = summaries.reduce(
        (sum, author) => sum + author.count, 0
    );

    const totalPages = Math.max(1, Math.ceil(searchData.matches.length / pageSize));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const pageStart = (currentPage - 1) * pageSize;
    const pageEnd = pageStart + pageSize;
    const pageMatches = searchData.matches.slice(pageStart, pageEnd);
    const isSearching = search !== deferredSearch;
    const selectedAuthorNames = selectedAuthorIds
        .map(authorId => authors.find(author => author.id === authorId)?.englishName)
        .filter((name): name is string => Boolean(name));

    function toggleAuthor(authorId: number) {
        setSelectedAuthorIds(current =>
            current.includes(authorId)
                ? current.filter(id => id !== authorId)
                : [...current, authorId]
        );
    }

    function toggleColumn(column: ColumnKey) {
        setVisibleColumns(current => ({ ...current, [column]: !current[column] }));
    }

    return (
        <>
            <Navbar />

            <main className="container-wide" style={{ paddingTop: 45, margin: "0 auto" }}>
                {/* Search Header - responsive flex */}
                <section style={{
                    display: "flex",
                    gap: "clamp(16px, 3vw, 32px)",
                    alignItems: "flex-start",
                    flexWrap: "wrap"
                }}>
                    <section style={{
                        flex: "1 1 500px",
                        background: "#fff",
                        borderRadius: 18,
                        padding: "clamp(20px, 3vw, 32px)",
                        boxShadow: "0 8px 24px rgba(0,0,0,.08)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 20
                    }}>
                        <div>
                            <h1 style={{ color: "#7A1F1F", fontSize: "var(--font-h1)", fontWeight: 700, margin: 0 }}>
                                Global Search
                            </h1>
                            <p style={{ color: "#666", fontSize: "var(--font-body)", lineHeight: 1.7, marginTop: 14 }}>
                                Search Kannada text, transliteration, and English translations across every vachana.
                            </p>
                        </div>

                        <input
                            type="text"
                            value={search}
                            placeholder="🔍 Search Kannada, English or Transliteration..."
                            onChange={e => setSearch(e.target.value)}
                            autoFocus
                            className="form-input"
                        />

                        <div>
                            <label style={{ display: "block", marginBottom: 10, fontWeight: 600, color: "#555", fontSize: "var(--font-body)" }}>
                                Filter by Vachanakara
                            </label>

                            <AuthorSelector
                                authors={authors}
                                selectedAuthorIds={selectedAuthorIds}
                                selectedAuthorNames={selectedAuthorNames}
                                onToggleAuthor={toggleAuthor}
                                onSelectAll={() => setSelectedAuthorIds([])}
                            />
                        </div>

                        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                            <PageSizeOptions pageSize={pageSize} onChange={value => { setPageSize(value); setPage(1); }} />
                            <ColumnOptions visibleColumns={visibleColumns} onToggleColumn={toggleColumn} />
                        </div>
                    </section>

                    {/* Summary cards - Desktop: vertical column */}
                    <section className="desktop-only" style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 18,
                        flex: "0 1 260px",
                        minWidth: 200
                    }}>
                        <SummaryCard title="Total Vachanas" value={totalVachanaCount.toLocaleString()} />
                        <SummaryCard title="Matching Vachanas" value={totalResultCount.toLocaleString()} />
                        <SummaryCard title="Matching Vachanakaras" value={searchData.authorCounts.length.toLocaleString()} />
                    </section>

                    {/* Summary cards - Mobile: 3-column grid */}
                    <section className="mobile-only mobile-summary-grid" style={{ width: "100%" }}>
                        <div className="summary-card">
                            <h2>{totalVachanaCount.toLocaleString()}</h2>
                            <p>Total Vachanas</p>
                        </div>
                        <div className="summary-card">
                            <h2>{totalResultCount.toLocaleString()}</h2>
                            <p>Matching Vachanas</p>
                        </div>
                        <div className="summary-card">
                            <h2>{searchData.authorCounts.length.toLocaleString()}</h2>
                            <p>Matching Vachanakaras</p>
                        </div>
                    </section>
                </section>

                {loading ? (
                    <h2 style={{ padding: "30px 0", fontSize: "var(--font-h2)" }}>Loading search index...</h2>
                ) : error ? (
                    <h2 style={{ padding: "30px 0", fontSize: "var(--font-h2)" }}>{error}</h2>
                ) : (
                    <>
                        {isSearching ? (
                            <p style={{ color: "#666", marginBottom: 20, fontSize: "var(--font-body)" }}>Updating results...</p>
                        ) : null}

                        {searchData.query ? (
                            <>
                                {/* Per Author Counts */}
                                <AuthorCountsBlock
                                    authorCounts={searchData.authorCounts}
                                    selectedAuthorIds={selectedAuthorIds}
                                    onSelectAuthor={authorId => { setSelectedAuthorIds([authorId]); setPage(1); }}
                                    onClearAuthor={() => { setSelectedAuthorIds([]); setPage(1); }}
                                />

                                {/* Results header */}
                                <div style={{ textAlign: "center", margin: "clamp(30px, 5vw, 55px) 0 clamp(24px, 3vw, 40px)" }}>
                                    <span style={{ color: "#7A1F1F", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "3px" }}>
                                        SEARCH RESULTS
                                    </span>
                                    <h2 style={{ margin: "10px 0 12px", fontSize: "var(--font-h2)", fontWeight: 700, color: "#222" }}>
                                        Global search result for vachanas
                                    </h2>
                                    <div style={{ width: 80, height: 4, background: "#7A1F1F", borderRadius: 10, margin: "0 auto" }} />
                                </div>

                                {searchData.matches.length ? (
                                    <PaginationStatus
                                        currentPage={currentPage}
                                        totalPages={totalPages}
                                        totalResults={searchData.matches.length}
                                        pageStart={pageStart}
                                        pageResultCount={pageMatches.length}
                                    />
                                ) : null}

                                {totalPages > 1 ? (
                                    <PaginationControls
                                        currentPage={currentPage}
                                        totalPages={totalPages}
                                        onPrevious={() => setPage(value => Math.max(1, value - 1))}
                                        onNext={() => setPage(value => Math.min(totalPages, value + 1))}
                                    />
                                ) : null}

                                <div className="desktop-only">
                                    <ResultsTable
                                        results={pageMatches}
                                        search={searchData.query}
                                        pageStart={pageStart}
                                        visibleColumns={visibleColumns}
                                    />
                                </div>

                                <div className="mobile-only">
                                    <MobileGlobalResultsCards
                                        results={pageMatches}
                                        search={searchData.query}
                                        pageStart={pageStart}
                                        visibleColumns={visibleColumns}
                                    />
                                </div>

                                {totalPages > 1 ? (
                                    <PaginationControls
                                        currentPage={currentPage}
                                        totalPages={totalPages}
                                        onPrevious={() => setPage(value => Math.max(1, value - 1))}
                                        onNext={() => setPage(value => Math.min(totalPages, value + 1))}
                                    />
                                ) : null}
                            </>
                        ) : (
                            <p style={{ display: "flex", flexDirection: "column", color: "#666", fontSize: 18, padding: "20px 0", textAlign: "center" }}>
                                Enter the text in search bar to search and see the results
                            </p>
                        )}
                    </>
                )}
            </main>

            <Footer />
        </>
    );
}

function AuthorSelector({
    authors,
    selectedAuthorIds,
    selectedAuthorNames,
    onToggleAuthor,
    onSelectAll
}: {
    authors: Author[];
    selectedAuthorIds: number[];
    selectedAuthorNames: string[];
    onToggleAuthor: (authorId: number) => void;
    onSelectAll: () => void;
}) {
    const label =
        selectedAuthorIds.length === 0
            ? "All vachanakaras"
            : selectedAuthorNames.length === 1
                ? selectedAuthorNames[0]
                : `${selectedAuthorNames.length} vachanakaras selected`;

    return (
        <details style={{ marginTop: 18, position: "relative" }}>
            <summary className="filter-summary" style={{ width: "min(100%, 420px)" }}>
                <span>{label}</span>
                <span aria-hidden="true" style={{ marginLeft: 12 }}>v</span>
            </summary>

            <div className="filter-dropdown" style={{ width: "min(100%, 520px)", maxHeight: 340, overflow: "auto" }}>
                <label style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 6px", borderBottom: "1px solid #eee", cursor: "pointer" }}>
                    <input type="checkbox" checked={selectedAuthorIds.length === 0} onChange={onSelectAll} />
                    All vachanakaras
                </label>

                {authors.map(author => (
                    <label key={author.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 6px", cursor: "pointer" }}>
                        <input type="checkbox" checked={selectedAuthorIds.includes(author.id)} onChange={() => onToggleAuthor(author.id)} />
                        {author.englishName}
                    </label>
                ))}
            </div>
        </details>
    );
}

function AuthorCountsBlock({
    authorCounts,
    selectedAuthorIds,
    onSelectAuthor,
    onClearAuthor
}: {
    authorCounts: AuthorCount[];
    selectedAuthorIds: number[];
    onSelectAuthor: (authorId: number) => void;
    onClearAuthor: () => void;
}) {
    type SortKey = "englishName" | "count";
    type SortDir = "asc" | "desc";

    const [sortKey, setSortKey] = useState<SortKey>("englishName");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [page, setPage] = useState(1);

    const PAGE_SIZE = 10;

    const sorted = useMemo(() => {
        const copy = [...authorCounts];
        copy.sort((a, b) => {
            if (sortKey === "count") {
                const diff = a.count - b.count;
                return sortDir === "asc" ? diff : -diff;
            }
            const diff = a.author.englishName.localeCompare(b.author.englishName);
            return sortDir === "asc" ? diff : -diff;
        });
        return copy;
    }, [authorCounts, sortKey, sortDir]);

    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const pageStart = (currentPage - 1) * PAGE_SIZE;
    const pageEnd = pageStart + PAGE_SIZE;
    const pageItems = sorted.slice(pageStart, pageEnd);

    function toggleSort(key: SortKey) {
        if (key === sortKey) {
            setSortDir(d => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(key);
            setSortDir("asc");
        }
    }

    return (
        <section style={{
            background: "#fff",
            borderRadius: 8,
            padding: "clamp(16px, 2vw, 22px)",
            boxShadow: "0 2px 10px rgba(0,0,0,.08)",
            marginBottom: 35,
            marginTop: 24
        }}>
            <h2 style={{ marginBottom: 18, color: "#7A1F1F", fontSize: "var(--font-h3)" }}>
                Per Vachanakar Result Count
            </h2>

            {selectedAuthorIds.length > 0 ? (
                <button type="button" onClick={onClearAuthor} className="btn btn-outline" style={{ marginBottom: 18 }}>
                    Show all vachanakaras
                </button>
            ) : null}

            {sorted.length ? (
                <>
                    <div className="author-counts-scroll">
                        <table>
                            <thead>
                                <tr style={{ background: "#7A1F1F", color: "#fff", textAlign: "left" }}>
                                    <th style={{ padding: "10px 12px", width: "18%", fontSize: "var(--font-table)" }}>sr. no.</th>
                                    <th style={{ padding: "10px 12px", width: "52%", cursor: "pointer", userSelect: "none", fontSize: "var(--font-table)" }} onClick={() => toggleSort("englishName")}>
                                        vachanakar english name{sortKey === "englishName" ? (sortDir === "asc" ? " ▲" : " ▼") : null}
                                    </th>
                                    <th style={{ padding: "10px 12px", width: "30%", cursor: "pointer", userSelect: "none", fontSize: "var(--font-table)" }} onClick={() => toggleSort("count")}>
                                        vachan count{sortKey === "count" ? (sortDir === "asc" ? " ▲" : " ▼") : null}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {pageItems.map((result, idx) => (
                                    <tr key={result.author.id} style={{ borderBottom: "1px solid #eee" }}>
                                        <td data-label="Sr. No." style={{ padding: 10, fontSize: "var(--font-table)" }}>{(pageStart + idx + 1).toLocaleString()}</td>
                                        <td data-label="Name" style={{ padding: 10, fontSize: "var(--font-table)" }}>
                                            <button type="button" onClick={() => onSelectAuthor(result.author.id)}
                                                style={{ background: "none", border: "none", padding: 0, color: "#7A1F1F", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>
                                                {result.author.englishName}
                                            </button>
                                        </td>
                                        <td data-label="Count" style={{ padding: 10, fontSize: "var(--font-table)" }}>{result.count}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
                            className="btn btn-outline" style={{ opacity: currentPage === 1 ? 0.6 : 1 }}>
                            Previous
                        </button>
                        <span style={{ color: "#555", fontSize: "var(--font-body)" }}>
                            Page {currentPage.toLocaleString()} / {totalPages.toLocaleString()}
                        </span>
                        <button type="button" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
                            className="btn btn-primary" style={{ opacity: currentPage === totalPages ? 0.6 : 1 }}>
                            Next
                        </button>
                    </div>
                </>
            ) : (
                <p style={{ color: "#666", fontSize: "var(--font-body)" }}>No vachanakaras matched this keyword.</p>
            )}
        </section>
    );
}

function PaginationStatus({ currentPage, totalPages, totalResults, pageStart, pageResultCount }: {
    currentPage: number; totalPages: number; totalResults: number; pageStart: number; pageResultCount: number;
}) {
    return (
        <p style={{ color: "#666", fontSize: "var(--font-body)" }}>
            Showing {pageStart + 1}-{pageStart + pageResultCount} of {totalResults} result(s). Page {currentPage} of {totalPages}.
        </p>
    );
}

function PaginationControls({ currentPage, totalPages, onPrevious, onNext }: {
    currentPage: number; totalPages: number; onPrevious: () => void; onNext: () => void;
}) {
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

function SummaryCard({ title, value }: { title: string; value: string }) {
    return (
        <div style={{ background: "#fff", padding: "clamp(16px, 2vw, 22px)", borderRadius: 8, boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
            <h2 style={{ color: "#7A1F1F", fontSize: "clamp(20px, 3vw, 28px)" }}>{value}</h2>
            <p style={{ color: "#555", fontSize: "var(--font-body)" }}>{title}</p>
        </div>
    );
}

function ColumnOptions({ visibleColumns, onToggleColumn }: {
    visibleColumns: Record<ColumnKey, boolean>; onToggleColumn: (column: ColumnKey) => void;
}) {
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

function ResultsTable({ results, search, pageStart, visibleColumns }: {
    results: FlatResult[]; search: string; pageStart: number; visibleColumns: Record<ColumnKey, boolean>;
}) {
    if (results.length === 0) return null;

    const hasVisibleColumn = Object.values(visibleColumns).some(Boolean);

    if (!hasVisibleColumn)
        return <p style={{ background: "#fff", borderRadius: 8, padding: 18, color: "#666" }}>All result columns are hidden.</p>;

    return (
        <div className="table-responsive" style={{ background: "#fff", borderRadius: 8, boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
            <table style={{ minWidth: 700 }}>
                <thead>
                    <tr style={{ background: "#7A1F1F", color: "#fff", textAlign: "left" }}>
                        {visibleColumns.serial ? <TableHeader width="6%">Sr. No.</TableHeader> : null}
                        {visibleColumns.author ? <TableHeader width="12%">Vachanakar Name</TableHeader> : null}
                        {visibleColumns.number ? <TableHeader width="7%">Vachana No.</TableHeader> : null}
                        {visibleColumns.kannada ? <TableHeader>Kannada Vachana</TableHeader> : null}
                        {visibleColumns.transliteration ? <TableHeader>Transliteration</TableHeader> : null}
                        {visibleColumns.translation ? <TableHeader>Translation</TableHeader> : null}
                    </tr>
                </thead>
                <tbody>
                    {results.map((result, index) => (
                        <tr key={`${result.author.id}-${result.vachana.number}`} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                            {visibleColumns.serial ? <TableCell label="Sr. No.">{(pageStart + index + 1).toLocaleString()}</TableCell> : null}
                            {visibleColumns.author ? (
                                <TableCell label="Author">
                                    <Link to={"/author/" + result.author.id} style={{ color: "#7A1F1F", fontWeight: 700 }}>{result.author.englishName}</Link>
                                </TableCell>
                            ) : null}
                            {visibleColumns.number ? <TableCell label="Vachana No.">{result.vachana.number}</TableCell> : null}
                            {visibleColumns.kannada ? <TableCell label="Kannada"><SearchText text={result.vachana.kannada} search={search} /></TableCell> : null}
                            {visibleColumns.transliteration ? <TableCell label="Transliteration"><SearchText text={result.vachana.transliteration} search={search} /></TableCell> : null}
                            {visibleColumns.translation ? <TableCell label="Translation"><SearchText text={result.vachana.translation ?? ""} search={search} /></TableCell> : null}
                        </tr>
                    ))}
                </tbody>
            </table>
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
            style={{ marginLeft: 10, border: "1px solid #a74040ff", borderRadius: 6, padding: "3px 8px", background: "#fff", color: "#7A1F1F", cursor: "pointer", fontSize: 12, flexShrink: 0, minHeight: 28 }} aria-label="Copy text">
            {copied ? "copied" : "copy"}
        </button>
    );
}

function SearchText({ text, search }: { text: string; search: string }) {
    return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "Noto Sans Kannada, sans-serif", fontSize: "var(--font-table)", lineHeight: 1.6, margin: 0, overflowWrap: "anywhere", wordBreak: "break-word", flex: "1 1 auto" }}>
                <HighlightText text={text} search={search} />
            </pre>
            <CopyButton text={text} />
        </div>
    );
}

function MobileGlobalResultsCards({ results, search, pageStart, visibleColumns }: {
    results: FlatResult[]; search: string; pageStart: number; visibleColumns: Record<ColumnKey, boolean>;
}) {
    if (results.length === 0) return null;

    const hasVisibleColumn = Object.values(visibleColumns).some(Boolean);
    if (!hasVisibleColumn) return null;

    function formatCopyAll(result: FlatResult): string {
        return [
            `Kannada:\n${result.vachana.kannada}`,
            `Transliteration:\n${result.vachana.transliteration}`,
            `English:\n${result.vachana.translation ?? ""}`
        ].join("\n\n");
    }

    function MobileCopyButton({ text, label }: { text: string; label?: string }) {
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
                className="btn-action" aria-label={label ?? "Copy text"}>
                {copied ? "Copied!" : label ?? "Copy"}
            </button>
        );
    }

    return (
        <>
            {results.map((result, index) => (
                <div key={`${result.author.id}-${result.vachana.number}`} className="global-search-mobile-card">
                    {/* Card Meta Header */}
                    <div className="card-meta">
                        {visibleColumns.serial && (
                            <span>sr. no. #{pageStart + index + 1}</span>
                        )}
                        {visibleColumns.author && (
                            <span>
                                Author : <Link to={"/author/" + result.author.id}>{result.author.englishName}</Link>
                            </span>
                        )}
                        {visibleColumns.number && (
                            <span>vachana no. : {result.vachana.number}</span>
                        )}
                    </div>

                    {/* Kannada Section */}
                    {visibleColumns.kannada && (
                        <div className="card-section">
                            <span className="card-label">Kannada</span>
                            <div className="card-kannada">
                                <HighlightText text={result.vachana.kannada} search={search} />
                            </div>
                        </div>
                    )}

                    {/* Transliteration Section */}
                    {visibleColumns.transliteration && (
                        <div className="card-section">
                            <span className="card-label">Transliteration</span>
                            <div className="card-transliteration">
                                <HighlightText text={result.vachana.transliteration} search={search} />
                            </div>
                        </div>
                    )}

                    {/* English Translation Section */}
                    {visibleColumns.translation && (
                        <div className="card-section">
                            <span className="card-label">English Translation</span>
                            <div className="card-english">
                                <HighlightText text={result.vachana.translation ?? ""} search={search} />
                            </div>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="card-actions">
                        {visibleColumns.kannada && (
                            <MobileCopyButton text={result.vachana.kannada} label="Copy Kannada" />
                        )}
                        {visibleColumns.transliteration && (
                            <MobileCopyButton text={result.vachana.transliteration} label="Copy Transliteration" />
                        )}
                        {visibleColumns.translation && (
                            <MobileCopyButton text={result.vachana.translation ?? ""} label="Copy English" />
                        )}
                        {(visibleColumns.kannada || visibleColumns.transliteration || visibleColumns.translation) && (
                            <MobileCopyButton
                                text={formatCopyAll(result)}
                                label="Copy All"
                            />
                        )}
                    </div>
                </div>
            ))}
        </>
    );
}

export default GlobalSearch;

