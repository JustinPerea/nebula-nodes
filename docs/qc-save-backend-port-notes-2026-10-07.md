# QC backend port — October 7, 2026

- Port the existing Design-agent Frame Review truthfulness fix into the isolated release branch. Keep the existing node definition, output ports, engine and shared QC infrastructure unchanged.
- Retain semantic identity/expression score keys for compatibility, but use null for unmeasured scores and verdicts. OpenCV face-box geometry and crop-edge density are separate proxies, with sampled detection coverage; they cannot certify identity, expression or subject correspondence.
- Accept vision semantic scores independently only from valid parsed JSON with finite numeric values in [0, 1]; JSON booleans and numeric strings remain unavailable. Missing face flags remain null, separate from a measured false.
- Source changes are limited to the Frame Review handler, the detect_faces function, and the Frame Review documentation section. Existing local extraction/PNG/engine tests supplement synthetic assessment/annotation regressions. No provider requests or new dependencies.

- Extended the scoped assessment regressions with moving face boxes/changed crop edges (positive proxies still cannot yield semantic verdicts), short or invalid advisory face flags, and an actual encoded/decoded PNG annotation check.

Validation: 54 focused tests passed in 6.96 seconds across `test_frame_review_assessments.py`, `test_video_qc_nodes.py` and `test_qc_infrastructure.py`, using the existing parent Python environment and this branch's backend source. Existing tests exercised real local FFmpeg extraction, valid PNG artifacts and all four QC nodes through the engine registry. Advisory provider interactions remained mocked. `git diff --check` passed. The coordinating-agent full backend gate passed all 2,471 tests; all 254 node contracts and generated-reference parity also passed.
