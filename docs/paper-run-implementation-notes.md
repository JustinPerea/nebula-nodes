# Paper run contract decisions

- Refresh applies a source record to the same canvas node. It never calls an execution API, changes edges, or clears downstream media.
- Execution captures the full JSON request before the backend starts, so a run retains its accepted Paper snapshot even when refresh completes during execution.
- Saved history retains each executed node's immutable output references as well as its source descriptor. Exact historical replay and explicit rerun with the latest Paper snapshot are separate actions.
- Recipe revision is an adapter-owned fingerprint of canonical saved settings and topology; it is not a Paper revision. Freshness compares full canonical recipe content and source identity/hash rather than trusting fingerprint equality.
- A failed/missing source retains the last good snapshot. Record sequence numbers prevent a late source refresh response from replacing a newer one.
- Run requests carry only the accepted snapshot in the source's snapshot list. The complete source history remains on the canvas/backend journal, avoiding quadratic duplication in persisted run records.
- Source execution events and delayed graph sync messages cannot rewind a newer source preview. The live source preview always comes from its highest accepted source sequence.
- If backend-loaded canvas nodes lack frontend attribution, matching their exact retained output references to saved run results restores their source hash and stale label.
- Browser demonstration exposed generic Video-output probing adding `_sourceDuration`, `_sourceFps`, and `_sourceIsVfr` after admission. Recipe equality excludes these three observed output facts so a first successful run remains current; actual recipe parameters and semantic private references remain part of equality.
- Browser rerun exposed compact run source metadata returning through graphSync at an equal source sequence. The frontend preserves its live record for an equal or older sequence, so one accepted snapshot in a run request cannot collapse complete source history or rewind the current preview.
- Latest-source replay reports a refresh/reconnect action when its sources are unavailable or missing instead of returning silently.
- Historical replay sends `preserveGraphParams: true` separately from its frozen recipe. Backend success and Stop finalization skip generic parameter mirroring for those requests, preserving edited live recipe settings. Outputs and provider recovery callbacks still write their authoritative results/checkpoints; ordinary runs retain their existing metadata sync.
