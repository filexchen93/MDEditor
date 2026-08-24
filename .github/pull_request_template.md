## Outcome

<!-- What user or engineering outcome does this change deliver? -->

## Safety and architecture

- [ ] Markdown source remains the canonical state.
- [ ] Unrelated source regions are not reformatted or serialized.
- [ ] File, preview, URL and Tauri permission changes were threat-reviewed.
- [ ] Any architecture boundary change has an ADR.

## Verification

- [ ] `pnpm run check`
- [ ] `pnpm test:e2e` when UI behavior changed
- [ ] Rust format, Clippy and tests when native code changed
- [ ] Chinese text, path or IME behavior considered where relevant

## Deliberately deferred

<!-- Record follow-up work so this pull request stays reviewable. -->
