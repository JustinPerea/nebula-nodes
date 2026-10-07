# Commons integration into current main

Commons is selectively composed with main `6f7e7155` (Paper, Krea MCP, Cinema art direction and bounded Batch), using the repaired domain from local readiness commit `5a935731`. It is **off by default**. The dirty Design-agent checkout and its Brand Lab work are not part of this integration.

## Activation and authority

- Only `NEBULA_COMMONS_ENABLED=1` enables the backend. Missing, `0`, `true` and other values stay off. `GET /api/capabilities/commons` reports the flag without opening the library or minting authority.
- Disabled Commons API, CLI, MCP and lazy runtime paths reject before storage access. Disabled startup skips human-token initialization, recovery and linked-folder scans. The UI hides Commons and does not request its authenticated status/store.
- Enabled browser access uses the per-launch backend terminal dev link. The fragment is consumed into browser session storage and removed from the URL. Headless startup requires the existing private stdin bootstrap; there is no network endpoint that mints human authority. A backend restart requires a fresh dev link.
- Claude/Codex turns carry the human token only to the chat backend. Native children receive a fresh, revocable agent capability, bound brand, private working directory and backend-owned conversation ID. The human token is not passed into child arguments, environment, workspace or agent output.
- Enabled Commons refuses Daedalus before launch because its native private-file boundary is unverified. Daedalus remains available with Commons off.
- Existing raw Claude/Codex provider session IDs cannot resume across the isolation change: start a new chat with `/clear`. Earlier workspace files and canvas run history are preserved. This also applies after a backend restart, because conversation bindings are process-local.

**Real library activation is a separate operational step:** preserve a backup, choose a safe restart, use a fresh browser chat, and verify the intended brand scope before reader/evaluation work. No real activation or store migration was performed for this integration.

## Behavior and preservation

Commons adds browser reference intake, search/filtering, local measurements, comments, collections, linked-folder controls, labeling and assisted review. Analysis is explicit and metered. Human corrections remain authoritative; assisted review is not blind ground truth.

The workspace loads lazily. Navigation keeps canvas/chat mounted and inactive while Commons is visible, preserving their instances and history. Returning restores the previous workspace. The current single appearance, rail/dock controls, Create save acknowledgement, graph import/run admission, immutable Batch recipes and Cinema inputs remain composed with current main.

Claude/Codex profiles retain the current backend-owned read-only Krea discovery bridge. Provider knowledge is copied as bounded, immutable trusted text into private workspaces, without broad repo grants or user/global/untracked files. GitHub ZIP checkouts use `backend/data/provider_knowledge_manifest.json`; regenerate it with `python3 scripts/generate-provider-knowledge-manifest.py` after staging added/removed knowledge paths. Existing snapshot files are not overwritten on resume.

The legacy human actor identifier remains unchanged for record compatibility; user-facing labels and guidance refer to the local user. No real-store identity migration is needed.

## Review repairs

- Backend chat rejects competing sends before any terminal validation response; malformed envelopes cannot escape cleanup. Done and cancellation acknowledgements follow generator cleanup and capability revocation. A next turn arriving while the old transport flush finishes waits for that flush.
- Protected file guards cover graph/API/CLI ingress and actual media consumers, including encoded Krea effects, custom Commons roots in Paper exports, and canonical verified Paper snapshot paths. Foreign Host/Origin requests fail before dispatch. Alias and workspace-identity checks preserve private boundaries.
- Database opening preflights supported existing schemas and rejects unknown/malformed versions before writable migration. Historical v1–v4, current WAL and hot-journal fixtures are synthetic. Read-only rejection may create empty SQLite sidecars; this is not a promise of byte-for-byte directory preservation under external concurrent writes.
- Failed comments/folder writes retain drafts. Review generation and acceptance are serialized; stale polls cannot replace newer state. Malformed search filters return 422 before search execution.

## Evidence

Focused regression suites use temporary files/SQLite, fake native runners and mocked provider transports. Installed CLI primary help establishes available flags; it does not prove all native global instruction discovery behavior or paid execution. Existing Codex sandbox probes establish denial of protected hard-link creation; an alias precreated outside that sandbox remains a documented limitation.

No packages, paid model calls, real library reads/writes, real folder scans, reader decisions, real backend restart or packaged Electron work are included. Temporary web previews use empty provider settings, separate state/output/Commons roots, stopped analysis and a zero daily analysis cap. Their fixed test identity has no access to real state.

See the domain, runner and UI integration decision notes for narrower evidence and implementation tradeoffs.

### Final local checks

- Full backend: **3,357 passed**; 12 existing FastAPI startup-event deprecation warnings.
- Full frontend: **1,183 passed in 126 files**; lint, TypeScript and production build/budget passed (306,837 bytes raw / 85,861 gzip entry, 36 eval-free JavaScript assets).
- All **255 node contracts**, provider contract inventory and generated model-reference parity passed.
- Staged content scan: no credential/private-key matches or sensitive files; whitespace check passed.
- Native Chrome on disposable ports **5213/8043** (off) and **5214/8044** (on): off hides Commons, preserves the Paper/Krea/Batch/Cinema catalog and creates no Commons directory; on renders a synthetic PNG, writes/filters/reloads a comment and removes the auth fragment. Back/reload preserves the Paper canvas node; a Commons round trip preserves an unsent chat draft. Analysis remained stopped with **zero calls** and a zero cap.
- Independent focused reviews: **467** Paper/Krea/file checks and **77** current chat/lifecycle checks passed. These are included in aggregate coverage, not additional unique test counts.

Verification logs and fixture state are private local audit artifacts outside Git. No remote CI or publication is claimed by these local checks.
