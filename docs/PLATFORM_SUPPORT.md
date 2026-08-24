# Platform support baseline

The first-release implementation order is **Windows → macOS → Linux**. All three remain CI targets from M0 so the order does not become a single-platform architecture.

| Platform | Initial minimum                               | M0 validation                                                                                                                                             |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | Windows 10 1809, x64, evergreen WebView2      | Primary development platform; frontend/E2E pass. Native link requires Visual Studio 2022 Build Tools with Desktop development with C++ and a Windows SDK. |
| macOS    | macOS 10.15 Catalina, Intel and Apple silicon | CI build/test target; periodic physical-device smoke test required before release.                                                                        |
| Linux    | Ubuntu 22.04 LTS x64 with WebKitGTK 4.1       | CI build/test target; package-specific validation will expand before release.                                                                             |

Node.js 24 and Rust 1.98.0 are the M0 CI toolchain. The desktop shell uses system webviews rather than bundling a browser engine. Raising a platform minimum requires an ADR or release note with the blocking dependency and migration impact.

These are project support targets, not statements of every operating system Tauri itself can run on.
