# Flora→Nebula Gap Matrix

Full audit of Flora models/capabilities that Nebula Nodes lacks as first-class nodes.
Built 2026-08-14 from: docs/flora-gap-audit.md (2026-07-25 baseline), repo docs, FAL skill
catalog (155 endpoints), web research (florafauna.ai public docs), and
backend/data/node_definitions.json (145 nodes, source of truth).

**Rules:** Universal-node reachability (fal-universal, replicate-universal, openrouter-universal,
nous-portal-universal) does NOT count as coverage. Every FAL slug listed below was verified
in `.claude/skills/fal/skills/`. "Blocked" means no BYOK-reachable API endpoint exists.

## Summary

| Metric | Count |
|---|---|
| Total gaps found (baseline) | 42 |
| Total gaps found (web, post-baseline) | 3 |
| Already closed (previous sessions) | 12 |
| Closed in Wave 1 | 6 |
| BYOK-reachable (remaining) | 14 |
| Blocked (no BYOK path) | 13 |
| Current Nebula node count | 146 |

## Already Closed (previous sessions)

| Flora model | Closed by | How |
|---|---|---|
| Sync 3, Sync Lipsync v2 Pro, VEED Lipsync | `sync-lipsync` node | New node, FAL model enum (3 models) |
| Enhancor V1/V3/V4 (substitute) | `topaz-image-upscale` node | Topaz has face_enhancement; Enhancor itself blocked |
| Veo 3.1 First-Last Frame | `veo-3-flf` node | New node, dedicated FAL FLF endpoint |
| Kling O3 Pro tier | `kling-o3` node | Enum expansion (Standard → Pro) |
| Seedance 2 I2V end frame | `seedance-2-i2v` node | Already had `end_image` port |
| Kling v2.1 end frame | `kling-v2-1` node | Already had `tail_image` port |
| Kling O3 end frame | `kling-o3` node | Already had `end_image` port |
| Veo 3.1 last frame | `veo-3` node | Already had `last_frame` port |
| Arrow 1.1 / 1.1 Max | `quiver-arrow-generate` node | Model enum already covers arrow-1, 1.1, 1.1-max |
| ElevenLabs Scribe v2 | `elevenlabs-stt` node | Model enum already covers scribe_v1, scribe_v2 |
| Veo 3.1 Fast / Lite | `veo-3` node | Model enum already covers all Veo variants |
| GPT Image 2 | `gpt-image-2-generate` / `gpt-image-2-edit` | Already added as first-class nodes |
| Kling 2.6 Pro I2V | `kling-pro` node | New node, FAL model enum (v2.6 Pro + v3 Pro + v2.5 Turbo Pro). Custom handler maps `image`→`start_image_url`. |
| Kling v3 Pro I2V | `kling-pro` node | Combined with above (same node, model enum) |
| Kling 2.5 Turbo Pro I2V | `kling-pro` node | Combined with above (same node, model enum) |
| Kling v3 Pro T2V | `kling-v3` node | Enum expansion (Standard/Pro T2V), preserves multi_prompt JSON parsing |
| Flux Kontext Max | `flux-kontext` node | Enum expansion (base/Max) |
| Flux 2 Max | `flux-2-pro` node | Enum expansion (Pro/Max) |

## BYOK-Reachable Gaps (implementable)

### MEDIUM Priority

| # | Flora model | FAL slug (verified) | Implementation shape | Priority |
|---|---|---|---|---|
| 5 | Kling O3 Pro Reference-to-Video | `fal-ai/kling-video/o3/pro/reference-to-video` | New node `kling-o3-ref`. Takes `image` (start), `end_image` (end), `images` (reference images), `prompt` with @Element/@Image tags. Uses `start_image_url`+`end_image_url`+`image_urls`. | MEDIUM |
| 6 | Kling v2.6 Pro Motion Control | `fal-ai/kling-video/v2.6/pro/motion-control` | New node `kling-motion`. Takes `image` (character) + `video` (motion reference) + `character_orientation` enum. Uses `image_url`+`video_url`. | MEDIUM |
| 9 | Topaz Video Upscale | `fal-ai/topaz/upscale/video` | New node `topaz-video-upscale` (transform). Takes `video` input. | MEDIUM |
| 10 | Grok Imagine Image (t2i) | `xai/grok-imagine-image` | New node `grok-imagine-image` (image-gen). | MEDIUM |
| 11 | Grok Imagine Image Edit | `xai/grok-imagine-image/edit` | New node `grok-imagine-image-edit` or combined with #10 via model/toggle. | MEDIUM |
| 12 | Seedream 5.0 Lite | `fal-ai/bytedance/seedream/v5/lite/text-to-image` | Enum expansion on `seedream-4-5` (add model enum: 4.5/5.0 Lite). | MEDIUM |
| 13 | Sora 2 Image-to-Video | `fal-ai/sora-2/image-to-video` | New node `sora-2-i2v` or enum expansion on `sora-2` to support i2v mode. | MEDIUM |

### LOW Priority

| # | Flora model | FAL slug (verified) | Implementation shape | Priority |
|---|---|---|---|---|
| 14 | Flux 2 Flash | `fal-ai/flux-2/flash` | Enum expansion on `flux-2-pro` (add Flash option) | LOW |
| 15 | Real-ESRGAN upscale | `fal-ai/esrgan` | New node `esrgan-upscale` (transform) | LOW |
| 16 | Recraft Crisp Upscale | `fal-ai/recraft/upscale/crisp` | New node `recraft-crisp-upscale` (transform) | LOW |
| 17 | Pika 2.2 I2V | `fal-ai/pika/v2.2/image-to-video` | New node `pika-i2v` (video-gen) | LOW |
| 18 | HunyuanVideo T2V | `fal-ai/hunyuan-video` | New node `hunyuan-video` (video-gen) | LOW |
| 19 | WAN 2.7 T2V | `fal-ai/wan/v2.7/text-to-video` | Enum expansion on `wan-2-6-t2v` (add 2.7 option) | LOW |
| 20 | ElevenLabs Music | `fal-ai/elevenlabs/music` | New node `elevenlabs-music` (audio-gen) | LOW |
| 21 | WAN 2.2 Animate Move | `fal-ai/wan/v2.2-14b/animate/move` | New node `wan-animate-move` (video-gen) | LOW |
| 22 | WAN 2.2 Animate Replace | `fal-ai/wan/v2.2-14b/animate/replace` | New node `wan-animate-replace` (video-gen) | LOW |
| 23 | Kling Video-to-Audio | `fal-ai/kling-video/video-to-audio` | New node `kling-video-to-audio` (audio-gen) | LOW |
| 24 | Seedance 1.0 Pro I2V | `fal-ai/bytedance/seedance/v1/pro/image-to-video` | Enum expansion on `seedance-1-5` (add v1.0 option) | LOW |
| 25 | Seedance 1.0 Pro T2V | `fal-ai/bytedance/seedance/v1/pro/text-to-video` | New node or enum expansion | LOW |
| 26 | LTX-2.3 Audio-to-Video | `fal-ai/ltx-2.3/audio-to-video` | New node `ltx-audio-to-video` (video-gen) | LOW |
| 27 | LTX-2.3 Fast T2V | `fal-ai/ltx-2.3/text-to-video/fast` | Enum expansion on `ltx-2-3` (add Fast option) | LOW |
| 28 | Video Understanding (vision) | `fal-ai/video-understanding` | New node `video-understanding` (analyzer) | LOW |

## Blocked Gaps (no BYOK-reachable API)

| Flora model | Why blocked | Priority |
|---|---|---|
| Enhancor V1/V3/V4 | No FAL endpoint, no direct API documented. Topaz substitute added. | HIGH (blocked) |
| Qwen Image 2.0 / Edit / Edit Plus / Edit 2511 Angles | Not on FAL (only `fal-ai/qwen-3-guard` LLM exists). No direct API path in repo. | HIGH (blocked) |
| Riverflow 2.0 Fast/Pro, 2.5 Pro (+ Inpainting) | Not on FAL. No direct API. | LOW (blocked) |
| Seedream 5 Pro | Not on FAL (only 5.0 Lite is available). 5.0 Lite is implementable. | LOW (blocked) |
| Flux 2 Flex / Klein 4B / Klein 9B | Not on FAL (only Pro, Max, Flash available). | LOW (blocked) |
| Flux Canny / Depth / Redux | Not on FAL (ControlNet-style structure guidance). | LOW (blocked) |
| Recraft V4.1 family (Pro/Vector/Utility/Utility Pro) | Not on FAL (only V3 and V4 exist in skills). | LOW (blocked) |
| Kling O1 family (image + video) | Not on FAL. | LOW (blocked) |
| Kling Avatar v2 Pro | Not on FAL. | STRETCH (blocked) |
| Fabric 1.0 | Not on FAL. | STRETCH (blocked) |
| Aurora avatar | Not on FAL. | STRETCH (blocked) |
| Magnific upscalers (Creative/Precision/V2) | Not on FAL. No direct API. | MEDIUM (blocked) |
| Bria video upscaler | Not on FAL. | LOW (blocked) |
| Marey / Motion Transfer / Pose Transfer | Not on FAL. | LOW (blocked) |
| Lucy Edit Pro / LTX-2 Retake / Grok Imagine Edit | Not on FAL. | LOW (blocked) |
| VEED Subtitles / VEED BG Removal (video) | Not on FAL. | LOW (blocked) |
| Mirelo SFX 1.5 | Not on FAL. | LOW (blocked) |
| Animatediff / Frame Morphing | Not on FAL. | LOW (blocked) |
| Tencent Hunyuan video (standalone) | `fal-ai/hunyuan-video` IS on FAL — see BYOK-reachable #18. NOT blocked. | ~~LOW~~ |
| SD 3.5 | Not on FAL (only SDXL). | LOW (blocked) |
| Seedance 2.5 | Not on FAL (only 2.0 and 1.x). | LOW (blocked) |
| LTX-2 Pro | Not on FAL (only LTX-2 and LTX-2.3). | LOW (blocked) |
| WAN 2.5 | Not on FAL (only 2.6 and 2.7). | LOW (blocked) |
| Veo 3.1 Ingredients (r2v) | Not on FAL. | LOW (blocked) |
| Kling O1 image (i2i/refs) | Not on FAL. | LOW (blocked) |
| Imagen 3 Outpainting | Not on FAL as separate endpoint. | LOW (blocked) |
| Nano Banana Pro Inpainting | Not on FAL as separate endpoint (edit node exists but not inpaint-specific). | LOW (blocked) |
| GPT Image 1.5 Inpainting | Not on FAL as separate endpoint. | LOW (blocked) |
| o3 Deep Research | Only via OpenRouter universal. Not a model-node gap. | LOW (blocked) |

## Newly Discovered on Web (post-baseline)

| Flora model | Category | Source URL | Date found | Status |
|---|---|---|---|---|
| LTX-2 Pro | Video | https://docs.flora.ai/models/video-models | 2026-08-14 | Blocked (not on FAL) |
| Seedance 2.5 | Video | https://docs.flora.ai/models/video-models | 2026-08-14 | Blocked (not on FAL) |
| WAN 2.7 | Video | https://docs.flora.ai/models/video-models | 2026-08-14 | BYOK-reachable (`fal-ai/wan/v2.7/text-to-video`) — see #19 |

*(Other models found on Flora's public docs — GPT Image 2, Qwen Image 2.0, Recraft V4.1, Riverflow 2.5, Seedream 5, Gemini 3.1 Flash TTS, ElevenLabs SFX — were already in the baseline or already covered by Nebula nodes.)*

## Workflow / Platform Gaps (not BYOK model gaps)

These are architectural/platform-level gaps from the agent art-direction-friction doc. They are NOT closable by adding a model node — they require platform features. Listed for completeness only.

- Semantic multi-reference roles and precedence
- Camera/angle edit execution with typed controls
- Integrated-scene / cutout QC
- Environment-aware relighting
- Generic promptable image edit with identity preservation
- Agent-runnable canvas execution
- Live schema/version migration
- Unified asset ingestion/attachment
- Durable async polling/events
- Capability-filtered discovery/provenance
- Complete media metadata
- Duration validation
- Temporal identity/material drift QC
- Loop-safe video generation/QC
- Automated video review
- Measurable camera geometry QC
- Multi-axis approval gates
- User-taste/creative-keeper gate
- Canonical asset roles/lineage
- Camera ownership/gesture/foreground-limb QC
- Content-addressed media storage
- Quick multi-image input
- Provider key health validation
- Durable provider artifact recovery
- Model-route capability matrix
- Shot acceptance rubric
- Reference-role binding contract
- Saved preset/Technique transparency

## Proposed Implementation Waves

### Wave 1 ✅ COMPLETE (committed 7aefe71)
1. ✅ New node `kling-pro` — model enum: v2.6 Pro, v3 Pro, v2.5 Turbo Pro I2V. Custom handler maps `image`→`start_image_url`, `end_image`→`end_image_url`.
2. ✅ Enum expansion on `kling-v3` — add model enum Standard/Pro T2V.
3. ✅ Enum expansion on `flux-kontext` — add model enum base/Max.
4. ✅ Enum expansion on `flux-2-pro` — add model enum Pro/Max.

### Wave 2 (MEDIUM priority, max 4 features)
5. New node `kling-o3-ref` — O3 Pro Reference-to-Video.
6. New node `kling-motion` — v2.6 Pro Motion Control.
7. New node `topaz-video-upscale` — Topaz Video Upscale.
8. New node `grok-imagine-image` — Grok Imagine Image t2i/i2i.

### Wave 3 (MEDIUM + LOW, max 4 features)
9. Enum expansion on `seedream-4-5` — add Seedream 5.0 Lite.
10. New node `sora-2-i2v` — Sora 2 Image-to-Video.
11. Enum expansion on `flux-2-pro` — add Flash option (combined with #4 or separate).
12. New node `esrgan-upscale` — Real-ESRGAN.

### Wave 4+ (LOW priority, remaining)
13-28. Remaining LOW priority items from the table above.
