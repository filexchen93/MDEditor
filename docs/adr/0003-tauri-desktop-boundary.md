# 0003: Tauri desktop boundary

- Status: Accepted
- Date: 2026-08-23

## Context

MDEditor needs native windows and controlled file access on Windows, macOS and Linux without granting the webview unrestricted operating-system capabilities.

## Decision

Use Tauri 2 as the desktop host. Pure editor, Markdown and session logic stays usable in browsers and Node tests. Native commands expose narrow, typed operations; capabilities are assigned per window and start with no filesystem or network permission.

## Alternatives considered

- Electron: mature and viable, but carries a larger runtime and requires strict sandbox/IPC configuration.
- A browser-only application: cannot provide the required reliable local file protocol on all target platforms.
- Native UI per platform: exceeds the available implementation surface and fragments editor behavior.

## Consequences

Maintainers accept Rust and platform WebView prerequisites. Security boundaries are auditable in capabilities and commands, while most tests remain independent of a native runtime.

## Review conditions

Review if Tauri blocks a required accessibility, file-safety or platform capability, or if the project can no longer maintain Rust safely.
