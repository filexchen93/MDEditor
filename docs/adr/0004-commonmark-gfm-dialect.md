# 0004: CommonMark and GFM dialect

- Status: Accepted
- Date: 2026-08-23

## Context

Markdown has many incompatible dialects. An explicit boundary is needed for predictable parsing, tests and user expectations.

## Decision

The core dialect is CommonMark plus GFM tables, task lists, strikethrough and autolinks. YAML front matter, footnotes, KaTeX and Mermaid are separately registered optional extensions. Raw HTML is preserved in source and sanitized only in preview output.

## Alternatives considered

- CommonMark only: too narrow for common GitHub-authored documents.
- An all-inclusive parser preset: creates accidental compatibility promises and a private dialect.
- Typora behavior as the specification: proprietary behavior is not a stable, testable standard.

## Consequences

Official CommonMark/GFM examples can define the conformance corpus. Unsupported syntax remains editable source, and optional extensions cannot mutate the core parser globally.

## Review conditions

Review when a standards-track extension is widely adopted or fixture evidence shows that the chosen boundary is internally inconsistent.
