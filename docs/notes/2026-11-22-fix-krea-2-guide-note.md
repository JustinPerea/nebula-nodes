# Krea 2 guide: read its note as a Markdown admonition

## Decisions

- Krea's Krea 2 guide moved the moodboard note in its Pricing section from a `<Note>` block to Markdown admonition lines (`> [!NOTE]`, a bare `>`, then `> ` before the text). `parse_k2_guide` stopped every refresh of that section with "a line this script doesn't read". It now skips the two marker lines and reads the note's text after `> `, the same way it read the text inside `<Note>`.
- It stays strict. Another admonition kind (`> [!WARNING]`) or an extra line inside the note still stops the refresh, so a change to the section still gets a human re-read.
- The pinned guide entry is refreshed from the live guide (read 2026-11-22). The table and the note state the same prices as the 2026-10-19 pin, so only `fetchedAt` and `sectionSha256` change. No price, quote or node changes.
