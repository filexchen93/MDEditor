# MDEditor

MDEditor is a local-first Markdown desktop editor. Your Markdown text is the document: live formatting, previews and exports are derived from it without rewriting the source.

**Project status:** Core editing is working. Advanced writing, workspace and export features are still undergoing native-app and release validation. Windows x64 is the first planned installer target; macOS and Linux are source and CI compatibility targets. See the [roadmap](docs/ROADMAP.md) and [platform support](docs/PLATFORM_SUPPORT.md) for details.

## What you can do

- **Write and recover safely:** work in multiple tabs with independent undo histories; preserve UTF-8 BOM, line endings and final newlines; detect changes on disk; save atomically and recover unsaved work after a crash.
- **Edit Markdown directly:** switch between source and hybrid views, use the formatting toolbar, find and replace text, navigate the outline, edit GFM tables and task lists, and use focus or typewriter mode.
- **Work with local files:** open individual documents or an explicitly authorized folder, search the workspace, follow local links and import images by file picker, paste or drag and drop.
- **Preview and export:** render KaTeX, Mermaid and local images; export sanitized HTML and PNG; print or save as PDF; and optionally export DOCX through Pandoc. Offline US/UK English spellcheck is opt-in.

The Markdown profile covers CommonMark, GFM tables, task lists, strikethrough and autolinks, plus footnotes, YAML front matter, `[toc]`, GitHub alerts, math and Mermaid. Markdown remains the only saved document state.

## Run from source

The browser-hosted development mode needs Node.js 22.13 or newer and pnpm 11 via Corepack. The native app also needs Rust and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```shell
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the browser-hosted frontend. For native file dialogs and other desktop features, run `pnpm desktop dev` after installing the Tauri prerequisites. In the app, the **文件** menu provides New, Open, Open Folder, Recent Files and Save As; Search and Save are in the top bar.

## Development and checks

| Command                   | Purpose                                          |
| ------------------------- | ------------------------------------------------ |
| `pnpm run check`          | Check formatting, build, lint and run unit tests |
| `pnpm test:e2e`           | Build and run Playwright browser tests           |
| `pnpm build:native-test`  | Build the isolated native test app               |
| `pnpm test:native`        | Run native Tauri/WebView tests                   |
| `pnpm test:native:manual` | Launch the Windows manual acceptance app         |

Native tests use isolated data directories. System IME, physical-keyboard and dialog checks still require manual acceptance; automated composition tests do not replace them. See the [contribution guide](CONTRIBUTING.md) for development checks.

## Distribution

The planned downloadable package is an unsigned Windows x64 installer, built and uploaded manually with a SHA-256 checksum. Signing, built-in updates and automated publication are deferred. See the [manual distribution checklist](docs/MANUAL_DISTRIBUTION.md) before sharing a build.

## Project documents

- [Roadmap](docs/ROADMAP.md) and [Typora capability plan](docs/TYPORA_PARITY_PLAN.md)
- [Architecture decisions](docs/adr) and [platform support](docs/PLATFORM_SUPPORT.md)
- [Contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md)

## License

Copyright 2026 MDEditor contributors. The project code is licensed under **GNU GPL version 3 only** (`GPL-3.0-only`); see [LICENSE](LICENSE). GPLv3 permits commercial use. If you distribute the program or a modified version, you must comply with its source-code and redistribution terms.

Third-party components retain their own licenses. Previously released Apache-2.0 versions retain their original license.
