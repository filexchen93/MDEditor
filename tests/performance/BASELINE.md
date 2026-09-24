# Performance baseline

This baseline defines reproducible inputs, budgets, and reporting fields for the
source editor and M2 progressive-rendering layer.

## Reference device

- Captured: 2026-08-23
- OS: Windows 11, x64
- Node.js: 24.18.0
- CPU and memory: record on the machine producing an accepted benchmark result
- Power mode: plugged in, normal balanced profile
- Build mode: production unless the test explicitly says otherwise

## Fixed corpora

- 1 MiB generated Markdown: mixed Chinese/English prose, emphasis, links, inline code and task lists
- 10 MiB generated Markdown: the same deterministic pattern
- 1 MiB long-line corpus with wrapping disabled
- 1,000-image viewport corpus using blocked image URLs (widgets render without network access)

Run `pnpm benchmark`. The browser harness records open-to-editable time,
source-to-hybrid activation, complete-outline readiness and item count,
dispatch-to-paint P50/P95, long-task count and duration, long-line opening, and
image-widget counts before and after a viewport change. It fails when the
documented budgets are exceeded. Results are only comparable when the device,
OS, power mode, build mode, revision and corpus hash are reported.
The report marks a dirty worktree explicitly; a release result requires a clean
source snapshot.

For release validation, run `pnpm benchmark:release`. It bundles the same
editor harness with Vite's production build and serves the resulting files to
headless Chromium. The development harness uses a dedicated Vite cache and
scans only its own entry page, so other local release snapshots cannot supply
CodeMirror dependencies. Both reports include synchronous dispatch and
post-dispatch paint-wait P95 diagnostics alongside the existing total.

## M2/M3 budgets

| Measurement                                       |          Budget |
| ------------------------------------------------- | --------------: |
| 1 MiB open-to-editable                            |     <= 3,000 ms |
| 10 MiB open-to-editable                           |    <= 10,000 ms |
| 1 MiB dispatch-to-paint P95                       |       <= 250 ms |
| 10 MiB dispatch-to-paint P95                      |       <= 500 ms |
| 1 MiB complete outline ready                      |     <= 3,000 ms |
| 10 MiB complete outline ready                     |    <= 10,000 ms |
| 1 MiB long-line open-to-editable                  |     <= 4,000 ms |
| Visible image widgets at either measured viewport | <= 100 of 1,000 |

Long tasks are reported rather than gated because browser startup, CPU power
state and headless scheduling can dominate individual entries. Any accepted
release benchmark must still explain a new longest task above 500 ms.

## Latest local result

Captured 2026-08-25 on Windows 11, Intel Core i7-10510U, 8 logical CPUs,
Node.js 24.18.0, Vite development harness in headless Chromium, uncommitted
worktree.

| Corpus | SHA-256                                                            |     Open |  Hybrid | Outline ready | Outline items | Dispatch P50 | Dispatch P95 |
| ------ | ------------------------------------------------------------------ | -------: | ------: | ------------: | ------------: | -----------: | -----------: |
| 1 MiB  | `e33dad9ab292ecd9768f18fdc304b1df1fbadf2f669407087aa18ee9d40dab38` | 107.0 ms | 51.0 ms |      439.1 ms |         5,637 |      33.8 ms |      60.5 ms |
| 10 MiB | `abaf645896aa48eb0d1be689b351c6e42a8343a0b3ff7088ec3ccaa09b5e0b92` |  71.8 ms | 31.7 ms |    3,441.0 ms |        56,375 |     300.9 ms |     434.4 ms |

The 1 MiB long-line corpus opened in 121.5 ms. Both measured viewports mounted 9
of 1,000 image widgets. Fifty long tasks totalled 8,700 ms while parsing
and collecting the complete large outlines; incremental collection kept the
longest individual task to 319 ms. No budget was breached. These
development-harness numbers validate the gate and are not a substitute for a
production-build release benchmark.

## Outline parse isolation check

On 2026-09-24, with the full 10 MiB outline collected before edits, a separate
outline parse state kept the complete syntax tree out of the live editor. On a
Windows 11 i7-10510U host, three consecutive development-harness runs measured
10 MiB dispatch-to-paint P95 at 34.4, 35.2 and 34.6 ms. Three consecutive
production-build runs measured 34.4, 34.9 and 34.9 ms. All six runs had no budget
breaches and returned 56,375 outline items. These are local worktree results;
the final release commit still needs its own recorded run.
