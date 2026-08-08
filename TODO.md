# TODO — Fix "All Datasets" select/unselect toggle + search filter + multi-dataset answers in AI Agent

## Problems addressed
1. Checkbox toggles didn't work (only row expand/collapse).
2. The hook force-reset `allSelected` back to `true` when toggled off.
3. **Search/filter in the dataset tree appeared broken** — the root "All Datasets" node was NOT expanded during search, so filtered results were hidden under a collapsed root.
4. **AI agent not answering for selected datasets** — production `dist` bundle was stale (predated the multi-dataset backend/frontend changes).
5. **Retrieval couldn't find compound-name entities** (e.g. "who is renukacharya"). Root cause: query token "renukacharya" never matched chunk tokens "renuka"/"revaṇācarya" verbatim, and loose substring matching caused false positives from common suffixes like "acharya".

## Plan steps
- [x] 1. `src/components/ai/DatasetTree.tsx` — Make checkboxes clickable; keep root expanded during search so results are visible.
- [x] 2. `src/hooks/useRagAssistant.ts` — Remove the auto-reset guard.
- [x] 3. Verify backend filtering + tree search logic against real index (server/_verify_tree_filter.cjs) — confirmed correct.
- [x] 4. Rebuild production bundle (`tsc -b && vite build`) so fixes are live.
- [x] 5. `server/hybrid_search.js` — Refined keyword matching to **prefix-based matching**: a query token matches a chunk token only when it is a leading prefix (e.g. "renuka" ⊂ "renukacharya"), eliminating false positives from common suffixes like "acharya".
- [x] 6. `server/hybrid_search.js` — Added a strong entity-text boost (up to 0.9) when a meaningful proper noun appears verbatim or via prefix in the chunk text; rebalanced hybrid weights to semantic 0.25 / keyword 0.35 / fuzzy 0.15 / boost 0.25 and raised `retrieveK` to 50 so boosted entity chunks aren't prematurely discarded.

## Verification (via live server API)
- "who is renukacharya" → Suprabodha_Agama.json (renuka) + Basava_Purāṇa.pdf at top; accurate answer about Reṇukācārya/Revaṇārādhya. ✅
- "who is basavanna" → Basava vachana datasets at top; accurate answer about Saṅgana Basavaṇṇa (no regression). ✅
- "what is veerashaivism", "shiva", "siddhanta" → all return relevant datasets (keyword-only fallback path). ✅

