/**
 * Sharded RAG index loader.
 * Reads only prebuilt shards under public/rag and never scans/chunks public/data.
 * Shard paths mirror public/data exactly after the public/data prefix.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAG_ROOT = path.resolve(HERE, '..', 'public', 'rag');
const MANIFEST = path.join(RAG_ROOT, 'manifest.json');

let manifestCache = null;
const indexCache = new Map();
const embeddingCache = new Map();

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function loadRagManifest() {
  if (!manifestCache) manifestCache = await readJson(MANIFEST);
  return manifestCache;
}

function safeRelative(p) {
  const normalized = path.posix.normalize(String(p || '').replaceAll('\\', '/'));
  if (normalized.startsWith('../') || normalized.includes('/../') || path.posix.isAbsolute(normalized)) {
    throw new Error('Invalid RAG shard path');
  }
  return normalized;
}

export async function loadShard(shardPath) {
  const rel = safeRelative(shardPath);
  if (indexCache.has(rel)) return indexCache.get(rel);
  const full = path.join(RAG_ROOT, rel, 'index.json');
  const data = await readJson(full);
  indexCache.set(rel, data);
  return data;
}

export async function loadShardEmbeddings(shardPath) {
  const rel = safeRelative(shardPath);
  if (embeddingCache.has(rel)) return embeddingCache.get(rel);
  const full = path.join(RAG_ROOT, rel, 'embeddings.bin');
  const data = await fs.readFile(full);
  embeddingCache.set(rel, data);
  return data;
}

/**
 * Resolve a dataset's shard from its original public/data path.
 * Example: public/data/Agamas/X.txt -> Agamas
 */
export function shardForSource(sourcePath) {
  const normalized = String(sourcePath || '').replaceAll('\\', '/');
  const marker = 'public/data/';
  const i = normalized.indexOf(marker);
  if (i < 0) return null;
  const rest = normalized.slice(i + marker.length);
  const first = rest.split('/')[0];
  return first ? first : null;
}

export function clearShardCaches() {
  indexCache.clear();
  embeddingCache.clear();
  manifestCache = null;
}

export { RAG_ROOT };
