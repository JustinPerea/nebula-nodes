# Cinema upload controls implementation notes — 2026-10-07

- Kept the existing Slava Restraint workspace layout and Send to motion behavior. This slice addresses reference feedback, field ownership and generation admission.
- The root-owned coordinator owns file transport and reference completion. Components attach by stable node/shot ID and render upload metadata; they no longer close over a whole scene or shot while a network request is pending.
- Shared controls and shot controls author functional field patches against the latest scene/shot. Reordering applies the requested IDs to current shot objects, retaining newly added shots and current outputs, variations and prompt edits.
- Accepted-reference removal uses the clicked artwork URL rather than a captured array index. Character sheet references remain intact when the last manually attached character image is removed.
- Upload rows show filename, pending/error state and explicit Remove. Failed uploads offer Retry only when a transient file remains available; interrupted reloads use the coordinator's message plus the normal attachment control.
- Selected-shot and variations controls block shared plus selected-shot uploads. Generate all blocks every upload in the scene, while a sibling-only composition upload leaves an independent selected shot available. Click handlers re-read upload status; shared execution entrypoints are guarded separately by the root agent.
- Upload completion, retry, removal, navigation and status changes invoke no generation. Only existing explicit Generate controls call execution.

## Verification

- `npm test -- tests/components/CinemaUploadControls.test.tsx tests/components/CinemaStudioView.edits.test.tsx tests/components/CinemaRunControls.test.tsx`: 20 passed.
- Targeted ESLint on the four changed Cinema components and two new test files: passed.
- Component regressions exercise pending/error scope, recovery actions, latest-status click guards, explicit generation after resolution, current-field edits and retained old callbacks after scene changes/deletion.
- Native geometry and root-owned transport, persistence and execution admission are validated separately; these component tests use synthetic metadata and mocked execution and upload boundaries.
