# Video QC Suite validation contract

This contract finalizes the accepted Factory Video QC proposal after its
orchestrator stopped at the weekly usage limit. It supersedes the draft stored
under Factory mission `a06170a9-b974-43ea-9dc3-82b2bd937afd`.

## Shared contract

- The registry contains exactly four new first-class analyzer nodes:
  `qc-loop-safety`, `qc-frame-review`, `qc-composited-look`, and
  `qc-camera-geometry`. The total registry count is 172.
- Every node is a synchronous `utility` analyzer with a required Video input,
  `mode` enum (`heuristic`, `vision-llm`, `opencv`, `jev`, default
  `heuristic`), an annotated Image output named `frame`, and a JSON Text
  output named `text`. `jev` was added on 2026-10-14 (see "Jev mode" below).
- Heuristic and OpenCV modes execute without provider keys. Vision-LLM mode
  fails clearly when none of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
  `GOOGLE_API_KEY` is configured, as a missing credential
  (`NoVisionProviderError` is a `MissingCredentialError`), before any request.
- Vision-LLM mode is a provider call even though the nodes are `utility`.
  Each definition says so in `providerVia` (`kind: param`, `freeWhen`
  heuristic/opencv), so the canvas badges a missing vision key, agents see
  `runsWithOptions`, and the run estimate lists the node as paid with no list
  price: under any spending limit an agent has to propose it. Any `mode` value
  other than exactly `heuristic` or `opencv` counts as vision-llm there.
- Local files and contained `/api/outputs/` references are accepted. Raw
  `http://` and `https://` inputs, missing files, and output traversal attempts
  are rejected before a subprocess, decoder, or provider call.
- Frame extraction is bounded by sample count and timeout. Temporary frames are
  cleaned after each run. Annotated outputs are valid decodable PNG files under
  `OUTPUT_ROOT` and are returned as `/api/outputs/...` references.
- Vision requests are non-streaming, time-bounded, and provider-specific.
  Inline advisory images are count-, dimension-, and aggregate-size-bounded
  before request construction so multi-frame reviews stay within provider
  request limits.
  Provider output is parsed as JSON when possible and schema-coerced by the
  handler; tests make no live or paid calls.

## Jev mode

`mode: jev` asks TypeSafe Jev one typed question per check (yes/no, pick one,
or a score) instead of asking a vision LLM for JSON. Code:
`backend/services/qc_jev.py` plus a `_jev_checks` list in each handler.

- Needs `TYPESAFE_API_KEY` (BYOK). With no key the node raises a missing
  credential before any frame is cut. `providerVia.byValue.jev` says so, so
  readiness, the canvas badge and agents ask for that key, not a vision key.
- Params shown only in Jev mode: `model` (pinned `jev-1.14.0` by default)
  and `min_confidence` (0.5).
- The local heuristic metrics run first, as in vision-llm mode, and Jev's
  answers overwrite the fields its checks cover. Same ports and report keys;
  the report adds `jev` with each check's question, answer, probabilities,
  confidence and verdict, the overall verdict, the lowest pass probability,
  the model that answered, input tokens, request id and which samples went.
- Each frame is in the request state once (`frame_3`, `first_frame`,
  `reference`); questions refer to it by name. At most 8 frames, downscaled
  to 768 px on the long side, so the images stay under 24k of the 32k-token
  per-question limit on a deliberately high estimate (TypeSafe hasn't
  published image token counts). The report says when frames were left out.
- All checks go in one request, priced per request (up to $0.0027, the 64k
  context ceiling). Long context isn't offered.
- Verdicts: a check is `true`, `false`, `unsure` (confidence below
  `min_confidence`) or `n/a`. The overall `jev.verdict` is `false` if any
  must-pass check fails, else `unsure` if any is unsure, else `true`; `null`
  when no must-pass check applied. Legacy boolean fields fail closed: an
  unsure check is never `true` there (`loop_safe` is `false`,
  `pass_fail_summary` entries and `chroma_key_detected` are `null`).
- Image input is experimental at TypeSafe; `jev.images` says so.

| Node | Check | Question type | Gates | Report fields it sets |
|---|---|---|---|---|
| qc-loop-safety | lighting, content, camera (first vs last frame) | 3 yes/no | all | `loop_safe`, `seam_score` (lowest pass probability), `discontinuity_type` (worst failure, or `unsure`) |
| qc-frame-review | identity | Choice: same / different / no face | yes (`n/a` with no face) | `identity_drift_score` |
| | expression | Score, 4 levels of unexplained change | pass at <= 0.45 | `expression_drift_score` |
| | background | yes/no | yes | `background_stability_score` |
| | face per sent frame (when `track_faces`) | yes/no | no | `face_detected_per_frame` |
| qc-composited-look | edge spill, light match, depth, cutout, chroma key | 5 yes/no | all | the matching scores, `compositing_artifacts` (the artifact type of each failed check), `chroma_key_detected`; `overall_integration_score` is the lowest pass probability |
| qc-camera-geometry | angle | Choice: low / eye-level / high | no | `detected_camera_angle`, `geometry_confidence` |
| | pan, tilt, zoom | 3 Choices | no | `motion_direction` |
| | expected angle (when set) | yes/no | yes | `expected_angle_match` |
| | reference match (when wired) | Score, 4 levels | pass at >= 0.5 | `reference_match_score` |

Kept on the local metrics in Jev mode because they are measurements, not
typed answers: loop `frame_analysis`, frame-review `color_drift_score` and the
OpenCV face proxies, composited `background_consistency_score`, and camera
`motion_estimate` magnitudes, horizon, vanishing points, distortion and
homographies.

## Node behavior

### `qc-loop-safety`

- Compares the loop boundary using first/last-frame pixel difference,
  histogram correlation, and SSIM in heuristic mode; OpenCV mode additionally
  evaluates dense optical-flow magnitude.
- Reports `seam_score`, `loop_safe`, `discontinuity_type`, `frame_analysis`,
  `mode`, `node_id`, and `timestamp`.

### `qc-frame-review`

- Samples the clip at a bounded rate and measures color/background stability.
  OpenCV mode optionally detects face boxes when `track_faces` is true.
- Reports frame count, per-frame face detection, background stability, color
  drift, and a pass/fail summary. A `null` face flag means detection was not
  available for that sample; it does not mean no face was detected.
- `identity_drift_score`, `expression_drift_score`, and the corresponding
  `pass_fail_summary` entries are `null` when unmeasured. Heuristic mode and
  OpenCV mode cannot certify identity or expression consistency.
- OpenCV's separately named `face_geometry_drift_score` and
  `face_edge_drift_score` measure box position/size and crop edge density only.
  They require at least two face observations and otherwise return `null`.
  `face_detection_coverage` records detected/sample counts and fraction, so
  partial coverage is visible. No subject correspondence or identity tracking
  is claimed; the largest detected face supplies each frame's proxy.
- `assessment_provenance` labels each identity/expression/face-proxy check as
  `unavailable`, `proxy`, or `advisory`, with a reason. Vision identity/expression
  scores and threshold verdicts are advisory and require valid parsed JSON
  containing finite numeric scores in [0, 1]. Missing, malformed, boolean,
  nonfinite, and out-of-range scores remain unmeasured independently; they
  never inherit a zero/pass default. Annotated output labels these distinctions.
- The annotated output is a contact sheet with sampled-frame and face overlays.

### `qc-composited-look`

- Measures edge density, luminance/color-temperature consistency, and
  foreground/background integration. OpenCV mode adds Canny, chroma-key, and
  background-consistency signals.
- Reports a bounded artifact list and edge-spill, light-match,
  depth-consistency, cutout-appearance, and overall-integration scores.

### `qc-camera-geometry`

- Accepts an optional local reference Image and optional `expected_angle`.
  Heuristic mode estimates horizon and coarse motion; OpenCV mode adds ORB
  matching, homography/vanishing-point signals, and a straight-line distortion
  proxy. Vision mode compares the clip with the expectation/reference.
- Reports detected angle, horizon, vanishing points, pan/tilt/zoom motion,
  distortion proxy, optional reference match, expected angle, and confidence.

## Integration and gates

- Backend definitions, handler registry, frontend definitions, graph import and
  offline-add mappings agree on all four node IDs. One shared `VideoQcNode`
  component renders the annotated frame and human-readable report summary.
- `docs/MODEL_REFERENCE.md` is regenerated and the tracked Flora gap audit notes
  the four closed friction items.
- Focused QC tests, the complete backend suite, TypeScript compilation,
  generated-reference check, node-contract check, and an adversarial security
  review all pass. Existing definitions and handler behavior remain intact.
