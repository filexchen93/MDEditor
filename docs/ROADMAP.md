# Roadmap

Milestones are quality gates. A later milestone does not begin broadly until the previous completion criteria are demonstrated.

## M0 — Engineering and quality baseline

Workspace, typed linting, formatting, package builds, React/Vite/Tauri shell, unit and E2E harnesses, official specification fixtures, performance inputs, ADRs, CI and project governance. The web baseline and native Windows build are verified.

## M1 — Reliable source editor

Single-document CodeMirror editor, new/open/save/save-as, byte-preserving UTF-8 and UTF-8 BOM codecs, LF/CRLF and final-newline retention, atomic replacement, external-change detection, crash recovery, recent files and settings. Exit gate: every supported round trip is byte-identical and fault injection never corrupts the original.

Status: **complete**. Source editing, session revisions, new/open/save/save-as, supported byte-level round trips, path authorization, external-change refusal, atomic replacement, application-data crash recovery, recent files, and persistent font-size/line-wrapping settings are implemented. Windows fault injection covers every pre- and post-replacement boundary and verifies that the target is always either the complete old content or the complete new content. The full web and native quality gates pass.

## M2 — Progressive rendering

Incremental Lezer decorations for headings, emphasis, links, quotes and lists; image widgets; code highlighting; source/hybrid toggle; dedicated Chinese IME coverage. Exit gate: rendering mode never mutates text and composition/selection/undo remain stable.

Status: **complete**. The hybrid layer derives viewport-bounded decorations
from Lezer's incremental tree for headings, emphasis, links, quotes, lists and
code, mounts protocol-filtered image widgets, and highlights fenced JavaScript,
TypeScript, JSON, HTML and CSS. Source/hybrid reconfiguration preserves the
canonical document, selection and history. Chromium IME coverage commits mixed
Chinese, Latin, punctuation and emoji exactly once while keeping widgets stable;
undo and redo are verified. The 1/10 MiB browser benchmark and all web/native
quality gates pass.

## M3 — Common enhancements

GFM table and task interactions, outline, KaTeX, Mermaid, tabs/workspaces, export, themes and configurable shortcuts. Complex renderers must fail independently of source editing and save.

## M4 — Ecosystem and release maturity

Permissioned plugin API, optional sync boundary, accessibility completion, signed packages, updates and a stable release process. Plugin work starts only after document and editing APIs are stable.

## Non-goals for the first stable release

Real-time collaboration, a cloud sync service, AI writing, mobile clients, a full plugin marketplace, commercial-editor feature parity and support for every non-standard Markdown dialect.
