# Markdown specification fixtures

Run `pnpm fixtures:spec` to import the pinned CommonMark 0.31.2 examples and GFM 0.29.0.gfm.13 examples. The generated `manifest.json` records source URLs, counts and source-response SHA-256 hashes. GFM examples are extracted from the tagged official `cmark-gfm` specification source because the published GFM site does not expose a JSON fixture endpoint.

These files are an input corpus, not proof of parser conformance by themselves. M1/M2 must execute every supported example against the chosen parser and document any intentionally unsupported extension.
