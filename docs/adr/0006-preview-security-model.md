# 0006: Preview security model

- Status: Accepted
- Date: 2026-08-23

## Context

Markdown may contain raw HTML, dangerous URLs, remote media and diagram programs. Preview convenience must not become filesystem, network or script authority.

## Decision

Treat all document content as untrusted. Sanitize preview HTML with an explicit allowlist, reject scripts, event attributes and dangerous URL protocols, and enforce a restrictive CSP. Open approved external protocols in the system browser. Preview transformations never write back to source. Complex renderers run with bounded inputs and stable error fallbacks.

KaTeX runs with trust disabled, strict errors and bounded expansion and sizing.
Mermaid runs at the strict security level with bounded source and graph size;
its generated SVG is parsed as XML and stripped of scripts, event handlers and
non-fragment links before it enters the live document. Both renderers are loaded
on demand behind an abortable editor interface. A renderer exception changes
only that preview to a text-only error state and never dispatches an editor
transaction.

Standalone HTML and print/PDF export pass rendered GFM through an explicit HTML
element and attribute allowlist, then revalidate link and image protocols. The
result contains no script, embeds a restrictive CSP, and is written through a
user-selected native path with atomic replacement. Export is a disposable
derivative and never advances the document revision or saved revision.

## Alternatives considered

- Disable all raw HTML in source: rejected because preservation is required for lossless editing.
- Trust local files: rejected because downloaded or shared local files remain attacker-controlled.
- Rely on CSP alone: rejected because defense in depth requires sanitization and capability isolation.

## Consequences

Some embedded content will be blocked or require explicit user action. Sanitizer, protocol and capability policies become security-sensitive dependencies with regression tests.

## Review conditions

Review for every new renderer, embeddable media type, external protocol or permission-bearing Tauri command.
