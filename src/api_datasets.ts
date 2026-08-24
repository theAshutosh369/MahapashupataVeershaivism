export type DatasetLanguage =
    | "kannada"
    | "transliteration"
    | "english"
    | "hindi"
    | "sanskrit"
    | "tamil"
    | "telugu"
    | "marathi";

export type DatasetItem = {
    page: number;
    [k: string]: string | number | null | undefined;
};

export type DatasetFile = {
    name?: string;
    data?: DatasetItem[];
};

// Allow configuring the backend API URL via environment variable
// In development, defaults to empty string (same origin, or use VITE_API_URL)
// All dataset endpoints are now served from the same unified backend
const API_BASE = import.meta.env.VITE_API_URL ?? '';

export async function listDatasets(): Promise<string[]> {
    // Scan server-side for json files under public/data/**
    // and return their basenames (e.g. "custom.json").
    const response = await fetch(`${API_BASE}/api/datasets/list`, {
        method: "GET"
    });


    if (!response.ok) {
        // fallback: keep UI usable
        return ["Ashutosh.json", "custom.json", "basavanna.json", "allama.json"];
    }

    const data = await response.json().catch(() => null);
    const list = data?.datasets;
    if (!Array.isArray(list)) {
        return ["Ashutosh.json", "custom.json", "basavanna.json", "allama.json"];
    }

    // UI should show only dataset json files under public/data/datasets
    // but keep it resilient if server returns other jsons.
    return list
        .filter((name: string) => name.endsWith('.json'))
        .filter((name: string) => name !== 'authors.json');
}

export async function getDataset(datasetName: string): Promise<DatasetFile | null> {
    const response = await fetch(
        `${API_BASE}/api/datasets/${encodeURIComponent(datasetName)}`,
        { method: 'GET' }
    );

    if (!response.ok) return null;
    return response.json().catch(() => null);
}

export async function upsertDatasetItem(
    datasetName: string,
    languages: DatasetLanguage[],
    item: DatasetItem
): Promise<{ ok: boolean }> {

    const response = await fetch(
        `${API_BASE}/api/datasets/${encodeURIComponent(datasetName)}/items`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ languages, item })
        }
    );

    if (!response.ok) {
        const err = await response
            .json()
            .catch(() => ({ error: "Unknown error" }));
        throw new Error(err?.error ?? err?.message ?? "Unable to update dataset item.");
    }


    return response.json();
}

export async function listDatasetsUnderDatasetsDir(): Promise<string[]> {
    // Deprecated wrapper kept for future use.
    return listDatasets();
}


