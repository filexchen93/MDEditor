# 0007: Permissioned plugin boundary

- Status: Accepted
- Date: 2026-08-27

## Context

M3 stabilized the document session and editing APIs, so plugin contracts can now
be designed without exposing CodeMirror, React, Tauri or filesystem internals.
Third-party plugin packages remain untrusted: a manifest declaration is not user
consent, an editor object is ambient authority, and a malformed edit must never
bypass document revision or source-safety rules.

## Decision

Introduce a versioned `@mdeditor/plugin-api` package as the only contract between
plugins and host capabilities. Version 1 accepts local relative JavaScript module
entries and the permissions `document:read` and `document:edit`. Manifests reject
unknown fields, permissions, path traversal, absolute paths and invalid semantic
versions.

The host persists explicit grants separately from manifests. A grant can only be
a subset of the permissions declared by the same plugin identifier. Host API
objects expose only granted methods, contain immutable identity and snapshot
values, and never expose editor, DOM, Tauri or filesystem objects. Document edits
carry an expected revision and ordered, non-overlapping source ranges. The API
boundary limits edit count and inserted size; the document host remains
responsible for rechecking the active document, read-only state, current revision
and range bounds before applying one canonical editor transaction.

This ADR defines contracts and authority reduction only. No third-party module is
loaded or executed until an isolated runtime, package authenticity policy,
installation flow and user consent UI are separately designed and reviewed.

## Alternatives considered

- Give plugins a CodeMirror view or Tauri handle: rejected because either exposes
  broad mutable and native authority that cannot be meaningfully permissioned.
- Treat declared permissions as granted: rejected because package authors cannot
  consent on behalf of users.
- Load plugins first and intercept sensitive calls later: rejected because ambient
  DOM and module authority already escapes the intended boundary.
- Design every future permission now: rejected because unused capabilities would
  freeze speculative APIs before their security and product semantics are known.

## Consequences

The first plugin contract is intentionally small and cannot yet run plugins. New
capabilities require manifest-version compatibility, a user-facing grant model,
runtime validation and tests. Plugins must handle absent methods when a user
denies optional authority. Host adapters can evolve independently of editor and
desktop implementation details.

## Review conditions

Review before loading any third-party code, adding network, filesystem, process,
clipboard or UI permissions, changing edit transaction semantics, or accepting a
remote or packaged plugin format.
