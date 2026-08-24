# Deployment Preparation - Implementation Steps

- [x] Step 1: Fix `src/services/rag/retriever.ts` - Change default API_BASE from `http://localhost:3001` to `''` (same-origin)
- [x] Step 2: Fix `src/pages/DatasetGenerator.tsx` - Replace hardcoded `localhost:3002` fetch calls with `getDataset()` from shared API service
- [x] Step 3: Add `start` script to `server/package.json`
- [x] Step 4: Create `.env.example` with all required environment variables documented
- [ ] Step 5: Verify production build works: `npm run build`
- [ ] Step 6: Verify server starts: `npm run prod`
- [ ] Step 7: Final verification - scan for any remaining hardcoded URLs

