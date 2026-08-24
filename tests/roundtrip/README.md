# Round-trip tests

M1 owns byte-level document round trips. The fixture matrix must include UTF-8, UTF-8 BOM, LF, CRLF, a missing final newline, Chinese paths, spaces, emoji and combining characters.

The invariant is strict: opening and saving an unmodified supported file produces identical bytes. Unsupported encodings must open read-only and must never be silently overwritten.
