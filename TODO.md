# Fix Render.com AI Agent Deployment Issues

## Steps
- [x] 1. Diagnose the root cause (rag_index.json not deployed + enrichedCandidates bug + join bug)
- [x] 2. Remove `server/rag_index.json` from `.gitignore`
- [x] 3. Fix `enrichedCandidates` → `candidates` bug in `server/rag_engine.js`
- [x] 4. Fix `lines.join('\\n')` → `lines.join('\n')` in `buildSystemPrompt()`
- [x] 5. Verify index metadata is correct (21077 chunks, 230 datasets, embeddings bin matches)
- [ ] 6. Commit changes (including the index file) and push so Render can deploy
- [ ] 7. Set `GEMINI_API_KEY` in Render dashboard (if not already set)

## Notes
- `server/rag_index.json` must be committed so it ships with the deployment
- `server/rag_embeddings.bin` is already tracked and deployed
- Set `GEMINI_API_KEY` in the Render dashboard (it's `sync: false` in render.yaml, so it must be set manually)

