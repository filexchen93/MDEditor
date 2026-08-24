# Test fixtures

Fixtures are grouped by the behavior they protect. The `spec` directory contains snapshots of the official CommonMark and GitHub Flavored Markdown examples. Refresh them deliberately with `pnpm fixtures:spec`, review the manifest and example-count diff, then run the complete test suite.

Small encoding and line-ending samples will be added with the M1 document codec. Large performance documents are generated in memory so the repository does not carry multi-megabyte derived files.
