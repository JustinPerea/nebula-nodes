# ComfyUI vs Flora vs Figma Weave vs Nebula — 4-way decision

> Generated 2026-06-28 via a multi-agent workflow (5 parallel research agents → 1 synthesis). Builds on, and does **not** replace:
> - `comfyui-capability-reference.md` (the canonical 16-section "everything ComfyUI does" reference — **verified still accurate against the live install**, see §1)
> - `flora-comfyui-gap-analysis.md` (the 65-gap Flora+ComfyUI competitive analysis — this doc adds **Figma Weave** as a third competitor and the **add-to-Nebula decision**, and corrects 3 stale Flora claims, see §5)
>
> **Question answered:** what does ComfyUI have, what makes it different from Flora AI and Figma Weave, and does it make sense to add what ComfyUI does to Nebula?
>
> **Bottom line:** Adopt ComfyUI's **graph-interaction + reproducibility layer** (needs zero local weights, and it's exactly what both hosted rivals hide). **Decline** its local open-weight diffusion engine — that's ComfyUI's deepest moat *and* precisely what Nebula's BYOK/no-server/no-markup thesis forks away from. Market the decline as the feature: "no GPU, no server, your keys."

---

## 1. Live-install verification (the user has ComfyUI installed)

Audited `/Users/justinperea/ComfyUI` against the existing capability reference:

- **Version:** `v0.26.0`, commit `7cb784e` (2026-06-25). The reference was compiled 2026-06-22 → install is **3 days / one point-release newer**. No doc claim is contradicted by the install.
- **Surface:** `comfy_extras/` = 123 modules · `nodes.py` = 2,544 lines (~400+ core node classes) · `supported_models.py` = 94 model classes · `comfy_api_nodes/` = **36 hosted/partner provider modules** · 6 third-party custom nodes (essentials, KJNodes, Krea2T-Enhancer, Manager, RBG-SmartSeedVariance, rgthree).
- **Only deltas** (uncaptured in the reference, worth a later refresh): v0.26.0–v0.26.2 catalog growth (Krea 2 open-weight, SeeDance 2.0 4K/Mini, HappyHorse 1.1, Boogu-Image, Luma Ray 3.2, `Load3DAdvanced`, saver-node output socket, Jobs-API cancel) + ~9 newer `ldm/` families (anima, krea2-local, chroma_radiance, hidream_o1, sam3, depth_anything_3, moge, rt_detr, triposplat).

**Conclusion: the existing reference is accurate and on-commit.** This doc therefore distills rather than re-derives it.

---

## 2. Everything ComfyUI can do (9-domain distillation)

ComfyUI is an open-source, local-first **node-graph engine for generative media**. The graph *is* the program — fully inspectable, editable, reproducible — and the same machinery drives image, video, audio, and 3D. Its defining line is the **local/open boundary**: everything below the account line is free and runs locally; a strictly opt-in, credit-metered **Partner Node** layer + hosted **Comfy Cloud** sit above it.

1. **Execution engine** — topological DAG, content-addressed caching + **partial re-execution** (re-runs only changed nodes, reports which were skipped), `IS_CHANGED`, `ExecutionBlocker` branch-skip, **lazy eval**, **node expansion** (a node returns a subgraph at runtime → tail-recursion loops), async nodes, V3 stateless schema.
2. **Node editor UX** — **bypass/mute/pin**, **widget↔input conversion**, **subgraphs** (collapse + publish as blueprint), groups/frames, GPU mask editor, connection-preserving paste, minimap, Nodes 2.0 renderer.
3. **Image pipeline** — checkpoint/UNet/CLIP/VAE loaders, **44 samplers × 9 schedulers**, **decomposed sampling** (separate NOISE/SAMPLER/SIGMAS/GUIDER sockets), full latent toolkit, broadest open-weight architecture coverage with same-day cadence.
4. **Conditioning & structural control** — CONDITIONING as a first-class wire: regional/area/mask/timestep prompting, **ControlNet**, T2I-Adapter, GLIGEN, unCLIP, inpaint/outpaint.
5. **LoRA / merging / model surgery** (all core) — LoRA/LyCORIS/DoRA chaining, **per-architecture block merge**, **SVD LoRA-extraction from a model diff**, runtime UNet patches (FreeU/PAG/SAG/Deep-Shrink/ToMe/torch.compile).
6. **Video / audio / 3D** — one engine, not four products: Wan/Hunyuan/LTX/Mochi/Cosmos video, Stable Audio + ACE-Step music, Hunyuan3D mesh + Load3D viewport (its outputs feed ControlNet).
7. **Workflow formats** — graph JSON vs API "prompt" JSON; **workflow-in-output-metadata** (the saved PNG/FLAC/MP4 *is* the workflow — drag it back, the full graph + `models[]` reconstitutes); templates + subgraph blueprints.
8. **Extensibility** — three axes: V1/V3 **Python node contract**, **JS frontend extension API**, and a **Registry + Manager + comfy-cli** distribution layer (SemVer, immutable versions, malware scanning).
9. **Platform / API / deployment** — same workflow JSON runs unchanged across Desktop / portable / headless / Comfy Cloud; REST + WebSocket API; 36 opt-in credit-metered **Partner Nodes**; `--disable-api-nodes` is a true air-gap switch; official Cloud MCP + community local MCP.

---

## 3. The 4-way differentiation matrix

| Axis | **ComfyUI** | **Flora AI** | **Figma Weave** | **Nebula Nodes** |
|---|---|---|---|---|
| **Execution model** | LOCAL open-weight inference (your GPU) | HOSTED model APIs, multi-tenant, account-billed | HOSTED model APIs, browser SaaS | LOCAL-first **BYOK proxy** to hosted APIs (your machine, your keys, no server) |
| **Graph paradigm** | Node-dataflow DAG (graph IS the program) | Node-dataflow canvas | Node-dataflow canvas + design layers/compositing (hybrid) | Node-dataflow DAG + **7 non-node Studios** |
| **Primary user** | ML tinkerer / pipeline engineer | Generalist creator, film/brand/agency | Product & brand designer (Figma-native) | BYOK power-user / local-first creator |
| **Collaboration** | Single-player (self-host, no built-in auth) | **Real-time multiplayer** + comments + shared credits | Async (Community share, Figma-frame sync); live canvas multiplayer **UNVERIFIED** | Single-player today |
| **Openness & license** | Open-source, self-hostable, free engine | Closed SaaS | Closed SaaS (SOC2, no-train) | **AGPL, open, no telemetry** |
| **Model coverage & depth-of-control** | Local open weights + 36 partner APIs; **44 samplers × 9 schedulers, decomposed sampling, ControlNet, LoRA chains, block-merge** | 50+ models / ~20 providers; **prompt-box depth** (plumbing hidden) | Multi-vendor hosted + pro-edit primitives; plumbing hidden | 300+ models via 4 universal nodes + 14 families; **prompt/param depth, no sampler/latent control** (by thesis) |
| **Extensibility** | **Custom-node ecosystem** (Registry + Manager + V1/V3 Python + JS API) | Techniques + Technique Builder (no code) | Weave tools / publishable workflows (no code) | Handler-per-provider; no third-party plugin surface yet |
| **Cost model** | **Zero-marginal local compute** + opt-in prepaid credits for partner APIs | Seat + credit metered (markup) | Seat + credit metered (markup) | **BYOK pass-through, zero markup** (cost-meter not yet built) |

---

## 4. What makes ComfyUI different — its genuine moat

The things ComfyUI does that **neither Flora nor Weave can** (and *why* they structurally can't):

1. **Local open weights on your own GPU** — custom checkpoints, community LoRAs, uncensored/niche fine-tunes no hosted API will serve. Both rivals are curated-hosted-API only.
2. **Decomposed sampling** — separate NOISE/SAMPLER/SIGMAS/GUIDER sockets; impossible over an API that exposes at most a sampler dropdown.
3. **Model surgery without retraining** — LoRA/DoRA chaining, block-merge, SVD LoRA-extraction, runtime UNet patches. Needs weight access.
4. **Open custom-node ecosystem** — versioned Registry/Manager + Python/JS authoring. Flora Techniques & Weave tools are closed no-code packages.
5. **Runtime graph control flow** — node expansion, loops, lazy eval, branch-skipping. Hosted single-shot canvases have no analog.
6. **Workflow-in-output-metadata** — the render *is* the editable, version-pinned pipeline. No hosted tool round-trips a render back into a graph.
7. **Zero-marginal-cost local compute + true air-gap.** Flora/Weave meter every generation and can't run offline.
8. **Same-day open-model support** as a community habit (Krea 2 / SeeDance 2.0 / Boogu within days).

### Positioning the three competitors
- **ComfyUI** = open local ML engine for **control/depth** (owns weights + open code; weak on polish/collab/licensing).
- **Flora** = hosted multiplayer aggregator-canvas for **speed/breadth** (50+ API models, FAUNA agent, Techniques, real-time multiplayer; deliberately hides depth).
- **Figma Weave** = **VERIFIED real** — the rebranded **Weavy** (Tel-Aviv startup, acquired by Figma Oct 2025 ~$200M per TechCrunch, integrated into Figma Design at Config 2026, June 24 2026). Architecturally **Flora-like** (multi-vendor, credit-metered, plumbing-hidden, designer-targeted node canvas). Its moat over Flora is **distribution** — welded to Figma (Weave tools in the left panel, Figma frames pasted as live synced nodes, enterprise billing/brand) — **not** a deeper engine. Caveat: live multiplayer co-editing *on the Weave canvas* is **not documented in any primary source** — Weave's real edge today is the Figma bridge, not collaboration.

**So Flora and Weave fight on the same hosted/curated/designer axis. ComfyUI is on a different axis (open local depth). Nebula sits on Flora's structural axis but carries ComfyUI's openness ethos (local-first, BYOK, AGPL, no markup).**

---

## 5. Does it make sense to add ComfyUI to Nebula? — the decision

**Decision in one line: adopt ComfyUI's graph-interaction and reproducibility layer; do NOT adopt its local open-weight inference engine.**

Why the surface area is small: Nebula has **already eaten the Flora-axis ergonomics layer** (PRs #6–#14 merged — perf, ⌘K palette, notifications, onboarding, friendly errors, unified Assets, prompt Enhance, compare slider, image export, auto-layout, canvas search, document node, run-history) and is Flora's structural analog. The remaining ComfyUI value worth capturing is the **graph-power-user interaction primitives + reproducibility** — all of which need **zero local weights**. The Weave triangulation sharpens it: since *both* Flora and Weave hide the plumbing, the **exposed, controllable, reproducible graph** is exactly where a local-first Nebula can out-craft both.

### ✅ BUILD NOW (local-first compatible — ships ComfyUI's interaction moat without inference)
1. **bypass / mute / pin** (`g-node-execution-states`) — highest-value missing interaction; pure frontend + engine skip-flags. **First.**
2. **workflow-in-output-metadata** — embed graph JSON in exported PNG/WebP, drag-to-reconstitute. ComfyUI's signature reproducibility; amplifies the already-merged export node; neither rival has it.
3. **widget↔input conversion** — promote any param to a typed port; cheap, foundational for parametric wiring.
4. **subgraphs** — collapse + publish reusable nodes; Nebula's honest local answer to Flora Techniques / Weave tools, no hosted marketplace needed.
5. **lazy-eval + ExecutionBlocker + per-node cache-rerun opt-out** — real DAG control flow; closes the **stale-cache correctness hole** where random-seed/live-API nodes serve cached output within the existing sha256/1h-TTL cache.
6. **app-feedback-layer** — toast + promise-dialog replacing blocking `window.alert/confirm`; small, but it's the dev-repo→product line.
7. **honest BYOK cost meter** (`g-usage-cost-tracking`) — not strictly ComfyUI, but repeatedly named Nebula's key differentiator and **still not built**. Flora hides cost behind a percentage "flower meter" (dollars opt-in); Weave behind credits. A transparent no-markup **real-dollar** meter is a win only Nebula's BYOK model earns.

### ⚠️ OSS-REFRAME (capture the value as a local/honest version — needs a product call)
- **node-expansion/loops** → a bounded iterate node, not full Turing-complete graph mutation.
- **MCP server / headless jobs API first** (Daedalus already exists) → expose the graph to external agents like Flora's GA MCP, *before* any third-party-plugin surface.
- **custom-node ecosystem** → decide deliberately; a curated BYOK app may rightly never want arbitrary third-party Python nodes.
- **workflow-manager + userdata store** → filesystem-backed/local, not a hosted account.
- Separately: **merge the parked Cinema per-shot PRs #15/#16** — the biggest done-but-unshipped item, unrelated to the inference question.

### 🛑 AGAINST THESIS — the elephant, stated plainly
The **entire local open-weight diffusion pipeline as nodes** (KSampler + 44 samplers/9 schedulers, decomposed sampling, all weight loaders, latent toolkit, model merging/LoRA-surgery/runtime UNet patches, VRAM/multi-GPU/precision). This is ComfyUI's deepest moat **and** exactly what BYOK-to-hosted-APIs excludes. **Verdict: not worth crossing.** Owning a CUDA/PyTorch runtime + weight management + VRAM flags is a *different product* with a different cost structure and user. Decline decisively and market the decline. Also 🛑: hosted accounts/seats/roles, Comfy-Cloud-style hosted execution, prepaid-credit markup, JWT/OAuth multi-user auth.

---

## 6. This week (actionable)
1. **Ship bypass/mute/pin first** — cheapest, highest-value graph interaction.
2. **Wire the honest BYOK dollar cost-meter** — unique positioning vs Flora's flower-meter and Weave's credits.
3. **Merge the parked Cinema per-shot PRs #15/#16.**

That combination keeps Nebula on Flora's structural axis while out-crafting both hosted rivals on **graph control + reproducibility** — the one place a local-first, AGPL tool can win.

### Portfolio moments (Design Engineer track)
- **bypass/mute/pin** as a node-graph micro-interaction study (the A/B-a-step-without-rewiring affordance).
- **workflow-in-output-metadata** (drag a render back into an editable graph) — a genuinely novel reproducibility demo for `/lab` on justinperea.com.
- The **honest BYOK cost meter** — a build-in-public-worthy "transparent vs hidden pricing" design story.

---

## 7. Corrections to `flora-comfyui-gap-analysis.md` (re-verified 2026-06-28)
Three Flora claims in the existing doc are now stale and should be read with these corrections:
1. **Domain moved:** `florafauna.ai` now 301-redirects to **`flora.ai`** (docs at `docs.flora.ai`, dev docs at `developer.flora.ai`). MEMORY/docs still say the old domain.
2. **Cost transparency is opt-in, not default:** Flora's default meter is a percentage **"flower meter"**; per-run dollars require toggling Preferences → "Show generation costs in dollars." (The "dollar-transparent cost" framing overstated it.) FAUNA usage is free.
3. **Collaboration model:** workspaces are **isolated** (no cross-workspace collab); by default all seats draw from **one shared usage pool** (per-user budgets are an optional admin toggle). "Multiple FAUNA agents in parallel" is **Coming Soon**, not live. Real-time multiplayer on the same file + comments + Publish-to-Community are confirmed. Flora is now **GA** on both public API and MCP.

> Provenance: ComfyUI verified against the live v0.26.0 install + the canonical reference; Figma Weave from primary Figma sources (figma.com/blog, weave.figma.com, weave.figma.com/pricing, help.figma.com Config-2026); Flora from flora.ai + docs.flora.ai; Nebula from the live codebase (node_definitions.json, 7 workspace dirs, PR merge-vs-open state via gh).
