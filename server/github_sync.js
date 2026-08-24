/**
 * GitHub Sync Module
 * Commits file changes to the GitHub repository after every save.
 * Uses GitHub API with a Personal Access Token.
 * 
 * Required environment variables:
 *   GITHUB_TOKEN  - Personal Access Token with repo scope
 *   GITHUB_REPO   - e.g. "theAshutosh369/MahapashupataVeershaivism"
 *   GITHUB_BRANCH - Branch to commit to (default: "main")
 */

function isSyncEnabled() {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    return !!(token && repo);
}

/**
 * Get the current commit SHA of the branch's HEAD via GitHub API.
 */
async function getHeadSha() {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const url = `https://api.github.com/repos/${repo}/git/ref/heads/${branch}`;
    const resp = await fetch(url, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'vachana-sanchaya-server',
        },
    });
    if (!resp.ok) {
        throw new Error(`Failed to get HEAD ref: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.object.sha;
}

/**
 * Create a blob (file content) on GitHub and return its SHA.
 */
async function createBlob(content) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const url = `https://api.github.com/repos/${repo}/git/blobs`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'vachana-sanchaya-server',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            content,
            encoding: 'utf-8',
        }),
    });
    if (!resp.ok) {
        throw new Error(`Failed to create blob: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.sha;
}

/**
 * Create a tree with the new file blob and return its SHA.
 */
async function createTree(baseTreeSha, filePath, blobSha) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const url = `https://api.github.com/repos/${repo}/git/trees`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'vachana-sanchaya-server',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: [
                {
                    path: filePath,
                    mode: '100644',
                    type: 'blob',
                    sha: blobSha,
                },
            ],
        }),
    });
    if (!resp.ok) {
        throw new Error(`Failed to create tree: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.sha;
}

/**
 * Create a commit on GitHub.
 */
async function createCommit(parentSha, treeSha, message) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const url = `https://api.github.com/repos/${repo}/git/commits`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'vachana-sanchaya-server',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            message,
            parents: [parentSha],
            tree: treeSha,
        }),
    });
    if (!resp.ok) {
        throw new Error(`Failed to create commit: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    return data.sha;
}

/**
 * Update the branch reference to point to the new commit.
 */
async function updateRef(commitSha) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const url = `https://api.github.com/repos/${repo}/git/refs/heads/${branch}`;
    const resp = await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'vachana-sanchaya-server',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            sha: commitSha,
            force: false,
        }),
    });
    if (!resp.ok) {
        throw new Error(`Failed to update ref: ${resp.status} ${await resp.text()}`);
    }
    return true;
}

/**
 * Commit a single file change to the GitHub repository.
 * 
 * @param {string} filePath - Relative path in the repo (e.g. "public/data/authors/basavaṇṇa.json")
 * @param {string} content  - New file content as string
 * @param {string} message  - Commit message
 */
export async function commitFile(filePath, content, message) {
    if (!isSyncEnabled()) {
        console.log(`[GitHub Sync] Skipped commit for ${filePath} — GITHUB_TOKEN and GITHUB_REPO not set`);
        return { ok: false, reason: 'sync_disabled' };
    }

    try {
        const headSha = await getHeadSha();
        const blobSha = await createBlob(content);
        const treeSha = await createTree(headSha, filePath, blobSha);
        const commitSha = await createCommit(headSha, treeSha, message);
        await updateRef(commitSha);

        console.log(`[GitHub Sync] Committed ${filePath} → ${commitSha.slice(0, 7)}`);
        return { ok: true, sha: commitSha };
    } catch (err) {
        console.error(`[GitHub Sync] Failed to commit ${filePath}:`, err?.message ?? String(err));
        // Don't throw — the save to the local file already succeeded
        return { ok: false, error: err?.message ?? String(err) };
    }
}
