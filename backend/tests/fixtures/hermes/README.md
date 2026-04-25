# Hermes CLI Fixture Reference

Captured 2026-04-23 from `hermes chat -q "say hi in exactly one word" -Q --provider openrouter --model moonshotai/kimi-k2.6`.

## Canonical stdout format of `hermes chat -q -Q`

```
session_id: <timestamp_id>
<response body>
```

Findings:

1. **Session ID appears on the first line** as `session_id: <id>`.
   - Format: `<YYYYMMDD>_<HHMMSS>_<hex>` (e.g. `20260423_095548_a2985d`)
   - Lowercase `session_id:` prefix, space, then the id
   - **No `--pass-session-id` flag needed** — `-Q` mode emits it automatically
2. **Response body follows on subsequent lines** as plain text (not JSON).
3. **Exit code 0 on success.** Stderr is empty for clean runs.

## Implications for `backend/services/hermes_session.py` parser

Plan Task 2 originally assumed `SESSION_ID: <ulid>` on a trailing line. The real
format is `session_id: <timestamp_id>` on the **leading** line. Parser should:

- Recognize `session_id:` (lowercase) as the marker, not `SESSION_ID:`
- Parse it from the first non-empty line, not any line
- Strip the first-line marker from the response body before emitting as `text`
- Do not pass `--pass-session-id` to the subprocess (superfluous)

Marker lines Daedalus's SKILL.md emits (still upper-case, per our convention,
since those are prints inside the response body, not Hermes's own session line):

- `SESSION_ID:` — NOT used; Hermes already handles this natively as `session_id:`
- `APPROVAL_REQUIRED:`, `PLAN:`, `COST:` — Daedalus emits these inside the
  response body when step-approval mode pauses
- `LEARNING_SAVED:` — Daedalus emits this after `skill_manage patch`
