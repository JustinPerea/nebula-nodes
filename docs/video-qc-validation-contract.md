# Video QC Suite validation contract

This contract finalizes the accepted Factory Video QC proposal after its
orchestrator stopped at the weekly usage limit. It supersedes the draft stored
under Factory mission `a06170a9-b974-43ea-9dc3-82b2bd937afd`.

## Shared contract

- The registry contains exactly four new first-class analyzer nodes:
  `qc-loop-safety`, `qc-frame-review`, `qc-composited-look`, and
  `qc-camera-geometry`. The total registry count is 172.
- Every node is a synchronous `utility` analyzer with a required Video input,
  `mode` enum (`heuristic`, `vision-llm`, `opencv`, default `heuristic`), an
  annotated Image output named `frame`, and a JSON Text output named `text`.
- Heuristic and OpenCV modes execute without provider keys. Vision-LLM mode
  fails clearly when none of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
  `GOOGLE_API_KEY` is configured.
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

## Node behavior

### `qc-loop-safety`

- Compares the loop boundary using first/last-frame pixel difference,
  histogram correlation, and SSIM in heuristic mode; OpenCV mode additionally
  evaluates dense optical-flow magnitude.
- Reports `seam_score`, `loop_safe`, `discontinuity_type`, `frame_analysis`,
  `mode`, `node_id`, and `timestamp`.

### `qc-frame-review`

- Samples the clip at a bounded rate and measures color/background stability.
  OpenCV mode optionally detects and tracks faces when `track_faces` is true.
- Reports frame count, per-frame face detection, identity/expression drift,
  background stability, color drift, and a pass/fail summary.
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
