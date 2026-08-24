# 0002: CodeMirror and Lezer editor core

- Status: Accepted
- Date: 2026-08-23

## Context

The editor needs low-latency text transactions, undo/redo, selections, IME support, incremental parsing and viewport-based decorations for documents up to 10 MiB.

## Decision

Use CodeMirror 6 for text editing and Lezer Markdown for incremental syntax data. Keep framework-independent configuration and extensions in `@mdeditor/editor-core`; React owns application composition, not document text.

## Alternatives considered

- A bare `contenteditable`: rejected due to browser editing inconsistencies and the cost of rebuilding editor primitives.
- Monaco: viable for code, but heavier and less aligned with progressive prose rendering.
- A rich-text editor with Markdown import/export: rejected by ADR 0001.

## Consequences

The project adopts CodeMirror's transaction and decoration model and must test extensions carefully during IME composition. React renders shell UI while CodeMirror controls its editing subtree.

## Review conditions

Review if profiling on fixed 1 MiB and 10 MiB corpora cannot meet latency targets after documented optimization, or if an accessibility blocker cannot be addressed within CodeMirror.
