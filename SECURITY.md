# Security policy

## Supported versions

MDEditor has not published a stable release. Security fixes currently target the latest `main` branch.

## Reporting a vulnerability

Please use GitHub's **Security → Report a vulnerability** private reporting flow for this repository. Do not open a public issue for a suspected vulnerability. Include affected versions or commits, reproduction steps, impact, and any suggested mitigation.

Maintainers should acknowledge a complete report within seven days, coordinate validation and remediation privately, and publish a security advisory after a fix is available. If private vulnerability reporting is unavailable, contact a maintainer privately through their verified GitHub profile rather than posting exploit details.

## Security boundaries

- Markdown and all rendered content are untrusted.
- The webview receives no general filesystem or network permission.
- File access must be limited to paths explicitly selected by the user.
- External URLs require protocol allowlisting and must open outside the editor webview.
- Preview sanitization must never alter Markdown source.
- Save failures must preserve the previous document bytes.
