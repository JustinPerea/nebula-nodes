# Agent Art-Direction Friction in Flora

> - **Observed:** 2026-08-10
> - **Production:** Mitamaton website hero — Nari at night
> - **Flora project:** `prj_ns7fsjww3geqe4wa1yj7j2vx6h8c79r8`
> - **Purpose:** Convert concrete production failures into requirements for agent-driven creative canvases, especially Nebula Nodes.
> **Scope:** Image reference handling, pose/camera control, scene integration, generation execution, polling, asset lifecycle, canvas visibility, video QC, and loop finishing. This is not a full Flora product review.

## Flora MCP capability map from this production

| Surface | Current production status | Evidence / boundary |
|---|---|---|
| `models.list` | **Dependable discovery** | Returns model IDs, provider, estimated credits/time, capabilities, and parameter schemas. It does not prove the corresponding media inputs are bindable through public generation calls. |
| `generations.create` for text-to-image | **Dependable submit** | Returned a durable run ID, cost, estimate, model, poll URL, and project ID; three Nano Banana Pro runs completed. Raw generation attached an output to the project, but the receipt omitted its canvas node ID. |
| `generations.retrieve` | **Dependable as a short direct read** | Immediate retrieval recovered completed jobs after long MCP calls failed. Holding a Code Tool call open for delayed polling repeatedly returned `502 Bad Gateway` while the underlying generation completed successfully. |
| `techniques.list` / `techniques.retrieve` | **Useful but rough** | Live schemas and costs are inspectable. The SDK/docs expose cursor iteration while direct responses also include a `techniques` wrapper; assuming the wrong shape produced an empty discovery result. Technique descriptions are insufficient to predict output behavior. |
| Technique runs | **Runnable but task-locked** | Reference-conditioned Techniques execute, but their live inputs hardcode a task. The tested camera/character/editorial/campaign Techniques exposed image inputs without a free-text shot-direction input. |
| Assets API | **Capable, multi-stage** | Local ingest requires reserve → external multipart upload → complete → attach → node verification. HTTP `204` proves storage upload only. |
| `projects.listNodes` | **Dependable delivery verification** | Provides sanitized visible media nodes and caught the difference between output URL, asset state, attachment, and actual canvas presence. |
| Generic promptable multi-reference edit | **Unavailable through tested public contracts** | Flora lists i2i/is2i models, but their public generation schemas expose no source-image binding. Saved Techniques accept references but not the custom shot instruction needed here. |
| Typed camera, pose, gaze, and body-performance control | **Unavailable** | No tested public surface independently controlled height, pitch, projection, body orientation, chin, eyeline, shoulders, or arms while preserving identity/wardrobe. |
| Media metadata contract | **Insufficient** | Output URLs typed as `.png` repeatedly downloaded as JPEG bytes; dimensions, MIME, checksum, and landed node ID required separate reads/probes. |
| MCP authentication lifecycle | **Operationally rough** | OAuth expired between successful production calls and returned `401 unauthorized`; no preflight warned of expiry. Reconnecting the Hermes MCP bridge restored authenticated reads before the next submit. |

## Executive summary

The primary friction was not a shortage of image or video models. Flora exposed many relevant models and saved Techniques. The problem was that the agent could not reliably express or execute the art direction as a typed, inspectable operation.

The clearest example is camera/pose control:

- Flora's live model catalog exposes `i2i-qwen-image-edit-2511-angles` with numeric `horizontal_angle`, `vertical_angle`, `zoom`, and `lora_scale` parameters.
- The public one-off generation contract exposes `prompt` plus `params`, but the model schema does **not** expose the required source-image binding.
- A direct one-off image edit therefore cannot be assembled from the public contract, even though the model is listed.
- The fallback was a `Comp Card` Technique that generated a 4×4 grid and contact sheet. The desired view then had to be found manually, cropped, background-extracted, and recomposited.

That workaround produced a technically stable video but a weak photograph. Nari read as a cutout placed over a landscape because identity, pose, wardrobe, environment, camera geometry, and relighting never passed through one integrated generation. Technical QC caught alpha and temporal drift, but not the higher-level failure: **the subject and scene did not share one lens, one light field, or one atmospheric volume.**

For Nebula, the highest-value improvements are therefore:

1. Typed, ordered multi-reference roles rather than an undifferentiated image array.
2. A first-class single-view camera/pose/gaze edit node with a real image input port.
3. Agent-runnable graphs with preflight validation and no UI-only Run step.
4. Automatic run-to-output-node provenance and deterministic canvas attachment.
5. Visual QC nodes for identity drift, scene integration, perspective, relighting, alpha halos, and loop seams.

## Severity scale

| Priority | Meaning |
|---|---|
| **P0** | Blocks an autonomous agent from completing or truthfully verifying the art direction. |
| **P1** | Forces expensive manual workaround, weakens quality, or makes failures hard to diagnose. |
| **P2** | Adds avoidable latency, payload volume, or operator confusion. |

---

## 1. Art-direction primitives

### F-01 — Listed angle-edit capability is not executable through the one-off agent contract

- **Priority:** P0
- **Observed behavior:** Flora lists `i2i-qwen-image-edit-2511-angles` with numeric controls:
  - `horizontal_angle`: 0–360
  - `vertical_angle`: -30–90
  - `zoom`: 0–10
  - `lora_scale`: 0–4
  - `seed`
- **Missing contract:** The model schema does not expose a source-image parameter. `client.generations.create(...)` accepts `prompt`, `model`, and opaque `params`, but there is no typed media input in that request.
- **Consequence:** The agent could discover that the model existed but could not bind Nari's image to it and execute a single-angle edit.
- **Workaround used:** Generate many views with the `Comp Card` Technique (`tech_ts7b9tj1afvgre78zn07af83218a2v3s`, run `run_s57bb5d36r77753m3mshehrkq18c6kw9`), manually inspect cells, crop one, extract it, and composite it.
- **Nebula requirement:** A first-class `Camera / Angle Edit` node with:
  - required `Image` input port
  - horizontal orbit, vertical camera angle, zoom/distance, and strength controls
  - optional face/identity lock input
  - previewable numeric camera diagram
  - output metadata containing the requested and landed camera values

### F-02 — No dependable single-view head-pose and gaze editor

- **Priority:** P0
- **Observed behavior:** No saved Technique provided a reliable operation equivalent to “raise only the chin by 15°, move the gaze 20° upward, preserve face, body, wardrobe, crop, environment, and light.”
- **Consequence:** A local rotation of a profile cutout looked leaned or pasted rather than anatomically skyward. Generative alternatives changed identity or expression.
- **Workaround used:** Multi-angle generation followed by cell selection and compositing.
- **Nebula requirement:** Separate controls for:
  - camera orbit
  - head yaw/pitch/roll
  - eye gaze vector
  - expression intensity
  - body pose

  Each control should declare which regions may change and which identity/wardrobe/background regions are locked.

### F-03 — Reference images have no explicit semantic roles in the generic generation contract

- **Priority:** P0
- **Observed behavior:** Production needed distinct references for:
  1. identity
  2. frontal face geometry
  3. profile geometry
  4. wardrobe
  5. composition/camera
  6. environment
  7. color/light
- **Flora behavior:** Saved Techniques sometimes define roles, but one-off multi-reference models do not expose those image bindings through the public generation schema. Where arrays are available, role, order, and weight are not first-class inspectable concepts.
- **Consequence:** A wardrobe sheet could overwrite facial identity; a scene reference could become the subject; the model could average incompatible references.
- **Workaround used:** Technique-specific inputs, repeated prose, multiple sequential generations, and manual reference ordering.
- **Nebula requirement:** Typed repeatable reference ports:
  - `Identity`
  - `Wardrobe`
  - `Pose`
  - `Composition`
  - `Environment`
  - `Lighting / Color`
  - `Prop`

  Each reference needs strength, crop policy, region scope, and a visible order-of-precedence contract.

### F-04 — Identity, pose, wardrobe, environment, and lighting are coupled

- **Priority:** P0
- **Observed behavior:** Changing one attribute frequently changed several others. Pose edits changed facial structure or expression; wardrobe transfer softened identity; background changes altered photographic register; camera-angle variation changed hair and body proportions.
- **Consequence:** Exact art direction became a chain of lossy transformations instead of one controlled scene synthesis.
- **Workaround used:** Preserve canonical images separately, select the least-damaged intermediate, then manually assemble the final plate.
- **Nebula requirement:** Region- and role-scoped edit nodes with explicit preservation constraints and before/after similarity reports for locked regions.

### F-05 — Saved Technique names/descriptions did not reliably predict landed behavior

- **Priority:** P1
- **Evidence:**
  - `Outfit to Campaign` (`tech_ts7dmhm29gf0j8ckat6gfths3984vccj`, run `run_s57d57a4sfctb9p4kjg15avp4x8c69g0`) produced fashion/portrait studies rather than the requested coherent telescope interaction.
  - `Editorial Fashion Shoot Replicator` (`tech_ts70tvv5e3kxzx4tj9ddpdtndh8ax1hx`, run `run_s5718frca6z0hne78wvrv3e0r18c6n02`) produced an unrelated indoor coffee scene in one attempt.
  - A second `Editorial Fashion Shoot Replicator` test (`run_s578mcam1r24a4hvagc3w7bpbn8c6xxa`) received the user's exact Fixa low-angle shot plus Nari's approved profile-in-sweater image and returned a conventional seated greenhouse portrait. It preserved neither the reference camera geometry nor the wardrobe.
  - `Cinematic Movie Stills` (`tech_ts70x23v7abvt2ssx2kkysbzed835bpb`, run `run_s571pese7jtb5h42kxwvhsdh018c7z4c`) produced useful components but not a complete approved hero frame.
- **Consequence:** The agent could not infer fidelity, model composition, or failure modes from the Technique surface.
- **Nebula requirement:** Every reusable graph/preset should expose:
  - internal node graph or a readable execution manifest
  - model IDs and versions
  - prompt templates
  - parameter values
  - reference-role mapping
  - expected output count/types
  - known limitations
  - sample landed outputs, not only a marketing description

### F-06 — Exact camera geometry is prose-only or hidden inside model behavior

- **Priority:** P0
- **Observed behavior:** The desired Fixa grammar required a camera almost on the ground, approximately 18–22mm, pitched steeply upward, with near-field hand/sleeve exaggeration and a face near optical center. The prior result only preserved “sky dominant” and “low camera” as loose style cues.
- **Consequence:** The output became a conventional side portrait over a landscape instead of a dynamic low-angle photograph.
- **Nebula requirement:** A `Camera Rig` utility output that can feed compatible image/video nodes:
  - camera height
  - pitch/yaw/roll
  - focal length or horizontal FOV
  - subject distance
  - focus distance
  - lens distortion amount
  - subject screen position
  - safe copy area

  The UI should show a simple top/side diagram and serialize values for the agent.

### F-07 — Extraction and compositing are not scene integration

- **Priority:** P0
- **Observed behavior:** Nari was extracted with transparency, placed over a separately generated night landscape, and locally graded. The first version had a feathered lower edge that made her appear to dissolve into the grass. The later opaque crop fixed the fade but still read as “put in there with Photoshop.”
- **Why it failed:** Subject and world did not share:
  - perspective projection
  - source direction and falloff
  - atmospheric depth
  - edge contamination from the sky
  - contact/occlusion cues
  - lens softness and grain
  - depth-of-field behavior
- **Consequence:** Technical edge cleanup improved the cutout but could not create a unified photograph.
- **Nebula requirement:** A scene-integration or harmonization node that regenerates/relights the whole frame jointly, plus a QC node that measures edge halos, light-direction mismatch, perspective mismatch, grain mismatch, and missing contact cues.

### F-08 — No explicit relighting contract tied to an environment reference

- **Priority:** P1
- **Observed behavior:** Flora has a `Relighting` Technique, but it accepts only one image and exposes no light direction, source size, color temperature, environment map, or preservation controls.
- **Consequence:** An agent cannot say “use this night environment as the illumination field while preserving identity and wardrobe.”
- **Nebula requirement:** Typed relighting inputs: base image, environment/light reference, mask/subject scope, key direction, softness, temperature, exposure, rim strength, shadow reconstruction, and grain/grade matching.

### F-09 — No generic promptable image-edit Technique available to the agent

- **Priority:** P0
- **Observed behavior:** The Technique catalog included narrow edits such as Object Remover, Virtual Try-On, solid background, relighting, and color transfer. It did not expose a general `Image + instruction → edited image` Technique with identity-preservation controls.
- **Consequence:** The agent could not perform a direct edit such as “keep this exact person and sweater, move the camera to ground level, remove the phone, replace daylight with a natural night sky, and re-render shared moonlight.”
- **Nebula requirement:** First-class promptable image-edit nodes with one or more image inputs, mask support, input-fidelity controls, semantic reference roles, and deterministic output attachment.

---

## 2. Agent execution and API friction

### F-10 — Model capability and public execution capability are different catalogs

- **Priority:** P0
- **Observed behavior:** Models such as image-to-image and images-to-image appear in `client.models.list`, but required media bindings are not represented in the generation parameter schema.
- **Consequence:** “Available” did not mean “agent-runnable.”
- **Nebula requirement:** A node is not considered available unless its complete executable contract is present: all typed inputs, params, validation, execution handler, output schema, and at least one contract test.

### F-11 — Agent-authored canvas workflows cannot always be triggered through the public API

- **Priority:** P0
- **Observed behavior:** Flora's canvas API can author certain generation graphs, but the public API could not trigger arbitrary canvas workflows. Execution required either a saved Technique or the UI Run control.
- **Consequence:** An autonomous agent could build the correct graph and still be unable to complete it.
- **Nebula requirement:** Any valid graph or selected upstream subgraph must be runnable by the same agent API that created it. UI and agent execution must call the same backend primitive.

### F-12 — Live schema retrieval is mandatory because stored assumptions drift

- **Priority:** P1
- **Observed behavior:** A video Technique call initially failed because expected input IDs differed from its current live schema. The run had to be rebuilt after `client.techniques.retrieve(...)`.
- **Consequence:** Hard-coded input IDs break paid workflows.
- **Nebula requirement:**
  - schema version/hash on every node and saved graph
  - preflight that resolves migrations before charging
  - structured `expected vs received` errors
  - generated typed client contracts

### F-13 — Similar list endpoints have inconsistent argument behavior

- **Priority:** P2
- **Observed behavior:**
  - `client.techniques.list({ limit: 200 })` returned `400 invalid_json`.
  - `client.techniques.list()` worked.
  - Other list APIs require filters such as `workspace_id`.
  - `projects.listNodes(project_id)` rejected an unnecessary options object in another tested path.
  - `projects.assets.attachAsset(project_id, { asset_id })` constructed an invalid `/projects/undefined/...` path. The live signature is the inverse shape: `attachAsset(asset_id, { projectId })`.
  - `projects.assets.listProjectAssets(...)` and `projects.canvas.listNodes(...)` were absent from the live SDK. Current readback uses `assets.list({ project_id: ... })` and `projects.listNodes(project_id)`.
- **Consequence:** Agents waste calls discovering method-specific quirks that should be encoded in one consistent SDK contract.
- **Nebula requirement:** Uniform list/pagination signatures and client-side validation before network calls.

### F-14 — Asset upload is a multi-stage critical path

- **Priority:** P1
- **Observed behavior:** A local file required:
  1. `assets.create({ source: 'signed-url', ... })`
  2. local multipart `curl` to storage
  3. recognize HTTP `204` as success
  4. `assets.complete(asset_id)`
  5. `projects.assets.attachAsset(...)`
  6. canvas-node verification
- **Consequence:** Six opportunities for partial success. A successfully uploaded file can still be absent from the project.
- **Nebula requirement:** One resumable `ingest local file` operation that returns only after the output is indexed and visible, while retaining low-level stages in provenance.

### F-15 — Upload completion, run completion, project attachment, and visible canvas presence are separate states

- **Priority:** P0
- **Observed behavior:** The initial motion run reached 68%, but no playable video was visible to the user in Flora. A completed output URL did not prove there was a video node on the intended canvas.
- **Consequence:** An agent can truthfully report “run completed” while falsely implying “deliverable exists in the project.”
- **Nebula requirement:** A generation succeeds only when an output node is transactionally created on the requested graph. Return `run_id`, `output_id`, `node_id`, local path, media metadata, and provenance together.

### F-16 — Polling was unreliable and expensive in agent turns

- **Priority:** P0
- **Observed behavior:** Technique retrieval repeatedly encountered intermittent `502 Bad Gateway`, gateway/tool failures, and duplicate-output placeholders. Long waits inside one execute call were less reliable than short immediate polls. On 2026-08-10, both a bounded 15-second loop and a single 45-second delayed retrieval returned `502`, while direct follow-up retrieval showed that the underlying image generations had completed normally.
- **Consequence:** Many calls were consumed without new state; tool limits were reached before delivery.
- **Nebula requirement:** Internal job manager with WebSocket/SSE events, durable run state, exponential backoff, and exactly-once completion notification. The agent should subscribe once, not manually poll dozens of times.

### F-17 — Callback support exists but is not usable from an ephemeral agent tool sandbox

- **Priority:** P1
- **Observed behavior:** Technique runs support `callback_url`, but the MCP execution sandbox did not provide a durable callback receiver that re-enters the agent task.
- **Consequence:** The documented asynchronous path still collapses into polling.
- **Nebula requirement:** Callbacks should terminate in Nebula's own durable event store and wake the agent/session or update the graph directly.

### F-18 — Duplicate tool output obscured whether state had changed

- **Priority:** P1
- **Observed behavior:** Several retrievals returned duplicate-output placeholders rather than a fresh structured response.
- **Consequence:** The agent could not distinguish a replay from a new poll result without retrying.
- **Nebula requirement:** Every run event needs monotonic sequence number, `updated_at`, state version, and an idempotency key. Replayed events should be explicitly labeled as replayed.

### F-19 — Technique discovery returns large, weakly filterable payloads

- **Priority:** P2
- **Observed behavior:** Finding an appropriate Technique required listing a large catalog and filtering client-side by names/descriptions. Model searches likewise produced large payloads.
- **Consequence:** Context and tool budgets are spent on catalog noise.
- **Nebula requirement:** Server-side search/filter by capability, input/output type, provider, model, cost, aspect, duration, and agent-runnable status. Return compact summaries first, full schema on demand.

### F-20 — Technique internals and provenance are opaque

- **Priority:** P1
- **Observed behavior:** `techniques.retrieve` returned name, description, cost, inputs, and outputs, but not the internal models, prompts, graph, parameter defaults, or version history needed to diagnose a bad result.
- **Consequence:** When “Editorial Fashion Shoot Replicator” returned an unrelated scene, the agent could not identify which internal node or prompt failed.
- **Nebula requirement:** Saved graph internals remain inspectable; if a preset is intentionally sealed, expose a signed execution manifest and exact version.

### F-21 — Output metadata is insufficient for acceptance without downloading

- **Priority:** P1
- **Observed behavior:** Run outputs were primarily typed URLs. Duration, frame rate, dimensions, codec, audio state, first/last-frame hashes, and landed seed were not reliably included in one result object.
- **Consequence:** Every candidate needed a local download and external probe before basic validation.
- **Nebula requirement:** Extract and persist full media metadata immediately; show it on the node and return it to the agent.

---

## 3. Generation fidelity and video finishing

### F-22 — Requested duration was not honored

- **Priority:** P1
- **Evidence:** The skyward motion prompt requested approximately seven seconds. The completed raw output from `run_s57eba5j2cp7mcrq3sfawr40dd8c7rb0` was **15.06 seconds at 24fps**.
- **Consequence:** Longer temporal exposure increased identity, hair, and knit drift and changed the required loop edit.
- **Nebula requirement:** Validate provider-supported duration values before run; report `requested_duration`, `submitted_duration`, and `landed_duration` separately; flag mismatch automatically.

### F-23 — Micro-motion accumulates identity and material drift over long holds

- **Priority:** P0
- **Observed behavior:** In the 15-second raw clip, Nari's face geometry shifted, hair and knit crawled, and a mild smile emerged. The environment stayed locked while the subject slowly changed.
- **Consequence:** “Locked camera” was satisfied structurally, but character continuity failed.
- **Workaround used:** Keep only the stable opening two seconds, reverse it, and add still holds.
- **Nebula requirement:** Temporal identity and material-consistency analyzer using sampled face embeddings, landmarks, garment texture, silhouette, and expression deltas.

### F-24 — Video generation is not loop-safe

- **Priority:** P1
- **Observed behavior:** The generated last frame did not match the opening frame despite a restrained loop brief.
- **Consequence:** A separate local edit was required.
- **Workaround used:** Forward/reverse construction with opening and apex holds.
- **Nebula requirement:**
  - first/last-frame hash and perceptual seam score
  - optical-flow seam preview
  - trim-to-best-seam
  - boomerang with dwell controls
  - optional first/last-frame constrained generation

### F-25 — Structural constraints landed better than fine behavioral constraints

- **Priority:** P1
- **Observed behavior:** Camera, stars, horizon, and landscape remained stable. Fine constraints such as exactly one blink, no emergent smile, and perfectly stable sweater fibers were less reliable.
- **Consequence:** Prompt budget spent on cadence and microscopic behavior did not guarantee those details.
- **Nebula requirement:** Separate what a provider reliably controls from what must be solved in post. Presets should declare constraint reliability by model, based on observed runs.

### F-26 — No automated first/middle/last-frame or drift review

- **Priority:** P0
- **Observed behavior:** Acceptance required downloading the MP4, probing with ffprobe, extracting contact sheets with ffmpeg, and running an external visual/video review.
- **Consequence:** The canvas could show a playable clip without surfacing slow identity drift or a bad seam.
- **Nebula requirement:** A `Video QC` node producing:
  - first/middle/last frame grid
  - per-second face crops
  - identity drift graph
  - camera-motion estimate
  - background stability score
  - expression drift
  - loop-seam score
  - audio presence and loudness
  - pass/fail gates supplied by the agent

---

## 4. Review and acceptance failures

### F-27 — Technical QC did not test scene integration

- **Priority:** P0
- **Observed behavior:** The final short loop passed checks for stable identity, fixed background, opaque silhouette, and a matching loop boundary. The user still correctly rejected it because Nari looked composited into the environment.
- **Root cause:** The acceptance rubric tested local defects but not the photograph as a unified optical event.
- **Nebula requirement:** An `Integrated Scene QC` node/rubric checking:
  - shared perspective and horizon
  - subject scale relative to lens
  - light direction, softness, temperature, and exposure match
  - edge spill/contamination
  - atmospheric occlusion
  - contact shadows and intersection
  - grain/sharpening/chromatic-aberration match
  - depth-of-field consistency
  - whether the subject reads as a cutout at thumbnail size

### F-28 — “Low angle” was underspecified and under-verified

- **Priority:** P0
- **Observed behavior:** The selected frame was low relative to the horizon but remained a conventional side/rear portrait. It did not reproduce the reference's ground-level, steep upward, ultra-wide perspective or near-field limb exaggeration.
- **Consequence:** The frame met a verbal label while missing the compositional mechanism that made the reference dynamic.
- **Nebula requirement:** Shot specs and QC should store measurable camera geometry, not adjectives. Reference analysis should emit a reusable camera/blocking object.

### F-29 — Approval state lacked explicit dimensions

- **Priority:** P1
- **Observed behavior:** A plate could be “approved” for opacity and copy space but later fail camera dynamism or integration.
- **Consequence:** One approval label hid which dimensions had actually passed.
- **Nebula requirement:** Multi-axis acceptance state per asset:
  - identity
  - wardrobe
  - pose/performance
  - composition
  - camera geometry
  - lighting/integration
  - environment
  - product proof
  - temporal stability
  - loopability

  Each axis records reviewer, evidence, status, and rejection reason.

### F-30 — Agent self-review needs explicit user-taste gates

- **Priority:** P1
- **Observed behavior:** The agent's internal review accepted a restrained frame that the user immediately read as pasted together and insufficiently dynamic.
- **Consequence:** Technical correctness was mistaken for creative approval.
- **Nebula requirement:** Before expensive video generation, require an explicit still-selection gate for taste-loaded axes. Keep “technically viable” separate from “creative keeper.”

---

## 5. Asset and file handling friction

### F-31 — Hosted file extensions may not match actual bytes

- **Priority:** P2
- **Observed behavior:** Some `media.flora.ai/...png` URLs downloaded as JPEG bytes. All five Flora-only rear-sky T2I outputs (`v10`–`v14`) repeated this mismatch at `2752×1536`.
- **Consequence:** Downstream tools can mis-handle files unless content is probed and renamed.
- **Nebula requirement:** Content-addressed local storage with MIME sniffing, canonical extension, checksum, and provenance.

### F-32 — Canonical identity, wardrobe, intermediate, and final assets are easy to mix

- **Priority:** P1
- **Observed behavior:** Nari's identity lock, profile geometry, campaign wardrobe sheet, generated pose study, extraction, opening frame, raw video, and edited loop all existed as separate assets and nodes.
- **Consequence:** A downstream run could accidentally use a wardrobe image as the face authority or an obsolete plate as the opening frame.
- **Nebula requirement:** Asset roles and lineage:
  - canonical identity lock
  - working character sheet
  - wardrobe-only reference
  - composition-only reference
  - environment-only reference
  - intermediate
  - approved keeper
  - superseded/rejected

  Nodes should warn when a lower-authority or superseded asset is connected to an identity port.

### F-33 — Camera geometry can transfer without the action that justified it

- **Priority:** P0
- **Observed behavior:** The Fixa camera reference used an extreme near-field arm as part of a phone/self-camera action. The generated night frame copied the enlarged foreground sleeve but removed the original phone and action context. The result read as if Nari were holding or reaching toward the camera, even though the intended camera was an independent ground-level observer.
- **Consequence:** Lens geometry technically matched while blocking motivation and camera ownership became wrong. Conventional pose, identity, edge, and integration checks did not detect the narrative contradiction.
- **Workaround:** Reject the frame and respecify camera ownership, limb exclusion, and eyeline independently: camera 3–5 cm above ground, 78–82° upward pitch, no hand or forearm in the near field, arms relaxed outside frame, gaze nearly vertical into the sky.
- **Follow-up evidence:** Two GPT Image 1.5 passes (`v4` and `v5`) removed the camera-reaching limb and raised the gaze, but both backed the camera away into a conventional low-angle portrait. The constraints remained coupled despite explicit authority rules.
- **Landed workaround:** Nebula's existing `nano-banana-fal-edit` node preserved the ground-level master geometry while removing the arm, raising the eyeline, thinning the stars, and restoring the left copy field. The approved candidate is `asset_jd74wdq68enf5p6vba964xz1018c75jy`.
- **Nebula requirement:**
  - per-reference region include/exclude masks
  - typed `camera_geometry` separate from `gesture/action`
  - explicit `camera_owner`: observer / tripod / handheld-by-subject / POV
  - limb-vector and lens-contact QA
  - eyeline target plus pitch controls
  - blocking-intent review that asks why every foreground limb is there

### F-34 — Reference conditioning and free-form shot direction are split across surfaces

- **Priority:** P0
- **Observed behavior:** `t2i-gemini-3-pro` accepted the full custom shot brief but no identity/wardrobe images. `i2i-gemini-3-pro` and `is2i-gemini-3-pro` appeared in the model catalog, but their public generation parameter schemas exposed no source-image field. The live schemas for Multi Angle Shoot, Character Lock, Editorial Fashion Shoot Replicator, Outfit to Campaign, and Cinematic Movie Stills accepted reference images but exposed no text input for camera pitch, no-ground composition, or emotional performance.
- **Consequence:** The agent had to choose between prompt authority and canonical-reference authority instead of combining them in one executable contract.
- **Nebula requirement:** One promptable image-edit surface with ordered typed reference inputs, explicit role/weight/preserve policy, masks, complete provider binding, and a preflight contract test.

### F-35 — Body performance is prompt prose, not a controllable object

- **Priority:** P0
- **Observed behavior:** The same rear-sky brief needed private awe carried by head release, expanded upper back, dropped shoulders, and arms unrelated to the lens. `v10` became a conventional full-body walk, `v11` pushed both sleeves into the near field, and `v12` finally removed the arms through a tighter crop. No public surface exposed shoulder openness/asymmetry, spine extension, head release, arm vector, hand state, weight shift, or performance intensity.
- **Consequence:** Camera ownership and emotion changed accidentally as the model solved framing constraints. A visually integrated image could still communicate the wrong action.
- **Nebula requirement:** A typed `Body Performance` / blocking object with pose landmarks, head and torso rotations, weight-bearing foot, shoulder state, elbow/hand vectors, gesture intent, emotional intensity, and camera-ownership validation.

### F-36 — OAuth expiry can interrupt an otherwise healthy production session

- **Priority:** P1
- **Observed behavior:** After successful catalog reads and two charged generations, the next generation returned `401 unauthorized` because the Flora MCP OAuth session was missing or expired. The failure happened before submission and did not charge. `hermes mcp test flora` reconnected the bridge; an authenticated `models.list` preflight then succeeded before retrying.
- **Consequence:** A long agent production can stop between adjacent calls with no advance warning or machine-actionable continuation receipt.
- **Nebula requirement:** Authentication readiness and expiry should be visible per provider, refreshed before paid submission, and returned as a structured reconnect action rather than a generic run failure.

### F-37 — Successful generation receipts omit the landed canvas node

- **Priority:** P1
- **Observed behavior:** Flora T2I submission returned `run_id`, model, estimate, cost, poll URL, and project ID. Completion returned an output URL. Verifying delivery still required a separate `projects.listNodes` scan by URL. Rear-sky `v12` was ultimately verified as image node `b960ba82-77c1-47f2-836c-f4f3759b392e`.
- **Consequence:** A completed generation can be real and attached, yet the agent cannot prove or address the landed graph object from the completion receipt alone.
- **Nebula requirement:** The terminal success object must include output artifact ID, durable URL/path, media metadata, graph/project ID, and node ID transactionally.

### F-38 — Reusing a seed is not a selective edit or preservation contract

- **Priority:** P0
- **Observed behavior:** `v12`, `v13`, and `v14` used `t2i-gemini-3-pro` with the same seed (`880091`). The user requested only a richer sky and darker exposure on Nari. `v13` landed those two changes but lengthened Nari's locked shoulder-length lob to the upper back and revealed more profile. `v14` tightened the hair/rear-view prose but retreated from the worm's-eye camera, flattened the emotional head release, and shifted the dusty-rose sweater nearly black.
- **Consequence:** A narrow revision becomes a full resynthesis. The agent cannot preserve an approved camera, body performance, identity silhouette, and wardrobe while changing only environment richness and subject exposure.
- **Nebula requirement:** First-class selective edit scopes (`environment`, `subject exposure`, `identity`, `wardrobe`, `camera`, `pose`) with masks/region binding, change-only vs preserve locks, input/output diff preview, and automatic rejection when a preserved axis drifts beyond tolerance. Seed continuity may be recorded as provenance but never treated as a lock.

---

## 6. What Nebula already covers

The current `backend/data/node_definitions.json` was checked before making recommendations.

Nebula already has useful foundations:

- `Character` utility with per-shot prompt, refs, and strength override.
- `GPT Image 1.5 Edit` with multiple reference-image inputs.
- `Nano Banana 2 Edit (FAL)` with multi-reference images, native 16:9, resolution control, and thinking level. Live-tested successfully for surgical blocking changes.
- `Ideogram Character` with separate Character, Character Refs, and Style Refs.
- `Mask Painter` plus inpainting nodes.
- `Image Compare`.
- `Krea 2` with multiple style-reference inputs.
- `Seedance 2.0 I2V` with optional `End Frame`.
- `Seedance 2.0 R2V` with multiple references.
- `Veo 3.1` with first frame, last frame, and video extension.

Those capabilities reduce several July-era model gaps. They do **not** yet solve the main production friction above:

- reference arrays still need semantic role and precedence controls
- a Character node does not provide numeric head/gaze/camera editing
- image comparison is not scene-integration QC
- first/last-frame inputs do not automatically provide seam scoring or loop finishing
- model nodes need to remain agent-runnable and transactionally attached to the graph

---

## 7. Recommended Nebula roadmap

### P0 — Agent completion contract

A graph run should return one durable object:

```text
run_id
status + monotonic state version
requested/submitted/landed parameters
input asset IDs + roles + checksums
model/provider/version
output node IDs
output local paths + URLs
media metadata
cost
provenance edges
QC results
```

Success means the output node exists on the intended graph. No separate attachment step.

### P0 — Camera / pose / gaze edit

Build a first-class image edit node around a verified reachable model such as Qwen Image Edit Angles, with:

- source image port
- optional identity lock port
- camera orbit/pitch/zoom controls
- head yaw/pitch/roll
- eye gaze target
- edit strength
- preservation mask
- landed-geometry report

### P0 — Semantic reference router

Create a utility that packages references with roles, weights, scopes, and precedence, then maps that object into provider-specific request shapes.

### P0 — Visual QC suite

Add agent-readable analyzers for:

1. identity similarity
2. face landmark and expression drift
3. scene integration / cutout detection
4. camera geometry vs reference
5. background stability
6. loop seam
7. mobile and desktop safe-area coverage

### P1 — Integrated scene generation preset

A reusable transparent graph:

```text
Character identity
+ wardrobe
+ composition/camera reference
+ environment
+ lighting reference
+ prompt
→ one joint multi-reference generation
→ optional harmonizing relight
→ integrated-scene QC
→ approval gate
→ video generation
```

Do not default to subject extraction and local compositing for a human hero image.

### P1 — Durable async execution

- WebSocket/SSE progress
- resumable background jobs
- callback-to-event-store
- exactly-once completion events
- retries with idempotency
- agent wake/resume on state change

### P1 — Saved graph transparency

Every preset/Technique equivalent should expose its graph, model versions, prompt template, parameter defaults, tests, and landed examples.

### P2 — Searchable capability registry

Filter by typed inputs, outputs, roles, model, provider, price, expected duration, and agent-runnable status. Avoid returning the full catalog for every discovery question.

---

## 8. Evidence ledger

| Artifact | ID / path | What it proves |
|---|---|---|
| Scene project | `prj_ns7fsjww3geqe4wa1yj7j2vx6h8c79r8` | User-visible production canvas. |
| Four-reference compositor | `tech_ts7dmhm29gf0j8ckat6gfths3984vccj` / `run_s57d57a4sfctb9p4kjg15avp4x8c69g0` | Semantic mismatch: campaign portraits instead of coherent telescope scene. |
| Cinematic stills | `tech_ts70x23v7abvt2ssx2kkysbzed835bpb` / `run_s571pese7jtb5h42kxwvhsdh018c7z4c` | Useful components, insufficient end-to-end shot control. |
| Editorial replication | `tech_ts70tvv5e3kxzx4tj9ddpdtndh8ax1hx` / `run_s5718frca6z0hne78wvrv3e0r18c6n02` | Technique can land unrelated content. |
| Comp card pose workaround | `tech_ts7b9tj1afvgre78zn07af83218a2v3s` / `run_s57bb5d36r77753m3mshehrkq18c6kw9` | Multi-output workaround for missing single-angle edit. |
| Skyward extraction | `tech_ts70k2var97rcxfqp4553wkk29858k5g` / `run_s570s8bqtfwsc1rx1qqftr5jfx8c6qc1` | Separate cutout stage that led to compositing/integration risk. |
| Selected composited plate | `asset_jd7d73kwpkxfjx5f6sn2fd3hsn8c6n4y` | Technically opaque but later rejected as visually pasted. |
| Raw skyward video | `run_s57eba5j2cp7mcrq3sfawr40dd8c7rb0` | 15.06s result, identity/material drift, non-matching endpoints. |
| Edited attached loop | `asset_jd75afkgbhjwqwqdc6c1r731p58c79ey` | Attachment can be verified separately from run completion; technical loop fix did not solve scene integration. |
| Durable local loop | `~/Documents/Workspace/Agents/system/nari/build/director/hero-loops/nari-skyward/nari-skyward-hero-loop.mp4` | Local post-processing was required for duration, drift, and seam. |
| Integrated low-angle still candidate | `asset_jd70hn92vgppthabn1y9a0s6n58c716e` / node `api_asset_jd70hn92vgppthabn1y9a0s6n58c716e` | A typed multi-reference generation outside Flora's Technique surface solved the cutout and camera-geometry failure; separate attachment/readback still remained necessary. |
| Independent ground-camera v6 | `asset_jd74wdq68enf5p6vba964xz1018c75jy` / node `api_asset_jd74wdq68enf5p6vba964xz1018c75jy` | Nano Banana 2 Edit preserved low-camera integration while removing the camera-holding read, raising gaze nearly overhead, thinning stars, and reopening the left copy field. |
| Flora rear-sky v10 | `run_m17f0f750h9njmetsyhmjtezr18c7c06` | Prompt landed rear orientation and emotional head release, but retreated to a conventional full-body landscape with visible grass. |
| Flora rear-sky v11 | `run_m1764tgb6z01b9tyfn584zf4cd8c7xkb` | Stronger near-field scale still retained a grass band and pushed sleeves toward the lens. A long polling call returned 502 although the run completed. |
| Flora rear-sky v12 | `run_m1780mvb3y88tms4wgqmn2y50x8c79kh` / node `b960ba82-77c1-47f2-836c-f4f3759b392e` | Edge-to-edge sky, no terrestrial horizon, rear/upward orientation, no camera-owning limb, and verified visible canvas delivery. |
| Flora rich-sky v13 | `run_m17989eaft07e3dgd39wkr7bfd8c605n` / node `607ab71c-acbc-4114-9223-ae7b5d753959` | Landed the user's richer-sky and darker-Nari revision, but full T2I resynthesis lengthened the locked lob and revealed more profile. |
| Flora continuity retry v14 | `run_m172h7kr8zemq6wpdws40snjj58c6tbp` / node `60a7a457-3130-4558-a849-fad144421561` | Shorter hair returned, but camera, head performance, sweater color, and profile constraint regressed despite the same seed. |

## 9. Nebula live-proof findings

After stopping the failing Flora generation branch, the same shot was attempted through Nebula's current execution code. These are not Flora defects, but they are direct agent-friction findings for Nebula.

### N-01 — `quick` cannot express a multi-image list

- **Observed:** `/api/quick` converts each input value into one temporary scalar input node. Passing a list to the `images` port is not converted into `PortValueDict(type="Image", value=[...])`.
- **Consequence:** An agent cannot use the simplest one-shot CLI path for GPT Image multi-reference edits.
- **Fix:** Accept arrays in `quick`, create one typed multi-image value, and validate every member as a URL, data URI, or local image before dispatch.

### N-02 — Inherited `PYTHONPATH` can select incompatible compiled packages

- **Observed:** Hermes exported Python 3.11 site-packages in `PYTHONPATH` while Nebula ran under Python 3.12. Importing Pydantic failed on `pydantic_core._pydantic_core`.
- **Workaround:** Run Nebula with `env -u PYTHONPATH` and its intended interpreter.
- **Fix:** Sanitize incompatible inherited Python paths and report the selected interpreter/environment before execution.

### N-03 — Configured key presence is not key validity

- **Observed:** Nebula reported `OPENAI_API_KEY` as configured, but the direct GPT Image 2 request returned `401 invalid_api_key`.
- **Consequence:** Capability discovery says a node is runnable when authentication is stale.
- **Fix:** Add provider health checks, last-verified timestamps, and explicit `configured / valid / authorized-for-model` status.

### N-04 — GPT Image 2 FAL streaming lost the final artifact

- **Observed:** `gpt-image-2-fal-edit` reached the streaming endpoint but ended with `Image stream ended without a final image event`.
- **Consequence:** Provider work may complete or bill while Nebula returns no image, request ID, raw event ledger, or recovery path.
- **Fix:** Persist request IDs and bounded raw SSE event metadata; recognize current final-event variants; on parser failure, retrieve the final result by request ID before declaring failure.

### N-05 — GPT Image 1.5 async-poll fallback succeeded

- **Observed:** `gpt-image-1-5-edit` accepted six ordered image references through the typed `images` port and returned a real PNG URL.
- **Landed result:** The fresh v3 pass produced the requested ground-level wide-angle geometry as one integrated exposure. The 16:9 candidate was attached to Flora as `asset_jd70hn92vgppthabn1y9a0s6n58c716e`.
- **Lesson:** Durable submit → status → result retrieval was more reliable than the uninstrumented SSE path in this run.

### N-06 — Reference roles still exist only in prose

- **Observed:** The multi-image port preserves order but does not type references as identity, profile, wardrobe, camera, or environment. A contradictory hairstyle phrase overrode Nari's canonical pixels and produced blunt bangs. A surgical follow-up edit retained the fringe; a fresh pass with corrected role prose restored the canonical hair.
- **Consequence:** The transport is typed, but art-direction semantics remain a fragile prompt convention.
- **Fix:** Add first-class per-reference metadata: role, priority, preserve/change policy, region or subject binding, strength, and canonical vs advisory status.

### N-07 — Provider success still needs durable artifact lineage

- **Observed:** The successful Nebula handler returned a remote URL. The agent separately downloaded, cropped, verified, durably copied, uploaded, completed, attached, and read the image back from Flora.
- **Fix:** A production graph should emit a durable artifact record with source node, ordered references, prompt, provider request ID, original dimensions, derivatives, approval state, and external-publish receipts.

### N-08 — Model-route selection is part of art direction

- **Observed:** GPT Image 1.5 was effective for fresh joint synthesis, but two surgical structural passes averaged away the extreme camera while fixing gesture and gaze. Nebula's existing Nano Banana 2 Edit node preserved the master perspective and landed all requested blocking changes in one pass.
- **Consequence:** A generic `image edit` capability label is insufficient. Agents need evidence about which editor preserves composition, which re-synthesizes geometry, and which supports surgical changes.
- **Fix:** Add a capability matrix and landed-eval scores per model for identity retention, composition retention, camera transformation, local object removal, relighting, typography, and multi-reference role adherence. The router should choose by edit intent, not provider or price alone.
- **Remaining gap:** No numeric Qwen Image Edit 2511 Angles node exists in Nebula's live registry. Nano Banana solved this shot, but it does not replace deterministic pitch/orbit/zoom controls.

### N-09 — Local reference payloads are eagerly inlined before submission

- **Observed:** The universal FAL image path converted each local reference into a full base64 data URI inside one JSON request. A 2K master plus two canonical references could spend minutes serializing/uploading before a provider request ID existed. Compressing the two authority refs to 768px JPEG reduced them to roughly 84KB and 40KB before retry.
- **Consequence:** Large local references create avoidable request-size, timeout, memory, and orphan-state risk before provider work begins.
- **Fix:** Ingest references once into durable object storage, pass URLs or provider file handles, enforce payload-size preflight, auto-compress advisory refs without touching canonical originals, and display the exact serialized request size before dispatch.

### N-10 — Request lineage begins too late for recovery

- **Observed:** A timed-out FAL-backed `v9` call preserved no provider request ID or status/result URL. Request-history recovery found prior successful requests but no recoverable `v9` record. The handler exposed only final outputs, not a durable submit receipt before polling.
- **Consequence:** The agent cannot distinguish “never submitted,” “submitted and still running,” and “completed but response lost,” so retry decisions can duplicate cost or abandon work.
- **Fix:** Persist the provider request ID, endpoint, status URL, result URL, idempotency key, submitted-at timestamp, and input hashes immediately after submit and before any poll. Recovery must read that receipt first.

### N-11 — Key presence is not provider account readiness

- **Observed:** After reference compression removed the pre-submit payload issue, the retry reached FAL and returned `403 User is locked — exhausted balance`. The node had still appeared configured because an API key existed.
- **Consequence:** Discovery advertises a runnable route that cannot accept paid work.
- **Fix:** Extend readiness beyond key presence to `authenticated`, `account_active`, `model_authorized`, `billing_ready`, and `last_verified_at`; fail preflight before serializing media or constructing a graph run.

## 10. Acceptance rule going forward

For a human-led hero scene, do not animate until a still passes all of these independently:

- canonical identity
- approved wardrobe
- intended body/head/gaze pose
- measurable camera geometry
- camera ownership and every foreground limb have an intentional, readable action
- scene and subject share one perspective and light field
- no alpha/halo/cutout read at full size or thumbnail
- desktop copy-safe area
- mobile subject-safe crop
- environment remains natural rather than fantastical
- user marks the still a creative keeper

A technically runnable image is not yet a shot.
