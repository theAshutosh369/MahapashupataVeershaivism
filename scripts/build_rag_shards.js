#!/usr/bin/env node
/**
 * Safe one-time migration of the existing monolithic RAG index into
 * dataset/category shards.
 *
 * Usage:
 *   node scripts/build_rag_shards.js
 *
 * The original server/rag_index.json and server/rag_embeddings.bin are read
 * only. New files are written below server/rag/.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShards, SHARD_ROOT } from '../server/rag_shards.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(root, '..');
const indexFile = path.join(project, 'server', 'rag_index.json');
const embeddingsFile = path.join(project, 'server', 'rag_embeddings.bin');

console.log('[RAG Shards] Starting SAFE migration.');
console.log('[RAG Shards] Source index:', indexFile);
console.log('[RAG Shards] Source embeddings:', embeddingsFile);
console.log('[RAG Shards] Output:', SHARD_ROOT);
console.log('[RAG Shards] Original files will NOT be modified.');

try {
    const manifest = await buildShards({ indexFile, embeddingsFile, outputRoot: SHARD_ROOT });
    console.log('[RAG Shards] Migration complete.');
    console.log('[RAG Shards] Chunks:', manifest.source.chunkCount);
    console.log('[RAG Shards] Shards:', Object.keys(manifest.shards).join(', '));
    for (const [name, info] of Object.entries(manifest.shards)) {
        console.log(`  - ${name}: ${info.chunks} chunks, ${info.vectors} vectors`);
    }
    console.log('[RAG Shards] Validate the generated server/rag/ tree before activating it.');
} catch (error) {
    console.error('[RAG Shards] Migration failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
}
