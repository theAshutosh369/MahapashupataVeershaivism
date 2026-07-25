import Navbar from "../components/Navbar";
import "../styles/pages/home.css";
import Footer from "../components/Footer";
import SearchBar from "../components/SearchBar";

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getAuthors } from "../api";
import type { AuthorSummary } from "../types";

type PageSize = 10 | 20 | 50;
const PAGE_SIZE_OPTIONS: PageSize[] = [10, 20, 50];

type ColumnKey = "sr" | "id" | "kannada" | "english" | "count";

const columnLabels: Record<ColumnKey, string> = {
  sr: "Sr. No.",
  id: "Id no.",
  kannada: "kannadaName",
  english: "EnglishName",
  count: "count of vachanas",
};

type SortKey = ColumnKey;

type SortDir = "asc" | "desc";

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div
      style={{
        background: "#fff",
        padding: "clamp(16px, 3vw, 25px)",
        borderRadius: 10,
        minWidth: 140,
        textAlign: "center",
        boxShadow: "0 2px 10px rgba(0,0,0,.08)",
      }}
    >
      <h2 style={{ fontSize: "clamp(20px, 4vw, 32px)" }}>{value}</h2>
      <p style={{ fontSize: "var(--font-body)", color: "#555" }}>{title}</p>
    </div>
  );
}

function ColumnOptions({
  visibleColumns,
  onToggleColumn,
}: {
  visibleColumns: Record<ColumnKey, boolean>;
  onToggleColumn: (column: ColumnKey) => void;
}) {
  const columns = Object.keys(columnLabels) as ColumnKey[];

  return (
    <details style={{ position: "relative" }}>
      <summary className="filter-summary">Show / hide columns</summary>
      <div className="filter-dropdown">
        {columns.map((column) => (
          <label
            key={column}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              cursor: "pointer",
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

function PageSizeOptions({
  pageSize,
  onChange,
}: {
  pageSize: PageSize;
  onChange: (value: PageSize) => void;
}) {
  return (
    <details style={{ position: "relative" }}>
      <summary className="filter-summary">Results per page</summary>
      <div className="filter-dropdown">
        {PAGE_SIZE_OPTIONS.map((option) => (
          <label
            key={option}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              cursor: "pointer",
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

function Th({
  column,
  width,
  children,
  onSort,
  active,
  sortDir,
  getSortIndicator,
}: {
  column: ColumnKey;
  width?: string;
  children?: React.ReactNode;
  onSort?: (column: ColumnKey) => void;
  active?: boolean;
  sortDir?: SortDir;
  getSortIndicator?: (column: ColumnKey) => string;
}) {
  const label = children ?? columnLabels[column];

  return (
    <th
      style={{
        padding: 12,
        width: width ?? undefined,
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        userSelect: "none",
        cursor: onSort ? "pointer" : undefined,
        fontSize: "var(--font-table)",
      }}
      onClick={onSort ? () => onSort(column) : undefined}
      aria-sort={
        active
          ? sortDir === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      title={`Sort by ${columnLabels[column]}`}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {label}
        {active ? (getSortIndicator ? getSortIndicator(column) : "") : ""}
      </span>
    </th>
  );
}

function Td({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <td
      data-label={label ?? ""}
      style={{
        padding: 10,
        borderRight: "1px solid #eee",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        fontSize: "var(--font-table)",
      }}
    >
      {children}
    </td>
  );
}

function MobileAuthorCards({
  authors,
  pageStart,
  visibleColumns,
  rowPinkByAuthor,
  search,
  page,
  pageSize,
  sortKey,
  sortDir,
  onSort,
}: {
  authors: AuthorSummary[];
  pageStart: number;
  visibleColumns: Record<ColumnKey, boolean>;
  rowPinkByAuthor: Record<number, boolean>;
  search: string;
  page: number;
  pageSize: PageSize;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (column: ColumnKey) => void;
}) {
  const sortOptions: { key: ColumnKey; label: string }[] = [
    { key: "sr", label: "Sr. No." },
    { key: "id", label: "Id" },
    { key: "kannada", label: "Kannada" },
    { key: "english", label: "English" },
    { key: "count", label: "Count" },
  ];

  return (
    <div className="mobile-only">
      {/* Mobile sort controls */}
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        marginBottom: 14,
        padding: "8px 4px",
      }}>
        <span style={{ fontSize: 12, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", alignSelf: "center" }}>
          Sort by:
        </span>
        {sortOptions.map(opt => {
          const isActive = sortKey === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onSort(opt.key)}
              style={{
                padding: "4px 10px",
                borderRadius: 16,
                border: `1.5px solid ${isActive ? "#7A1F1F" : "#ddd"}`,
                background: isActive ? "#7A1F1F" : "#fff",
                color: isActive ? "#fff" : "#666",
                fontSize: 12,
                fontWeight: isActive ? 700 : 500,
                cursor: "pointer",
                touchAction: "manipulation",
                transition: "all 0.15s",
              }}
            >
              {opt.label} {isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
            </button>
          );
        })}
      </div>

      {authors.map((author, index) => {
        const pink = Boolean(rowPinkByAuthor[author.id]);
        const showSr = visibleColumns.sr;
        const showId = visibleColumns.id;
        const showKannada = visibleColumns.kannada;
        const showEnglish = visibleColumns.english;
        const showCount = visibleColumns.count;
        const hasAnyVisible = showSr || showId || showKannada || showEnglish || showCount;

        if (!hasAnyVisible) return null;

        return (
          <div
            key={author.id}
            className="mobile-vachana-card mobile-author-card-compact"
            style={{
              background: pink ? "#f0fdd8" : "#fff",
              borderColor: pink ? "#b3d94c" : "rgba(122, 31, 31, 0.08)",
            }}
          >
            {(showSr || showCount) && (
              <div className="mobile-vachana-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                {showSr ? <span>#{pageStart + index + 1}</span> : <span />}
                {showCount ? (
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#7A1F1F", background: "rgba(122,31,31,0.08)", padding: "2px 10px", borderRadius: 20 }}>
                    {author.count.toLocaleString()} vachanas
                  </span>
                ) : null}
              </div>
            )}

            {showKannada && (
              <div className="mobile-vachana-section">
                <span className="mobile-vachana-label">Kannada Name</span>
                <div className="mobile-vachana-kannada-text" style={{ fontSize: 15 }}>
                  {author.kannadaName}
                </div>
              </div>
            )}

            {showEnglish && (
              <div className="mobile-vachana-section">
                <span className="mobile-vachana-label">English Name</span>
                <div className="mobile-vachana-english-text">
                  <Link
                    to={`/author/${author.id}`}
                    onClick={() => {
                      try {
                        window.history.replaceState(
                          {
                            ...(window.history.state ?? {}),
                            __vachana_preserve_home: {
                              search,
                              page,
                              pageSize,
                              sortKey,
                              sortDir,
                              visibleColumns,
                              scrollY: window.scrollY,
                            },
                          },
                          ""
                        );
                      } catch (e) {
                        console.debug(e);
                      }
                    }}
                    state={{
                      __vachana_back_from: window.location.pathname,
                      __vachana_preserve_page: true,
                      __vachana_preserve_page_number: Math.floor(pageStart / 10) + 1,
                    }}
                    style={{
                      color: "#7A1F1F",
                      fontWeight: 700,
                      textDecoration: "none",
                    }}
                  >
                    {author.englishName}
                  </Link>
                </div>
              </div>
            )}

            {showId && author.id ? (
              <div className="mobile-vachana-section" style={{ marginBottom: 0 }}>
                <span className="mobile-vachana-label">ID</span>
                <div className="mobile-vachana-english-text" style={{ fontSize: 13, color: "#666" }}>
                  {author.id.toLocaleString()}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AuthorsTable({
  authors,
  pageStart,
  visibleColumns,
  sortKey,
  sortDir,
  onSort,
  getSortIndicator,
  rowPinkByAuthor,
  search,
  page,
  pageSize,
}: {
  authors: AuthorSummary[];
  pageStart: number;
  visibleColumns: Record<ColumnKey, boolean>;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: ColumnKey) => void;
  getSortIndicator: (key: ColumnKey) => string;
  rowPinkByAuthor: Record<number, boolean>;
  search: string;
  page: number;
  pageSize: PageSize;
}) {
  const hasVisibleColumn = Object.values(visibleColumns).some(Boolean);

  const showMessage = !authors.length || !hasVisibleColumn;
  const message = !hasVisibleColumn
    ? "All result columns are hidden."
    : "No authors matched this filter.";

  if (showMessage) {
    return (
      <p
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 18,
          color: "#666",
        }}
      >
        {message}
      </p>
    );
  }

  return (
    <div className="table-responsive" style={{ background: "#fff", borderRadius: 8, boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
      <table style={{ minWidth: 600, borderCollapse: "collapse", background: "#fff7f7" }}>
        <thead>
          <tr style={{ background: "#7A1F1F", color: "#fff", textAlign: "left" }}>
            {visibleColumns.sr ? (
              <Th column="sr" width="6%" active={sortKey === "sr"} sortDir={sortDir} onSort={onSort} getSortIndicator={getSortIndicator}>Sr. No.</Th>
            ) : null}
            {visibleColumns.id ? (
              <Th column="id" width="10%" active={sortKey === "id"} sortDir={sortDir} onSort={onSort} getSortIndicator={getSortIndicator}>Id no.</Th>
            ) : null}
            {visibleColumns.kannada ? (
              <Th column="kannada" active={sortKey === "kannada"} sortDir={sortDir} onSort={onSort} getSortIndicator={getSortIndicator}>kannadaName</Th>
            ) : null}
            {visibleColumns.english ? (
              <Th column="english" active={sortKey === "english"} sortDir={sortDir} onSort={onSort} getSortIndicator={getSortIndicator}>EnglishName</Th>
            ) : null}
            {visibleColumns.count ? (
              <Th column="count" width="18%" active={sortKey === "count"} sortDir={sortDir} onSort={onSort} getSortIndicator={getSortIndicator}>count of vachanas</Th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {authors.map((author, index) => {
            const pink = Boolean(rowPinkByAuthor[author.id]);
            return (
              <tr
                key={author.id}
                style={{
                  borderBottom: "1px solid #eee",
                  verticalAlign: "top",
                  background: pink ? "#d7f639ff" : undefined,
                }}
              >
                {visibleColumns.sr ? <Td label="Sr. No.">{(pageStart + index + 1).toLocaleString()}</Td> : null}
                {visibleColumns.id ? <Td label="Id no.">{author.id.toLocaleString()}</Td> : null}
                {visibleColumns.kannada ? <Td label="Kannada Name">{author.kannadaName}</Td> : null}
                {visibleColumns.english ? (
                  <Td label="English Name">
                    <Link
                      to={`/author/${author.id}`}
                      onClick={() => {
                        try {
                          window.history.replaceState(
                            {
                              ...(window.history.state ?? {}),
                              __vachana_preserve_home: {
                                search,
                                page,
                                pageSize,
                                sortKey,
                                sortDir,
                                visibleColumns,
                                scrollY: window.scrollY,
                              },
                            },
                            ""
                          );
                        } catch (e) {
                          console.debug(e);
                        }
                      }}
                      state={{
                        __vachana_back_from: window.location.pathname,
                        __vachana_preserve_page: true,
                        __vachana_preserve_page_number: Math.floor(pageStart / 10) + 1,
                      }}
                      style={{
                        color: "#7A1F1F",
                        fontWeight: 700,
                        textDecoration: "none",
                      }}
                    >
                      {author.englishName}
                    </Link>
                  </Td>
                ) : null}
                {visibleColumns.count ? <Td label="Count">{author.count.toLocaleString()}</Td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Home() {
  const _historyState = (window.history.state ?? {}) as unknown as {
    __vachana_preserve_home?: {
      search?: string;
      pageSize?: PageSize;
      page?: number;
      sortKey?: SortKey;
      sortDir?: SortDir;
      visibleColumns?: Record<ColumnKey, boolean>;
      scrollY?: number;
    } | null;
  };

  const preserved = _historyState.__vachana_preserve_home ?? undefined;

  const [search, setSearch] = useState(() => preserved?.search ?? "");
  const [authors, setAuthors] = useState<AuthorSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [pageSize, setPageSize] = useState<PageSize>(() => preserved?.pageSize ?? 10);
  const [page, setPage] = useState(() => preserved?.page ?? 1);

  const [sortKey, setSortKey] = useState<SortKey>(() => preserved?.sortKey ?? "english");
  const [sortDir, setSortDir] = useState<SortDir>(() => preserved?.sortDir ?? "asc");

  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>(() =>
    preserved?.visibleColumns ?? {
      sr: true,
      id: true,
      kannada: true,
      english: true,
      count: true,
    }
  );

  const [rowPinkByAuthor, setRowPinkByAuthor] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let isMounted = true;

    async function load() {
      setLoading(true);
      try {
        const data = await getAuthors();
        if (isMounted) {
          setAuthors(data);
        }
      } catch (error) {
        console.error(error);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      isMounted = false;
    };
  }, []);

  const normalizedSearch = search.trim().toLowerCase();

  const filteredAuthors = useMemo(() => {
    if (!normalizedSearch) return authors;

    return authors.filter(
      (author) =>
        author.kannadaName.includes(search) ||
        author.englishName.toLowerCase().includes(normalizedSearch),
    );
  }, [authors, normalizedSearch, search]);

  const sortedAuthors = useMemo(() => {
    const list = [...filteredAuthors];
    const dir = sortDir === "asc" ? 1 : -1;

    list.sort((a, b) => {
      switch (sortKey) {
        case "sr":
        case "id":
          return (a.id - b.id) * dir;
        case "kannada":
          return a.kannadaName.localeCompare(b.kannadaName, undefined, { sensitivity: "base" }) * dir;
        case "english":
          return a.englishName.localeCompare(b.englishName, undefined, { sensitivity: "base" }) * dir;
        case "count":
          return (a.count - b.count) * dir;
        default:
          return 0;
      }
    });

    return list;
  }, [filteredAuthors, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedAuthors.length / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = pageStart + pageSize;
  const pageAuthors = sortedAuthors.slice(pageStart, pageEnd);

  useEffect(() => {
    const state = (window.history.state ?? {}) as unknown as {
      __vachana_preserve_home?: { scrollY?: number } | null;
      __vachana_preserve_page?: boolean;
    };

    const preservedState = state.__vachana_preserve_home;

    if (preservedState && typeof preservedState.scrollY === "number") {
      requestAnimationFrame(() => {
        try {
          window.scrollTo(0, preservedState.scrollY || 0);
        } catch (e) {
          console.debug(e);
        }
      });
    }

    try {
      window.history.replaceState({ ...(window.history.state ?? {}), __vachana_preserve_page: false, __vachana_preserve_home: null }, "");
    } catch (e) {
      console.debug(e);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function computePinkRows() {
      const next: Record<number, boolean> = {};
      const API_BASE = import.meta.env.VITE_API_URL ?? '';

      for (const summary of authors) {
        try {
          // Use the API endpoint (same as getAuthor) so it works in production too
          const resp = await fetch(`${API_BASE}/api/authors/${encodeURIComponent(summary.file)}`, {
            headers: { 'Accept': 'application/json' }
          });
          if (!resp.ok) {
            next[summary.id] = false;
            continue;
          }

          const json = (await resp.json()) as { vachanas?: Array<{ translation?: string | null }> };
          const vachanas = Array.isArray(json?.vachanas) ? json.vachanas : [];

          const allFilled =
            vachanas.length > 0 &&
            vachanas.every(v => (v.translation ?? "").toString().trim().length > 0);

          next[summary.id] = allFilled;
        } catch {
          next[summary.id] = false;
        }
      }

      if (!cancelled) setRowPinkByAuthor(next);
    }

    void computePinkRows();

    return () => {
      cancelled = true;
    };
  }, [authors]);

  function toggleColumn(column: ColumnKey) {
    setVisibleColumns((current) => ({ ...current, [column]: !current[column] }));
  }

  function toggleSort(column: ColumnKey) {
    if (sortKey !== column) {
      setSortKey(column);
      setSortDir("asc");
      return;
    }
    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
  }

  function getSortIndicator(column: ColumnKey) {
    if (sortKey !== column) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  return (
    <>
      <Navbar />

      <main className="container-wide" style={{ margin: "0 auto" }}>
        <section className="hero-section">
          <div style={{ textAlign: "center", marginBottom: "clamp(20px, 4vw, 40px)" }}>
            <h1 style={{ fontSize: "var(--font-h1)", color: "#7A1F1F", marginBottom: 10 }}>Mahapashupata Veershaivam</h1>
            <p style={{ fontSize: "clamp(14px, 2vw, 18px)", color: "#666" }}>A Digital Library of Kannada Vachanas</p>
          </div>

          <div className="hero-grid">
            <div>
              <h3 style={{ color: "#7A1F1F", marginBottom: 18, fontSize: "var(--font-h3)" }}>Search</h3>
              <SearchBar value={search} onChange={setSearch} />
              <p style={{ marginTop: 15, color: "#777", fontSize: "var(--font-body)" }}>
                {loading ? "Loading..." : `${filteredAuthors.length} author(s) found`}
              </p>
              <div style={{ marginTop: 28 }}>
                <label style={{ display: "block", marginBottom: 10, fontWeight: 600, color: "#555", fontSize: "var(--font-body)" }}>
                  Filter by Vachanakara
                </label>
              </div>
            </div>

            <div>
              <h3 style={{ color: "#7A1F1F", marginBottom: 18, fontSize: "var(--font-h3)" }}>Statistics</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <StatCard title="Authors" value={authors.length.toString()} />
                <StatCard
                  title="Vachanas"
                  value={authors.reduce((sum, a) => sum + a.count, 0).toLocaleString()}
                />
              </div>
            </div>

            <div>
              <h3 style={{ color: "#7A1F1F", marginBottom: 18, fontSize: "var(--font-h3)" }}>Display Options</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <PageSizeOptions pageSize={pageSize} onChange={(value) => setPageSize(value)} />
                <ColumnOptions visibleColumns={visibleColumns} onToggleColumn={toggleColumn} />
              </div>
            </div>
          </div>
        </section>

        <section style={{ marginBottom: 60 }}>
          <div style={{ display: "grid", gap: 18 }}>
            <div style={{ marginBottom: 35, justifyContent: "center", textAlign: "center" }}>
              <span
                style={{
                  display: "block",
                  color: "#7A1F1F",
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "3px",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                COLLECTION
              </span>
              <h2 style={{ margin: 0, fontSize: "var(--font-h2)", fontWeight: 700, color: "#222", lineHeight: 1.2 }}>
                Vachanakaras
              </h2>
            </div>

            {sortedAuthors.length ? (
              <p style={{ color: "#666", fontSize: "var(--font-body)" }}>
                Showing {Math.min(sortedAuthors.length, pageStart + 1).toLocaleString()}-
                {Math.min(sortedAuthors.length, pageEnd).toLocaleString()} of {sortedAuthors.length.toLocaleString()} result(s). Page{" "}
                {currentPage.toLocaleString()} of {totalPages.toLocaleString()}.
              </p>
            ) : null}

            {totalPages > 1 ? (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "4px 0 10px" }}>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="btn btn-outline"
                  style={{ opacity: currentPage === 1 ? 0.6 : 1 }}
                >
                  Previous page
                </button>
                <span style={{ color: "#555", fontSize: "var(--font-body)" }}>
                  Page {currentPage.toLocaleString()} / {totalPages.toLocaleString()}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="btn btn-primary"
                  style={{ opacity: currentPage === totalPages ? 0.6 : 1 }}
                >
                  Next page
                </button>
              </div>
            ) : null}

            <div className="desktop-only">
              <AuthorsTable
                authors={pageAuthors}
                pageStart={pageStart}
                visibleColumns={visibleColumns}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={toggleSort}
                getSortIndicator={getSortIndicator}
                rowPinkByAuthor={rowPinkByAuthor}
                search={search}
                page={currentPage}
                pageSize={pageSize}
              />
            </div>
            <MobileAuthorCards
              authors={pageAuthors}
              pageStart={pageStart}
              visibleColumns={visibleColumns}
              rowPinkByAuthor={rowPinkByAuthor}
              search={search}
              page={currentPage}
              pageSize={pageSize}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />

            {totalPages > 1 ? (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "4px 0 10px" }}>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="btn btn-outline"
                  style={{ opacity: currentPage === 1 ? 0.6 : 1 }}
                >
                  Previous page
                </button>
                <span style={{ color: "#555", fontSize: "var(--font-body)" }}>
                  Page {currentPage.toLocaleString()} / {totalPages.toLocaleString()}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="btn btn-primary"
                  style={{ opacity: currentPage === totalPages ? 0.6 : 1 }}
                >
                  Next page
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}

