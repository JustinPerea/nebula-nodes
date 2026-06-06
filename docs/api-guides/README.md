# Nebula Nodes - API Guides

Nebula integrates **15 external AI/media APIs** (image, video, audio, 3D, text/LLM, and SVG). This directory holds the **user-facing guide** for each provider plus a **coverage + agent-skill audit** measuring how much of each provider's API surface Nebula actually wires up, and whether an agent skill exists to drive those nodes.

Per-provider guides live alongside this file at `./<provider>.md` (e.g. [`./fal.md`](./fal.md)).

## Coverage matrix

Sorted by node count (desc). **API coverage** = share of the provider's published API surface reachable through Nebula nodes. **Agent skill** = whether a `.claude/skills/` skill exists to drive the nodes (`complete` / `partial` / `none`). **Top unused capability** = the single most notable gap.

| Provider | Nodes | API coverage | Agent skill | Top unused capability |
|---|---:|---|---|---|
| [FAL (fal.ai)](./fal.md) | 44 | ~52% | complete | Stem separation now wired (Demucs); remaining FAL audio gaps: TTS, voice cloning |
| [OpenAI](./openai.md) | 9 | ~60% | complete | Image variations endpoint (dall-e-2) — no node |
| [Meshy](./meshy.md) | 8 | ~35% | complete | Creative Lab product line (Keychain, Fridge Magnet, Figure, Lamp) — entirely unused |
| [Google (Gemini / Imagen / Veo / Lyria)](./google.md) | 8 | ~45% | complete | Veo reference images (up to 3) and video extension (clips longer than 8s, up to ~148s) |
| [Runway](./runway.md) | 7 | ~65% | complete | Sound-effect generation (POST /v1/sound_effect) — no node |
| [ElevenLabs](./elevenlabs.md) | 6 | ~33% | complete | Music generation (prompt-to-music + stems) — no node |
| [MiniMax (Hailuo)](./minimax.md) | 3 | ~12% | complete | Entire audio stack: TTS (40+ languages), voice cloning, voice design |
| [Krea](./krea.md) | 3 | ~10% | complete | Video generation entirely unused (Veo, Kling, Runway, Hailuo, Seedance, Wan, Ray 2, LTX, Grok — 30+ models) |
| [QuiverAI (Arrow)](./quiver.md) | 2 | ~85% | complete | No user-facing model browser (GET /v1/models data only fills the dropdown) |
| [xAI (Grok Imagine)](./xai.md) | 1 | ~20% | complete | Image generation (grok-imagine-image / -quality) — entire text-to-image modality absent |
| [Replicate](./replicate.md) | 1 | ~20% | complete | Real-time streaming of model output (SSE via urls.stream) — the big one for chat/LLM models |
| [OpenRouter](./openrouter.md) | 1 | ~30% | complete | Tool / function calling (tools, tool_choice) |
| [Nous Portal (Hermes)](./nous.md) | 1 | ~70% | complete | Legacy POST /completions endpoint (and `<think>` prefill via it) not exposed |
| [Higgsfield](./higgsfield.md) | 1 | ~25% | complete | DoP motion/camera presets (getMotions()) — Higgsfield's headline feature — not surfaced |
| [Anthropic (Claude)](./anthropic.md) | 1 | ~20% | complete | Tool use / function calling — both custom client tools and Anthropic server tools entirely unexposed |

## Agent skill gaps

**2026-06-04 update:** A full skill-authoring pass landed — 14 provider skills were created or refreshed. **All 15 providers now have a `complete` agent skill** (0 partial, 0 missing). The "Missing entirely" and "Partial" backlogs below are cleared; every entry now resolves to a shipped skill with its path. Skills are kept self-sufficient (one `SKILL.md` per provider, with a few topic/reference files where the param surface warranted depth) and each includes a Capability boundaries section so an agent never over-promises beyond what the nodes wire.

**Completed this pass (created):**

- ✅ **ElevenLabs** (`.claude/skills/elevenlabs/SKILL.md`) — 5 audio nodes (tts/sfx/sts/isolation/dubbing), per-node param schemas, voice_id handling (free-text, default Rachel), JSON-vs-multipart encoding, dubbing submit→poll internals, and the hard boundary that STT/music/text-to-dialogue/voice-design/cloning are **not** nodes.
- ✅ **MiniMax** (`.claude/skills/minimax/SKILL.md`) — 3 video node IDs and their mode-selecting input ports (t2v/i2v/s2v), model/duration/resolution constraints (10s-only-at-768P, 1080P-only-at-6s), in-prompt camera syntax, async submit→poll→download lifecycle, and the **video-only** scope boundary (no TTS/music/image).
- ✅ **Krea** (`.claude/skills/krea/SKILL.md`) — the 3 node IDs (krea-2-generate, krea-style-search, krea-style-train), the `visibleWhen` quirk hiding learning_rate/batch_size for qwen/z-image, style→generation chaining, the moodboard model (native vs raw moodboard_id, real ref-strength values), and the **only-Krea-2-plus-styles** boundary.
- ✅ **QuiverAI** (`.claude/skills/quiver/SKILL.md`) — node-wiring for quiver-arrow-generate / -vectorize (IDs, SVG output port, every param), model-selection + per-model reference caps (4 for arrow-1/1.1 vs 16 for max), SSE-streaming execution, generate-vs-vectorize guidance, and the unshipped-`svg_edit` boundary.
- ✅ **xAI** (`.claude/skills/xai/SKILL.md`) — node identity (grok-imagine-video), the param contract (duration/aspect_ratio/resolution), async submit-then-poll model (15-min cap), t2v/i2v recipes, and the known gaps (no reference-to-video, edit/extend, image gen/edit, or voice).
- ✅ **Replicate** (`.claude/skills/replicate/SKILL.md`) — auth/setup, the `replicate-universal` contract (one required `model_id`, no fixed ports — all other inputs passed by name), per-model input discovery, recommended default slugs per media type, output-type inference, and the gaps to route around (no Files API, fine-tuning, deployments, or in-app search).
- ✅ **OpenRouter** (`.claude/skills/openrouter/SKILL.md`) — node identity (openrouter-universal), the model-picker contract (modalities drive ports + image flag), param semantics (temperature/max_tokens text-only), recipes, the real `X-OpenRouter-Title` header (not the legacy `X-Title`), and the limits not to over-promise (no tools, structured output, audio/PDF/video, provider routing, image_config, web search).
- ✅ **Nous Portal** (`.claude/skills/nous/SKILL.md` + `HERMES-SETUP.md`) — the node contract (nous-portal-universal), the **no-.env-key** auth model (reads `~/.hermes/auth.json` via OAuth), model guidance for the 3 Hermes models, reasoning usage, and capability boundaries (text-only, no tools/JSON/Tool Gateway).
- ✅ **Higgsfield** (`.claude/skills/higgsfield/SKILL.md`) — node contract (id `higgsfield`, prompt+image→video), model selection (DoP vs Kling/Seedance I2V-only), the image-URL gotcha (non-URL inputs silently dropped), `Authorization: Key …` auth + `platform.higgsfield.ai` base, and the honest video-only boundary (no Soul/Speak/motion-presets).
- ✅ **Anthropic** (`.claude/skills/anthropic/SKILL.md`) — the claude-chat contract (messages + optional images → text, streaming), full param reference (incl. extended-thinking temperature=1 gotcha and filtered thinking, the silently-dropped top_p), accepted image formats, wiring patterns, and in-Nebula limits (single-turn, no tools, no JSON, hardcoded model list).

**Completed this pass (refreshed):**

- ✅ **FAL** (`.claude/skills/fal/SKILL.md`) — reconciled the node→endpoint map to the authoritative **38-node** roster (dropped the stale 39/160 framing and non-current models, fixed the kling-v2-1 slug); added the Nebula input-port → FAL-key mapping; documented base64 inlining and that **only the two GPT Image 2 nodes stream** (all 36 others queue-poll); flagged the audio/LLM/training nodes Nebula cannot reach.
- ✅ **OpenAI** (`.claude/skills/openai/SKILL.md`) — **new broader skill** superseding the gpt-image-2-only coverage; documents all 9 OpenAI-direct nodes (GPT Image 1 / Edit, DALL·E 3, GPT Image 2 generate/edit, TTS, STT, Translate, GPT-4o chat) with full params + handler gotchas, deferring only gpt-image-2 prompt craft to `.claude/skills/gpt-image-2/SKILL.md`.
- ✅ **Google / Gemini** (`.claude/skills/gemini/SKILL.md`) — added the 4 previously-missing nodes (TTS, Lyria, Embeddings, Style Reference); added the real Nebula node-ID/param mapping (was raw-model-ID only); locked all 24 model IDs to the **literal `-preview` enum strings** the nodes ship (the correct fix, not blind suffix-stripping); added a Capability boundaries subsection. The 4 prompting/topic files (nano-banana/veo/imagen/gemini-text) were preserved.
- ✅ **Runway** (`.claude/skills/runway/SKILL.md`) — rewrote to the required section structure; corrected drift (removed the bogus `seedance2` model option, fixed the image-ratio count to the node's 11, corrected TTS/STS/dubbing voice-preset counts to the real node enums, dropped the stale `/v1/uploads` step in favor of the handler's base64 inlining); documented the async-poll-only execution and wire-format gotchas. The 4 topic files were preserved.

**Already complete (unchanged this pass):**

- ✅ **Meshy** (`.claude/skills/meshy/SKILL.md`) — sourced 2026-04-17; still `complete`. Worth a refresh only if Creative Lab, Printability, or Convert/Resize nodes are ever added (the endpoint map + credit table would then need updating).

## Capability gaps worth closing

Across all 15 providers, the most valuable **unused** API capabilities, ranked. (Several are reachable through *another* Nebula provider today — noted where relevant — but remain gaps for that specific provider.)

1. **Speech-to-Text / transcription** — now wired on two direct providers: OpenAI (Whisper STT, pre-existing) and **ElevenLabs STT** (`elevenlabs-stt`, shipped 2026-06-05 — diarization, plain text or SRT/VTT subtitles, feeds Nebula's text-driven nodes directly). The remaining transcription gap is in **FAL's audio catalog**, whose STT models are still unwired.
2. **Real-time output streaming (SSE)** — Replicate's `urls.stream` and FAL's broader `/stream` are unused; the big win for chat/LLM models that currently block-and-poll.
3. **Tool / function calling + structured JSON output** — **structured JSON output now wired** (2026-06-05) on three providers: OpenAI (`gpt-4o-chat`, `response_format: json_object`), Google Gemini (`gemini-chat`, `response_format` → `generationConfig.responseMimeType: application/json`), and OpenRouter (`openrouter-universal`, `response_format: json_object`, live-verified). **Anthropic** (`claude-chat`) remains the holdout — no native `response_format`/JSON-mode param (structured output there would need tool-use or prompt/prefill). **Tool / function calling** is still unexposed across all four providers — the remaining piece of this gap, which blocks agentic workflows.
4. **The FAL audio catalog** — text-to-music/SFX is now wired (Stable Audio 2.5, `stable-audio-25`, 2026-06-05), **ACE-Step** (`ace-step`, music with vocals/lyrics, shipped 2026-06-05 alongside Stable Audio 2.5) covers full songs with synthesized vocals, **MMAudio V2** (`mmaudio-v2`, video→audio Foley, shipped 2026-06-05) generates synchronized sound effects for a video, and **Demucs** (`demucs`, stem separation, shipped 2026-06-05) splits a mixed track into isolated vocals/drums/bass/other stems. The remaining FAL audio gaps are TTS and voice cloning.
5. **Video edit / extend / reference modes** — xAI video edits+extensions, Veo reference images + extension (up to ~148s), FAL/Runway video-to-video families. Extends Nebula past one-shot clips.
6. **Krea's gateway breadth** — 30+ video models, image editing (Flux Kontext/SeedEdit/Seedream), and Topaz upscaling (to 22K) all unwired; some are covered by other providers, upscaling and node-apps are not.
7. **Image upscaling** — FAL now exposes two image upscalers: `seedvr2-upscale` (faithful) and `clarity-upscaler` (creative/added detail, shipped 2026-06-05). **Video upscaling** is now also wired: SeedVR2 Video Upscale (`seedvr-video-upscale`, shipped 2026-06-05) — temporally-consistent video upscale to up to 4K, the first video upscaler in Nebula. The remaining upscaling gap is Runway's `image_upscale` (no node); a common, high-demand post-step.
8. **Inpainting / masked image editing** — FAL hosts inpainting models with no Nebula node.
9. **Prompt caching** — **addressed** (2026-06-05): `claude-chat` and `openrouter-universal` now have an opt-in `prompt_caching` toggle (default off) that sets `cache_control: {type: ephemeral}` breakpoints on the system prefix + last content block, making re-runs within ~5 min a ~90%-cheaper cache read. Opt-in because of a small cache-write premium; Anthropic ignores prefixes under ~1024 tokens so it's safe on short prompts. OpenAI nodes (`gpt-4o-chat`) cache automatically with no param.
10. **Webhooks + cancellation** — **cancellation is now wired across the async providers** (2026-06-05): on node cancellation each handler fires the provider's cancel endpoint (best-effort, on a detached task) so the queued/in-flight job stops upstream instead of running to completion — FAL (`PUT cancel_url`), Runway (`DELETE /tasks/{id}`), Replicate (`POST /predictions/{id}/cancel`), Meshy (`DELETE` the task), Krea (`DELETE /jobs/{id}`), Higgsfield (`POST cancel_url`). MiniMax exposes no documented cancel endpoint (task cancels locally only). **Webhooks** remain unused — a local BYOK app has no public callback URL to receive them.

## Verification notes

All 15 provider audits report `sourcesVerified: true` — capabilities were checked against official documentation. **No provider requires re-verification.**

Two narrower caveats a human may still want to confirm:

- **Nous Portal (Hermes)** — verified, but several wired behaviors are *not* in the public OpenAPI schema: the `GET /models` dropdown proxy and the `images` input port both hit surfaces the text-only Hermes inference API does not document (best-effort/undocumented, not unverified-source).
- **QuiverAI (Arrow)** — verified; note that `svg_edit` appears in the API's `supported_operations` enum but has **no shipped endpoint**, and `svg_animate` (referenced in a Nebula dev note) is **not** in canonical docs. Nothing functional to wire until QuiverAI ships them.
