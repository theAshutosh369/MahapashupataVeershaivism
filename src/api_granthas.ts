const configuredApiBase = String(import.meta.env.VITE_API_URL ?? '').trim();
const API_BASE = configuredApiBase || (import.meta.env.DEV ? 'http://localhost:3003' : '');

export type GranthaTreeResponse = {
    ok: boolean;
    files: string[];
};

/**
 * Returns every Grantha/source file under public/data as a path relative to
 * public/data. The existing Grantha-list API owns the filesystem scan, so the
 * Granthas page does not duplicate or reclassify the source hierarchy.
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
