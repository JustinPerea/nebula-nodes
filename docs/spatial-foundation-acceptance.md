# Spatial foundation acceptance — 2026-09-05

This is an evidence ledger, not a completion declaration. Scope remains the
provider-neutral spatial foundation, legacy compatibility, safe viewers,
backend-authoritative Atlas gating, and generalized paid-operation lifecycle.
No public Atlas adapter or paid demo is part of this acceptance run.

| Requirement | Evidence checked | Status / remaining proof |
|---|---|---|
| Ten versioned spatial port families | `backend/models/spatial.py`, browser types/parsers, contract tests | Implemented and tested; explicit depth interpretation and embedded sensor-rig binding added |
| Five local author/validator nodes | Real isolated canvas runs: Camera Pose, Camera Path, Sensor Rig, Spatial Value Validate, Spatial Context | All executed successfully; context used a local image fixture, not reconstruction |
| Stable author identity under caching | Engine regression runs identical poses twice; live fresh/cached runs preserve n1/n2/n4/n7 and context anchors n7 | Verified after cache-key fix |
| Legacy World v1 compatibility | Canonicalization and browser tests; alias/null/invalid URI regressions, canonical version precedence and null-label rejection | Reviewed and tested; legacy v1 remains v1 on persistence, v2 adaptation is in memory |
| Safe structured viewer registry | Registry and renderer cover all ten types; actual pose/path/rig/context canvas cards inspected; six remaining actual components rendered in isolated fixture page with screenshots | Summary rendering verified. Synthetic fixture links are not asset/decoder proof; v2 remains summary/download only |
| Atlas fail-closed gate | Capability tests cover missing adapter, entitlement, policy, definitions, mismatched hashes and handlers | Focused gate/policy/admission/guard suites: 86 passed; no entitlement or adapter invented |
| Generalized operation lifecycle | Shared policy, start guard, recovery and engine modules; tests include late policy registration and its cache/quick/recovery predicates | Focused 86-test gate/policy/admission/guard suite and full backend suite pass; no paid run used |
| Malformed graph output import | 42 graph-file tests; all ten malformed spatial types retain node, remove output, warn | Automated proof, including separate-origin portable restore |
| Graph persistence | Backend restart restored nine nodes/six edges; real ZIP save/restore retains all nine/six, context pose n7, zero warnings, image HTTP 200 | Archive bytes and restored assets proven. Native file-dialog round trip remains unverified |
| Viewport fit | Three fit tests and live screenshot clear top/bottom controls | Tested in full frontend suite; initial and built-in fits share padding |
| Full regression/build | Final source rerun: 1,973 backend (41.80s), 737 frontend across 81 files; production build/budget, generated docs and diff checks passed | Verified; temporary live archive integration is separate from the 737 count |

## Open acceptance findings

- Depth maps now require scale/offset, invalid sentinel, byte order and distance
  convention in both parsers. Contract semantics are documented; no decoder is
  implemented. Preview cards expose interpretation even in compact mode.
- SensorStream binding is now checked against a required embedded rig snapshot
  in both parsers (ID, sensor membership, modality, frame). This does not attest
  physical calibration or synchronize multiple streams automatically.
- World splat, raster-image and collider MIME roles are now validated on both
  boundaries. Generic octet-stream is deliberately supported. Metadata checks
  do not prove byte-level conformance. New spatial summaries do not decode
  assets; any future interactive decoder must independently validate bytes.
- The in-app browser Save click produced no observable file or confirmation.
  The real archive pipeline subsequently passed with picker I/O captured by an
  integration test. Chrome is unavailable to CUA; native Dia interaction was
  stopped on a user-activity conflict. A quiet native-browser window is still
  needed to verify the actual Save/Load dialogs without interrupting the user.
- Current tests run from a lockfile-matched temporary frontend because the
  repository's iCloud-backed installed dependencies failed test initialization.
  Repository source and lockfile remain the implementation authority.

## Isolated live environment

- Frontend: `http://127.0.0.1:5175/`, source synchronized from this checkout.
- Backend state/output: `/tmp/nebula-spatial-backend.ZuuVFf/`.
- Provider settings point to an absent temporary file. No paid work was started.
- Screenshots were shared in the task during actual canvas operation. The
  original 5173 tab and user graph were not used as the test graph.
