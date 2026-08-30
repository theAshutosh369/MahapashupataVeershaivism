const API_BASE = import.meta.env.VITE_API_URL ?? '';

export type GranthaTreeResponse = {
    ok: boolean;
    files: string[];
};

/**
 * Returns every file under public/data as a path relative to public/data.
 * The order and directory structure are preserved by sorting paths naturally
 * on the server/client boundary; no categorisation or relocation is applied.
 */
export async function listGranthas(): Promise<string[]> {
    const response = await fetch(`${API_BASE}/api/granthas/list`, { method: 'GET' });
    if (!response.ok) {
        throw new Error('Unable to load Granthas.');
    }

    const data = (await response.json()) as GranthaTreeResponse;
    if (!data?.ok || !Array.isArray(data.files)) {
        throw new Error('Invalid Grantha list response.');
    }

    return data.files.filter((file) => typeof file === 'string' && file.trim().length > 0);
}
