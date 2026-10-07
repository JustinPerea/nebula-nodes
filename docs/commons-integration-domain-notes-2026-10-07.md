# Commons domain integration decisions — 2026-10-07

- Add one strict backend switch: only `NEBULA_COMMONS_ENABLED=1` activates Commons. `commons.activation` has no persistent-state imports; capability reads can use it safely without auth initialization, database access, migrations or workers.
- Keep the API mounted with a router-wide 404 guard so disabled behavior remains explicit and testable. Protect lazy runtime factories independently, before path lookup or singleton allocation, including cached state and task creation. Close a rejected coroutine rather than leaving unscheduled work alive.
- Preserve schema checks, brand scoping, quarantine, human writes and explicit worker start from the reviewed Commons snapshot. Enabled status can allocate a stopped worker; it never starts the loop.
- Compose CLI and MCP additions onto current main instead of replacing full files. Remote clients consult backend activation before reading a local upload or writing fetched pixels; their own environment is not the backend's activation authority.
- An MCP process carrying a Nebula-issued agent token sends it on scoped requests. Local paths from such an agent are delegated to the backend's authenticated `/add` boundary rather than read by the MCP wrapper. External clients upload their own guarded bytes and remain self-reported agents.
- CLI commands bind to the workspace returned by the authenticated backend for a per-turn token. Environment-provided directories do not establish workspace authority.

- Validate asset IDs before building client paths. Raw MCP/CLI IDs previously allowed URL path normalization outside the Commons prefix; the shared segment validator rejects traversal, encoded separators and query/fragment injection while retaining ULIDs and valid legacy identifiers.

Focused validation: **53 tests passed** across `test_commons_activation.py`, `test_commons_clients_activation.py` and `test_commons_agents.py`. These cover strict opt-in, pre-allocation rejection, disabled router/store overrides, unscheduled coroutine disposal, enabled authenticated human writes, stopped worker status, remote preflight, per-turn MCP actor/brand propagation, scoped CLI pixel downloads, and invalid URL segments. The new gates were written against failing tests first.

All tests use temporary roots and mocked providers. No real library or migration was opened. Broad integration tests are coordinated by the root agent after concurrent seams finish.

## Independent integration review

- Main startup and capability discovery enforce inactivity before human-auth initialization, store migration, recovery, or scanning. Scoped HTTP requests restore only a current registry-bound workspace identity.
- Review found that enabled Commons still allowed the legacy unscoped Daedalus runner after a valid human token. Root added a backend Claude/Codex allowlist; the regression now verifies rejection before any runner or workspace allocation while retaining default-off Daedalus behavior.
- Added WebSocket regressions proving cancellation revokes the child capability and releases its workspace before confirmation, and a resumed chat cannot change its bound brand or runner.
- Updated the copied API's fake-runner dispatch tests to use the required current human token and assert the actual protected-storage refusal rather than an older product-name substring.
- Reciprocal runner review found no domain blocker. Adopted case-insensitive Authorization replacement in the MCP wrapper so future internal header additions cannot duplicate or override a scoped per-turn actor.
- **89 tests passed** across activation/client/copied agent/API checks, new WebSocket dispatch regressions and root integration tests after these changes. Warnings are the existing FastAPI startup-event deprecation. All work stayed in temporary synthetic state.

## Current Paper and Krea consumer boundaries

- The reviewed Commons branch predates current-main's Krea gateway and Paper source modules. Read-only disposable probes found three missing consumer boundaries, and the root agent authorized targeted repairs.
- Krea's gateway now checks the final resolved local asset before reading bytes. This matters for nested JSON `effects`: the general graph scan sees encoded text, while the provider later decodes a local URI. Both direct API-token and account-MCP paths consume these guarded assets; upload/model contracts and job behavior stay the same.
- Paper's PNG export validator now composes the general protected-store and workspace guard. Its original absolute-PNG, historical namespace, regular-file, hardlink and size checks remain, with their existing errors, before any PNG open. This covers custom Commons roots and peer workspace namespaces beyond the historical state-root list.
- Paper source storage checks its configured root, SQLite path and snapshot paths before accessing them. `snapshot()` returns the canonical path of the exact artwork whose hash it verified, rather than trusting a persisted `filePath` label. Hashes, immutable exclusive creation, source identity and refresh semantics stay intact.
- Added 13 synthetic regressions in `test_current_consumer_file_access.py`, including encoded Krea media refusal before reads, allowed artwork/own-workspace compatibility, custom Commons/peer Paper export refusal, redirected snapshot metadata returning and serving the verified artwork, and protected snapshot aliases/configured storage refusal. The tests were written against failing behavior first.
- **467 tests passed** across current consumer regressions, all Paper/Krea suites and focused file/provider-boundary suites. Compile and diff checks passed. The first broad pass exposed a historical hardlink error-message ordering regression; moving the additional guard after Paper's existing regular-file/size checks restored that contract while keeping all checks before byte access.
- No provider calls, Paper desktop calls, real stores, package changes, commits or pushes were used for these repairs. Source is frozen for the root agent's final aggregate verification.
