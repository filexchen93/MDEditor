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

## M4 — Ecosystem and release maturity

Permissioned plugin API, optional sync boundary, accessibility completion, signed packages, updates and a stable release process. Plugin work starts only after document and editing APIs are stable.

Status: **in progress**. A versioned plugin contract now validates strict local
module manifests and separates declared `document:read` / `document:edit`
permissions from explicit user grants. The generated host surface exposes only
granted immutable capabilities; source edits require an expected revision and
pass ordered-range, overlap, count and size checks before reaching a document
adapter. No third-party module is loaded yet: execution isolation, package
authenticity, consent UI and host integration remain release gates.
The active document now has a correctly associated tabpanel, closing a tab
restores focus deterministically, and the Markdown toolbar uses one tab stop with
wrapping Arrow/Home/End navigation. Persistent polite status announcements,
application busy state, visible focus treatment and Escape-dismissable settings
and export disclosures strengthen the current workspace keyboard and
screen-reader path. Dedicated browser coverage exercises these semantics and
focus transitions.

## Non-goals for the first stable release

Real-time collaboration, a cloud sync service, AI writing, mobile clients, a full plugin marketplace, commercial-editor feature parity and support for every non-standard Markdown dialect.
