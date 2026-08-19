# Nebula Nodes UI acceptance evidence — 2026-08-19

These captures came from the normal local stack: Vite at `127.0.0.1:5173`
and FastAPI at `127.0.0.1:8000`, operated through native Chrome. The original
8-node / 5-edge graph was restored after destructive or temporary checks.
Provider-paid generation and account-consuming agent turns were intentionally
not submitted.

| Evidence | Flow proved |
|---|---|
| [01](01-canvas-baseline.png) · [02](02-canvas-auto-layout.png) · [03](03-reload-layout-loss.png) | Baseline graph, auto-layout, original reload-persistence defect |
| [04](04-fixed-layout-before-reload.png) · [05](05-fixed-layout-after-reload.png) | Fixed layout survives browser reload |
| [06](06-spaced-rapid-additions.png) · [07](07-pointer-connection-created.png) · [08](08-inspector-edit.png) · [09](09-run-history-local-node.png) | Accessible insertion, pointer connection, Inspector editing, local execution history |
| [10](10-save-load-schema-failure.png) · [11](11-save-load-restored.png) | Strict saved-bundle failure and backward-compatible media-metadata recovery |
| [12](12-stop-active-local-render.png) · [13](13-stop-cancelled-local-render.png) · [14](14-stop-run-history-cancelled.png) | Active FFmpeg execution, Canvas Stop, truthful cancelled history |
| [15](15-original-graph-restored.png) · [16](16-restored-fit-before-reload.png) · [17](17-restored-after-reload.png) | Original graph restored, fit, and reload persistence |
| [18](18-skin-default.png) · [19](19-skin-hermes.png) · [20](20-skin-slava-wayfinding.png) · [21](21-skin-slava-restraint-restored.png) | All four UI skins and final preferred-skin restoration |
| [22](22-create-canvas-results.png) · [23](23-create-session-empty.png) · [24](24-create-canvas-list.png) · [25](25-create-lightbox-video.png) · [26](26-create-lightbox-image.png) | Create provenance views, grid/list, and image/video lightbox navigation |
| [27](27-assets-characters.png) · [28](28-assets-moodboards.png) · [29](29-assets-styles.png) · [30](30-style-applied-in-create.png) | Asset tabs and style-to-Create handoff |
| [31](31-character-studio-new-validation.png) · [32](32-character-studio-existing.png) · [33](33-moodboard-studio-new-validation.png) · [34](34-moodboard-studio-existing.png) | Character and Moodboard new/existing studio flows |
| [35](35-chat-claude-ready.png) · [36](36-chat-codex-ready.png) · [37](37-chat-daedalus-controls.png) | Claude, Codex, and Daedalus chat shells without sending a turn |
| [38](38-command-palette-full.png) · [39](39-command-palette-search.png) · [40](40-cinema-node-added.png) · [41](41-cinema-studio-shot.png) | Command palette discovery and Cinema Studio local authoring |
| [42](42-remotion-node-added.png) · [43](43-command-palette-spaced-insertions.png) · [44](44-remotion-editor-text-layer.png) | Remotion insertion/editor and collision-free Command Palette placement |
| [45](45-onboarding-welcome.png) · [46](46-onboarding-tour-node-library.png) · [47](47-onboarding-tour-create.png) · [48](48-onboarding-tour-agent.png) · [49](49-onboarding-tour-assets.png) | Complete onboarding walkthrough |
| [50](50-backend-offline-graph-preserved.png) · [51](51-backend-reconnected-graph-preserved.png) | Pre-fix backend restart preserved the graph but exposed no connection truth |
| [52](52-assets-project-scope-working.png) · [53](53-assets-project-moodboards-styles-working.png) · [54](54-project-character-draft.png) · [55](55-project-moodboard-draft.png) | Fixed project-scoped lists and new-draft scope retention |
| [56](56-backend-offline-visible-status.png) · [57](57-backend-recovered-graph-preserved.png) | Fixed visible offline status, automatic recovery, and graph preservation |

Runtime corroboration includes successful project requests with
`projectId=nebula_nodes`, an execution cancellation `DELETE`, an empty cancelled
run directory, and a restored backend graph count of 8 nodes / 5 edges.
