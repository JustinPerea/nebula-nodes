# Settings UI decisions — 2026-10-07

- A failed or pending settings GET keeps the editable form and Save unavailable. Retry is explicit, and closed or superseded loads cannot replace a newer form.
- Provider removal is a separate action scoped to one provider. Blank key inputs keep an existing configured key; the row explains removal. Removal refreshes masked settings and configured readiness without replacing unrelated unsaved fields.
- Unsaved backend-setting edits are retained only in memory, including dock dismissal. They are never persisted to browser storage. Interface preferences already apply immediately and keep that behavior.
- Save and removal errors stay visible until recovery; no timeout erases feedback. A mutation owns its async completion, and in-flight writes block another mutation.
- Existing Krea OAuth actions remain explicit. Refreshing readiness does not generate media or alter saved node parameters/history.
- A successful write followed by a failed readiness GET has a separate Retry refresh path. Editing and another write remain blocked until that read completes; Retry refresh never repeats PUT or DELETE. A known successful deletion is cleared immediately from the draft/baseline/readiness cache.
- Removal reconciles fresh configured keys with the in-memory form: unrelated typed key drafts and non-secret edits survive, while untouched keys and the configured count use the fresh response.
- Added ownership guards to App's initial and settings-saved readiness reads. A separate Krea connection update does not invalidate a keys read, while newer key/mode changes, newer refreshes, or unmounting do.
- The API key input now has an accessible provider label. Show/Hide uses text instead of the previously literal escaped glyph strings, and the input can shrink beside the explicit Remove button.
- Targeted acceptance: 51 tests across Settings, provider-removal API, App readiness ownership and the existing Commons lifecycle test passed; targeted ESLint and the Slava CSS scope guard passed. Whole-project type checking initially encountered the concurrent, incomplete Cinema wiring; root owns the final combined gate. No real credential, OAuth, provider generation, packaged app or native browser claim is made by this subtask.
