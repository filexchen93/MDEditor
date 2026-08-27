# Platform support baseline

The current implementation and manual-package order is **Windows → macOS → Linux**. Windows x64 is the only required package for the personal open-source phase. All three remain CI targets so the source does not become a single-platform architecture.

| Platform | Initial minimum                               | Current role                                                                                                                                                     |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | Windows 10 1809, x64, evergreen WebView2      | Primary development and manual unsigned-package target. Native link requires Visual Studio 2022 Build Tools with Desktop development with C++ and a Windows SDK. |
| macOS    | macOS 10.15 Catalina, Intel and Apple silicon | Source and CI compatibility target; package only on demand and smoke-test it on physical hardware before sharing.                                                |
| Linux    | Ubuntu 22.04 LTS x64 with WebKitGTK 4.1       | Source and CI compatibility target; package-specific validation is required only when a Linux artifact is shared.                                                |

Node.js 24 and Rust 1.98.0 are the M0 CI toolchain. The desktop shell uses system webviews rather than bundling a browser engine. Raising a platform minimum requires an ADR or release note with the blocking dependency and migration impact.

These are project compatibility targets, not a promise of signed installers,
automatic updates, formal support periods or every operating system Tauri itself
can run on. See
[Manual unsigned distribution](MANUAL_DISTRIBUTION.md) for the current sharing
policy.
