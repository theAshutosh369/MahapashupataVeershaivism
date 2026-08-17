import fs from 'node:fs';
import path from 'node:path';

const publicRoot = 'C:\\vachana-sanchaya\\vachana-sanchaya\\public';
const dataRoot = path.join(publicRoot, 'data');
const datasetRoot = path.join(dataRoot, 'datasets');
const authorRoot = path.join(dataRoot, 'authors');

console.log('=== RAG Path Diagnostic ===\n');
console.log('publicRoot:', publicRoot);
console.log('dataRoot:', dataRoot);
console.log('datasetRoot:', datasetRoot);
console.log('authorRoot:', authorRoot);

console.log('\n=== Directory Existence Check ===');
console.log('publicRoot exists:', fs.existsSync(publicRoot));
console.log('dataRoot exists:', fs.existsSync(dataRoot));
console.log('datasetRoot exists:', fs.existsSync(datasetRoot));
console.log('authorRoot exists:', fs.existsSync(authorRoot));

console.log('\n=== File Counts ===');

function countJsonFiles(dir) {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: false });
    return files.filter(f => String(f).toLowerCase().endsWith('.json')).length;
}

console.log('JSON files in datasetRoot:', countJsonFiles(datasetRoot));
console.log('JSON files in authorRoot:', countJsonFiles(authorRoot));

console.log('\n=== Sample Files ===');
if (fs.existsSync(datasetRoot)) {
    const files = fs.readdirSync(datasetRoot).slice(0, 3);
    console.log('Sample files in datasetRoot:', files);
}

if (fs.existsSync(authorRoot)) {
    const dirs = fs.readdirSync(authorRoot).slice(0, 3);
    console.log('Sample dirs in authorRoot:', dirs);
}
