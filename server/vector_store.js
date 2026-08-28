/**
 * Vector Store — Abstract storage layer for embeddings.
 *
 * CURRENT BACKEND: Float32 binary file.
 * FUTURE BACKENDS (interface-compatible): LanceDB, SQLite, pgvector, etc.
 *
 * To migrate to a new backend, implement the same public API:
 *
 *   class NewBackendStore {
 *     static async create(filePath, dimension)    // Create new store
 *     static async open(filePath, dimension)       // Open existing store
 *     async append(embedding)                      // Append one vector
 *     async finalize()                             // Flush/close writes
 *     async get(index)                             // Get one vector
 *     async loadBatch(start, count)                // Load a range
 *     async loadAll()                              // Load all into memory (deprecated)
 *     async search(query, topK)                    // Cosine similarity (delegates to searchBatched)
 *     async searchBatched(query, topK, batchSize)  // Batched cosine similarity
 *     async unload()                               // Free memory
 *     size()                                       // Number of vectors stored
 *     dimension()                                  // Vector dimension
 *     getMemoryBytes()                             // RAM used by this store
 *     getFileSize()                                // Storage size on disk
 *     static fileExists(filePath)                  // Check if store exists
 *   }
 *
 * USAGE:
 *   import { VectorStore } from './vector_store.js';
 *   const store = await VectorStore.create('/path/to/vectors.bin', 768);
 *   // or
 *   const store = await VectorStore.open('/path/to/vectors.bin', 768);
 */

import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';

// ─── Debug flag ────────────────────────────────────────────────────────────
const DEBUG = false;

// ─── Binary format constants ────────────────────────────────────────────────
const MAGIC = 0x56454354; // 'VECT' little-endian
const FORMAT_VERSION = 1;
const HEADER_SIZE = 16; // magic(4) + version(4) + dimension(4) + count(4)

// ─── Buffer size for streaming writes ───────────────────────────────────────
const WRITE_BUFFER_SIZE = 1024 * 1024; // 1 MB buffer

// ─── Batch size for loading embeddings during search ────────────────────────
const DEFAULT_BATCH_SIZE = 500;

// ─── Singleton reusable zero vector ─────────────────────────────────────────
export var ZERO_VECTOR = null;

export function ensureZeroVector(dimension) {
    if (!ZERO_VECTOR || ZERO_VECTOR.length !== dimension) {
        ZERO_VECTOR = new Float32Array(dimension);
    }
    return ZERO_VECTOR;
}

// ─── Memory tracking helpers ────────────────────────────────────────────────

function getProcessMemory() {
    const mem = process.memoryUsage();
    return {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
        arrayBuffers: mem.arrayBuffers ? Math.round(mem.arrayBuffers / 1024 / 1024) : 0
    };
}

export function logMemorySnapshot(label) {
    if (!DEBUG) return null;
    const mem = getProcessMemory();
    console.log(`[Memory] ${label}: RSS=${mem.rss}MB heap=${mem.heapUsed}/${mem.heapTotal}MB ext=${mem.external}MB buf=${mem.arrayBuffers}MB`);
    return mem;
}

// ─── Float32 Binary Store Implementation ────────────────────────────────────

class Float32BinaryStore {
    #filePath;
    #dim;
    #count;
    #data;          // Float32Array with all loaded vectors (deprecated, kept for backward compat)
    #dirty;         // dirty flag
    #writeStream;   // active write stream
    #writePos;      // bytes written so far
    #fd;            // file descriptor for reading
    #loaded;        // whether data is loaded in memory
    #scratchBuf;    // reusable buffer for append() — avoids per-call Buffer.alloc
    #batchBuf;      // reusable buffer for loadBatch() — avoids per-call Buffer.alloc

    constructor(filePath, dim, count) {
        this.#filePath = filePath;
        this.#dim = dim;
        this.#count = count;
        this.#data = null;
        this.#dirty = false;
        this.#writeStream = null;
        this.#writePos = 0;
        this.#fd = null;
        this.#loaded = false;
        this.#scratchBuf = null;
        this.#batchBuf = null;
    }

    // ── Factory methods ───────────────────────────────────────────────────

    /**
     * Create a new empty vector store at filePath.
     * Overwrites any existing file.
     */
    static async create(filePath, dimension) {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });

        // Write header: magic(4) + version(4) + dimension(4) + count(4)
        const header = Buffer.alloc(HEADER_SIZE);
        header.writeUInt32LE(MAGIC, 0);
        header.writeUInt32LE(FORMAT_VERSION, 4);
        header.writeUInt32LE(dimension, 8);
        header.writeUInt32LE(0, 12); // count = 0 initially

        await fs.writeFile(filePath, header);

        const store = new Float32BinaryStore(filePath, dimension, 0);
        store.#fd = await fs.open(filePath, 'r+');
        store.#scratchBuf = Buffer.alloc(dimension * 4);
        return store;
    }

    /**
     * Open an existing vector store.
     * Validates magic and version, reads header.
     */
    static async open(filePath) {
        const stat = await fs.stat(filePath);
        if (stat.size < HEADER_SIZE) {
            throw new Error('Vector store file is too small (corrupt): ' + filePath);
        }

        const fd = await fs.open(filePath, 'r');
        const header = Buffer.alloc(HEADER_SIZE);
        await fd.read(header, 0, HEADER_SIZE, 0);

        const magic = header.readUInt32LE(0);
        if (magic !== MAGIC) {
            await fd.close();
            throw new Error('Invalid vector store magic number. Expected VECT, got 0x' + magic.toString(16));
        }

        const version = header.readUInt32LE(4);
        if (version !== FORMAT_VERSION) {
            await fd.close();
            throw new Error('Unsupported vector store version: ' + version);
        }

        const dimension = header.readUInt32LE(8);
        const count = header.readUInt32LE(12);

        // Validate file size matches declared count
        const expectedSize = HEADER_SIZE + count * dimension * 4;
        if (stat.size !== expectedSize) {
            if (DEBUG) console.warn(`[VectorStore] File size mismatch: expected ${expectedSize}, actual ${stat.size}. Truncating count.`);
            // Recompute count from actual file size
            const actualCount = Math.floor((stat.size - HEADER_SIZE) / (dimension * 4));
            if (actualCount < 0) {
                await fd.close();
                throw new Error('Vector store file too small for any vectors');
            }
            const store2 = new Float32BinaryStore(filePath, dimension, actualCount);
            store2.#fd = fd;
            store2.#scratchBuf = Buffer.alloc(dimension * 4);
            return store2;
        }

        const store = new Float32BinaryStore(filePath, dimension, count);
        store.#fd = fd;
        store.#scratchBuf = Buffer.alloc(dimension * 4);
        return store;
    }

    /**
     * Check if a vector store file exists.
     */
    static async fileExists(filePath) {
        try {
            await fs.access(filePath, fsc.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    // ── Write operations ──────────────────────────────────────────────────

    /**
     * Begin streaming writes. Opens a write stream and updates header count.
     */
    async beginWrite() {
        if (this.#writeStream) {
            throw new Error('Write already in progress. Call finalize() first.');
        }

        // Reopen for appending
        if (this.#fd) {
            await this.#fd.close();
            this.#fd = null;
        }

        this.#writeStream = fsc.createWriteStream(this.#filePath, {
            flags: 'r+',
            start: HEADER_SIZE + this.#count * this.#dim * 4,
            highWaterMark: WRITE_BUFFER_SIZE
        });

        this.#writePos = HEADER_SIZE + this.#count * this.#dim * 4;

        return new Promise((resolve, reject) => {
            this.#writeStream.once('open', resolve);
            this.#writeStream.once('error', reject);
        });
    }

    /**
     * Append one embedding vector. Must be called after beginWrite().
     * Uses a reusable scratch buffer — no per-call Buffer.alloc().
     */
    async append(vector) {
        if (!this.#writeStream) {
            throw new Error('No write stream. Call beginWrite() first.');
        }

        if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
            throw new Error('Vector must be an array or Float32Array');
        }

        if (vector.length !== this.#dim) {
            throw new Error(`Vector dimension mismatch: expected ${this.#dim}, got ${vector.length}`);
        }

        // Use reusable scratch buffer instead of Buffer.alloc per call
        const buf = this.#scratchBuf;
        for (let i = 0; i < this.#dim; i++) {
            buf.writeFloatLE(Number(vector[i]) || 0, i * 4);
        }

        return new Promise((resolve, reject) => {
            const canContinue = this.#writeStream.write(buf);
            this.#writePos += buf.length;
            this.#count++;

            if (!canContinue) {
                this.#writeStream.once('drain', resolve);
            } else {
                resolve();
            }
        });
    }

    /**
     * Finalize writes: close stream, update header count, reopen for reading.
     */
    async finalize() {
        if (!this.#writeStream) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.#writeStream.once('finish', async () => {
                this.#writeStream = null;

                // Update header count
                const header = Buffer.alloc(4);
                header.writeUInt32LE(this.#count, 0);
                const tmpFd = await fs.open(this.#filePath, 'r+');
                await tmpFd.write(header, 0, 4, 12);
                await tmpFd.close();

                // Reopen for reading
                if (this.#fd) {
                    try { await this.#fd.close(); } catch { /* ignore */ }
                }
                this.#fd = await fs.open(this.#filePath, 'r');

                resolve();
            }).once('error', reject);

            this.#writeStream.end();
        });
    }

    // ── Read operations ───────────────────────────────────────────────────

    /**
     * Get one embedding by index.
     * Returns a Float32Array if data is loaded, otherwise reads from disk.
     */
    async get(index) {
        if (index < 0 || index >= this.#count) {
            throw new Error(`Index out of range: ${index} (count: ${this.#count})`);
        }

        if (this.#data && this.#loaded) {
            const offset = index * this.#dim;
            return this.#data.slice(offset, offset + this.#dim);
        }

        // Read from disk (single vector) — use scratch buffer
        const buf = this.#scratchBuf;
        const pos = HEADER_SIZE + index * this.#dim * 4;
        await this.#fd.read(buf, 0, buf.length, pos);
        const arr = new Float32Array(this.#dim);
        for (let i = 0; i < this.#dim; i++) {
            arr[i] = buf.readFloatLE(i * 4);
        }
        return arr;
    }

    /**
     * Load a batch of embeddings into a Float32Array.
     * Uses a reusable batch buffer to avoid per-call allocations.
     */
    async loadBatch(startIndex, count) {
        if (startIndex < 0 || startIndex >= this.#count) {
            throw new Error(`Start index out of range: ${startIndex}`);
        }
        const actualCount = Math.min(count, this.#count - startIndex);
        const byteLength = actualCount * this.#dim * 4;

        // Reuse batch buffer if big enough, otherwise allocate once
        if (!this.#batchBuf || this.#batchBuf.length < byteLength) {
            this.#batchBuf = Buffer.alloc(byteLength);
        }
        const buf = this.#batchBuf.slice(0, byteLength);
        const pos = HEADER_SIZE + startIndex * this.#dim * 4;
        await this.#fd.read(buf, 0, buf.length, pos);
        return new Float32Array(buf.buffer, buf.byteOffset, actualCount * this.#dim);
    }

    /**
     * Load ALL embeddings into memory. Returns Float32Array.
     * @deprecated Use searchBatched() instead. Kept for backward compatibility.
     */
    async loadAll() {
        if (this.#data && this.#loaded) {
            return this.#data;
        }

        const totalFloats = this.#count * this.#dim;
        const buf = Buffer.alloc(totalFloats * 4);
        await this.#fd.read(buf, 0, buf.length, HEADER_SIZE);
        this.#data = new Float32Array(buf.buffer, buf.byteOffset, totalFloats);
        this.#loaded = true;
        return this.#data;
    }

    /**
     * Unload embeddings from memory and free the Float32Array.
     */
    async unload() {
        this.#data = null;
        this.#loaded = false;
        if (typeof global.gc === 'function') global.gc();
    }

    /**
     * Cosine similarity search. Delegates to searchBatched() for memory efficiency.
     */
    async search(queryEmbedding, topK) {
        return this.searchBatched(queryEmbedding, topK, DEFAULT_BATCH_SIZE);
    }

    /**
     * Batched search: load embeddings in batches, score each batch, keep topK.
     * Avoids loading all embeddings into memory at once.
     * Uses reusable batch buffer internally.
     */
    async searchBatched(queryEmbedding, topK, batchSize) {
        batchSize = batchSize || DEFAULT_BATCH_SIZE;
        const dim = this.#dim;
        const count = this.#count;

        // Pre-compute query magnitude
        const query = new Float32Array(queryEmbedding);
        let queryMag = 0;
        for (let i = 0; i < dim; i++) {
            const v = query[i] || 0;
            queryMag += v * v;
        }
        queryMag = Math.sqrt(queryMag);
        if (queryMag === 0) return [];

        // Min-heap of size topK
        const heap = [];
        function heapPush(item) {
            heap.push(item);
            let i = heap.length - 1;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (heap[parent].score <= heap[i].score) break;
                [heap[parent], heap[i]] = [heap[i], heap[parent]];
                i = parent;
            }
        }
        function heapPop() {
            if (heap.length === 0) return null;
            const top = heap[0];
            const last = heap.pop();
            if (heap.length > 0) {
                heap[0] = last;
                let i = 0;
                const n = heap.length;
                while (true) {
                    let smallest = i;
                    const left = (i << 1) + 1;
                    const right = left + 1;
                    if (left < n && heap[left].score < heap[smallest].score) smallest = left;
                    if (right < n && heap[right].score < heap[smallest].score) smallest = right;
                    if (smallest === i) break;
                    [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
                    i = smallest;
                }
            }
            return top;
        }

        let minScore = 0;

        // Load and score in batches
        for (let batchStart = 0; batchStart < count; batchStart += batchSize) {
            const batchCount = Math.min(batchSize, count - batchStart);
            const batch = await this.loadBatch(batchStart, batchCount);

            for (let i = 0; i < batchCount; i++) {
                const offset = i * dim;
                let dot = 0;
                let mag = 0;
                for (let j = 0; j < dim; j++) {
                    const v = batch[offset + j];
                    dot += query[j] * v;
                    mag += v * v;
                }
                const vecMag = Math.sqrt(mag);
                const similarity = vecMag > 0 ? dot / (queryMag * vecMag) : 0;
                if (similarity <= minScore && heap.length >= topK) continue;

                if (heap.length >= topK) {
                    heapPop();
                }
                heapPush({ index: batchStart + i, score: similarity });
                minScore = heap[0]?.score || 0;
            }
        }

        // Extract results sorted by score descending
        const results = [];
        while (heap.length > 0) {
            results.push(heapPop());
        }
        results.reverse();

        return results;
    }

    // ── Accessors ─────────────────────────────────────────────────────────

    size() {
        return this.#count;
    }

    dimension() {
        return this.#dim;
    }

    getMemoryBytes() {
        if (this.#data && this.#loaded) {
            return this.#data.byteLength;
        }
        return 0;
    }

    async getFileSize() {
        try {
            const stat = await fs.stat(this.#filePath);
            return stat.size;
        } catch {
            return 0;
        }
    }

    getFilePath() {
        return this.#filePath;
    }

    isLoaded() {
        return this.#loaded;
    }

    // ── Cleanup ───────────────────────────────────────────────────────────

    async close() {
        if (this.#writeStream) {
            await this.finalize();
        }
        if (this.#fd) {
            await this.#fd.close();
            this.#fd = null;
        }
        this.#data = null;
        this.#loaded = false;
        this.#scratchBuf = null;
        this.#batchBuf = null;
    }

    /**
     * Remove the store file from disk.
     */
    static async destroy(filePath) {
        try {
            await fs.unlink(filePath);
        } catch {
            // ignore if not exists
        }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const VectorStore = Float32BinaryStore;
export default VectorStore;
