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

## M4 — Personal open-source usability and manual distribution

The current goal is a dependable editor for personal use and open-source sharing,
not a signed, automatically updating commercial release. Windows x64 is the first
manual package target. macOS and Linux remain source and CI compatibility targets;
installers are produced only when there is a concrete need and a machine available
for smoke testing.

Status: **in progress**. The versioned plugin contract and the first workspace
accessibility improvements are complete. The remaining work is ordered by direct
value to personal use rather than ecosystem breadth.

### Priority 1 — Core usability and accessibility

- Add automated WCAG checks for the main editor workflow and fix actionable
  violations.
- Verify keyboard-only use, high-contrast/forced-color display, zoom and narrow
  window behavior on Windows.
- Keep file safety, crash recovery, byte preservation and existing regression
  gates ahead of new feature count.
- Document known limitations instead of blocking personal builds on exhaustive
  certification across every assistive technology and operating system.

The active document already has an associated tabpanel, deterministic focus after
tab close, a roving Markdown toolbar, persistent polite status announcements,
application busy state, visible focus treatment and Escape-dismissable settings
and export disclosures. Browser coverage exercises these semantics and focus
transitions.

### Priority 2 — Unsigned manual packages

- Replace placeholder versions before a shared build and enable the required
  Tauri Windows bundle target.
- Produce an unsigned Windows installer locally only after frontend, browser and
  native quality gates pass.
- Smoke-test install, launch, open, edit, save, recovery and uninstall on a clean
  or disposable Windows environment.
- Generate a SHA-256 checksum and short release notes for every uploaded artifact.
- Upload installers and checksums manually to the Git hosting release/download
  area. Do not keep generated installers in ordinary source history.
- Clearly disclose that unsigned builds can trigger Windows SmartScreen or
  unknown-publisher warnings.

The checklist is maintained in
[Manual unsigned distribution](MANUAL_DISTRIBUTION.md).

### Priority 3 — Optional capabilities driven by personal need

The permissioned plugin contract continues to validate manifests, grants and
document edits, but third-party execution, installation UI and package
authenticity are deferred until a real plugin is needed. The optional sync
boundary is also deferred until a concrete provider or multi-device workflow is
required. Neither blocks manual installer distribution.

### Deferred for the current phase

- Code signing, certificate/key management and Apple notarization.
- Built-in automatic updates, update channels and rollback infrastructure.
- Automated release workflows, formal release trains, provenance and publication
  approvals.
- A plugin marketplace, general-purpose cloud sync service and production support
  commitments.

These items return to the roadmap only if distribution grows beyond trusted
personal/open-source users or operating-system warnings become an adoption
problem.

### M4 exit gate for the current phase

M4 is complete when the documented quality gates pass, the unsigned Windows
installer can be built reproducibly from a versioned commit, its checksum is
published, and a clean-machine smoke test confirms the core local-first workflow.
Signing, automatic updates and automated publication are explicitly not required.

## Non-goals for the current personal-open-source phase

Real-time collaboration, a hosted cloud sync service, AI writing, mobile clients,
a full plugin marketplace, commercial-editor feature parity, signed distribution,
automatic updates and support for every non-standard Markdown dialect.
