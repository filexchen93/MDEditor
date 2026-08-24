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
source-to-hybrid activation, dispatch-to-paint P50/P95, long-task count and
duration, long-line opening, and image-widget counts before and after a viewport
change. It fails when the documented budgets are exceeded. Results are only
comparable when the device, OS, power mode, build mode, revision and corpus hash
are reported.

## M2 budgets

| Measurement                                       |          Budget |
| ------------------------------------------------- | --------------: |
| 1 MiB open-to-editable                            |     <= 3,000 ms |
| 10 MiB open-to-editable                           |    <= 10,000 ms |
| 1 MiB dispatch-to-paint P95                       |       <= 250 ms |
| 10 MiB dispatch-to-paint P95                      |       <= 500 ms |
| 1 MiB long-line open-to-editable                  |     <= 4,000 ms |
| Visible image widgets at either measured viewport | <= 100 of 1,000 |

Long tasks are reported rather than gated because browser startup, CPU power
state and headless scheduling can dominate individual entries. Any accepted
release benchmark must still explain a new longest task above 500 ms.

## Latest local result

Captured 2026-08-24 on Windows 11, Intel Core i7-10510U, 8 logical CPUs,
Node.js 24.18.0, Vite development harness in headless Chromium, uncommitted
worktree.

| Corpus | SHA-256                                                            |     Open |   Hybrid | Dispatch P50 | Dispatch P95 |
| ------ | ------------------------------------------------------------------ | -------: | -------: | -----------: | -----------: |
| 1 MiB  | `e33dad9ab292ecd9768f18fdc304b1df1fbadf2f669407087aa18ee9d40dab38` | 157.6 ms | 130.9 ms |      33.5 ms |      34.6 ms |
| 10 MiB | `abaf645896aa48eb0d1be689b351c6e42a8343a0b3ff7088ec3ccaa09b5e0b92` | 108.4 ms |  30.2 ms |      32.7 ms |      34.4 ms |

The 1 MiB long-line corpus opened in 81.4 ms. Both measured viewports mounted 9
of 1,000 image widgets. Five long tasks totalled 519 ms; the longest was 144 ms.
No budget was breached. These development-harness numbers validate the gate and
are not a substitute for a production-build release benchmark.
