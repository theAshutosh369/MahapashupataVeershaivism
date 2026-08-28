// Render production bootstrap.
// Forces the prebuilt Google Drive RAG index path before server.js starts.
process.env.RAG_USE_PREBUILT_INDEX = '1';
await import('./server.js');
