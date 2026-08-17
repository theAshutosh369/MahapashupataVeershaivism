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
        const authorCounts: AuthorCount[] = [];

        if (!q)
            return {
                query,
                matches,
                authorCounts
            };

        for (const author of scopedAuthors) {
            let count = 0;

            for (const vachana of author.vachanas) {
                const matched =
                    vachana.kannada.includes(query) ||
                    vachana.transliteration.toLowerCase().includes(q) ||
                    (vachana.translation ?? "").toLowerCase().includes(q);

                if (matched) {
                    count += 1;
                    matches.push({ author, vachana });
                }
            }

            if (count > 0) {
                authorCounts.push({ author, count });
            }
        }

        authorCounts.sort((a, b) => b.count - a.count);

        return {
            query,
            matches,
            authorCounts
        };
    }, [scopedAuthors, deferredSearch]);

    const totalResultCount = searchData.authorCounts.reduce(
        (sum, result) => sum + result.count,
        0
    );

    const totalVachanaCount = summaries.reduce(
        (sum, author) => sum + author.count,
        0
    );

    const totalPages = Math.max(
        1,
        Math.ceil(searchData.matches.length / pageSize)
    );

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
        setVisibleColumns(current => ({
            ...current,
            [column]: !current[column]
        }));
    }

    return (
        <>
            <Navbar />

            <main
                className="container"
                style={{
                    paddingTop: 45,
                    width: "min(1800px, calc(100% - 24px))"
                }}
            >
                <section style={{
                    display: "flex",
                    gap: 32,
                    alignItems: "flex-start"
                }}>
                    <section
                        style={{
                            flex: 1,
                            background: "#fff",
                            borderRadius: 18,
                            padding: 32,
                            boxShadow: "0 8px 24px rgba(0,0,0,.08)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 24
                        }}
                    >
                        <div>
                            <h1
                                style={{
                                    color: "#7A1F1F",
                                    fontSize: 42,
                                    fontWeight: 700,
                                    margin: 0
                                }}
                            >
                                Global Search
                            </h1>

                            <p
                                style={{
                                    color: "#666",
                                    fontSize: 18,
                                    lineHeight: 1.7,
                                    marginTop: 14
                                }}
                            >
                                Search Kannada text, transliteration, and English
                                translations across every vachana.
                            </p>
                        </div>

                        <input
                            type="text"
                            value={search}
                            placeholder="🔍 Search Kannada, English or Transliteration..."
                            onChange={e => setSearch(e.target.value)}
                            autoFocus
                            style={{
                                width: "100%",
                                padding: "18px 20px",
                                fontSize: 18,
                                borderRadius: 12,
                                border: "1px solid #d8d8d8",
                                outline: "none"
                            }}
                        />

                        <div>
                            <label
                                style={{
                                    display: "block",
                                    marginBottom: 10,
                                    fontWeight: 600,
                                    color: "#555"
                                }}
                            >
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

                        <div
                            style={{
                                display: "flex",
                                gap: 16,
                                alignItems: "flex-start",
                                marginTop: 22,
                                flexWrap: "wrap"
                            }}
                        >
                            <PageSizeOptions
                                pageSize={pageSize}
                                onChange={value => {
                                    setPageSize(value);
                                    setPage(1);
                                }}
                            />

                            <ColumnOptions
                                visibleColumns={visibleColumns}
                                onToggleColumn={toggleColumn}
                            />
                        </div>
                    </section>

                    <section
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 18,
                            marginBottom: 30
                        }}
                    >
                        <SummaryCard
                            title="Total Vachanas"
                            value={totalVachanaCount.toLocaleString()}
                        />
                        <SummaryCard
                            title="Matching Vachanas"
                            value={totalResultCount.toLocaleString()}
                        />
                        <SummaryCard
                            title="Matching Vachanakaras"
                            value={searchData.authorCounts.length.toLocaleString()}
                        />

                    </section>

                </section>



                {loading ? (
                    <h2 style={{ padding: "30px 0" }}>Loading search index...</h2>
                ) : error ? (
                    <h2 style={{ padding: "30px 0" }}>{error}</h2>
                ) : (
                    <>
                        {isSearching ? (
                            <p style={{ color: "#666", marginBottom: 20 }}>
                                Updating results...
                            </p>
                        ) : null}

                        {searchData.query ? (
                            <>

                                <section
                                    style={{
                                        // display: "grid",
                                        // gridTemplateColumns: "260px 1fr",
                                        gap: 18,
                                        alignItems: "start"
                                    }}
                                >


                                    {/* Per Vachanakar Result Count */}
                                    <aside style={{
                                        marginTop: "20px"
                                    }}>

                                        <AuthorCountsBlock
                                            authorCounts={searchData.authorCounts}
                                            selectedAuthorIds={selectedAuthorIds}
                                            onSelectAuthor={authorId => {
                                                setSelectedAuthorIds([authorId]);
                                                setPage(1);
                                            }}
                                            onClearAuthor={() => {
                                                setSelectedAuthorIds([]);
                                                setPage(1);
                                            }}
                                        />
                                    </aside>

                                    {/* FULL WIDTH: Search Results Table */}
                                    <div
                                        style={{
                                            textAlign: "center",
                                            margin: "55px 0 40px"
                                        }}
                                    >
                                        <span
                                            style={{
                                                color: "#7A1F1F",
                                                fontSize: 14,
                                                fontWeight: 700,
                                                textTransform: "uppercase",
                                                letterSpacing: "3px"
                                            }}
                                        >
                                            SEARCH RESULTS
                                        </span>

                                        <h2
                                            style={{
                                                margin: "10px 0 12px",
                                                fontSize: 38,
                                                fontWeight: 700,
                                                color: "#222"
                                            }}
                                        >
                                            Global search result for vachanas
                                        </h2>

                                        <div
                                            style={{
                                                width: 80,
                                                height: 4,
                                                background: "#7A1F1F",
                                                borderRadius: 10,
                                                margin: "0 auto"
                                            }}
                                        />
                                    </div>
                                    <div>
                                        {searchData.matches.length ? (
                                            <PaginationStatus
                                                currentPage={currentPage}
                                                totalPages={totalPages}
                                                totalResults={searchData.matches.length}
                                                pageStart={pageStart}
                                                pageResultCount={pageMatches.length}
                                            />
                                        ) : null}
                                    </div>


                                    <section style={{ gridColumn: "1 / -1" }}>
                                        {totalPages > 1 ? (
                                            <PaginationControls
                                                currentPage={currentPage}
                                                totalPages={totalPages}
                                                onPrevious={() =>
                                                    setPage(value =>
                                                        Math.max(1, value - 1)
                                                    )}
                                                onNext={() =>
                                                    setPage(value =>
                                                        Math.min(totalPages, value + 1)
                                                    )}
                                            />
                                        ) : null}

                                        <ResultsTable
                                            results={pageMatches}
                                            search={searchData.query}
                                            pageStart={pageStart}
                                            visibleColumns={visibleColumns}
                                        />

                                        {totalPages > 1 ? (
                                            <PaginationControls
                                                currentPage={currentPage}
                                                totalPages={totalPages}
                                                onPrevious={() =>
                                                    setPage(value =>
                                                        Math.max(1, value - 1)
                                                    )}
                                                onNext={() =>
                                                    setPage(value =>
                                                        Math.min(totalPages, value + 1)
                                                    )}
                                            />
                                        ) : null}
                                    </section>
                                </section>
                            </>
                        ) : (


                            <p
                                style={{
                                    display: "flex", flexDirection: "column",
                                    color: "#666",
                                    fontSize: 18,
                                    padding: "20px 0",
                                    textAlign: "center"
                                }}
                            >
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
            <summary
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 18,
                    width: "min(100%, 420px)",
                    padding: "13px 15px",
                    border: "1px solid #ccc",
                    borderRadius: 8,
                    background: "#fff",
                    cursor: "pointer"
                }}
            >
                <span>{label}</span>
                <span aria-hidden="true">v</span>
            </summary>

            <div
                style={{
                    width: "min(100%, 520px)",
                    maxHeight: 340,
                    overflow: "auto",
                    marginTop: 8,
                    padding: 12,
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    background: "#fff",
                    boxShadow: "0 6px 20px rgba(0,0,0,.12)",
                    zIndex: 2
                }}
            >
                <label
                    style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "center",
                        padding: "8px 6px",
                        borderBottom: "1px solid #eee"
                    }}
                >
                    <input
                        type="checkbox"
                        checked={selectedAuthorIds.length === 0}
                        onChange={onSelectAll}
                    />
                    All vachanakaras
                </label>

                {authors.map(author => (
                    <label
                        key={author.id}
                        style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            padding: "8px 6px"
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={selectedAuthorIds.includes(author.id)}
                            onChange={() => onToggleAuthor(author.id)}
                        />
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
        <section
            style={{
                background: "#fff",
                borderRadius: 8,
                padding: 22,
                boxShadow: "0 2px 10px rgba(0,0,0,.08)",
                marginBottom: 35
            }}
        >
            <h2 style={{ marginBottom: 18, color: "#7A1F1F" }}>
                Per Vachanakar Result Count
            </h2>

            {selectedAuthorIds.length > 0 ? (
                <button
                    type="button"
                    onClick={onClearAuthor}
                    style={{
                        border: "1px solid #7A1F1F",
                        borderRadius: 8,
                        padding: "10px 14px",
                        background: "#fff",
                        color: "#7A1F1F",
                        marginBottom: 18
                    }}
                >
                    Show all vachanakaras
                </button>
            ) : null}

            {sorted.length ? (
                <>
                    <div style={{ overflowX: "auto" }}>
                        <table
                            style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                tableLayout: "fixed"
                            }}
                        >
                            <thead>
                                <tr
                                    style={{
                                        background: "#7A1F1F",
                                        color: "#fff",
                                        textAlign: "left"
                                    }}
                                >
                                    <th style={{ padding: 12, width: "18%" }}>sr. no.</th>
                                    <th
                                        style={{
                                            padding: 12,
                                            width: "52%",
                                            cursor: "pointer",
                                            userSelect: "none"
                                        }}
                                        onClick={() => toggleSort("englishName")}
                                    >
                                        vachanakar english name
                                        {sortKey === "englishName" ? (sortDir === "asc" ? " ▲" : " ▼") : null}
                                    </th>
                                    <th
                                        style={{
                                            padding: 12,
                                            width: "30%",
                                            cursor: "pointer",
                                            userSelect: "none"
                                        }}
                                        onClick={() => toggleSort("count")}
                                    >
                                        vachan count
                                        {sortKey === "count" ? (sortDir === "asc" ? " ▲" : " ▼") : null}
                                    </th>
                                </tr>
                            </thead>

                            <tbody>
                                {pageItems.map((result, idx) => (
                                    <tr
                                        key={result.author.id}
                                        style={{ borderBottom: "1px solid #eee" }}
                                    >
                                        <td style={{ padding: 10, overflowWrap: "anywhere" }}>
                                            {(pageStart + idx + 1).toLocaleString()}
                                        </td>
                                        <td style={{ padding: 10, overflowWrap: "anywhere" }}>
                                            <button
                                                type="button"
                                                onClick={() => onSelectAuthor(result.author.id)}
                                                style={{
                                                    background: "none",
                                                    border: "none",
                                                    padding: 0,
                                                    margin: 0,
                                                    color: "#7A1F1F",
                                                    fontWeight: 700,
                                                    fontSize: "inherit",
                                                    fontFamily: "inherit",
                                                    cursor: "pointer",
                                                    opacity: selectedAuthorIds.includes(result.author.id) ? 1 : 0.9
                                                }}
                                            >
                                                {result.author.englishName}
                                            </button>
                                        </td>
                                        <td style={{ padding: 10 }}>{result.count}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 12,
                            alignItems: "center",
                            marginTop: 12
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                            style={{
                                border: "1px solid #7A1F1F",
                                borderRadius: 8,
                                padding: "8px 12px",
                                background: currentPage === 1 ? "#eee" : "#fff",
                                color: currentPage === 1 ? "#777" : "#7A1F1F",
                                cursor: currentPage === 1 ? "not-allowed" : "pointer"
                            }}
                        >
                            Previous
                        </button>

                        <span style={{ color: "#555" }}>
                            Page {currentPage.toLocaleString()} / {totalPages.toLocaleString()}
                        </span>

                        <button
                            type="button"
                            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages}
                            style={{
                                border: "1px solid #7A1F1F",
                                borderRadius: 8,
                                padding: "8px 12px",
                                background: currentPage === totalPages ? "#eee" : "#7A1F1F",
                                color: currentPage === totalPages ? "#777" : "#fff",
                                cursor: currentPage === totalPages ? "not-allowed" : "pointer"
                            }}
                        >
                            Next
                        </button>
                    </div>
                </>
            ) : (
                <p style={{ color: "#666" }}>No vachanakaras matched this keyword.</p>
            )}
        </section>
    );
}

function PaginationStatus({
    currentPage,
    totalPages,
    totalResults,
    pageStart,
    pageResultCount
}: {
    currentPage: number;
    totalPages: number;
    totalResults: number;
    pageStart: number;
    pageResultCount: number;
}) {
    const firstResult = pageStart + 1;
    const lastResult = pageStart + pageResultCount;

    return (
        <p style={{ color: "#666" }}>
            Showing {firstResult.toLocaleString()}-{lastResult.toLocaleString()} of {totalResults.toLocaleString()} result(s). Page {currentPage.toLocaleString()} of {totalPages.toLocaleString()}.
        </p>
    );
}

function PaginationControls({
    currentPage,
    totalPages,
    onPrevious,
    onNext
}: {
    currentPage: number;
    totalPages: number;
    onPrevious: () => void;
    onNext: () => void;
}) {
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

function SummaryCard({ title, value }: { title: string; value: string }) {
    return (
        <div
            style={{
                background: "#fff",
                padding: 22,
                borderRadius: 8,
                boxShadow: "0 2px 10px rgba(0,0,0,.08)"
            }}
        >
            <h2 style={{ color: "#7A1F1F" }}>{value}</h2>
            <p style={{ color: "#555" }}>{title}</p>
        </div>
    );
}

function ColumnOptions({
    visibleColumns,
    onToggleColumn
}: {
    visibleColumns: Record<ColumnKey, boolean>;
    onToggleColumn: (column: ColumnKey) => void;
}) {
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

function ResultsTable({
    results,
    search,
    pageStart,
    visibleColumns
}: {
    results: FlatResult[];
    search: string;
    pageStart: number;
    visibleColumns: Record<ColumnKey, boolean>;
}) {
    if (results.length === 0) return null;

    const hasVisibleColumn = Object.values(visibleColumns).some(Boolean);

    if (!hasVisibleColumn)
        return (
            <p
                style={{
                    background: "#fff",
                    borderRadius: 8,
                    padding: 18,
                    color: "#666"
                }}
            >
                All result columns are hidden.
            </p>
        );

    return (
        <div
            style={{
                background: "#fff",
                borderRadius: 8,
                boxShadow: "0 2px 10px rgba(0,0,0,.08)",
                overflow: "visible"
            }}
        >
            <table
                style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    tableLayout: "fixed"
                }}
            >
                <thead>
                    <tr
                        style={{
                            background: "#7A1F1F",
                            color: "#fff",
                            textAlign: "left"
                        }}
                    >
                        {visibleColumns.serial ? (
                            <TableHeader width="6%">Sr. No.</TableHeader>
                        ) : null}

                        {visibleColumns.author ? (
                            <TableHeader width="12%">Vachanakar Name</TableHeader>
                        ) : null}

                        {visibleColumns.number ? (
                            <TableHeader width="7%">Vachana No.</TableHeader>
                        ) : null}

                        {visibleColumns.kannada ? <TableHeader>Kannada Vachana</TableHeader> : null}
                        {visibleColumns.transliteration ? <TableHeader>Transliteration</TableHeader> : null}
                        {visibleColumns.translation ? <TableHeader>Translation</TableHeader> : null}
                    </tr>
                </thead>

                <tbody>
                    {results.map((result, index) => (
                        <tr
                            key={`${result.author.id}-${result.vachana.number}`}
                            style={{
                                borderBottom: "1px solid #eee",
                                verticalAlign: "top"
                            }}
                        >
                            {visibleColumns.serial ? (
                                <TableCell>
                                    {(pageStart + index + 1).toLocaleString()}
                                </TableCell>
                            ) : null}

                            {visibleColumns.author ? (
                                <TableCell>
                                    <Link
                                        to={"/author/" + result.author.id}
                                        style={{
                                            color: "#7A1F1F",
                                            fontWeight: 700
                                        }}
                                    >
                                        {result.author.englishName}
                                    </Link>
                                </TableCell>
                            ) : null}

                            {visibleColumns.number ? <TableCell>{result.vachana.number}</TableCell> : null}

                            {visibleColumns.kannada ? (
                                <TableCell>
                                    <SearchText text={result.vachana.kannada} search={search} />
                                </TableCell>
                            ) : null}

                            {visibleColumns.transliteration ? (
                                <TableCell>
                                    <SearchText
                                        text={result.vachana.transliteration}
                                        search={search}
                                    />
                                </TableCell>
                            ) : null}

                            {visibleColumns.translation ? (
                                <TableCell>
                                    <SearchText
                                        text={result.vachana.translation ?? ""}
                                        search={search}
                                    />
                                </TableCell>
                            ) : null}
                        </tr>
                    ))}
                </tbody>
            </table>
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
            // fallback below
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
            onBlur={() => {
                setTimeout(() => setCopied(false), 0);
            }}
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

function SearchText({ text, search }: { text: string; search: string }) {
    return (
        <div
            style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6
            }}
        >
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

            <CopyButton text={text} />
        </div>
    );
}

export default GlobalSearch;

