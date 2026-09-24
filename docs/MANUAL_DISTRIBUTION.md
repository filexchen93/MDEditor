# Manual unsigned distribution

This project is licensed under GPL-3.0-only. Builds are created locally and
uploaded manually. Code signing, automatic updates and an automated release
pipeline are intentionally deferred.

Packaging is a delivery checklist, not the active product-development priority.
Unless an installer is immediately needed for testing, complete the Markdown
authoring, workspace and output milestones in the roadmap before spending time on
package polish.

## Current distribution target

- Primary artifact: unsigned Windows x64 installer.
- macOS and Linux: source and CI compatibility targets; package only on demand and
  only when the resulting artifact can be tested on that platform.
- Upload location: the Git hosting service's release/download area rather than the
  repository's ordinary source history.

Unsigned installers can produce SmartScreen or unknown-publisher warnings. Every
download page must state this clearly and link back to the exact source commit.

## One-time packaging work still required

1. Choose the initial public version and keep the root, desktop, Cargo and Tauri
   versions consistent.
2. Enable the selected Windows bundle target in `apps/desktop/src-tauri/tauri.conf.json`.
3. Add application icons and verify displayed product, publisher and version
   metadata.
4. Record the exact output paths produced by `pnpm desktop build` once the first
   successful package has been generated.

## Checklist for every manually shared build

1. Start from a clean, versioned commit and record its commit hash.
2. Install locked dependencies with `pnpm install --frozen-lockfile`.
3. Run `pnpm check` and `pnpm test:e2e`.
4. Run the Rust formatting, Clippy and test gates documented in
   `CONTRIBUTING.md`.
5. Build the installer with `pnpm desktop build`.
6. Install it in a clean or disposable Windows environment and verify:
   - launch and create a new document;
   - open, edit, save and save-as with Chinese paths and content;
   - UTF-8 BOM, LF/CRLF and final-newline preservation;
   - recovery after closing an unsaved draft;
   - HTML export and print/PDF entry;
   - uninstall without deleting user documents.
7. Generate a SHA-256 checksum, for example with
   `Get-FileHash -Algorithm SHA256 <installer>` on Windows.
8. Write short release notes containing the version, commit hash, supported
   platform, important changes, known limitations and unsigned-build warning.
9. Upload the installer, checksum and release notes manually.
10. Download the uploaded artifact once and verify its checksum before sharing the
    link.

## Deferred work

The following are not defects or release blockers in the current phase:

- Windows or macOS code signing and notarization;
- an in-application updater;
- stable/preview update channels;
- automated Git tag builds or publication workflows;
- formal long-term support, rollback or release-train commitments.

Revisit these controls if artifacts are distributed beyond trusted users, manual
builds become frequent, or unsigned-package warnings prevent normal installation.
