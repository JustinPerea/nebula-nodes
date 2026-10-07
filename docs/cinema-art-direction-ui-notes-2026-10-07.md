# Cinema art-direction UI decisions — 2026-10-07

- Camera Rig explicitly describes its Cinema use as prompt guidance; the diagram remains an editable aid rather than a promise of physical camera control or image adherence.
- Reference Set calls its existing serialized `*_weight` fields reference priority. Positive priorities order actual reference images, and zero excludes a connected role from the preview without removing its wire or stored value.
- Cinema Scene uses a custom canvas card, so registry-only port additions would not expose connection handles. The card now renders every declared Cinema input in a separate labeled row, including the previously missing Character handle, while preserving its existing shot output ids.
- Reference Set role handles previously shared the card's positioning context. Each existing role row now establishes a relative positioning context so seven role inputs have distinct physical connection locations.
- Camera and priority cards show the backend's defaults for missing, empty, boolean and non-finite imported values instead of converting them to zero, while retaining the original stored metadata until an explicit edit.
- Character Studio disables unsupported consistency strength, shows why it is unavailable, and retains the stored number. Editing other Character fields continues to preserve reference order and the exact trait string.
- No graph execution, run ownership, Create, Commons, Electron, provider API or autosave lifecycle changes are part of this UI port.

## Validation

Focused regression tests exercise the actual store's parameter persistence and edge deletion transport, preserving earlier Cinema variations and immutable run history without invoking generation. Graph roundtrips validate CameraRig/ReferenceSet port compatibility across file versions 1–3 and retain legacy strength and priority metadata. Character form tests cover disabled strength and preservation through another field edit. Browser geometry acceptance remains separate from these DOM/transport tests.

- **54 tests / 5 files passed:** `ArtDirectionNodes`, `graphFile.artDirection`, existing `graphFile.cinema`, `portCompatibility` and `referenceRoles` suites.
- Application TypeScript (`tsconfig.app.json`, no emit, no incremental cache), touched-file ESLint and `git diff --check` passed.
- These tests use synthetic media URLs and mocked network transport. They prove graph/UI behavior and execution admission boundaries; they do not prove model adherence or a paid provider run.
