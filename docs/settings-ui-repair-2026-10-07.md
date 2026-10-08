# Settings repair acceptance — 2026-10-07

Implemented in the isolated `codex/ui-audit-2026-10-07` worktree.

| Check | Evidence |
| --- | --- |
| Failed, pending or malformed GET cannot submit defaults | Component tests hide fields/Save, persist the error, then explicitly retry loading |
| Old load cannot replace a reopened, edited form | Deferred old/new requests resolve in opposite ownership order |
| Dismiss/unmount retains unsaved fields | Reopened component restores keys, folders, Krea default and telemetry draft; no Storage writes |
| Save failure retains edits and visible recovery | Error survives timer advancement; explicit retry submits the intended draft |
| Pending mutation cannot start another write | Double-click and unmount/reopen keep the form disabled with one PUT |
| Browser removal targets only one provider | DELETE helper sends a provider path and no payload; component preserves another provider's typed edit and unsaved output folder |
| Successful deletion followed by failed GET remains removed | Draft, baseline and readiness clear the key immediately; Retry refresh only performs GET |
| Fresh readiness cannot be overwritten by an old background GET | App deferred-request tests cover newer refreshes, direct panel cache updates, unmount and independent Krea state |
| Existing Krea consent/history semantics remain | Existing mocked Settings/Krea tests and Commons navigation test pass |

51 targeted tests passed. Targeted ESLint and the Slava CSS scope guard passed. The root session runs the final combined test/build gates after Cinema integration.

Unsaved backend-setting drafts are held in memory only. Closing the panel preserves them; page reload clears them. Discard changes restores the loaded baseline. Interface preferences retain their existing immediate behavior. Blank browser key fields leave an existing key configured; the explicit Remove action disconnects it.

Post-write refresh failures block another mutation and expose Retry refresh, so a successful save/deletion is never silently repeated. Error text does not display raw server errors or credential values.

No real keys, OAuth, paid generation, native browser interaction or packaged Electron behavior was tested in this subtask. Root-owned browser evidence and backend tests are recorded separately.
