# 0001: Markdown text as canonical state

- Status: Accepted
- Date: 2026-08-23

## Context

MDEditor must preserve user-authored Markdown byte-for-byte when no edit occurs and avoid reformatting unrelated regions after a local edit. Rich-document models generally require serialization that can change valid source spelling.

## Decision

The in-memory Markdown text is the only canonical document content. Editor state may own that text; syntax trees, HTML, DOM nodes, decorations and preview widgets are disposable derived data. No derived representation may overwrite source by serialization.

## Alternatives considered

- HTML or `contenteditable` DOM as canonical state: rejected because Markdown spelling and layout cannot be reconstructed losslessly.
- ProseMirror/Tiptap JSON plus bidirectional synchronization: rejected because two authoritative states create conflict and cursor-mapping risk.
- Markdown AST serialization: rejected because serializers normalize unrelated source.

## Consequences

Source fidelity is directly testable and rendering may fail independently. Structured edits must be expressed as localized text transactions, which requires more care than whole-document serialization.

## Review conditions

Review only if a proposed model demonstrates byte-level round trips, local-edit locality, stable selection mapping and no second source of truth across the full supported corpus.
