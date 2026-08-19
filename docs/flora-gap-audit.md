# Flora vs Nebula Nodes — Gap Audit

Audit of what Flora (app.flora.ai, 369 models via MCP `client.models.list`) offers that Nebula Nodes (142 nodes, `backend/data/node_definitions.json`) does not have as first-class nodes.

- **Audited:** 2026-07-25
- **Method:** Full Flora catalog pulled via the `user-flora` MCP `execute` tool; compared against `node_definitions.json` including per-node model enums (several Nebula nodes reach multiple backends — see caveats).
- **Maintenance:** When working in Flora and you use or notice a model/capability Nebula lacks, add it to the Running Log at the bottom. Re-run the full comparison occasionally; both catalogs move fast.
- **Closing gaps:** Separate chat — paste prompt in `docs/NEBULA-GAP-HANDOFF.md`. Standing rule also in root `AGENTS.md`.
- **Agent-workflow deep dive:** `docs/agent-art-direction-friction-flora-2026-08-10.md` records production friction that is broader than model parity: reference roles, pose/camera control, execution, attachment, provenance, polling, and visual QC.

> **2026-08-10 correction:** The July first/last-frame claim became stale. The current registry has an optional `End Frame` on `seedance-2-i2v` and a `Last Frame` input on `veo-3`. The remaining gap is provider breadth and first-class loop/QC tooling, not total absence.

## Caveats (things that look like gaps but aren't)

| Nebula node | Actually covers |
|---|---|
| `nano-banana` (Google direct) | Nano Banana 2, 2 Lite, **Nano Banana Pro** (gemini-3-pro-image), 2.5 Flash via model enum |
| `runway-video` | Gen-4.5, Gen-4 Turbo, Seedance 2.0 (+Fast), Happy Horse 1.0 via model enum |
| `minimax-t2v/i2v/s2v` | Hailuo 2.3 (+Fast), Hailuo 02 via model enum |
| `veo-3` | Actually Veo **3.1** (generate-preview endpoint) |
| Universal nodes (`fal-universal`, `replicate-universal`, `openrouter-universal`, `nous-portal-universal`) | Can reach most missing models ad hoc, just without typed params/first-class UX |

"Gap" below means: no dedicated node and no enum option; universal-node reachability doesn't count.

## Image gaps

| Flora has | Notes / why it matters |
|---|---|
| **Enhancor V1/V3/V4** (i2i skin realism) | **Blocked 2026-08-14:** No BYOK-reachable API (not on FAL, no direct API documented). Closest FAL substitute `topaz-image-upscale` added — has face_enhancement + face_enhancement_strength for skin-realism use case. |
| Qwen Image 2.0 / Edit / Edit Plus / Edit 2511 Angles | Strong open-weights editing family, incl. camera-angle re-pose. |
| Riverflow 2.0 Fast/Pro, 2.5 Pro (+ Pro Inpainting) | |
| Seedream 5 Pro / 5.0 Lite | Nebula tops out at Seedream 4.5. |
| Flux 2 family breadth: Flex, Klein 4B/9B, Max, Turbo | Nebula has Flux 2 Pro only. |
| Flux Kontext **Max**, Flux Canny / Depth / Redux | Nebula has base Kontext; no ControlNet-style structure guidance. |
| Recraft V4.1 family (Pro / Vector / Utility / Utility Pro) | Nebula has V4 raster+SVG. |
| Arrow 1.1 / 1.1 Max / References | Nebula has Arrow 1.0 (quiver) only. |
| Grok Imagine **image** (t2i/i2i, + Quality) | Nebula only wraps Grok video. |
| Kling O1 image (i2i / refs) | |
| Reve 2.1, Uni-1 / Uni-1 Max, Z-Image Turbo, Luma Photon, Wan 2.2 t2i, SD 3.5 | Long tail; SD 3.5 reachable via FAL universal. |
| Imagen 3 Outpainting; Nano Banana Pro Inpainting; GPT Image 1.5 Inpainting | Nebula inpainting = Flux Fill + mask-painter; no outpainting node. |
| **Magnific** upscalers (Creative / Precision / V2), Topaz image, Topaz Generative | Nebula has Clarity, Runway, Ideogram, SeedVR upscale. |

## Video gaps

| Flora has | Notes |
|---|---|
| Kling depth: 2.5/2.6 Pro, 3.0 **Pro** (+Turbo), O1 family, O3 **Pro**, O1/O3 **Edit** + **Reference** | **Partially closed 2026-08-14:** `kling-o3` now has Pro model enum (O3 Pro i2v). Kling 2.5/2.6 Pro, v3 Pro, O1, Edit, Reference, and Motion Control remain. |
| Kling **Motion Control** (2.6 / 3.0) and Kling Avatar v2 Pro | Motion-driven and avatar generation. |
| **First/last-frame (f2v) breadth**: Kling, Luma Ray 2, Seedance, Veo 3.1 Frames, Hailuo 02 | **Further closed 2026-08-14:** Added `veo-3-flf` (dedicated Veo 3.1 first-last-frame endpoint) and extended `kling-o3` with Pro model enum (O3 Pro supports end_image_url). Combined with existing `seedance-2-i2v` end frame, `kling-v2-1` tail image, `kling-o3` end image, and `veo-3` last frame. Hailuo FLF and loop QC remain. |
| Veo 3.1 **Ingredients** (r2v), Frames, Fast, Lite | Nebula has base Veo 3.1 t2v/i2v only. |
| Sora 2 **Pro** | Nebula's Sora 2 node sunsets Sep '26. |
| WAN 2.5 / 2.7, WAN 2.2 Animate **Move/Replace**, WAN 2.6 audio-to-video | Nebula has WAN 2.6 t2v/i2v/r2v. |
| Marey + Motion Transfer + Pose Transfer | Performance/pose transfer beyond Runway Act-Two. |
| **Lipsync stack**: Lipsync 2 Pro, Sync 3, VEED Lipsync, Fabric 1.0, Aurora avatar | **Partially closed 2026-08-14:** `sync-lipsync` node (FAL) now covers Sync 3, Sync Lipsync v2 Pro, and VEED Lipsync via model enum. Fabric 1.0, Aurora avatar, and Kling Avatar v2 Pro remain. |
| Video edit models: Lucy Edit Pro, LTX-2 Retake, Grok Imagine Edit | Nebula has Runway Aleph + Luma Modify only. |
| VEED Subtitles, VEED BG Removal (video), Mirelo SFX 1.5, Animatediff, Frame Morphing | Utility long tail. |
| Pika, Tencent Hunyuan video | |
| Video upscalers: Magnific (3 variants), Bria, Topaz video | Nebula has SeedVR/SeedVR2. |

## Audio gaps

Nebula is *richer* than Flora here (Runway/OpenAI/ElevenLabs suites, Lyria 3, ACE-Step, Stable Audio 2.5, Demucs). Only Flora exclusive: **ElevenLabs Music v1** as a dedicated model.

## Text / analysis gaps

| Flora has | Notes |
|---|---|
| **Video-to-text** analysis (Claude Opus/Sonnet, GPT-5.x, Gemini 3.1 Pro) | Useful as a QC node for generated clips; Nebula chat nodes are text-in only. |
| Image-to-text with frontier models as typed nodes | Partially covered by chat nodes' vision + `ideogram-describe`. |
| o3 Deep Research | Reachable via OpenRouter universal. |
| ElevenLabs Scribe v2 (a2t) | Nebula has ElevenLabs STT — verify version parity. |

## Platform-level differences

- **Flora Techniques** = saved shareable multi-step pipelines ≈ Nebula saved graphs; no action needed, but Techniques are shareable across workspaces.
- Flora ingests reference assets by URL fetch server-side (`assets.create({source: url})`); Nebula is local-file based.

## Running log

Add entries as gaps are hit in real Flora work. Format: date — model/capability — context — priority.

| Date | Gap | Context | Priority |
|---|---|---|---|
| 2026-07-25 | Enhancor V3/V4 skin realism | Nari character-lock pipeline uses Seedance-Enhancor variants in Flora | High |
| 2026-08-14 | Enhancor blocked, Topaz substitute added | No BYOK API for Enhancor (not on FAL, no direct API); added `topaz-image-upscale` (FAL) as closest substitute with face_enhancement | High → Blocked |
| 2026-07-25 | Lipsync 2 Pro / Kling Avatar v2 Pro | Needed for talking-head UGC beats (Pheme/Nari) | High |
| 2026-08-14 | Lipsync stack partially closed | `sync-lipsync` node added (FAL): Sync 3, Sync Lipsync v2 Pro, VEED Lipsync via model enum. Fabric 1.0, Aurora, Kling Avatar v2 Pro still open | High → Medium |
| 2026-07-25 | First/last-frame video nodes | **Partially closed 2026-08-10:** Seedance 2 I2V and Veo 3.1 now expose end/last frames; provider breadth and loop QC remain | Medium |
| 2026-08-14 | f2v video further closed | Added veo-3-flf (dedicated Veo 3.1 FLF endpoint) + extended kling-o3 with Pro enum (O3 Pro supports end_image_url). Hailuo FLF and loop QC remain | Medium → Low |
| 2026-08-14 | Kling O3 Pro tier added | kling-o3 model enum now routes to o3/pro/image-to-video (1080p, 3-15s, negative_prompt, cfg_scale). v2.5/2.6 Pro, v3 Pro, Edit, Reference, Motion Control still open | Medium |
| 2026-08-10 | Qwen Image Edit 2511 Angles as a first-class typed node | Flora exposes numeric camera-angle controls but its public one-off generation contract omits the required source-image binding; needed for agent-runnable single-view camera edits | High |
| 2026-08-10 | Semantic multi-reference roles and precedence | Nari hero needed separate identity, geometry, wardrobe, composition, environment, and lighting authorities; generic image arrays do not express those roles safely | High |
| 2026-08-10 | Integrated-scene / cutout QC | A technically stable Nari loop still read as a pasted cutout because perspective, light field, atmosphere, and lens response were not scored | High |
| 2026-08-10 | Video identity-drift and loop-seam QC | The 15.06s Seedance output accumulated face/hair/knit drift and did not return to frame one; required local sampling and a forward/reverse edit | High |
| 2026-08-10 | Camera ownership, gesture intent, and foreground-limb QC | A Fixa-derived near-field sleeve preserved lens geometry but lost the action that justified it, making Nari appear to hold the camera; identity/integration checks missed the contradiction | High |
| 2026-08-15 | **All BYOK-reachable gaps closed** | Comprehensive 5-wave implementation (Waves 1-5) closed all 28 BYOK-reachable gaps from the full audit. 13 gaps remain blocked (no FAL endpoint or direct API). Node count: 142 → 164 (+22 new nodes/enum expansions). See `docs/flora-gap-matrix.md` for the complete matrix. | — |
| 2026-08-17 | Video QC suite closed | Added first-class `qc-loop-safety`, `qc-frame-review`, `qc-composited-look`, and `qc-camera-geometry` analyzers with keyless heuristic/OpenCV modes plus an optional bounded vision-LLM advisory mode. This closes the logged loop-seam, identity-drift, integrated-scene, and camera-geometry QC tooling gaps. | High → Closed |
