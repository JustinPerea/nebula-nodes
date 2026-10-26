# 2026-10-23 — The desktop sidecar test reads a key's ending with the person's token

Branch `fix/desktop-settings-mask-test`, from main at 84621738.

## What and why

- Claude Prime found one failing desktop test on main: `desktop/tests/sidecar.test.mjs`, "a real backend reads the stdin token: only it unlocks a person-only route". It expected `'***eeee'` for the injected FAL key and got `'***'`.
- The test was stale, not the backend. Since the MCP parity work (Justin's Q55 a, merged 2026-10-21), `GET /api/settings` shows a key's last four characters only to the person's own requests: "Only the app (your person token) gets the endings. Everything else learns which providers are set, and nothing more." The test read settings without the person token, so it got the bare `***` an agent gets.
- The test now reads settings twice: with `X-Nebula-Person` it gets `'***' + the last four`, and with no token it gets a bare `'***'`. So it checks both sides of Q55 a, not just the ending.
- Nothing changes for agents: this is a test only.

## Why it went unnoticed

CI (`.github/workflows/ci.yml`) runs the backend suite, the frontend suite, lint, the build and the contracts, but not `desktop/tests`. Adding a desktop job belongs to the deferred desktop pass (Justin, 2026-10-20: "We can do a desktop focused pass later on"), so I listed it there instead of adding it here.

## Checks

- The whole desktop suite (`node --test --test-concurrency=1 tests/*.test.mjs`, with a temp HOME and provider key variables unset): 378 tests, 369 passed, 0 failed (the rest are skips).
- A surprise: under `env -i` with only PATH, HOME and TMPDIR, the three tests that start a real backend timed out waiting for health, with no output. Started by hand in the same stripped environment, the backend is healthy in 2 s. With the normal environment (HOME still temp), all three pass. So the stripped environment lacks something the sidecar's spawn needs; it isn't a product failure. It's not explored further here.
