# Contributing to MDEditor

Thank you for helping build a reliable Markdown editor. Correctness and document safety take precedence over feature count.

## Set up the repository

Install Node.js 22.13 or newer, enable Corepack, then install the locked dependencies:

```shell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

Native work also requires stable Rust and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/). Keep core logic in the TypeScript packages so it remains testable without Tauri.

## Change rules

- Markdown source is the canonical state. Do not introduce an HTML, DOM or AST source of truth.
- Do not serialize and rewrite an entire document to implement a local edit.
- Preserve encoding, BOM, line endings and final-newline state in document I/O.
- Keep dependencies moving in the direction documented in the README and ADRs.
- Treat Markdown, HTML, URLs, images and diagrams as untrusted input.
- Add regression coverage for behavior changes, including Chinese text and paths where relevant.
- Record decisions that change an accepted architecture boundary in a new or superseding ADR.

## Quality gates

Run `pnpm run check` before opening a pull request. UI changes must also pass `pnpm test:e2e`; native changes must pass `cargo fmt --check`, Clippy with warnings denied, and Rust tests from `apps/desktop/src-tauri`.

Commits should be focused and explain why the change is needed. Pull requests must describe user-visible effects, risks to source fidelity or file safety, tests performed, and follow-up work deliberately left out.

## Specification fixtures

Do not refresh official Markdown fixtures as a side effect of dependency installation. Run `pnpm fixtures:spec` deliberately, review changed source hashes and counts, and include the reason in the pull request.
