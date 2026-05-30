# Nebula Persistent-Character System — Research Report (Threads A + B)

> Research session 2026-05-30. Deep-research fan-out (25 primary sources) → robust text-return re-verification (the first run's schema-forced verify phase failed mechanically; sources were sound). Every fact below traces to a canonical source in §6. Feeds the "Nebula Character" design.

## 1. TL;DR

- **Two structurally different ways to keep a character consistent; Nebula needs both eventually.** (1) *Reference-edit / zero-shot* — re-feed reference image(s) every call, nothing stored or trained (nano-banana, Seedream 4.x, FLUX Kontext, IP-Adapter, PuLID). (2) *Trained adapter* — a one-time fine-tune produces a downloadable **LoRA** = the true persistent-identity artifact, reusable across unlimited prompts/scenes via a trigger token.
- **For non-human "steplings," face-ID methods are the wrong tool.** IP-Adapter-FaceID, InstantID, and PuLID-FLUX are all human-face-specialized (face-detection/recognition embeddings). Only **base IP-Adapter** (subject-agnostic, Apache-2.0, zero-shot) and **per-character LoRA / DreamBooth** explicitly support arbitrary non-human/stylized subjects.
- **Ship reference-edit FIRST.** A Character = a stored, named bundle of reference images, fed every call into the edit nodes Nebula ALREADY has (`fal-ai/nano-banana-2/edit` = 14 refs, `fal-ai/bytedance/seedream/v4(.5)/edit` = 10 refs, `fal-ai/flux-pro/kontext/max/multi`). Zero-training, commercial-OK, non-human-capable, reachable today, no new model integration.
- **Trained LoRA is the v2 upgrade for true persistence** — ~12-20 images, ~1000 steps, ~20-30 min, ~$2/run via `fal-ai/flux-lora-fast-training` (supports "styles, people and other subjects") or Replicate `ostris/flux-dev-lora-trainer`. Use the *fast/general* trainer, **NOT** `flux-lora-portrait-trainer` (human-portrait-tuned).
- **FLUX.1-dev licensing is real but doesn't block commercial output.** The dev model and any LoRA derivative are *non-commercial*; the **generated images are explicitly commercially usable** (BFL §2.d). Nebula can ship stepling images commercially — it just must not sell/redistribute the trained adapter itself, or self-host raw dev weights for revenue.
- **Higgsfield's Soul ID = trained character layer** (~10-20+ photos, ~3-5 min, "train once, publish forever"); **Soul Cast = NEW zero-training parametric actor builder.** This validates the two-tier plan (zero-train default + optional trained mode). Identity is the shared primitive under every Higgsfield studio.

## 2. Thread A — AI Character Identity Methods

| Method | Zero-shot or Trained | Persistence | Non-human / stylized | Commercial-OK? | Reachable in Nebula today? | Notes |
|---|---|---|---|---|---|---|
| **Reference-edit** (nano-banana / Seedream 4.5 / FLUX Kontext) | Zero-shot | **Per-use only** — re-feed refs each call | Subject-agnostic (non-human *inferred* from design, not stated on page) | **Yes** — all carry fal "Commercial use" badge | **Yes** — already wired as edit nodes | Ref param = `image_urls`. Max refs: nano-banana-2 = **14**; Seedream v4 = **10** (hard cap, last-10 rule); nano-banana v1 & flux-kontext-multi = *not published by fal* |
| **IP-Adapter (CLIP)** | Zero-shot (adapter trained once) | Reusable adapter, identity is **per-use** conditioning | **Yes — subject-agnostic** | **Yes** — Apache-2.0 | Not hosted on fal today (needs integration) | 22M params; weaker identity lock than a trained LoRA |
| **IP-Adapter-FaceID** | Zero-shot | Per-use (face embedding) | **No** — human-face only | Code Apache-2.0; weight license stricter (unverified) | No | Wrong tool for steplings |
| **InstantID** | Zero-shot, single ref | Per-use | **No** — human-face only (InsightFace) | Code commercial-OK; **required weights = non-commercial research only** | No (SDXL-only) | Blocked at the weights level |
| **PuLID-FLUX** | Zero-shot / tuning-free | Per-use | **No** — face/ID specialized | Code Apache-2.0; underlying FLUX.1-dev non-commercial, but hosted `fal-ai/flux-pulid` labeled "Commercial use" ($0.0333/MP) | **Yes via `fal-ai/flux-pulid`** | Reachable but face-oriented → wrong default for steplings |
| **Per-character LoRA** (fal / Replicate) | **Trained** (~1000 steps, ~20-30 min, ~$2) | **Reuse-everywhere** — downloadable LoRA, true persistent identity via trigger token | **Yes** — fal `flux-lora-fast-training`: "styles, people and other subjects"; Replicate `ostris`: "characters/objects" | **Outputs commercial-OK**; adapter itself = non-commercial Derivative | Trainer reachable; needs a Nebula train node + LoRA-attach generate node | Use *fast/general* trainer, NOT `flux-lora-portrait-trainer`. ~12-20 images |
| **DreamBooth(-LoRA)** | **Trained** (data floor ~4 imgs) | **Reuse-everywhere** — LoRA | **Yes — explicitly demonstrated** (tarot-card style via trigger token) | Same FLUX.1-dev chain | Not hosted; HF script (self-run) | Pivotal tuning + DreamBooth-LoRA; best low-data path |

**FLUX.1-dev licensing chain (decisive for defaults):** FLUX.1 [dev] is **non-commercial only**, and a fine-tuned LoRA is a **Derivative that inherits** that restriction — you can't sell/distribute the adapter as a model or self-host dev weights for revenue (BFL Non-Commercial License v1.1.1/v2.0 §1.a, §2.a-b). **BUT §2.d explicitly permits commercial use of generated Outputs** (sole carve-out: can't train a competing model). Run through a hosted commercially-licensed provider (fal labels FLUX/PuLID/LoRA endpoints "Commercial use"; Replicate asserts commercial output rights), **Nebula's commercial-OK default is safe for FLUX-based reference-edit and even trained-LoRA outputs** — only gate downloading/redistributing the adapter or self-hosting dev weights.

## 3. Thread B — Higgsfield Suite Map

| Product / Feature | What it does | Underlying model | Bring into Nebula? (priority) |
|---|---|---|---|
| **Soul 2.0** | Foundation photo model; "all images commercial use" | Proprietary | Reference only (P3) |
| **Soul ID** | Train-once character consistency; locked across style/pose/lighting | Built on Soul 2.0 | **YES — direct analog to the Nebula Character primitive (P0 concept)** |
| **Soul Cast** | NEW zero-training parametric AI actor builder (genre/era/archetype → consistent actor); $5 exclusivity | Cinema Studio 2.0 stack | **YES — the zero-train Character mode (P1)** |
| **Soul HEX** | Palette/color consistency from a reference | Soul-family | Maybe — a "color-lock" node (P3) — *we already shipped `cinema-color`* |
| **Soul Moodboard** | References → style/tone moodboard | Soul 2.0 | Maybe — feeds Character refs (P2) |
| **Soul Cinema** | Cinematic still model | Proprietary | Reference only — *we shipped `cinema-look`* (P3) |
| **Cinema Studio / 2.0** | Virtual camera/lens, multi-axis moves, frame locking, character consistency | Orchestrates Seedance/Kling/Veo/Sora/Wan | Later — video studio (P3) |
| **Marketing Studio** | One-prompt marketing; URL → avatar → mode → publish | Seedance 2.0 + Soul 2.0 + agent | **YES — Nebula UGC/Marketing studio (P2)** |
| **App Ad Generator** | App URL/screens → avatar screen-demo UGC | Seedance 2.0 + Soul/Nano Banana + TTS/lip-sync | Later (P3) |
| **URL to Ad** | Drop URL → auto script/shots/camera/edit | Marketing Studio pipeline | **YES — ad-from-URL (P2)** |
| **Avatar / Creator system** | 40-100+ avatars; custom avatar from prompt; reuse across campaigns | Soul 2.0 + Seedance 2.0 | **YES — avatar library = Character library (P2)** |
| **Opener / Hook Generator** | Proven hook options matched to format | LLM/script layer | Later (P3) |
| **UGC / Pro / CGI formats** | Talking head, review, unboxing, try-on, Hyper Motion, TV Spot | Seedance 2.0 | Later (P3) |
| **Video model lineup** (Seedance 2.0 / Kling 3.0 / Veo 3.1 / Sora 2 / Wan 2.7 / MiniMax …) | 3rd-party video models | various | Reference for Nebula's video node lineup (P3) |
| **Nano Banana / Reve** | Image refine / prompt-faithful T2I | Gemini edit / Reve | Nano Banana already in Nebula |
| **Virality Predictor / Face Swap / BG Remover / Transitions** | Utility tools | n/a | Skip / much later |

**How Soul ID works (precise):** A **train-once character-consistency layer on Soul 2.0**. Upload **~10 to 20+ photos** of one persona (Higgsfield's own pages conflict: ~10+ vs "20+"; ≥1 full-height, recent). It "trains this AI model… locks in unique facial features and carries them across every picture." **Training ≈3-5 min** (pages conflict 3 vs 5). Artifact = a **named, reusable character** in a "Character" tab — "no need to re-upload references… stays locked in," a "digital twin," tagline **"Train once, publish forever."** Multiple characters per account. **NOT zero-shot** (requires upload+train). Commercial use inherited from Soul 2.0. Caveat for steplings: photo guidance is **face-centric** (human-tuned).

**Soul Cast (new):** A **parametric, zero-training AI actor builder inside Cinema Studio 2.0** — no photos, no training. Select genre/budget/era/archetype/identity/appearance/outfit → an actor "consistent across every scene" + auto backstory. **$5 one-time for sole usage rights.** Maps cleanly to a Nebula "zero-train Character" mode.

## 4. Recommendation — the "Nebula Character" Primitive

**What a Character asset should BE:** a first-class, stored, named entity in the graph store — *not* a transient node input:

- `id`, `name`, `thumbnail` (auto from refs) — shows in a Character library palette.
- `referenceImages: string[]` — canonical refs, capped at the strictest downstream limit (start 10 for Seedream's hard cap; nano-banana-2 allows 14).
- `promptContext?` — optional text descriptors / trigger phrase folded into edit prompts.
- `mode: "reference" | "trained"` — reference = re-feed images per call (v1); trained = points at a stored LoRA (v2).
- `trainedAdapter?: { provider, loraUrl, triggerToken, baseModel: "flux-dev", commercialOutputsOnly: true }`.
- `subjectType: "human" | "non-human" | "stylized"` — drives which method is offered (gates face-ID to human).

**Ship FIRST: the reference-edit Character (v1).** It's the only path satisfying all four constraints (BYOK + node-graph + non-human + commercial-OK) *today with zero new model integration*: zero-training, subject-agnostic (works for steplings where every face-ID method fails), commercial-OK on fal, reuses existing edit nodes. Face-ID family is **deprioritized** — it can't handle non-human characters; relevant only for the later human-avatar/Marketing track.

**Phased path:**
- **v1 — Reference-edit Character (build now).** A Character asset in `graphStore`; a "Character" input pin / picker on the edit nodes (`nano-banana-2/edit`, `seedream/v4.5/edit`, `flux-pro/kontext/max/multi`) auto-populates `image_urls` from the asset's refs every run. Same asset usable on canvas AND injected into the Cinema Studio (and future Studios). Default: **nano-banana-2/edit** (14 refs, commercial, Gemini 3.1) for steplings; Seedream v4.5 as the 10-ref alternative. Nebula's "Soul Cast-equivalent" zero-train tier.
- **v2 — Optional trained-LoRA mode.** A **Train Character** node wrapping `fal-ai/flux-lora-fast-training` (general/non-human, ~12-20 imgs, ~$2) → stores `loraUrl`+`triggerToken`. A "trained" Character drives a LoRA-attach generate node (`fal-ai/flux-lora`). Surface the FLUX.1-dev gate (outputs OK, adapter not for resale). Nebula's "Soul ID-equivalent" trained tier — true persistence.
- **v3 — Face-ID modes (human only).** `fal-ai/flux-pulid` (later InstantID/FaceID) as a `subjectType: human` option for the Marketing/UGC track. Gated behind the human flag so it's never offered for steplings.

## 5. Higgsfield → Nebula Roadmap (post-Character)

Identity is the shared primitive — every item consumes the Character asset from §4.
1. **Avatar / Character library** — palette of saved Characters (reference + trained), reusable across canvas + all Studios. Direct analog to Higgsfield's avatar system. Lowest-effort, highest-leverage next step.
2. **Marketing / UGC Studio** — a studio surface composing Character + product + format into publish-ready output. Each format = a preset subgraph.
3. **Ad-from-URL** — paste a product URL → extract name/desc/images → auto-assemble a Character-driven ad subgraph.
4. **Speak / lip-sync** — talking-head output. (NB: Higgsfield delivers lip-sync *inside* Seedance 2.0; no standalone "Speak"/"Draw-to-Video" product was found — treat those names as unverified.)
5. **Opener/Hook + Ad Reference generators** — LLM/script layer. Later.
6. **Video studio (Cinema-Studio analog)** — virtual camera, frame locking, character consistency across shots. Largest scope; last.

## 6. Sources

- fal.ai: `nano-banana/edit`, `nano-banana-2/edit`, `bytedance/seedream/v4/edit` (+v4.5), `flux-pro/kontext/max/multi`, `flux-pulid`, `flux-lora-portrait-trainer`, `flux-lora-fast-training`
- GitHub: `tencent-ailab/IP-Adapter`, `instantX-research/InstantID`, `ToTheBeginning/PuLID`, `black-forest-labs/flux` (LICENSE-FLUX1-dev) · bfl.ai/legal/non-commercial-license-terms
- Replicate: `blog/fine-tune-flux`, `ostris/flux-dev-lora-trainer`
- HuggingFace: `blog/linoyts/new-advanced-flux-dreambooth-lora`
- higgsfield.ai: `/soul-intro`, `/soul-cinema`, `/soul-cast-intro`, `/ai-video`, `/marketing-studio-intro`, blog: `SOUL-ID-Superior-Level-of-AI-Character-Consistency`, `sould-id-best-character-consistency`, `Higgsfield-SOUL-ID-Turns-Your-Photos-Into-AI-Character`

## 7. Open Questions / Gaps

- **Max ref-image count for `fal-ai/nano-banana/edit` (Gemini 2.5) and `flux-pro/kontext/max/multi`** — not in fal's rendered schema; verify before hard-coding a cap.
- **`fal-ai/flux-pulid` advanced param names** (true_cfg, id_weight, …) — confirm via the fal API tab before wiring.
- **IP-Adapter-FaceID weight license** (separate from Apache-2.0 code) — check the HF card if ever considered.
- **Seedream v4.5 edit max refs** — assumed ~10 like v4; verify.
- **Explicit non-human support** — none of the four reference-edit pages state it; inferred from subject-agnostic design. **Run a quick empirical test with a stepling reference before committing the default.**
- **Higgsfield internal contradictions** — Soul ID image count (~10 vs 20+) and training time (3 vs 5 min) conflict across its own pages; don't quote a single authoritative number.
- **No canonical "Speak"/"Draw-to-Video" Higgsfield product** found — lip-sync lives inside Seedance 2.0; treat those names as unverified.
