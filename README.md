# MDEditor

MDEditor is an open-source, cross-platform, local-first Markdown desktop editor. Its first priority is lossless, reliable access to Markdown source; progressive rendering is an enhancement, never the document model.

The project has completed **M3 (common enhancements)** and begun M4 release maturity work. It includes a multi-document tab workspace with independent CodeMirror histories, byte-preserving UTF-8/BOM and newline handling, controlled native open/save dialogs, disk-change detection, same-directory atomic replacement, crash-recovery workspaces, recent files, persistent editor settings, and a lossless source/hybrid mode. The hybrid layer progressively derives headings, emphasis, links, quotes, lists, image widgets and highlighted code without rewriting Markdown. M3 adds accessible GFM task checkboxes, table insertion and Tab/Shift+Tab cell navigation with automatic row creation, an asynchronously derived document outline with source jump navigation, isolated on-demand KaTeX and Mermaid previews, sanitized standalone HTML export, system print/PDF output, paper/dark/system themes, and six configurable application shortcuts. M4 starts with a versioned permission boundary for future plugins; it does not execute third-party modules yet. Supported round trips are byte-identical, Windows fault injection proves atomic-save outcomes, and dedicated Chinese IME coverage verifies stable composition, selection and history.

## Architecture

```text
@mdeditor/ui → @mdeditor/editor-core → @mdeditor/markdown
             ⇢ @mdeditor/renderers (lazy KaTeX/Mermaid chunks)
             → @mdeditor/document-session
future plugin runtime → @mdeditor/plugin-api → explicit host capabilities
desktop web adapter → controlled Tauri APIs
```

Markdown text will be the canonical document state. UI state must not duplicate the complete editor text, and preview serializers must never rewrite source documents.

## Requirements

- Node.js 22.13 or newer (Node.js 24 is used in CI)
- pnpm 11 via Corepack
- Rust stable and the Tauri 2 platform prerequisites for native desktop builds

## Development

```shell
corepack enable
pnpm install
pnpm run check
pnpm dev
```

`pnpm dev` starts the browser-hosted frontend. After installing the Rust/Tauri prerequisites, use `pnpm desktop dev` to run the native window.

Useful commands:

| Command              | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `pnpm run check`     | Run formatting, lint, unit tests and all builds       |
| `pnpm build`         | Build every workspace package in dependency order     |
| `pnpm test`          | Run Vitest unit and fixture checks                    |
| `pnpm test:e2e`      | Run the Playwright browser smoke test                 |
| `pnpm lint`          | Run the repository ESLint policy                      |
| `pnpm format:check`  | Verify formatting without changing files              |
| `pnpm fixtures:spec` | Deliberately refresh CommonMark/GFM fixture snapshots |
| `pnpm benchmark`     | Run the initial deterministic corpus benchmark        |

## Supported scope

The core dialect is CommonMark plus GFM tables, task lists, strikethrough and autolinks. KaTeX and Mermaid are registered optional fenced-block extensions whose browser code loads only when a matching preview is needed; YAML front matter and footnotes remain possible later extensions. Collaboration, cloud sync, mobile clients, AI writing and a plugin marketplace are not goals for the first stable version.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and [SECURITY.md](SECURITY.md) for private vulnerability reporting. Architecture decisions live in [`docs/adr`](docs/adr); current gates and platform targets are recorded in the [roadmap](docs/ROADMAP.md) and [platform baseline](docs/PLATFORM_SUPPORT.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
