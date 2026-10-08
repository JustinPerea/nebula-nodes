# Settings API repair decisions — 2026-10-07

- A browser provider key is removed through `DELETE /api/settings/api-keys/{provider}`. This explicit action targets one supported credential family, preserves unrelated settings and keys, and returns only a status. Empty and masked values in the existing Settings PUT retain their previous meaning (leave the key unchanged).
- The deletion route uses the existing credential-provider allowlist. Unknown names are rejected before reading or changing settings; injected credentials continue through their existing credential bridge and cannot be deleted through this browser route. Krea MCP OAuth state is separate from the Settings key file and is not touched.
- Browser key-update shape/type validation happens before merging anything, and the merge copies loaded settings. A malformed request cannot partly update keys or mutate a shared loaded dictionary before being rejected. Existing non-secret Settings behavior is retained.
- Validation uses temporary settings files and synthetic values only. No real credentials, OAuth sessions, provider requests, or running application state are accessed.

## Verification

- 108 targeted backend tests passed: the 33 new Settings API cases, provider-key validation tests, node/provider contracts, and the existing browser Settings / injected-key PUT regressions. Existing FastAPI startup deprecation warnings remain unchanged.
- The new tests cover every supported provider, deletion persistence and masked reopening, absent-key idempotence, cache invalidation (including in-flight generation fencing), unknown-provider rejection, injected-mode rejection, unchanged Krea MCP vault/revision, and malformed PUT payloads without partial mutation.
- `git diff --check` passed. Full integrated suites and native UI verification are owned by the root agent.
