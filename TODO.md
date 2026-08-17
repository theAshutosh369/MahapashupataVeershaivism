# TODO - Author page table search + pagination

- [ ] Refactor `src/pages/Author.tsx` to mirror `src/pages/GlobalSearch.tsx` structure
  - [ ] Add column toggle UI (serial/author/number/kannada/transliteration/translation)
  - [ ] Render results in a table (like GlobalSearch)
  - [ ] Implement pagination controls with selectable page size: 10 / 50 / 100
  - [ ] Ensure pagination works with author-local search
- [ ] Reuse the existing table subcomponents logic (either copy minimal helpers into Author or extract shared components)
- [ ] Run TypeScript check / build (if scripts exist) to ensure no regressions

