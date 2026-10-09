# Flora UI/UX map and Nebula improvement plan

**Audit date:** 2026-10-09. **Nebula baseline:** published application tree `cba5bbb1` (255 node definitions), inspected in the isolated `codex/flora-ux-comparison-2026-10-09` worktree. The parallel Design-agent checkout was left untouched.

The strongest transferable pattern is **keeping the next decision beside the work**: select the medium, connect a source, configure the model, inspect the result, then prepare a compatible next step. Nebula already implements much of this machinery. The opportunity is to make it easier to find on the canvas and more consistent across surfaces.

## Evidence and limits

- **Observed Flora:** signed-in Home, Projects, an existing empty canvas, and the Add Node menu through the normal browser. No nodes, account settings, sharing permissions or generations were changed. A toolbar onboarding hint was dismissed.
- **Documented Flora:** official editor documentation and September/October product updates. These establish advertised interaction contracts, not proof of runtime correctness, billing accuracy, collaboration reliability or generated quality.
- **Observed Nebula:** current application code with a private, isolated seven-node/six-edge fixture, synthetic logo outputs and blocked generation/OAuth routes. Selected-node settings, context actions, Create results/comparison and a short-window pinned Inspector were inspected.
- **Source findings:** inspected frontend/backend paths. Upload races, asset double-click behavior and edge placement remain source-derived candidates unless explicitly marked reproduced below.
- No paid generation, account connection, provider check or motion handoff was performed. Private screenshots, workspace identifiers and fixture files are excluded from the repository. This is an interface/workflow audit, not an assessment of either product's proprietary backend.

## Flora's interface map

| Surface | Visible or documented structure | User decision it supports | Evidence |
|---|---|---|---|
| Home | Creation destinations, recent project thumbnails and community media | Resume work or start a creative task | Observed; [September 20 update](https://flora.ai/updates/pipeline-ready-3d-shareable-decks-2026-09-20) |
| Projects | Workspace/Private tabs, search, folders and project cards | Find and organize a board | Observed |
| Global navigation | Search; Create/Generate; Home, Projects, Library, Tools, Techniques, Community and MCP; pinned/recent work | Move between creation, content and tools | Observed; [dashboard update](https://flora.ai/updates/director-1-1-styles-library-tool-first-dashboard-2026-09-11) |
| Canvas chrome | Compact tool rail; Canvas/Agent/Chat modes; project actions; minimap/zoom; queue | Work on the graph while retaining access to tools and execution | Observed |
| Add Node | Search, then Text/Image/Video/Audio/3D/Technique/Import/Export/Note; secondary editing and utility tools | Choose what to make before choosing a model | Observed; [toolbar docs](https://docs.flora.ai/editor/toolbar) |
| Node editor | Medium-specific editing and action controls | Configure the selected piece of work | [Node editor](https://docs.flora.ai/nodes/editor), [canvas](https://docs.flora.ai/editor/canvas) |
| Model picker | Search, provider grouping, pinned models and Auto recommendations | Pick a suitable model without traversing the entire catalog | [Model menu update](https://flora.ai/updates/model-menu-and-full-screen-generation-history) |
| Reference authoring | Compatible `@` source mentions create connections; reusable Elements have names, guidelines and preview versions | Explain what a reference means and connect it | [Mentions update](https://flora.ai/updates/elements-mentions-more), [Elements](https://docs.flora.ai/editor/elements) |
| Review/history | Global history and full-screen review of versions; filters and output actions | Compare and reuse earlier work | [History update](https://flora.ai/updates/model-menu-and-full-screen-generation-history), [dashboard update](https://flora.ai/updates/director-1-1-styles-library-tool-first-dashboard-2026-09-11) |
| Batch | Labeled source items, Zip/Cross modes, input/output highlights and a matrix view | Understand which combination produced a result | [Batch node](https://docs.flora.ai/nodes/batch-node) |
| Techniques | Examples, required inputs, outputs, cost/time information and read-only workflow inspection | Understand a reusable recipe before applying it | [Techniques](https://docs.flora.ai/nodes/techniques) |
| Technique Builder | Define inputs, define outputs, publish with a visibility choice | Package a pipeline for reuse | [Technique Builder](https://docs.flora.ai/nodes/technique-builder) |
| Agent/collaboration | Selection-aware assistant; comments, project sharing and live editing | Discuss or delegate work in context | [FAUNA](https://docs.flora.ai/editor/fauna), [collaboration](https://docs.flora.ai/editor/collaboration-and-sharing) |
| Execution/recovery | Run/cancel controls, clear-output action and specific rejection messages | Stop work or recover without rebuilding the setup | [October 6 update](https://flora.ai/updates/cancel-mid-run-2026-10-06) |

### What the live inspection does not establish

The node editor, reference picker, generation history, Technique internals and execution behavior above were documented, not exercised on a live paid workflow. The available empty canvas was kept unchanged. Native browser input became unreliable during further panel inspection, so failed automation clicks were not interpreted as Flora defects.

The inspected canvas has numerous parallel controls: a tool rail, project tools, three modes, assistant entry points, zoom/help controls and a queue. Its Home also mixes work resumption with promotional/community content. These are useful counterexamples to copying all of Flora's chrome into Nebula. New-project actions appeared disabled in the inspected session; the reason was not established.

## Five journeys compared

### 1. Start and choose a model

**Flora:** medium → node editor → searchable model picker. **Nebula:** task/provider/category search in Library or Create → a model-specific node/draft → provider-readiness guidance.

Nebula's shared discovery and explicit setup were recently improved and should remain. Add a compact first layer such as Image, Video, Audio, Text, Import and Workflow, backed by the existing search. Keep full model browsing one step away. Medium-first organization is a discoverability proposal, not evidence that Nebula lacks search or modality categories.

**Existing foundation:** `NodeLibrary.tsx:193`, `ProviderReadinessBadge.tsx:23`, `model-discovery-setup-2026-10-08.md`.

### 2. Bring in and connect a reference

**Flora:** import or select a compatible source → mention/connect → inspect ordered references. **Nebula:** upload/input node, Character/Moodboard/Paper node or Create reference tray → typed edge/reference-role guidance.

Nebula already has role-bearing references. Make them easier to author through visible source chips with a thumbnail, role, order and **View on canvas**. An optional compatible mention picker can use existing edge validation. A mention must become an inspectable real edge rather than a hidden prompt attachment.

**Existing foundation:** `ReferenceTray.tsx:25`, `PaperSourceNode.tsx:135`, `ModelNode.tsx:385`, `ConnectionPopup.tsx:160`.

### 3. Run and understand the scope

**Flora:** selected work/run controls; documented assistant review of selected nodes and cost. **Nebula:** graph Run/Stop, selection Run, node Run, queue/progress/errors and persistent run history.

Nebula's single-node action runs the target **and its ancestors**. That is explained in the Inspector tooltip, but “Run This Node” does not disclose the scope in its visible label. Add an optional compact scope view beside Run: target, required upstream work, static inputs, authoritative cache status when available and unknown costs. Do not invent prices or add a compulsory approval dialog to every routine run.

**Existing foundation:** `SelectionToolbar.tsx:67`, `ContextMenu.tsx:56`, `backend/main.py:3012`, `RunHistoryPanel.tsx:188`.

### 4. Inspect a result and continue

**Flora:** contextual medium actions and history/review. **Nebula:** canvas preview/settings/selection tools plus richer Create result actions, full screen, comparison, recipe details and Use as input.

Live Nebula inspection confirmed that Create already exposes comparison and Use as input. Canvas selection exposes Ask, Run, Copy, Duplicate, Arrange, Download and Delete; the node settings surface adds parameters and Run/Duplicate/Delete. Bring compatible next-step actions next to a selected canvas result. Reuse the existing drag-to-empty connection picker rather than building a second connection system.

**Existing foundation:** `ResultsGallery.tsx:60`, `ResultDetails.tsx:31`, `ResultCard.tsx:169`, `ConnectionPopup.tsx:160`.

### 5. Save, inspect and reuse a workflow

**Flora:** inspect Technique examples/inputs/outputs/internal graph → add a recipe → connect missing inputs → explicit run. **Nebula:** Styles, saved recipes/history, graph duplication/arrangement and portable `.nebula.zip` bundles containing graph and referenced media.

Start with an inspectable saved-workflow view: purpose, graph outline, required inputs and provider prerequisites. Applying it should add an undoable draft without replacing unrelated nodes or history. First-class grouped pipelines and a project browser are larger product choices; do not silently fold the unapproved Design-agent/Brand Lab work into this initiative.

**Existing foundation:** `PresetLibrary.tsx:14`, `graphFile.ts:635`, `backend/services/project_context.py:1`.

## Concrete Nebula findings

| Finding | Evidence class | Consequence | Next verification/fix |
|---|---|---|---|
| Pinned Inspector covers the compact rail in a short window | **Reproduced** at 800×300. Inspector rectangle `(16,16,300,260)` overlaps navigation; attempting the Assets action reached the overlaid Model control. Closing Inspector restored Assets access. | Navigation is visually obscured and pointer targets conflict. | Reserve rail/drawer space, or choose a different placement/docked mode. Check all drawers, pinned/unpinned state and keyboard access. |
| Inspector content itself clips at 300px height | **Not reproduced.** The rendered shell was 260px high with a scrolling body despite the source's larger placement minimum. | No clipping defect is asserted. | Preserve scrolling; fix the overlap above. |
| Canvas file drops discard cursor placement and lack visible failure/progress | **Source finding:** `Canvas.tsx:482–508`; position explicitly discarded, failed request logged to console. | An import can appear away from its drop point or fail without actionable feedback. | Delay/fail imports in a disposable fixture; add pending/error/retry and stable drop placement. |
| Generic Inspector upload can overwrite newer parameter edits | **Source risk:** `Inspector.tsx:761–800` completes using captured full params; `graphStore.ts:2997` shallow-replaces params. | A delayed completion could replace edits made while the upload was pending. | Delay upload, edit another field/switch selection, then verify completion changes only the original node's intended fields. |
| Asset row double-click editing also reaches click-to-add handlers | **Source candidate:** `AssetsPanel.tsx:192`, `:223`. | An edit gesture may add unwanted nodes; placement also uses fixed coordinates. | Reproduce with a disposable asset. Give Add and Edit separate targets if confirmed. |
| Context/connection menus use raw pointer coordinates | **Source candidate:** `ContextMenu.tsx:82`, `ConnectionPopup.tsx:186`. A tested central menu fit; edge clipping was not established. | Edge placement and keyboard focus need a dedicated acceptance pass. | Open at each viewport corner; verify all actions and focus return. |

## Prioritized implementation sequence

### First: keep canvas controls reachable

Fix the reproduced pinned-Inspector/navigation overlap and verify menu bounds. This is a small usability repair with direct evidence, and should precede adding another floating control.

**Acceptance:** at normal and compact widths/heights, every rail action and Inspector field remains reachable; drawer transitions preserve selection and navigation, and dismissing the drawer reveals the fitted graph; overlaid controls do not hijack pointer clicks; Escape/focus return work; graph data and generation-request counts remain unchanged.

### Next: selected-result actions

Add a compact **Add next step** surface with compatible actions such as Edit image or Use in video. Keep model selection, provider readiness and typed connections visible. The existing Create actions and connection picker are the foundation.

**Acceptance:** keyboard/touch can reach it; adding creates exactly one valid node and edge, positions/focuses the new step, is undoable and preserves the source/history. Preparing a step makes zero generation requests. Unsupported choices explain why.

### Then: consistent canvas intake

Reuse accepted/pending/failed/retry/remove conventions from Create/Cinema for canvas file drops and generic Inspector uploads. Complete uploads against stable node/field identity and current params.

**Acceptance:** delayed/failing uploads show recovery; intervening edits survive; switching selection cannot redirect completion; multiple drops retain intentional placement; import/refresh never triggers generation.

### Then: execution scope and reference disclosure

Show affected work beside Run; add inspectable reference chips/optional compatible mentions. Preserve existing cancellation and uncertain-start recovery semantics.

**Acceptance:** preview makes zero provider calls; actual scope comes from the backend; missing/unsupported references explain the constraint. When the artwork changes, Paper refresh exports a new snapshot and marks earlier results stale while retaining edges/history; unchanged artwork adds no snapshot. Only explicit rerun uses the new snapshot; saved historical runs retain their original sources.

### Later: reusable workflow previews and board organization

Add read-only saved-workflow inspection before applying; assess named sections/frames on a realistic 15–30-node board. Decide project browsing and grouped pipeline semantics separately before implementing them.

**Acceptance:** inspecting/applying never executes; missing inputs/providers are clear; applying preserves unrelated nodes and history, is undoable, and works after reopening. Example outputs are labeled as examples.

## Keep Nebula's strengths

- Local/BYOK provider choice with honest configured-versus-verified status.
- Typed ports and reference roles; compatible downstream connection creation.
- Paper as an editable linked source with immutable run snapshots and explicit reruns.
- Earlier output/history preservation, frozen recipe disclosure and existing comparison tools.
- Portable graph/media bundles and local export.
- The compact rail and current single visual identity. A competitor comparison does not justify restoring alternate themes or expanding the rail.

## Additional capability scouting

Flora's observed Add menu includes a 3D import/view/capture node, and its official September update describes viewer lighting and captures. Current Nebula has Meshy/Hunyuan/World Labs mesh outputs and an interactive `MeshPreview`, but no first-class imported-mesh-to-image capture node in the current definitions. This is logged in `flora-gap-audit.md` as a later capability opportunity; it is not part of the immediate UI work.

## Verification record

This audit changes documentation only. It does not rerun broad implementation tests for unchanged application code. Exact before/after exports of the synthetic seven-node/six-edge graph matched, and instrumentation recorded zero generation, provider-check and motion-handoff requests. Browser evidence is private and synthetic where stated. The existing October discovery, results, history, uploads, onboarding, navigation and compact-rail repairs are treated as the baseline, not reopened as missing features. Packaged Electron remains outside scope.
