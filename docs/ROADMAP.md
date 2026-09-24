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

Status: **complete**. The editor uses its declared GFM parser in both
source and hybrid modes. Task markers become accessible, undoable checkboxes in
hybrid mode; tables can be inserted from the toolbar and navigated across every
cell with Tab / Shift+Tab, with a new row created after the final cell. These
interactions edit only canonical Markdown transactions and have dedicated unit,
browser, Unicode-offset and empty-cell coverage. The document outline derives
all ATX and Setext headings from the complete syntax tree in cancellable 20 ms
time slices, excludes headings inside fenced code, and supports source-focused
jump navigation with live updates. KaTeX and Mermaid fenced blocks load in
separate browser chunks and render through an abortable interface; input bounds,
strict renderer settings and post-render SVG filtering contain each failure in
its own text-only fallback without changing source or history. The tab workspace
keeps a separate CodeMirror instance, selection, undo history and document
session for every open file; dirty closes require confirmation, duplicate paths
activate their existing tab, and a versioned recovery workspace atomically
captures every dirty tab while migrating legacy single-document snapshots.
Standalone HTML export derives GFM output from the current editor state, applies
an explicit element and attribute allowlist plus URL protocol checks, and embeds
a restrictive CSP with print-ready styling. Desktop exports use a native save
dialog and atomic replacement; the same sanitized document drives the system
print dialog for PDF output. Export never changes source, revisions or save
state. Paper, dark and system themes share a complete semantic color-token
layer across the shell, source editor, hybrid widgets and export. Six persisted
application shortcuts are configurable from validated choices; conflicts are
rejected, and editor preferences reconfigure without replacing the document,
selection or undo history. Unit, browser, production-build and native atomic
write gates pass.

## Future direction — Typora-class capability

The project remains open source under GPL-3.0-only, and its Markdown product
capability is expected to reach the level of a mature desktop editor. The
benchmark and implementation decisions are maintained in
[Typora capability parity plan](TYPORA_PARITY_PLAN.md).

Commercial use is permitted by GPLv3. Paid services and release infrastructure are
not part of this goal. Signing, automatic updates, release channels, accounts,
commercial licensing and automated publication remain deferred.

## M4 — Typora-class single-document authoring

Status: **in progress**. The current source-safe hybrid layer is the foundation,
not the finished authoring experience.

- Implement live preview with active Markdown structures expanding back to
  editable source without introducing a second document state.
- Add transaction-based formatting commands for common inline and block syntax.
- Complete table row, column, alignment, resize and reorder operations.
- Add footnotes, YAML front matter, TOC, GitHub alerts, inline/display math and a
  shared editor/export Markdown profile.
- Expose and verify find/replace; add outline filtering, word/character/line and
  reading-time statistics, focus/typewriter modes and Markdown auto-pairing.
- Preserve IME correctness, undo history, byte fidelity, renderer isolation and
  the existing 1/10 MiB performance gates.

Exit gate: the documented single-file writing scenario can be completed in live
preview without falling back to source mode, and every operation remains a
reversible edit of canonical Markdown text.

## M5 — Folder, link and image workflows

- Add an explicitly authorized folder workspace with a virtualized file tree,
  file operations and filesystem watching.
- Add fuzzy quick open and cancellable cross-file search with bounded native
  traversal.
- Support internal headings, local Markdown files and external URL navigation.
- Add clipboard, drag/drop and picker image import; copy assets according to a
  workspace policy and write portable relative links.
- Add reference-aware image rename/move/copy and broken-link inspection.
- Add conservative configurable auto-save that never bypasses external-change
  fingerprints; retain recovery snapshots for untitled and dirty documents.
- Add an ADR and adversarial tests for authorized roots, path traversal, symbolic
  links, conflicts and partial failures.

Exit gate: a real documentation repository with Chinese paths, nested Markdown
files and local images can be searched, edited and recovered without data loss or
access outside the approved root.

## M6 — Output fidelity, themes and manual distribution

- Use one rendering pipeline for live preview, styled/unstyled HTML, image and
  print/PDF output, including footnotes, TOC, alerts, math, Mermaid and local
  images.
- Add useful PDF controls and an optional external Pandoc adapter for DOCX.
- Add verified system spellcheck, installable scoped themes and an explicitly
  trusted local-CSS option.
- Render a safe subset of inline and block HTML while continuing to reject
  scripts, event handlers and arbitrary iframe execution.
- Complete automated accessibility checks and Windows keyboard, high-contrast,
  zoom and narrow-window verification.
- Replace placeholder versions, enable the Windows x64 bundle and follow
  [Manual unsigned distribution](MANUAL_DISTRIBUTION.md) for local builds,
  checksums, smoke tests and manual upload.

Exit gate: the benchmark document is structurally and visually consistent in the
editor, HTML, image and PDF outputs, and an unsigned Windows installer can be
reproduced from a versioned commit and smoke-tested on a clean environment.
Signing, updates and automated publication are explicitly not required.

## Deferred for the personal-open-source phase

- Code signing, certificate/key management, Apple notarization and OS trust
  programs.
- Built-in automatic updates, stable/preview channels and rollback infrastructure.
- Automated release publication, formal release trains and commercial support.
- Accounts, licensing, payments, telemetry and growth infrastructure.
- Real-time collaboration, hosted cloud sync, mobile clients and AI writing.
- A plugin marketplace or execution of arbitrary third-party code. The existing
  permissioned plugin contract remains available for future concrete needs.
- Exact replication of every Typora legacy feature or every Pandoc export format.
