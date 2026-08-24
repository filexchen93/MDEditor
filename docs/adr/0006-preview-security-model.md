# 0006: Preview security model

- Status: Accepted
- Date: 2026-08-23

## Context

Markdown may contain raw HTML, dangerous URLs, remote media and diagram programs. Preview convenience must not become filesystem, network or script authority.

## Decision

Treat all document content as untrusted. Sanitize preview HTML with an explicit allowlist, reject scripts, event attributes and dangerous URL protocols, and enforce a restrictive CSP. Open approved external protocols in the system browser. Preview transformations never write back to source. Complex renderers run with bounded inputs and stable error fallbacks.

## Alternatives considered

- Disable all raw HTML in source: rejected because preservation is required for lossless editing.
- Trust local files: rejected because downloaded or shared local files remain attacker-controlled.
- Rely on CSP alone: rejected because defense in depth requires sanitization and capability isolation.

## Consequences

Some embedded content will be blocked or require explicit user action. Sanitizer, protocol and capability policies become security-sensitive dependencies with regression tests.

## Review conditions

Review for every new renderer, embeddable media type, external protocol or permission-bearing Tauri command.
