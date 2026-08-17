import { useEffect, useMemo, useState } from "react";

import Footer from "../components/Footer";
import Navbar from "../components/Navbar";

import { listDatasets, upsertDatasetItem } from "../api_datasets";


type DatasetLanguage =
    | "kannada"
    | "transliteration"
    | "english"
    | "hindi"
    | "sanskrit"
    | "tamil"
    | "telugu"
    | "marathi";

type DatasetFieldKey =
    | "page"
    | "kannada"
    | "hindi"
    | "marathi"
    | "telugu"
    | "tamil"
    | "sanskrit"
    | "english";

type DatasetRow = {
    page: number;
    [k: string]: unknown;
};

const NON_ENGLISH_LANGUAGES: Exclude<DatasetLanguage, "english" | "transliteration">[] = [
    "sanskrit",
    "hindi",
    "marathi",
    "kannada",
    "telugu",
    "tamil"
];

const LANGUAGE_OPTIONS: Exclude<DatasetLanguage, "transliteration">[] = [
    ...NON_ENGLISH_LANGUAGES,
    "english"
];

function normalizeDatasetName(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return "custom.json";
    return trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
}

function fieldKeysForCreate(lang: DatasetLanguage): DatasetFieldKey[] {
    // Keep the order stable for UI + payload building.
    // Requirement: when creating sanskrit + english, order should be: page -> sanskrit -> english
    // This function also enforces page always first and english always last (when present).
    if (lang === "english") return ["page", "english"];

    return ["page", lang as DatasetFieldKey, "english"];
}

function DatasetGenerator() {
    const [mode, setMode] = useState<"new" | "existing">("new");

    // common
    const [datasetNames, setDatasetNames] = useState<string[]>(["custom.json"]);

    // Create/New
    const [datasetNameInput, setDatasetNameInput] = useState<string>("custom.json");
    const effectiveName = useMemo(
        () => normalizeDatasetName(datasetNameInput),
        [datasetNameInput]
    );
    const [newLanguage, setNewLanguage] = useState<Exclude<DatasetLanguage, "transliteration">>(
        "sanskrit"
    );

    // Existing
    const [existingDatasetName, setExistingDatasetName] = useState<string>("");

    // shared inputs
    const [page, setPage] = useState<number>(1);
    const [pageInput, setPageInput] = useState<string>("1");

    // drafts keyed by field
    const [drafts, setDrafts] = useState<Record<Exclude<DatasetFieldKey, "page">, string>>({
        kannada: "",
        hindi: "",
        marathi: "",
        telugu: "",
        tamil: "",
        sanskrit: "",
        english: ""
    });

    const [showField, setShowField] = useState<Record<DatasetFieldKey, boolean>>({
        page: true,
        kannada: false,
        hindi: false,
        marathi: false,
        telugu: false,
        tamil: false,
        sanskrit: false,
        english: false
    });

    const [fieldKeys, setFieldKeys] = useState<DatasetFieldKey[]>(["page", "english"]);

    // existingData is not used for rendering; keeping for future but avoid lint noise.
    const [, setExistingData] = useState<DatasetRow | null>(null);


    // Message shown below the Add Data section after save/update.
    const [bottomMessage, setBottomMessage] = useState<string>("");

    // Hide message after any click on the screen (outside inputs/buttons also clears).
    useEffect(() => {
        if (!bottomMessage) return;

        const onAnyClick = () => setBottomMessage("");
        window.addEventListener("click", onAnyClick, { capture: true });
        return () => window.removeEventListener("click", onAnyClick, { capture: true });
    }, [bottomMessage]);



    const isExistingSelectedPresent = useMemo(() => {

        return datasetNames.includes(existingDatasetName);
    }, [datasetNames, existingDatasetName]);

    useEffect(() => {
        (async () => {
            const names = await listDatasets();
            setDatasetNames(names);
        })();
    }, []);

    // Keep field toggles in sync with selected mode
    useEffect(() => {
        if (mode === "new") {
            const keys = fieldKeysForCreate(newLanguage);
            // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
            setFieldKeys(keys);

            setShowField({
                page: keys.includes("page"),
                kannada: keys.includes("kannada"),
                hindi: keys.includes("hindi"),
                marathi: keys.includes("marathi"),
                telugu: keys.includes("telugu"),
                tamil: keys.includes("tamil"),
                sanskrit: keys.includes("sanskrit"),
                english: keys.includes("english"),
            });

            // reset drafts for fields not visible
            setDrafts(prev => {
                const next = { ...prev };
                (Object.keys(next) as Array<keyof typeof next>).forEach(k => {
                    if (!keys.includes(k as DatasetFieldKey)) {
                        next[k] = ""; // no cast needed now
                    }
                });
                return next;
            });
        } else {
            // existing mode default keys - overwritten after dataset load
            setFieldKeys(["page", "english"]);
            setShowField(prev => ({ ...prev, page: true, english: true }));
        }
    }, [mode, newLanguage]);


    // Load existing dataset shape: use data[0] keys for toggles + input fields
    useEffect(() => {
        if (mode !== "existing") return;

        let cancelled = false;

        (async () => {
            try {
                const resp = await fetch(
                    `http://localhost:3002/api/datasets/${encodeURIComponent(existingDatasetName)}`
                );
                const json = await resp.json();
                if (!Array.isArray(json?.data) || json.data.length === 0) {
                    if (!cancelled) {
                        setExistingData(null);
                        setFieldKeys(["page", "english"]);
                        setShowField(prev => ({ ...prev, page: true, english: true }));
                    }
                    return;
                }

                const first = json.data[0] as DatasetRow;
                const keysFromRow = Object.keys(first).filter(k => k !== "page");

                const sanitizedKeys: DatasetFieldKey[] = [
                    "page",
                    ...(keysFromRow
                        .filter(k =>
                            [
                                "kannada",
                                "hindi",
                                "marathi",
                                "telugu",
                                "tamil",
                                "sanskrit",
                                "english"
                            ].includes(k)
                        ) as DatasetFieldKey[])
                ];

                const finalKeys: DatasetFieldKey[] = Array.from(new Set(sanitizedKeys));

                if (!cancelled) {
                    setExistingData(null);
                    setFieldKeys(finalKeys);
                    setShowField(() => ({
                        page: finalKeys.includes("page"),
                        kannada: finalKeys.includes("kannada"),
                        hindi: finalKeys.includes("hindi"),
                        marathi: finalKeys.includes("marathi"),
                        telugu: finalKeys.includes("telugu"),
                        tamil: finalKeys.includes("tamil"),
                        sanskrit: finalKeys.includes("sanskrit"),
                        english: finalKeys.includes("english")
                    }));

                    setDrafts(prev => {
                        const next = { ...prev };
                        (Object.keys(next) as (keyof typeof next)[]).forEach(k => {
                            if (!finalKeys.includes(k as DatasetFieldKey)) next[k] = "";
                        });
                        return next;
                    });
                }
            } catch {
                if (cancelled) return;
                setExistingData(null);
                setFieldKeys(["page", "english"]);
                setShowField(prev => ({ ...prev, page: true, english: true }));
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [mode, existingDatasetName]);

    // When page changes in existing mode, load data row drafts from that page
    useEffect(() => {
        if (mode !== "existing") return;

        let cancelled = false;

        (async () => {
            try {
                const resp = await fetch(
                    `http://localhost:3002/api/datasets/${encodeURIComponent(existingDatasetName)}`
                );
                const json = await resp.json();
                const rows: DatasetRow[] = Array.isArray(json?.data) ? json.data : [];
                const found = rows.find(r => Number(r?.page) === Number(page)) ?? null;
                if (cancelled) return;
                setExistingData(found);

                if (!found) {
                    setDrafts(prev => {
                        const next = { ...prev };
                        (Object.keys(next) as (keyof typeof next)[]).forEach(k => {
                            if (fieldKeys.includes(k as DatasetFieldKey)) next[k] = "";
                        });
                        return next;
                    });
                    return;
                }

                setDrafts(prev => {
                    const next = { ...prev };
                    (Object.keys(next) as (keyof typeof next)[]).forEach(k => {
                        if (!fieldKeys.includes(k as DatasetFieldKey)) return;
                        const v = (found as Record<string, unknown>)[k];
                        next[k] = v == null ? "" : String(v);
                    });
                    return next;
                });
            } catch {
                if (cancelled) return;
                setExistingData(null);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [mode, existingDatasetName, page, fieldKeys]);

    const toggleField = (key: DatasetFieldKey) => {
        setShowField(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const visibleFieldKeys = useMemo(() => {
        return fieldKeys.filter(k => showField[k]);
    }, [fieldKeys, showField]);

    async function onCreateOrAdd() {
        const pageNum = Number(page);
        if (!Number.isFinite(pageNum)) {
            alert("Invalid page number");
            return;
        }

        if (mode === "new") {
            // const keys = fieldKeysForCreate(newLanguage);

            const languagesToSend: DatasetLanguage[] = [];
            const item: Record<string, unknown> = { page: pageNum };

            item.english = drafts.english === "" ? null : drafts.english;
            languagesToSend.push("english");

            if (newLanguage !== "english") {
                const lang = newLanguage as Exclude<DatasetLanguage, "english" | "transliteration">;
                item[lang] = (drafts as Record<string, string>)[lang] === "" ? null : (drafts as Record<string, string>)[lang];
                languagesToSend.push(lang);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await upsertDatasetItem(effectiveName, languagesToSend, item as any);
            setBottomMessage("Dataset saved.");
            const next = page + 1;
            setPage(next);
            setPageInput(String(next));
            // ✅ Clear drafts so inputs reset
            setDrafts({
                english: "",
                kannada: "",
                hindi: "",
                marathi: "",
                telugu: "",
                tamil: "",
                sanskrit: ""
            });
            return;

        }

        const languagesToSend: DatasetLanguage[] = [];
        const item: Record<string, unknown> = { page: pageNum };

        const keysToSend = visibleFieldKeys.filter(k => k !== "page");
        for (const k of keysToSend) {
            if (k === "english") {
                languagesToSend.push("english");
                item.english = drafts.english === "" ? null : drafts.english;
                continue;
            }

            if (["kannada", "hindi", "marathi", "telugu", "tamil", "sanskrit"].includes(k)) {
                languagesToSend.push(k as DatasetLanguage);
                item[k] = (drafts as Record<string, string>)[k] === "" ? null : (drafts as Record<string, string>)[k];
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await upsertDatasetItem(existingDatasetName, languagesToSend, item as any);
        setBottomMessage("Dataset Updated.");
        const next = page + 1;
        setPage(next);
        setPageInput(String(next));
    }

    return (
        <>
            <Navbar />

            <main className="container" style={{ paddingTop: 45, width: "min(1200px,95%)" }}>
                <h1 style={{ color: "#7A1F1F", fontSize: 34, marginBottom: 18 }}>Dataset</h1>

                <section
                    style={{
                        background: "#fff",
                        borderRadius: 10,
                        padding: 18,
                        boxShadow: "0 2px 10px rgba(0,0,0,.08)",
                        marginBottom: 18
                    }}
                >
                    <h2 style={{ color: "#7A1F1F", fontSize: 20, marginBottom: 10 }}>Select the Dataset</h2>

                    <div style={{ display: "grid", gap: 14 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <input
                                type="radio"
                                name="datasetMode"
                                checked={mode === "new"}
                                onChange={() => {
                                    setMode("new");
                                    setBottomMessage("");
                                    // Reset Add Data fields to defaults whenever switching to Create New
                                    setExistingDatasetName("");
                                    setPage(1);
                                    setPageInput("1");
                                    setNewLanguage("sanskrit");
                                    setFieldKeys(["page", "english"]);
                                    setShowField({
                                        page: true,
                                        kannada: false,
                                        hindi: false,
                                        marathi: false,
                                        telugu: false,
                                        tamil: false,
                                        sanskrit: false,
                                        english: false
                                    });
                                    setDrafts({
                                        kannada: "",
                                        hindi: "",
                                        marathi: "",
                                        telugu: "",
                                        tamil: "",
                                        sanskrit: "",
                                        english: ""
                                    });

                                }}
                            />
                            <span>Create New Dataset</span>
                        </label>

                        {mode === "new" ? (
                            <div style={{ display: "grid", gap: 12 }}>

                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "220px 1fr",
                                        gap: 12,
                                        alignItems: "center"
                                    }}
                                >
                                    <label style={{ color: "#333" }}>Dataset Name :</label>
                                    <input
                                        value={datasetNameInput}
                                        onChange={e => setDatasetNameInput(e.target.value)}
                                        placeholder="e.g. basavanna.json"
                                        style={{
                                            padding: 10,
                                            borderRadius: 8,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16
                                        }}
                                    />
                                </div>

                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "220px 1fr",
                                        gap: 12,
                                        alignItems: "center"
                                    }}
                                >
                                    <label style={{ color: "#333" }}>Language :</label>
                                    <select
                                        value={newLanguage}
                                        onChange={e => setNewLanguage(e.target.value as Exclude<DatasetLanguage, "transliteration">)}
                                        style={{
                                            padding: 10,
                                            borderRadius: 8,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16
                                        }}
                                    >
                                        {LANGUAGE_OPTIONS.map(l => (
                                            <option key={l} value={l}>
                                                {l}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        ) : null}

                        <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <input
                                type="radio"
                                name="datasetMode"
                                checked={mode === "existing"}
                                onChange={() => {
                                    setMode("existing");
                                    setBottomMessage("");
                                    // Reset Add Data fields to defaults whenever switching to Create New
                                    setExistingDatasetName("");
                                    setPage(1);
                                    setPageInput("1");
                                    setNewLanguage("sanskrit");
                                    setFieldKeys(["page", "english"]);
                                    setShowField({
                                        page: true,
                                        kannada: false,
                                        hindi: false,
                                        marathi: false,
                                        telugu: false,
                                        tamil: false,
                                        sanskrit: false,
                                        english: false
                                    });
                                    setDrafts({
                                        kannada: "",
                                        hindi: "",
                                        marathi: "",
                                        telugu: "",
                                        tamil: "",
                                        sanskrit: "",
                                        english: ""
                                    });

                                }}
                            />
                            <span>Use Existing Dataset</span>
                        </label>

                        {mode === "existing" ? (
                            <div style={{ display: "grid", gap: 10 }}>
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "220px 1fr",
                                        gap: 12,
                                        alignItems: "center"
                                    }}
                                >
                                    <label style={{ color: "#333" }}>Dataset Name :</label>
                                    <input
                                        value={existingDatasetName}
                                        onChange={e => setExistingDatasetName(e.target.value)}
                                        placeholder="e.g. Ashutosh.json"
                                        style={{
                                            padding: 10,
                                            borderRadius: 8,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16
                                        }}
                                    />
                                </div>

                                {!isExistingSelectedPresent ? (
                                    <div style={{ color: "#a74040", fontSize: 13, marginTop: -6 }}>
                                        this dataset is not present
                                    </div>
                                ) : null}

                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "220px 1fr",
                                        gap: 12,
                                        alignItems: "center"
                                    }}
                                >
                                    <label style={{ color: "#333" }}>Select file :</label>
                                    <select
                                        value={existingDatasetName}
                                        onChange={e => {
                                            const next = e.target.value;
                                            setExistingDatasetName(next);
                                        }}
                                        style={{
                                            padding: 10,
                                            borderRadius: 8,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16
                                        }}
                                    >
                                        {datasetNames
                                            .slice()
                                            .sort((a, b) => a.localeCompare(b))
                                            .map(n => (
                                                <option key={n} value={n}>
                                                    {n}
                                                </option>
                                            ))}
                                    </select>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </section>

                <section
                    style={{
                        background: "#fff",
                        borderRadius: 10,
                        padding: 18,
                        boxShadow: "0 2px 10px rgba(0,0,0,.08)",
                        marginBottom: 18
                    }}
                >
                    <h2 style={{ color: "#7A1F1F", fontSize: 20, marginBottom: 10 }}>Data fields</h2>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                        {fieldKeys.map(k => (
                            <label
                                key={k}
                                style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
                            >
                                <input
                                    type="checkbox"
                                    checked={showField[k] ?? false}
                                    onChange={() => toggleField(k)}
                                />
                                <span style={{ color: "#333" }}>{k === "page" ? "page no." : k}</span>
                            </label>
                        ))}
                    </div>

                    <p style={{ marginTop: 10, color: "#666" }}>Use toggles to show/hide the input fields below.</p>
                </section>

                <section
                    style={{
                        background: "linear-gradient(180deg, #ffffff 0%, #fff7f7 100%)",
                        borderRadius: 14,
                        padding: 20,
                        boxShadow: "0 8px 26px rgba(0,0,0,.08)",
                        border: "1px solid rgba(122,31,31,.12)"
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginBottom: 12
                        }}
                    >
                        <h2 style={{ color: "#7A1F1F", fontSize: 20, margin: 0 }}>Add Data</h2>

                        {bottomMessage ? (
                            <div
                                style={{
                                    padding: "0px 10px 0px 10px",
                                    background: "rgba(122, 31, 31, 0.06)",
                                    color: "#27bc31ff",
                                    fontSize: 20,
                                    fontWeight: 600,
                                    marginTop: 0
                                }}
                            >
                                {bottomMessage}
                            </div>
                        ) : null}
                    </div>


                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: showField.english ? "1fr 1.2fr" : "1fr",
                            gap: 24
                        }}
                    >
                        {showField.page ? (
                            <div style={{ gridColumn: "1 / -1", marginBottom: 10 }}>
                                <label style={{ display: "block", marginBottom: 8, color: "#333" }}>page no.</label>

                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 10,
                                        width: "100%"
                                    }}
                                >
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const next = Math.max(1, page - 1);
                                            setPage(next);
                                            setPageInput(String(next));
                                        }}
                                        style={{
                                            border: "1px solid #ccc",
                                            borderRadius: 8,
                                            padding: "10px 12px",
                                            background: "#fff",
                                            color: "#7A1F1F",
                                            cursor: "pointer",
                                            fontSize: 16,
                                            flex: "0 0 auto"
                                        }}
                                    >
                                        -
                                    </button>

                                    <input
                                        type="number"
                                        inputMode="numeric"
                                        value={pageInput}
                                        min={1}
                                        onChange={e => {
                                            setPageInput(e.target.value);
                                        }}
                                        onBlur={() => {
                                            const next = parseInt(pageInput, 10);
                                            if (Number.isNaN(next) || next < 1) {
                                                setPage(1);
                                                setPageInput("1");
                                            } else {
                                                setPage(next);
                                                setPageInput(String(next));
                                            }
                                        }}
                                        onKeyDown={e => {
                                            if (e.key === "Enter") {
                                                const next = parseInt(pageInput, 10);
                                                if (Number.isNaN(next) || next < 1) {
                                                    setPage(1);
                                                    setPageInput("1");
                                                } else {
                                                    setPage(next);
                                                    setPageInput(String(next));
                                                }
                                            }
                                        }}
                                        style={{
                                            flex: "1 1 auto",
                                            padding: 10,
                                            borderRadius: 8,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16
                                        }}
                                    />

                                    <button
                                        type="button"
                                        onClick={() => {
                                            const next = page + 1;
                                            setPage(next);
                                            setPageInput(String(next));
                                        }}
                                        style={{
                                            border: "1px solid #ccc",
                                            borderRadius: 8,
                                            padding: "10px 12px",
                                            background: "#fff",
                                            color: "#7A1F1F",
                                            cursor: "pointer",
                                            fontSize: 16,
                                            flex: "0 0 auto"
                                        }}
                                    >
                                        +
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        <div
                            style={{
                                display: "grid",
                                gap: 18
                            }}
                        >
                            {showField.sanskrit ? (
                                <div
                                    style={{
                                        background: "#fff",
                                        border: "1px solid #e4e4e4",
                                        borderRadius: 12,
                                        padding: 16,
                                        boxShadow: "0 2px 8px rgba(0,0,0,.04)"
                                    }}
                                >
                                    <label style={{ display: "block", marginBottom: 8, color: "#333", fontWeight: 600 }}>Sanskrit</label>
                                    <textarea
                                        rows={4}
                                        value={drafts.sanskrit}
                                        onChange={e => setDrafts(prev => ({ ...prev, sanskrit: e.target.value }))}
                                        style={{
                                            width: "100%",
                                            minHeight: 500,
                                            padding: 14,
                                            borderRadius: 10,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16,
                                            lineHeight: 1.7,
                                            resize: "vertical",
                                            fontFamily: "Noto Sans Devanagari, sans-serif"
                                        }}
                                    />
                                </div>
                            ) : null}

                            {showField.hindi ? (
                                <div
                                    style={{
                                        background: "#fff",
                                        border: "1px solid #e4e4e4",
                                        borderRadius: 12,
                                        padding: 16,
                                        boxShadow: "0 2px 8px rgba(0,0,0,.04)"
                                    }}
                                >
                                    <label style={{ display: "block", marginBottom: 8, color: "#333", fontWeight: 600 }}>Hindi</label>
                                    <textarea
                                        rows={4}
                                        value={drafts.hindi}
                                        onChange={e => setDrafts(prev => ({ ...prev, hindi: e.target.value }))}
                                        style={{
                                            width: "100%",
                                            minHeight: 500,
                                            padding: 14,
                                            borderRadius: 10,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16,
                                            lineHeight: 1.7,
                                            resize: "vertical",
                                            fontFamily: "Noto Sans Devanagari, sans-serif"
                                        }}
                                    />
                                </div>
                            ) : null}

                            {showField.marathi ? (
                                <div
                                    style={{
                                        background: "#fff",
                                        border: "1px solid #e4e4e4",
                                        borderRadius: 12,
                                        padding: 16,
                                        boxShadow: "0 2px 8px rgba(0,0,0,.04)"
                                    }}
                                >
                                    <label style={{ display: "block", marginBottom: 8, color: "#333", fontWeight: 600 }}>Marathi</label>
                                    <textarea
                                        rows={4}
                                        value={drafts.marathi}
                                        onChange={e => setDrafts(prev => ({ ...prev, marathi: e.target.value }))}
                                        style={{
                                            width: "100%",
                                            minHeight: 500,
                                            padding: 14,
                                            borderRadius: 10,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16,
                                            lineHeight: 1.7,
                                            resize: "vertical",
                                            fontFamily: "Noto Sans Devanagari, sans-serif"
                                        }}
                                    />
                                </div>
                            ) : null}

                            {showField.kannada ? (
                                <div
                                    style={{
                                        background: "#fff",
                                        border: "1px solid #e4e4e4",
                                        borderRadius: 12,
                                        padding: 16,
                                        boxShadow: "0 2px 8px rgba(0,0,0,.04)"
                                    }}
                                >
                                    <label style={{ display: "block", marginBottom: 8, color: "#333", fontWeight: 600 }}>Kannada</label>
                                    <textarea
                                        rows={4}
                                        value={drafts.kannada}
                                        onChange={e => setDrafts(prev => ({ ...prev, kannada: e.target.value }))}
                                        style={{
                                            width: "100%",
                                            minHeight: 500,
                                            padding: 14,
                                            borderRadius: 10,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16,
                                            lineHeight: 1.7,
                                            resize: "vertical"
                                        }}
                                    />
                                </div>
                            ) : null}

                            {showField.telugu ? (
                                <div
                                    style={{
                                        background: "#fff",
                                        border: "1px solid #e4e4e4",
                                        borderRadius: 12,
                                        padding: 16,
                                        boxShadow: "0 2px 8px rgba(0,0,0,.04)"
                                    }}
                                >
                                    <label style={{ display: "block", marginBottom: 8, color: "#333", fontWeight: 600 }}>Telugu</label>
                                    <textarea
                                        rows={4}
                                        value={drafts.telugu}
                                        onChange={e => setDrafts(prev => ({ ...prev, telugu: e.target.value }))}
                                        style={{
                                            width: "100%",
                                            minHeight: 500,
                                            padding: 14,
                                            borderRadius: 10,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16,
                                            lineHeight: 1.7,
                                            resize: "vertical"
                                        }}
                                    />
                                </div>
                            ) : null}

                            {showField.tamil ? (
                                <div
                                    style={{
                                        background: "#fff",
                                        border: "1px solid #e4e4e4",
                                        borderRadius: 12,
                                        padding: 16,
                                        boxShadow: "0 2px 8px rgba(0,0,0,.04)"
                                    }}
                                >
                                    <label style={{ display: "block", marginBottom: 8, color: "#333", fontWeight: 600 }}>Tamil</label>
                                    <textarea
                                        rows={4}
                                        value={drafts.tamil}
                                        onChange={e => setDrafts(prev => ({ ...prev, tamil: e.target.value }))}
                                        style={{
                                            width: "100%",
                                            minHeight: 500,
                                            padding: 14,
                                            borderRadius: 10,
                                            border: "1px solid #ccc",
                                            background: "#fff",
                                            fontSize: 16,
                                            lineHeight: 1.7,
                                            resize: "vertical"
                                        }}
                                    />
                                </div>
                            ) : null}
                        </div>

                        {showField.english ? (
                            <div
                                style={{
                                    background: "#fff",
                                    border: "1px solid #e4e4e4",
                                    borderRadius: 12,
                                    padding: 16,
                                    boxShadow: "0 2px 8px rgba(0,0,0,.04)"
                                }}
                            >
                                <label
                                    style={{
                                        display: "block",
                                        marginBottom: 8,
                                        color: "#333",
                                        fontWeight: 600
                                    }}
                                >
                                    English
                                </label>

                                <textarea
                                    value={drafts.english}
                                    onChange={e =>
                                        setDrafts(prev => ({
                                            ...prev,
                                            english: e.target.value
                                        }))
                                    }
                                    style={{
                                        width: "100%",
                                        minHeight: 500,
                                        padding: 14,
                                        borderRadius: 10,
                                        border: "1px solid #ccc",
                                        background: "#fff",
                                        fontSize: 16,
                                        lineHeight: 1.7,
                                        resize: "vertical",
                                        fontFamily: "Inter, Arial, sans-serif"
                                    }}
                                />
                            </div>
                        ) : null}
                    </div>

                    <div
                        style={{
                            display: "flex",
                            justifyContent: "flex-end",
                            marginTop: 18,
                            gap: 12,
                            flexWrap: "wrap"
                        }}
                    >


                        <button

                            type="button"
                            onClick={onCreateOrAdd}
                            disabled={mode === "existing" && !isExistingSelectedPresent}
                            style={{
                                border: "1px solid #7A1F1F",
                                borderRadius: 8,
                                padding: "10px 14px",
                                background: "#7A1F1F",
                                color: "#fff",
                                cursor: "pointer",
                                fontSize: 16,
                                opacity: mode === "existing" && !isExistingSelectedPresent ? 0.6 : 1
                            }}
                        >
                            {mode === "new" ? "Create" : "Add"}
                        </button>
                    </div>


                </section>
            </main>


            <Footer />
        </>
    );
}

export default DatasetGenerator;

