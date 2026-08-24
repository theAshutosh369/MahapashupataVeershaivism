import type { Author } from "./types";
import type { AuthorSummary } from "./types";

// Allow configuring the backend API URL via environment variable
// In development, defaults to localhost:3001
// In production (when served from same origin), use empty string (relative URL)
const API_BASE = import.meta.env.VITE_API_URL ?? '';

export async function getAuthors(): Promise<AuthorSummary[]> {

    const response = await fetch("/data/authors.json");

    if (!response.ok)
        throw new Error("Unable to load authors.");

    return response.json();
}

export async function getAuthor(file: string): Promise<Author> {

    const response = await fetch("/data/authors/" + file);

    if (!response.ok)
        throw new Error("Unable to load author.");

    return response.json();
}

export async function updateVachanaField(
    authorFile: string,
    vachanaNumber: number,
    field: "translation" | "kannada" | "transliteration",
    value: string | null
): Promise<{ ok: boolean } & Record<string, string | null>> {

    const response = await fetch(
        `${API_BASE}/api/authors/${encodeURIComponent(authorFile)}/vachanas/${encodeURIComponent(
            String(vachanaNumber)
        )}/${encodeURIComponent(field)}`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ [field]: value })
        }
    );

    if (!response.ok) {
        const err = await response
            .json()
            .catch(() => ({ error: "Unknown error" }));
        throw new Error(err?.error ?? `Unable to update ${field}.`);
    }

    return response.json();
}

export async function updateVachanaTranslation(
    authorFile: string,
    vachanaNumber: number,
    translation: string | null
): Promise<{ ok: boolean; translation: string | null }> {
    const result = await updateVachanaField(
        authorFile,
        vachanaNumber,
        "translation",
        translation
    );

    const translationValue = (result as { translation?: string | null }).translation ?? null;

    return {
        ok: result.ok,
        translation: translationValue
    };
}




