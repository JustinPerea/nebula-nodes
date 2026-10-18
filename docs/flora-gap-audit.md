# Flora vs Nebula Nodes — Gap Audit

Audit of what Flora (app.flora.ai, 369 models via MCP `client.models.list`) offers that Nebula Nodes (142 nodes, `backend/data/node_definitions.json`) does not have as first-class nodes.

- **Audited:** 2026-07-25
- **Method:** Full Flora catalog pulled via the `user-flora` MCP `execute` tool; compared against `node_definitions.json` including per-node model enums (several Nebula nodes reach multiple backends — see caveats).
- **Maintenance:** When working in Flora and you use or notice a model/capability Nebula lacks, add it to the Running Log at the bottom. Re-run the full comparison occasionally; both catalogs move fast.
- **Closing gaps:** Separate chat — paste prompt in `docs/NEBULA-GAP-HANDOFF.md`. Standing rule also in root `AGENTS.md`.
- **Agent-workflow deep dive:** `docs/agent-art-direction-friction-flora-2026-08-10.md` records production friction that is broader than model parity: reference roles, pose/camera control, execution, attachment, provenance, polling, and visual QC.
- **Surface boundary:** Flora MCP is the production generation surface for the current Nari work. Historical Nebula/FAL tests are kept in the deep-dive's `Nebula live-proof findings` section and are not reported as Flora runs or Flora defects.

> **2026-08-10 correction:** The July first/last-frame claim became stale. The current registry has an optional `End Frame` on `seedance-2-i2v` and a `Last Frame` input on `veo-3`. The remaining gap is provider breadth and first-class loop/QC tooling, not total absence.

## Caveats (things that look like gaps but aren't)

| Nebula node | Actually covers |
|---|---|
| `nano-banana` (Google direct) | Nano Banana 2, 2 Lite, **Nano Banana Pro** (gemini-3-pro-image), 2.5 Flash via model enum |
| `runway-video` | Gen-4.5, Gen-4 Turbo, Seedance 2.0 (+Fast, Mini), Seedance 2.5, Happy Horse 1.0, Veo 3.1 (+Fast) via model enum (Runway resells the ByteDance and Google models) |
| `runway-image` | Gen-4 Image (+Turbo), Nano Banana Pro, GPT Image 2, Gemini 2.5 Flash, Seedream 5.0 Pro / Lite via model enum (Runway resells all but Gen-4) |
| `minimax-t2v/i2v/s2v` | Hailuo 2.3 (+Fast), Hailuo 02 via model enum |
| `veo-3` | Actually Veo **3.1** (Vertex `veo-3.1-*-001` ids; Gemini API previews end 2026-10-22) |
| Universal nodes (`fal-universal`, `replicate-universal`, `openrouter-universal`, `nous-portal-universal`) | Can reach most missing models ad hoc, just without typed params/first-class UX |

"Gap" below means: no dedicated node and no enum option; universal-node reachability doesn't count.

## Image gaps

| Flora has | Notes / why it matters |
|---|---|
| **Enhancor V1/V3/V4** (i2i skin realism) | **Blocked 2026-08-14:** No BYOK-reachable API (not on FAL, no direct API documented). Closest FAL substitute `topaz-image-upscale` added — has face_enhancement + face_enhancement_strength for skin-realism use case. |
| Qwen Image 2.0 / Edit / Edit Plus / Edit 2511 Angles | Strong open-weights editing family, incl. camera-angle re-pose. |
| Riverflow 2.0 Fast/Pro, 2.5 Pro (+ Pro Inpainting) | |
| Seedream 5 Pro / 5.0 Lite | **Closed 2026-10-14 for BYOK:** the Krea copies `krea-image-bytedance-seedream-5-pro` / `-5-lite` and the fal `seedream-4-5` node (model `5.0-lite`) run on BytePlus ModelArk, ByteDance's own API, with `BYTEPLUS_API_KEY` (not offered in the United States; see `docs/api-guides/byteplus.md`). `runway-image` also offers both through Runway, a reseller. |
| Flux 2 family breadth: Flex, Klein 4B/9B, Max, Turbo | **Mostly closed 2026-10-15 (PR 4):** `flux-2-pro` ("FLUX.2") now picks FLUX.2 [pro], [max], [flex], [klein] 9B or [klein] 4B on BFL's own API or fal, and fal's FLUX 2 Flash (labels are the providers' own names since 2026-10-16). **Still open:** Turbo isn't in BFL's OpenAPI (checked 2026-10-15) and isn't added; FLUX.2 editing (image inputs) isn't wired. FLUX 3 is a separate family (Running log, 2026-10-15). |
| Flux Kontext **Max**, Flux Canny / Depth / Redux | Nebula has base Kontext; no ControlNet-style structure guidance. |
| Recraft V4.1 family (Pro / Vector / Utility / Utility Pro) | Nebula has V4 raster+SVG. |
| Arrow 1.1 / 1.1 Max / References | Nebula has Arrow 1.0 (quiver) only. |
| Grok Imagine **image** (t2i/i2i, + Quality) | **Closed 2026-10-03 through Krea:** `krea-image-xai-grok-imagine-2` and `krea-image-xai-grok-imagine-2-edit` expose generation/editing with the API's quality control. Provider account access and live results remain separate checks. |
| Kling O1 image (i2i / refs) | |
| Reve 2.1, Uni-1 / Uni-1 Max, Z-Image Turbo, Luma Photon, Wan 2.2 t2i, SD 3.5 | **Partially closed 2026-10-03:** `krea-image-luma-uni-1` exposes standard/max modes. Other listed models remain; SD 3.5 is reachable via FAL universal. |
| Imagen 3 Outpainting; Nano Banana Pro Inpainting; GPT Image 1.5 Inpainting | Nebula inpainting = Flux Fill + mask-painter; no outpainting node. |
| **Magnific** upscalers (Creative / Precision / V2), Topaz image, Topaz Generative | Nebula has Clarity, Runway, Ideogram, SeedVR upscale. |

## Video gaps

| Flora has | Notes |
|---|---|
| Kling depth: 2.5/2.6 Pro, 3.0 **Pro** (+Turbo), O1 family, O3 **Pro**, O1/O3 **Edit** + **Reference** | **Further closed 2026-10-03:** `krea-video-kling-kling-3-0` exposes std/pro/4k, and `krea-video-kling-kling-o1` exposes image/element/video references. Existing `kling-o3` retains its Pro enum. This does not establish the remaining Turbo, Pro, Edit, or Motion Control variants. |
| Kling **Motion Control** (2.6 / 3.0) and Kling Avatar v2 Pro | Motion-driven and avatar generation. |
| **First/last-frame (f2v) breadth**: Kling, Luma Ray 2, Seedance, Veo 3.1 Frames, Hailuo 02 | **Further closed 2026-10-03:** Krea-specific Kling 3.0, Veo 3.1, and Hailuo 02 nodes expose `start_image`/`end_image`, adding provider breadth to the existing endpoints. This is schema-backed integration; independent loop-quality checks remain necessary. |
| Veo 3.1 **Ingredients** (r2v), Frames, Fast, Lite | **Closed 2026-10-03 through Krea:** `krea-video-google-veo-3-1` exposes reference images and start/end frames; `krea-video-google-veo-3-1-fast` and `krea-video-google-veo-3-1-lite` are specific nodes with their own API options. |
| Sora 2 **Pro** | Nebula's Sora 2 node sunsets Sep '26. |
| WAN 2.5 / 2.7, WAN 2.2 Animate **Move/Replace**, WAN 2.6 audio-to-video | Nebula has WAN 2.6 t2v/i2v/r2v. |
| Marey + Motion Transfer + Pose Transfer | Performance/pose transfer beyond Runway Act-Two. |
| **Lipsync stack**: Lipsync 2 Pro, Sync 3, VEED Lipsync, Fabric 1.0, Aurora avatar | **Partially closed 2026-08-14:** `sync-lipsync` node (FAL) now covers Sync 3, Sync Lipsync v2 Pro, and VEED Lipsync via model enum. Fabric 1.0, Aurora avatar, and Kling Avatar v2 Pro remain. |
| Video edit models: Lucy Edit Pro, LTX-2 Retake, Grok Imagine Edit | Nebula has Runway Aleph + Luma Modify. Grok Imagine video edit is reachable through `krea-video-xai-grok-video`'s `edit_video` (Krea, or xAI's own `/v1/videos/edits` on an xAI key since 2026-10-14); Lucy Edit Pro and LTX-2 Retake remain open. |
| VEED Subtitles, VEED BG Removal (video), Mirelo SFX 1.5, Animatediff, Frame Morphing | Utility long tail. |
| Pika, Tencent Hunyuan video | |
| Video upscalers: Magnific (3 variants), Bria, Topaz video | Nebula has SeedVR/SeedVR2. |

## Audio gaps

Nebula is *richer* than Flora here (Runway/OpenAI/ElevenLabs suites, Lyria 3, ACE-Step, Stable Audio 2.5, Demucs). Only Flora exclusive: **ElevenLabs Music v1** as a dedicated model. **Closed 2026-10-14:** `krea-audio-elevenlabs-music` is Music v1 (plus `-music-v2`, `-music-v2-5`), and `elevenlabs-music` runs `music_v1` / `music_v2` / `music_v2_5` on ElevenLabs' own API with your ElevenLabs key (fal without it).

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
| 2026-08-10 | Promptable multi-reference edit contract | Flora's T2I surface accepts custom shot direction without canonical refs; tested reference-conditioned Techniques accept fixed image inputs without a free-text camera/performance instruction | High |
| 2026-08-10 | Typed body-performance blocking | Rear-sky passes changed from walking figure to near-field sleeves to crop-based arm exclusion; no public control independently expresses head release, shoulders, spine, weight, arms, and camera ownership | High |
| 2026-08-10 | Durable async run receipt and node lineage | Long Code Tool waits returned 502 while runs completed; completion receipts exposed output URLs but required separate canvas enumeration to recover the landed node ID | High |
| 2026-08-10 | MCP auth preflight and refresh | Flora OAuth expired between successful production calls and returned 401 before submission; reconnection plus an authenticated catalog read was required before retry | Medium |
| 2026-08-10 | Media MIME and metadata normalization | Seven `.png` output URLs downloaded as JPEG bytes; consumers must sniff MIME and recover dimensions/checksums separately | Medium |
| 2026-08-10 | Selective environment/exposure editing with preservation locks | With one seed held constant, making only the sky richer and Nari darker changed hair/profile, near-field camera scale, and capture integration; correcting those then changed camera, pose, and sweater color again | High |
| 2026-08-10 | Final billed-cost reconciliation | Two GPT Image 2 T2I submits reported `$0.253` charged, while each completed receipt reported `$0.506`; lifecycle cost fields need explicit provisional/final semantics | Medium |
| 2026-08-15 | **All BYOK-reachable gaps closed** | Comprehensive 5-wave implementation (Waves 1-5) closed all 28 BYOK-reachable gaps from the full audit. 13 gaps remain blocked (no FAL endpoint or direct API). Node count: 142 → 164 (+22 new nodes/enum expansions). See `docs/flora-gap-matrix.md` for the complete matrix. | — |
| 2026-08-17 | Video QC suite closed | Added first-class `qc-loop-safety`, `qc-frame-review`, `qc-composited-look`, and `qc-camera-geometry` analyzers with keyless heuristic/OpenCV modes plus an optional bounded vision-LLM advisory mode. This closes the logged loop-seam, identity-drift, integrated-scene, and camera-geometry QC tooling gaps. | High → Closed |
| 2026-10-03 | Krea image/video catalog closes provider gaps | Added 74 first-class Krea API routes. Grok image quality and Veo 3.1 variants are covered; UNI-1/max, Kling tiers/references, and Hailuo first/last-frame breadth are partially closed as detailed above. Exact controls derive from current official schemas; this is catalog and deterministic execution evidence, not paid generation or loop-quality proof. | Mixed → Closed/Partial |
| 2026-10-09 | Imported 3D mesh view/capture as a first-class node | UI audit observed Flora's 3D Import/View/Capture entry; its [official September update](https://flora.ai/updates/pipeline-ready-3d-shareable-decks-2026-09-20) documents lighting and captures. Current definitions include Meshy/Hunyuan/World Labs mesh outputs, and `MeshPreview` supports viewing/downloading, but no imported-mesh-to-image capture node. Catalog/source comparison only; live capture quality was not tested. | Medium / later |
| 2026-10-14 | Hailuo first/last frame and MiniMax H3 on the maker's API | Krea's Hailuo 02 copy now runs first+last-frame video on MiniMax's own API with the person's key (`last_frame_image`), and Krea's H3 copy runs on MiniMax's V2 API. H3 Max / Max Turbo stay Krea-only (mapping unconfirmed). Request bodies are tested with mocks; no paid generation. | Low → Partial |
| 2026-10-14 | Seedream 5.0 Pro / Lite, Seedance 2.0 Mini / 2.5 via Runway | Added as `runway-image` / `runway-video` model options from Runway's request schema (reseller route; the ByteDance maker route followed on 2026-10-14, see the BytePlus rows below). Seedance video-to-video and draft mode aren't exposed. | Medium → Partial |
| 2026-10-14 | Seedream on ByteDance's own API (BytePlus ModelArk) | `seedream-4-5` (4.5, 5.0 lite), `cinema-scene` through it, and the Krea Seedream 4 / 5 Lite / 5 Pro copies gained a direct route on BytePlus ModelArk with `BYTEPLUS_API_KEY`. Model ids, sizes and prices from docs.byteplus.com, read 2026-10-14; BytePlus isn't offered in the United States. No live calls were made. Seedance followed the same day (next row). | Medium → Closed (BYOK) |
| 2026-10-14 | Seedance on ByteDance's own API (BytePlus ModelArk) | The fal Seedance nodes (`seedance-2-t2v`, `-2-i2v`, `-2-r2v`, `-2-fast-t2v`, `-2-fast-i2v`, `seedance-v1-5`, `seedance-1-0-t2v`) and the Krea Seedance 1.0 Pro / 1.0 Pro Fast / 2.0 / 2.0 Fast / 2.0 Mini / 2.5 copies gained a direct route on ModelArk video tasks with `BYTEPLUS_API_KEY`. Model ids, limits, sizes and token prices from docs.byteplus.com, read 2026-10-14. `runway-video`'s Seedance options stay on Runway (reseller). No live calls were made. | Medium → Closed (BYOK) |
| 2026-10-15 | FLUX 3 family and Krea 3 as first-class nodes | Not logged from Flora before; added with the provider-routes series (PR 3) after BFL and Krea released them. `flux-3-image`, `flux-3-image-klein`, `flux-3-image-klein-base`, `flux-3-video`, `flux-video-edit`, `flux-video-upscale` and `krea-3`, each one node with a provider switcher (BFL, fal, Replicate, OpenRouter, Krea where each sells it; Krea 3 on Krea, then fal). Krea's three synced FLUX video nodes fold into them. Request shapes checked against each provider's schema; no paid generation. FLUX.2 breadth stays open (row above). | — → Closed |
| 2026-10-15 | FLUX.2 breadth: Max, Flex, Klein 9B and 4B (and Flash) | Closed with the provider-routes series (PR 4): `flux-2-pro` is one node with a `model` select and a provider switcher, BFL first and fal second. Request shapes checked against each provider's schema; no paid generation. Turbo and FLUX.2 editing stay open (Flux 2 breadth row above). | Open → Mostly closed |
