# Everything ComfyUI Can Do — a capability reference

> Compiled 2026-06-22 by a multi-agent workflow: deep research per domain → adversarial fact-check against canonical sources → completeness critic → assembly. Sources are limited to docs.comfy.org, github.com/comfyanonymous/ComfyUI (+ Comfy-Org repos), and the official Comfy blog/release notes. ComfyUI moves fast — version-specific claims are date-stamped where known.

## Orientation

### What ComfyUI is, in full

ComfyUI is an open-source, **local-first node-graph engine for generative media**. Instead of a single "prompt box," you build a *workflow*: a directed acyclic graph of typed nodes that you drop on an infinite canvas and wire together — load a model, encode text into conditioning, denoise a latent with a sampler, decode it back to pixels. Its own README calls it "the most powerful and modular AI engine for content creation." The graph *is* the program, and that program is fully inspectable, editable, and reproducible.

The paradigm is **explicit pipelines over hidden defaults**. Where most tools bury the diffusion stack behind a UI, ComfyUI exposes every step as a discrete node with typed inputs and outputs. That's the source of both its power (anything in the pipeline is reachable and recombinable) and its learning curve (you assemble the pipeline yourself). The same graph/latent/sampler machinery is not image-only — it drives **video, audio, and 3D** through core nodes with official example workflows.

What it's exceptional at: **control and reproducibility**. Fine-grained conditioning (masking, time-ranges, regional prompting, ControlNet, IP-Adapter), surgical model work (LoRA stacking, checkpoint merging, weight adapters), and a deterministic execution engine that caches unchanged nodes and re-runs only what changed. Because a workflow can be embedded inside its own output image, an exported PNG often *is* the workflow — drag it back in and the whole graph reconstitutes.

The **local-first / open boundary** is the defining line of the project. ComfyUI is fully open-source and runs every model locally for free; you own the weights, the data, and the box they run on. Layered on top — strictly opt-in — are **API / Partner Nodes** that call closed-source hosted models through a Comfy account and a credits system, plus an optional **Comfy Cloud** hosted runtime. Everything below the account line is free and local; everything above it is an account-gated convenience. The same workflow JSON runs across the Desktop app, a portable/manual install, headless server mode, and the cloud.

It is also **extensible along three axes**: a Python backend node contract (the V1 dict API and newer V3 `io.Schema` API), a JavaScript frontend extension API (`app.registerExtension`), and a distribution layer — the Comfy Registry, ComfyUI-Manager, and `comfy-cli` — for installing, updating, and reproducing nodes and models. A large custom-node ecosystem extends the core surface, and an **MCP layer** lets AI agents drive ComfyUI as a set of callable tools rather than by hand at the canvas.

**How to read this doc.** The 16 sections fan out from the center: start with *Overview & Philosophy* and the *Execution Engine & Graph Model* for the mental model, then *Node Editor & Canvas UX* for how you actually build. The pipeline sections (*Image Generation*, *Conditioning & Structural Control*, *LoRA / Merging / Surgery*, *Beyond Images: Video, Audio, 3D*) cover what you can make. The operational sections (*Workflow Management & Formats*, *Queue/History/Execution Control*, *Platform/API/Deployment*, *Installation & Desktop*, *Manager & Model Management*) cover how you run and reproduce it. The frontier sections (*Extensibility*, *API/Partner Nodes & Credits*, *MCP & Agent-Driven Operation*, *Recent Evolution 2025–2026*) cover where it's going. Use the **Capability Map** below for a 60-second tour and the **Glossary** when a term is unfamiliar.

## Capability map (the 60-second tour)

### Capability Map — the whole surface in 60 seconds

| Capability area | What you can do | See section |
|---|---|---|
| Paradigm & philosophy | Build generative-media pipelines as an explicit, modular node graph; run everything locally and open-source | Overview & Philosophy |
| Execution engine | Run a workflow as a DAG with caching, partial re-execution, lazy evaluation, and node expansion (`execution.py`, `comfy_execution/`) | Execution Engine & Graph Model |
| Node editor & canvas | Drop typed nodes on an infinite canvas, wire outputs to inputs, reroute, group, bypass, and collapse — Vue/TS frontend over LiteGraph.js | Node Editor & Canvas UX |
| Image generation | Run the full diffusion stack as nodes: load checkpoint/UNet/CLIP/VAE → encode prompt → prep latent → KSampler → VAE decode | Image Generation Pipeline |
| Conditioning & control | Combine, mask, time-range, and region prompts; steer with ControlNet and IP-Adapter on the `CONDITIONING` wire | Conditioning & Structural Control |
| Model surgery | Stack LoRAs, merge checkpoints, apply weight adapters, and do block-level model patching — all in core | LoRA, Model Merging & Model Surgery |
| Video / audio / 3D | Drive video, audio, and 3D generation with the same graph/latent/sampler machinery via core nodes + example workflows | Beyond Images: Video, Audio, 3D |
| Workflow formats | Save/load the graph as portable JSON (UI + API shapes), embed it in output media, and load from a Templates library | Workflow Management & Formats |
| Extensibility | Author custom nodes (Python V1 dict / V3 `io.Schema`), extend the frontend (`app.registerExtension`), and publish to the Registry | Extensibility & the Custom-Node Ecosystem |
| Platform & deployment | Serve an HTTP + WebSocket API from `main.py`; run as Desktop app, portable install, headless server, or Comfy Cloud — same JSON everywhere | Platform, API & Deployment |
| Recent evolution | Track ~weekly releases (0.3.x → 0.x), new model-day support, schema migrations, frontend rewrites (2025–2026, date-stamped) | Recent Evolution (2025–2026) |
| API / Partner nodes | Call closed-source hosted models through an opt-in, account-gated, credit-metered layer (`comfy_api_nodes/`) | API Nodes / Partner Nodes & Credits |
| MCP & agents | Expose ComfyUI as callable tools so an AI agent (Claude Code/Desktop, Cursor, Amp) drives the graph instead of a human | MCP and Agent-Driven Operation |
| Queue & run control | Queue, batch, prioritize, cancel, replay, and partially execute runs from the run-management UI | Queue, History & Execution Control UX |
| Installation & Desktop | Install via Desktop app, manual/portable, or headless — distinct trees at docs.comfy.org, same engine underneath | Installation, Runtime Distribution & ComfyUI Desktop |
| Manager & model mgmt | Install/update/reproduce nodes and models via ComfyUI-Manager, `cm-cli`, `comfy-cli`, the Registry, and the on-disk model layout | ComfyUI Manager & Model/Node Management Infrastructure |

## Contents

1. [Overview & Philosophy](#overview-philosophy)
2. [Execution Engine & Graph Model](#execution-engine-graph-model)
3. [Node Editor & Canvas UX](#node-editor-canvas-ux)
4. [Image Generation Pipeline](#image-generation-pipeline)
5. [Conditioning & Structural Control](#conditioning-structural-control)
6. [LoRA, Model Merging & Model Surgery](#lora-model-merging-model-surgery)
7. [Beyond Images: Video, Audio, 3D](#beyond-images-video-audio-3d)
8. [Workflow Management & Formats](#workflow-management-formats)
9. [Extensibility & the Custom-Node Ecosystem](#extensibility-and-the-custom-node-ecosystem)
10. [Platform, API & Deployment](#platform-api-deployment)
11. [Recent Evolution (2025–2026)](#recent-evolution-2025-2026)
12. [API Nodes / Partner Nodes and the Comfy Account & Credits Layer](#api-nodes-partner-nodes-credits)
13. [MCP and Agent-Driven Operation](#mcp-agent-driven-operation)
14. [Queue, History & Execution Control UX](#queue-history-execution-control-ux)
15. [Installation, Runtime Distribution & ComfyUI Desktop](#installation-runtime-distribution-desktop)
16. [ComfyUI Manager & Model/Node Management Infrastructure](#manager-model-node-management)

---

## <a id="overview-philosophy"></a>Overview & Philosophy

ComfyUI is an open-source, local-first **node-graph engine for generative media**. The project describes itself in its own README as *"the most powerful and modular AI engine for content creation"* and as *"the AI creation engine for visual professionals who demand control over every model, every parameter, and every output."* The official docs frame it as *"a node-based interface and inference engine for generative AI"* where *"users can combine various AI models and operations through nodes to achieve highly customizable and controllable content generation"* — and as *"The most powerful open source node-based application for generative AI."*

The distinguishing trait is that ComfyUI is both a **GUI and an inference engine in one**: the node graph you draw on the canvas *is* the program that gets executed, and the same backend runs that graph whether you're clicking in the browser or driving it over the HTTP API. It is not a wrapper around a hidden pipeline; the pipeline is the graph.

### What it generates

A single ComfyUI install can produce **images, video, audio, 3D models, and more** from one unified node interface — the docs note *"A ComfyUI workflow can generate any type of media: image, video, audio, AI model, AI agent, and so on."* The supported model architectures (verbatim from the README, current as of June 2026) span:

- **Image:** SD1.x, SD2.x, SDXL, SDXL Turbo, Stable Cascade, SD3 and SD3.5, PixArt Alpha and Sigma, AuraFlow, HunyuanDiT, Flux, Lumina Image 2.0, HiDream, Qwen Image, Hunyuan Image 2.1, Flux 2, Z Image, Ernie Image
- **Image editing:** Omnigen 2, Flux Kontext, HiDream E1.1, Qwen Image Edit
- **Video:** Stable Video Diffusion, Mochi, LTX-Video, Hunyuan Video, Wan 2.1, Wan 2.2, Hunyuan Video 1.5
- **Audio:** Stable Audio, ACE Step
- **3D:** Hunyuan3D 2.0

Native support for new open-weight models tends to land in core quickly after release — the project runs a **weekly release cycle targeting Monday**, and *"releases a new major stable version (e.g., v0.7.0) roughly every 2 weeks."*

### The graph/dataflow paradigm vs. prompt-box tools

The mental model is **visual dataflow programming**, not a form. The canonical concepts:

- **Workflow (a.k.a. graph)** — *"a collection of program objects called nodes that are connected to each other, forming a network"* (the docs note this network is *"also known as a graph"*). The docs call it *"a high-level visual programming environment allowing users to design complex systems."*
- **Nodes** — the fundamental units of work (load a checkpoint, encode a prompt, sample, decode, save). Each node has typed inputs and outputs.
- **Links** — the wires between nodes (*"also referred to as connections or wires"*) that *"carry data from one node's output to another node's input, defining the flow of your workflow."*

How this differs from prompt-box tools (Automatic1111, DALL·E web, Midjourney) and why people choose it:

| Prompt-box / form tools | ComfyUI graph |
|---|---|
| Fixed pipeline; you fill in fields | You *build* the pipeline; every step is a node you can rewire |
| Internal steps (VAE decode, latent ops, conditioning) are hidden | The graph exposes every step; the README notes core *"only re-executes the parts of the workflow that change between executions"* |
| One model, one happy path | Mix architectures, ControlNets, LoRAs, upscalers, and custom nodes in arbitrary topologies |
| Output is the artifact | The *workflow itself* is a reusable, shareable artifact (saved as JSON, and embedded in generated PNG/WebP/FLAC metadata so a finished image carries the full graph + seeds that made it) |

The cost of this power is a steeper learning curve — there is no single "generate" box; you assemble the graph (or load a template). The payoff is exact reproducibility and total control, which is precisely the project's stated value proposition: *"control over every model, every parameter, and every output."*

### Concrete vocabulary: samplers and schedulers

Because the graph exposes the actual inference machinery, the core sampling node (`KSampler`) surfaces the full algorithm list rather than presets. The lists below are taken from `comfy/samplers.py` (canonical source, June 2026); the file is the authoritative source of truth, as new samplers are added there frequently.

- **Samplers** (`KSAMPLER_NAMES` plus the appended `ddim`, `uni_pc`, `uni_pc_bh2`): `euler`, `euler_cfg_pp`, `euler_ancestral`, `euler_ancestral_cfg_pp`, `heun`, `heunpp2`, `exp_heun_2_x0`, `exp_heun_2_x0_sde`, `dpm_2`, `dpm_2_ancestral`, `lms`, `dpm_fast`, `dpm_adaptive`, `dpmpp_2s_ancestral`, `dpmpp_2s_ancestral_cfg_pp`, `dpmpp_sde`, `dpmpp_sde_gpu`, `dpmpp_2m`, `dpmpp_2m_cfg_pp`, `dpmpp_2m_sde`, `dpmpp_2m_sde_gpu`, `dpmpp_2m_sde_heun`, `dpmpp_2m_sde_heun_gpu`, `dpmpp_3m_sde`, `dpmpp_3m_sde_gpu`, `ddpm`, `lcm`, `ipndm`, `ipndm_v`, `deis`, `res_multistep`, `res_multistep_cfg_pp`, `res_multistep_ancestral`, `res_multistep_ancestral_cfg_pp`, `gradient_estimation`, `gradient_estimation_cfg_pp`, `er_sde`, `seeds_2`, `seeds_3`, `sa_solver`, `sa_solver_pece`, `ddim`, `uni_pc`, `uni_pc_bh2`.
- **Schedulers** (`SCHEDULER_NAMES`): `simple`, `sgm_uniform`, `karras`, `exponential`, `ddim_uniform`, `beta`, `normal`, `linear_quadratic`, `kl_optimal`.

The `KSampler` node's required inputs — `model`, `seed`, `steps`, `cfg`, `sampler_name`, `scheduler`, `positive`, `negative`, `latent_image`, `denoise` — map one-to-one onto diffusion-model concepts, with no abstraction layer hiding them.

### Who uses it and why

ComfyUI's own funding announcement (blog.comfy.org, April 24 2026) frames the audience as technical creatives and studios: *"Technical artists use ComfyUI the way engineers use code, composing models, LoRAs, ControlNets, and community nodes into precise, reproducible workflows."*

- **Creative studios** building modular creative pipelines (cited: Black Math)
- **Agencies / ad studios** running major brand campaigns (cited: Silverside AI, behind *"SVEDKA's 2026 Super Bowl commercial, the first primarily AI-generated Super Bowl ad"*)
- **Technical artists** and **enterprise teams** — the post notes *"'ComfyUI artist' has emerged as a job title in high demand"*
- The comfy.org homepage lists production users including Amazon Studios, Apple, Autodesk, Netflix, Nike, Pixomondo, Tencent, and Ubisoft across VFX & Animation, Advertising & Creative Studios, Gaming, and eCommerce & Fashion

Reported scale (same source, April 2026): **4 million users, 150,000+ daily downloads, and 60,000+ community-built nodes.** The draw is reproducibility, full local control of weights and parameters, offline operation, and extensibility via custom nodes.

### The project organization: Comfy-Org

ComfyUI began as a community project by **comfyanonymous** and is now stewarded by **Comfy Org** (GitHub org `Comfy-Org`), which has also become a company; **Yannik Marek** is named as a cofounder. The mission is explicitly open-source-first — *"We want to live in a world where the best tool is open source."* The org commits that *"ComfyUI will always stay[s] open. You will always be able to run ComfyUI on your own machine, on your own terms,"* and frames the company as *"not building a walled garden"* but *"building open infrastructure, the kind that lasts."* Comfy Org has raised **~$47M total**: a **$17M seed announced September 16 2025** (Pace Capital, Chemistry, Abstract Ventures and others), and a **$30M round at a ~$500M valuation announced April 24 2026** (led by Craft, with Pace Capital, Chemistry, TruArrow and others) — *"bringing our total funding to $47 million"* — while keeping the core open-source.

The org maintains the surrounding ecosystem as separate repos, notably:

- **`ComfyUI`** — the core engine (Python backend + inference)
- **`ComfyUI_frontend`** — the official UI
- **`desktop`** — the packaged desktop app
- **`comfy-cli`** — command-line installer/manager (`pip install comfy-cli`)
- **`ComfyUI-Manager`** — installs custom nodes/extensions
- **`docs`**, **`embedded-docs`**, **`workflow_templates`**, **`registry-backend`**, and **`rfcs`** (ComfyUI standards)

### Licensing

ComfyUI core and the official frontend are both licensed **GPL-3.0** (GNU General Public License v3.0, 29 June 2007). This is a strong copyleft license — derivative works distributed to others must also be GPL-3.0. Note that **custom nodes are independently licensed** by their authors and frequently carry different (often more permissive) licenses; the GPL-3.0 applies to ComfyUI's own code, not automatically to every third-party node in the registry.

### The core-vs-frontend split

ComfyUI is deliberately split into a **Python backend/engine** and a **separate TypeScript/Vue frontend**, developed in two repos:

- **Core (`comfyanonymous/ComfyUI` → mirrored under `Comfy-Org/ComfyUI`)** — the inference engine, node definitions, model loading, the execution graph runner, and the HTTP/WebSocket API. Releases a new stable version roughly every 2 weeks (e.g. v0.7.x).
- **Frontend (`Comfy-Org/ComfyUI_frontend`)** — the browser canvas and UI, built with **TypeScript (~83%) + Vue (~15%)** on top of **litegraph** (the node-canvas library), with **PrimeVue** for components and **Vite** for builds.

The two are coupled at release time: the frontend's compiled bundle is **published to PyPI as `comfyui-frontend-package` and pinned as a dependency of ComfyUI core** (alongside `comfyui-workflow-templates` and `comfyui-embedded-docs`), so a normal install ships a pinned, tested frontend. The split is also why you can pin or float the UI independently — e.g. launching with `--front-end-version Comfy-Org/ComfyUI_frontend@latest`. The frontend follows a structured ~4-week pipeline per minor version (≈2 weeks of active development on main, then ≈2 weeks feature-frozen) — *"Each feature has approximately 4 weeks from merge to ComfyUI stable release."* The practical upside of the split: the UI can iterate fast and ship nightlies without destabilizing the engine, and any client (a script, an automation, another app) can drive the same backend graph over the API without the browser at all.

### Installation routes (what's shipped where)

All first-party, from the README and docs (June 2026):

| Route | Platforms | Notes |
|---|---|---|
| **Desktop application** | Windows, macOS | *"The easiest way to get started."* Beta |
| **Windows Portable** | Windows | Embedded Python; portable package; NVIDIA (and CUDA 12.6 portable for 10-series/older) variants |
| **comfy-cli** | cross-platform | `pip install comfy-cli` then `comfy install` |
| **Manual install** | Windows, Linux, macOS | `git clone`, install PyTorch for your hardware, `pip install -r requirements.txt`, `python main.py` |
| **Comfy Cloud** | hosted | Official paid cloud version; *"the full power of ComfyUI from anywhere"* |

Hardware support is broad: NVIDIA (RTX 20-series and above for the main portable; 10-series and older via the CUDA 12.6 portable), AMD (ROCm on Linux; **experimental on Windows and Linux for RDNA 3, 3.5 and 4 only**), Intel Arc (native PyTorch `torch.xpu`), Apple Silicon (M1–M4), plus Ascend NPUs (`torch_npu`), Cambricon MLUs (`torch_mlu`), and Iluvatar Corex. It runs CPU-only via `--cpu` (slow), uses smart offloading to run large models on GPUs *"with as low as 1GB vram,"* and *"works fully offline: core will never download anything unless you want to."* That offline-by-default posture is the concrete expression of the local-first philosophy — your weights, your machine, your graph.

---

## <a id="execution-engine-graph-model"></a>Execution Engine & Graph Model

ComfyUI runs a workflow as a directed acyclic graph of nodes. The backend file that drives this is `execution.py`, supported by the `comfy_execution/` package (`graph.py`, `graph_utils.py`, `caching.py`). The execution model was rewritten in 2024 (PR **#2666**, "Execution Model Inversion," by *guill*, merged 2024-08-15) to invert the engine **from recursive node calls to a topological sort**, which is what makes runtime graph mutation, lazy evaluation, and `ExecutionBlocker` possible. (The original umbrella PR #931, "Node Expansion, While Loops, Components, and Lazy Evaluation," was *closed without merging* on 2024-01-29; guill split its core engine changes out into the merged #2666 and moved the demo loop/branch nodes to the `BadCafeCode/execution-inversion-demo-comfyui` repo.)

### Workflow vs. prompt (API graph)

Two JSON shapes exist and must not be confused:

- **Workflow JSON** — the editor document (node positions, widget UI, links). Used by the frontend.
- **Prompt / API graph** — a flat dict keyed by node id; each entry has `class_type` and an `inputs` map. Input values are either literals (widget values) or links expressed as `[source_node_id, output_index]`. This is what the backend executes.

A run is submitted by POSTing the prompt to `/prompt`. The frontend converts the workflow to the prompt format before posting.

### The `/prompt` queue endpoint

`POST /prompt` request body fields (verified against `server.py`):

| Field | Meaning |
|---|---|
| `prompt` | The API-format graph (node id → `{class_type, inputs}`) |
| `client_id` | WebSocket client id, stored into `extra_data` so execution messages route back to the submitter |
| `extra_data` | Arbitrary attached data (e.g. `extra_pnginfo` saved into output PNGs) |
| `number` | Optional queue priority value |
| `front` | If truthy, the request's `number` is negated so the job sorts to the front of the queue |

Response: on success a JSON body with `prompt_id` (a UUID identifying the run), `number` (queue position), and `node_errors`; on validation failure (HTTP 400) `error` plus `node_errors` (per-node error detail). Validation (`execution.validate_prompt`) runs **before** the prompt is queued — an invalid prompt is rejected and never executed.

Related routes (from the official server docs):

| Route | Purpose |
|---|---|
| `GET /queue` | Current queue (running + pending) |
| `POST /queue` | Clear pending / delete specific items |
| `GET /history`, `GET /history/{prompt_id}` | Completed-run history and outputs |
| `POST /interrupt` | Stop the currently executing prompt |
| `GET /object_info`, `GET /object_info/{node_class}` | Node type schemas (inputs/outputs/flags) served to the frontend |
| `POST /free` | Unload models / free memory |

The queue is single-runner: prompts execute one at a time, ordered by `number` (modifiable via `number`/`front`).

### Topological execution

The engine no longer recurses from output nodes. Instead, `comfy_execution/graph.py` provides:

- **`TopologicalSort`** — tracks dependencies with `blockCount` (how many nodes still block a given node) and a `blocking` map. A node becomes runnable when its `blockCount` hits 0. Dependencies are added as **strong links** (`add_strong_link(from_node_id, from_socket, to_node_id)`), which increment the target's block count. It also exposes `make_input_strong_link(to_node_id, to_input)`, `get_ready_nodes`, `pop_node`, and `add_external_block` (used for async pending tasks).
- **`ExecutionList`** (extends `TopologicalSort`) — the actual run order. It provides `stage_node_execution()` (async; pick a ready node), `complete_node_execution()` (pop it, decrement dependents), and `unstage_node_execution()` (return a staged node to the graph — used when a node needs more inputs first, i.e. lazy, or when it expands). The main run loop itself lives in `PromptExecutor.execute_async` in `execution.py`, which repeatedly calls `execution_list.stage_node_execution()`, runs the node, and then dispatches on the result: `ExecutionResult.PENDING` → `unstage_node_execution()`, `ExecutionResult.SUCCESS` → `complete_node_execution()`.
- Execution begins from **output nodes** and works backward to determine which ancestors must run; only the subgraph feeding required outputs is scheduled.

### Caching & change detection

ComfyUI caches node outputs and re-runs only nodes whose result *could* differ from the previous run. This is the core of its incremental/partial re-execution.

- **Default rule:** without `IS_CHANGED`, a node is "changed" if any of its inputs or widget values changed (structurally, via the cache key).
- **`IS_CHANGED` (V1)** — `@classmethod IS_CHANGED(s, ...)` receives the same args as `FUNCTION`. It returns **any object** (not a bool, despite the name); the engine compares it to the previous run's value and re-executes if `is_changed != is_changed_old`. Gotchas: returning `True` means *unchanged* (`True == True`); to force always-rerun, `return float("NaN")` (NaN never equals itself). Canonical example — `LoadImage.IS_CHANGED` returns the SHA-256 hex digest of the file (`hashlib.sha256(...).digest().hex()`) so edits on disk invalidate the cache.
- In `execution.py`, `IsChangedCache` caches the `IS_CHANGED`/`fingerprint_inputs` result per node per prompt; it's invoked through `_async_map_node_over_list`, and `ExecutionBlocker` results are coerced to `None` (`[None if isinstance(x, ExecutionBlocker) else x for x in is_changed]`).

**Cache-key system** (`comfy_execution/caching.py`):

| Class | Behavior |
|---|---|
| `CacheKeySetID` | Key = `(node_id, class_type)`. No input analysis. |
| `CacheKeySetInputSignature` | Content-addressed key: class type + `IS_CHANGED` value + sorted inputs (ancestor refs or literals) + full ordered ancestry chain. Two nodes share a cached result iff their whole upstream signature matches. |
| `BasicCache` | Base store keyed by cache key. |
| `HierarchicalCache` | Adds parent/child subcaches (needed for expanded subgraphs). |
| `LRUCache` | Eviction by generation; bounded by N results. |
| `RAMPressureCache` | Extends `LRUCache`; adds memory-aware OOM scoring (CPU-tensor RAM usage, workflow age via a 1.3× old-workflow multiplier) and evicts until a memory target is reached. The default. |

(Also present in the file: `CacheKeySet` base, `Unhashable`, and `NullCache`.)

**Cache mode flags** (mutually exclusive group `cache_group`, from `comfy/cli_args.py`):

| Flag | Effect |
|---|---|
| `--cache-ram [GB ...]` | RAM-pressure caching. **Default.** With no args, active headroom ≈10% of system RAM (min 2 GB, max 10 GB), inactive ≈100% of system RAM (max 96 GB). |
| `--cache-classic` | Old aggressive caching (also set automatically by `--high-ram`). |
| `--cache-lru N` | Keep up to N node results; may use more RAM/VRAM, more reuse. |
| `--cache-none` | Re-execute every node every run; lowest memory. Note: known to break loop / expansion patterns — e.g. for-loops throw a `KeyError` in `caching.py` ancestry tracking (issue #10329). |

### `NOT_IDEMPOTENT`

A node marked `NOT_IDEMPOTENT = True` (V1) / `not_idempotent=True` in the V3 `io.Schema` "will always re-run and never reuse cached outputs." Mechanism (in `CacheKeySetInputSignature.get_immediate_node_signature`): when `class_def.NOT_IDEMPOTENT` is set, the node's `node_id` is appended to the signature, so even identical inputs produce a distinct key per node instance and cannot share/reuse a cached result. Used for nodes whose output legitimately depends on identity/side-effects rather than purely on inputs.

### `ExecutionBlocker` (conditional / branch skipping)

`ExecutionBlocker` is defined in `comfy_execution/graph_utils.py` (and imported into `execution.py`). It is a sentinel any node may return on an output socket; its only attribute is `message`. Any downstream node that receives one **skips execution** and re-emits a blocker on all its own outputs:

- `ExecutionBlocker(None)` — silently blocks the path.
- `ExecutionBlocker("message")` — blocks and surfaces an error message (sent as an `execution_error` with `exception_type: "ExecutionBlocked"`).

On block, the engine wraps outputs as `tuple([blocker] * len(obj.RETURN_TYPES))` (V1) or `tuple([ExecutionBlocker(r.block_execution)] * len(obj.RETURN_TYPES))` (V3, where `block_execution` is a field on the V3 `NodeOutput`). The docs are explicit: **"There is intentionally no way to stop an `ExecutionBlocker` from propagating forward"** (stated on the Lazy Evaluation docs page) — it flows to the end of that branch. This is the supported primitive for conditionally disabling a path (vs. lazy evaluation, which avoids *computing* an input); the source even recommends preferring a lazy BOOL input over `ExecutionBlocker` where possible. Note: raising `InterruptProcessingException` is a different mechanism — it aborts the whole run and emits an `execution_interrupted` message.

### Lazy evaluation (partial input evaluation)

By default every required and optional input is fully evaluated before a node runs. Lazy inputs defer that:

- Declare with the input option `{"lazy": True}` (e.g. `"image1": ("IMAGE", {"lazy": True})`).
- Implement `check_lazy_status(self, ...)` (V1 **instance** method — the docs note it is *not* a classmethod because it uses actual input values; V3 classmethod). It receives the same args as the main function — already-evaluated inputs hold real values, un-evaluated lazy inputs are `None`. It **returns a list of the names of the lazy inputs still needed**; an empty list means "ready to run." It may be called repeatedly (you can use one lazy value to decide whether you need another).

Internally, each requested lazy input is promoted via `execution_list.make_input_strong_link(unique_id, name)` and the node returns `ExecutionResult.PENDING`, so it's re-staged once those inputs resolve. The canonical example is `LazyMixImages`: with a mask that's all-1.0 it never evaluates one image, with all-0.0 it never evaluates the other — entire upstream subtrees are skipped. Lazy evaluation works precisely because the engine is topological (it can pull more inputs mid-execution).

### Node expansion (loops, recursion, dynamic subgraphs at runtime)

The most advanced feature: a node's execution can return an entire **subgraph** that replaces it in the running graph. The execute method returns a dict:

```python
return {
    "result": (merge_model_node.out(0), merge_clip_node.out(0), ...),  # node's outputs (may be subgraph refs)
    "expand": graph.finalize(),                                          # the subgraph, in API-prompt format
}
```

- Built with `GraphBuilder` from `comfy_execution.graph_utils`: `graph.node("ClassType", **inputs)` creates nodes, `.out(i)` references outputs, `graph.finalize()` produces the `"expand"` payload. `GraphBuilder.alloc_prefix()` and the module's `add_graph_prefix` function keep node IDs **unique across the whole graph and deterministic across runs** (required for caching).
- In `execution.py`, expansion is detected by `if 'expand' in r:` (V1) / `r.expand is not None` (V3, gated by `enable_expand` in the schema). The engine sets `has_subgraph`, registers ephemeral nodes via `dynprompt.add_ephemeral_node(...)`, stores partial results in `pending_subgraph_results`, and creates a child cache with `cache.ensure_subcache_for(unique_id, new_node_ids)`.
- For cache efficiency, pass **links** to subgraph nodes rather than raw tensors by declaring inputs with `rawLink: True` — then a node receives `["nodeId", outputIndex]` instead of the evaluated value, so giant tensors aren't re-keyed into the cache. (`rawLink` is documented in the Datatypes input-options reference.)

**Loops / recursion** are built on expansion via **tail recursion**: a loop-close node (`WhileLoopClose` in the demo nodes) checks its condition and, while true, expands to the loop body **plus another copy of itself**, chaining iterations until the condition fails. There is no native `while` opcode — looping is expansion-driven.

### Async node execution

The V3 API supports `async def execute(...)`. In `execution.py`, `_async_map_node_over_list` checks `inspect.iscoroutinefunction(f)` and wraps the call in `asyncio.create_task(...)`. After an immediate `await asyncio.sleep(0)`, finished tasks return right away; unfinished ones are tracked (`add_external_block`, stored in `pending_async_nodes`) and later awaited via `resolve_map_node_over_list_results`. This lets I/O-bound nodes (e.g. cloud API calls) yield the event loop while other work proceeds. Inside a node you `await` async helpers; **do not call `asyncio.run()`** inside a node — ComfyUI is already in a running loop and it raises `RuntimeError: asyncio.run() cannot be called from a running event loop` (a recurring custom-node bug, e.g. ComfyUI issue #9007). `fingerprint_inputs`/`IS_CHANGED` may also be async.

### V3 (stateless class-method) node schema

V3 was announced (blog: "Nodes V3 / dependency resolution") to give custom nodes a stable, versioned public API and to begin supporting parallel and **out-of-process** node execution. It replaces the dict-based V1 definitions:

- Inherit from `io.ComfyNode` (import `from comfy_api.latest import ComfyExtension, io, ui`, or a pinned version like `from comfy_api.v0_0_2 import ...`). `comfy_api.latest` tracks the newest API; numbered versions are backward-compatible.
- Implement `@classmethod define_schema(cls) -> io.Schema` (the V3 analog of `INPUT_TYPES`), collecting all node metadata in one place.
- `execute` is **always a classmethod** and **stateless** — `__init__` "will have no effect on what is exposed," the class "is sanitized before execution," and "node objects do not expose state." This is what allows a node to run unchanged in-process, in an isolated subprocess, or on another machine.
- Return `io.NodeOutput(...)` — `io.NodeOutput(image)`, multiple values `io.NodeOutput(w, h, n)`, or with UI `io.NodeOutput(image, ui=ui.PreviewImage(image, cls=cls))`.

**`io.Schema` key fields** (verified against the V3 migration Schema reference): `node_id` (required, globally unique), `display_name`, `category` (default `"sd"`), `description`, `inputs`, `outputs`, `hidden`, `is_output_node`, `not_idempotent` ("always re-run, never reuse cached outputs"), `enable_expand` ("Allows NodeOutput to include an expand property for node expansion"), `search_aliases`, `is_input_list`, `accept_all_inputs`, plus flags `is_deprecated`, `is_experimental`, `is_dev_only`, `is_api_node`.

**Hidden inputs** (declared in `hidden`, accessed as `cls.hidden.<name>`): `io.Hidden.unique_id`, `io.Hidden.prompt`, `io.Hidden.extra_pnginfo`, `io.Hidden.dynprompt`, `io.Hidden.auth_token_comfy_org`, `io.Hidden.api_key_comfy_org`.

**Method renames (V1 → V3):**

| V1 | V3 |
|---|---|
| `IS_CHANGED` | `fingerprint_inputs(cls, **kwargs)` — same semantics (recompute when return value differs from last run) |
| `VALIDATE_INPUTS` | `validate_inputs(cls, **kwargs)` |
| `check_lazy_status` (instance) | `check_lazy_status` (classmethod) |
| `OUTPUT_NODE` | `is_output_node` |
| `NOT_IDEMPOTENT` | `not_idempotent` |

ComfyUI loads V3 extensions through a `comfy_entrypoint()` (which may be sync or async); the extension class exposes an **async** `get_node_list()`. V1 and V3 nodes coexist.

### Validation (`VALIDATE_INPUTS`) and execution order checks

Validation runs in `validate_prompt`/`validate_inputs` (both async) before queueing:

- **`VALIDATE_INPUTS`** (classmethod; V3 `validate_inputs`) returns `True` if valid or an error **string** to block execution. Critical limitation: it only receives inputs that are **constants in the workflow** — values arriving over links from other nodes are *not* available (those nodes haven't run yet). If the method declares an `input_types` parameter, it receives a dict of the connected inputs' types for type checking. Inputs handled by `VALIDATE_INPUTS` skip the engine's default type/range validation.
- Built-in validation detects **dependency cycles** (`if unique_id in visiting:` → `"dependency_cycle"` error) and does type checking. Per-input error types (verified in `execution.py`): `"required_input_missing"`, `"bad_linked_input"`, `"return_type_mismatch"`, `"custom_validation_failed"`, `"value_not_in_list"`. Prompt-level errors: `"missing_node_type"`, `"prompt_no_outputs"`, `"prompt_outputs_failed_validation"`, `"exception_during_validation"`.

### Other relevant node properties (V1)

| Property | Role |
|---|---|
| `RETURN_TYPES` (required) | Tuple of output datatype strings |
| `RETURN_NAMES` | Output labels (defaults to lowercased types) |
| `FUNCTION` (required) | Name of the method invoked on execution |
| `CATEGORY` (required) | Location in the Add Node menu |
| `OUTPUT_NODE` | `True` marks a terminal/output node (these anchor what must run) |
| `INPUT_IS_LIST` / `OUTPUT_IS_LIST` | Control list/batch sequential processing semantics |
| `SEARCH_ALIASES` | Alternate search names (used by many core nodes in `nodes.py`, e.g. `CLIPTextEncode`, `LoadImage`) |

### Execution lifecycle messages (WebSocket)

During a run the server pushes (routed by `client_id`):

| Message `type` | Data | Meaning |
|---|---|---|
| `status` | `exec_info.queue_remaining` | Queue size changed |
| `execution_start` | `prompt_id` | Prompt about to run |
| `execution_cached` | `prompt_id`, `nodes` (list) | These nodes are **skipped — served from cache** |
| `executing` | `node` (id, or `None` = done), `prompt_id` | A node is about to run |
| `progress` | `node`, `prompt_id`, `value`, `max` | Intra-node progress (if the node implements the hook) |
| `executed` | `node`, `prompt_id`, `output` | Fires only when a node returns a UI element |
| `execution_error` | `prompt_id` + detail | Error during execution |
| `execution_interrupted` | `prompt_id`, `node_id`, `node_type`, `executed` (list of executed nodes) | `InterruptProcessingException` raised |
| `execution_success` | `prompt_id`, `timestamp` | All nodes finished |

The `execution_cached` message is the observable side of incremental re-execution: it lists exactly which nodes the cache let the engine skip on this run.

### Version stamping

- Execution-model inversion, node expansion, lazy evaluation: **PR #2666** ("Execution Model Inversion," guill), merged 2024-08-15. The companion umbrella PR #931 was closed unmerged; the demo loop/branch/lazy nodes (`LazyMixImages`, `WhileLoopClose`, etc.) live in `BadCafeCode/execution-inversion-demo-comfyui`.
- V3 stateless schema (`io.ComfyNode`, `define_schema`, async `execute`, `not_idempotent`, `enable_expand`): in-tree under `comfy_api/`.
- `--cache-ram` as the default cache mode and `RAMPressureCache`: present in current `master` (`comfy/cli_args.py`, `comfy_execution/caching.py`), verified 2026-06-22.

*Custom-node note:* control-flow primitives (lazy inputs, `ExecutionBlocker`, expansion/loops) are **core engine features**, but practical loop/branch *nodes* (e.g. for-loop, while-loop, switch nodes) are generally shipped by custom-node packs and the demo repo above rather than as built-in core nodes.

---

## <a id="node-editor-canvas-ux"></a>Node Editor & Canvas UX

ComfyUI's editor is a node graph: you build workflows by dropping **nodes** onto an infinite canvas and wiring their typed **outputs** to **inputs**. Historically the canvas was rendered by **LiteGraph.js** — a Comfy-Org fork of the original litegraph.js — driven by the Vue/TypeScript + PrimeVue application shell in `Comfy-Org/ComfyUI_frontend`. The standalone `Comfy-Org/litegraph.js` repo is now **archived**; its code was merged into the frontend monorepo (`ComfyUI_frontend/src/lib/litegraph`, published as `@comfyorg/litegraph`). As of ComfyUI **v0.3.76 (Dec 2, 2025)** a second renderer, **Nodes 2.0**, ships as a public beta alongside the classic LiteGraph renderer. Everything below is from canonical docs (`docs.comfy.org`) and Comfy-Org repos; versions are stamped where the changelog gives them.

### Node anatomy: inputs, outputs, widgets

A node is a "function operator" with typed connection points and inline parameter controls. The docs describe nodes as accepting input data, performing an operation, and producing output data; "ComfyUI nodes almost always have at least one input or output, and usually have multiple inputs and outputs."

- **Inputs / outputs** are colored endpoints; "you can only connect ports of the same color" (same data type). Canonical type colors (from `core-concepts/nodes`):

| Color | Data type |
|---|---|
| Lavender | diffusion MODEL |
| Yellow | CLIP |
| Rose | VAE |
| Orange | CONDITIONING |
| Pink | LATENT (latent image) |
| Blue | IMAGE (pixel) |
| Green | MASK |
| Light green | number (INT/FLOAT) |
| Bright green | MESH |

- **Widgets** are the in-node parameter controls (sliders, combo dropdowns, text, number fields); "these parameters determine the logic of node execution."
- **Widget ↔ input conversion**: a widget can be exposed as an external input socket (so its value can be driven by another node) and converted back. The frontend added **auto widget-to-input conversion** (litegraph v1.3.4): dragging a link onto a node auto-converts the matching widget to an input; the conversion is also reachable from the endpoint/widget context menu. Float widget display is governed by settings *Float widget rounding decimal places [0=auto]* (range 0–6) and *Disable default float widget rounding* (default off); *Disable node widget sliders* (default off) forces text entry instead of sliders.
- **Badges**: nodes can show a **node ID badge** and a **node source badge** (Comfy Core shows a fox icon; custom nodes show the package name). A separate **Node life cycle badge mode** setting also exists (default Show all). The *Node source badge mode* setting offers **None / Hide built-in / Show all** (the ID and life-cycle badge-mode settings default to *Show all*).
- **Node states** are shown visually: **Normal** (default), **Running** (while executing), **Error** (typically after a run when there's a problem with the node's input), and **Missing** (after importing a workflow whose Comfy Core or custom nodes aren't present in the installation).

### Node modes: Always / Never / Bypass (mute vs bypass)

Every node has an execution **mode**, set from the right-click menu, the selection toolbox, or a hotkey:

- **Always** (default) — "executes whenever it runs for the first time or when any of its inputs change since the last execution."
- **Never (Mute)** — "never executes under any circumstances, as if it's been deleted"; downstream nodes receive **no** data from it. Toggle with **Ctrl/Cmd + M**.
- **Bypass** — the node itself never executes, but "subsequent nodes can still try to obtain data that hasn't been processed" — i.e. the upstream/unprocessed data is passed through rather than cut. Toggle with **Ctrl/Cmd + B**.

(The docs also list "On Event" / "On Trigger" modes as "currently ineffective.")

The key distinction: Never blocks the data path; Bypass lets upstream data flow past the disabled node so the rest of the graph keeps running. (Group-level mute/bypass toggles on group headers are commonly added by the **rgthree-comfy** custom-node pack's Fast Groups Muter/Bypasser, not core — *third-party, not in canonical docs*.)

### Node appearance: title, color, collapse, pin, resize

- **Rename**: double-click the node title (setting *Double click node title to edit*, default on).
- **Color / style**: right-click menu or the selection toolbox lets you recolor the node.
- **Collapse / expand**: **Alt/Opt + C** (or the title-bar dot) collapses the node body.
- **Pin / unpin**: **P** locks selected items in place so they can't be dragged.
- **Resize**: drag any corner. The setting *Always shrink new nodes* (default on) spawns nodes at minimum size.

### Selection toolbox

A floating toolbar that appears above the current selection (setting *Show selection toolbox*, default on; the **Node Selection Toolbox Redesign** shipped in **v0.3.63**, Oct 6 2025). It offers quick actions including recolor, Bypass toggle, lock/pin, delete, and — with the partial-execution backend added in **v0.3.48** (Aug 2 2025) — executing only the selected portion of the graph. For a Load Image node, the toolbox also exposes the **Mask** button to open the Mask Editor.

### Links, link render modes, and reroutes

- **Link render mode** (Display/Lite Graph → Graph → *Link Render Mode*): **Straight**, **Linear**, **Spline** (default, value 2), or **Hidden**. *Link midpoint markers*: None / Circle (default) / Arrow.
- **Disconnect**: drag off the input endpoint, or use the link's midpoint menu.
- **Action on link release** is configurable for two cases: *No modifier* (default **context menu**) and *Shift* (default **search box**); options are context menu / search box / no action — this is what lets you drag a wire into empty space and instantly get a filtered node-add menu.
- **Reroute nodes**: ComfyUI has a **native reroute** built into the canvas (the docs recommend it over the old Reroute node for new workflows) for redirecting a wire through an arbitrary point. *Middle-click creates a new Reroute node* (default on). *Reroute spline offset* (default 20) tunes curve smoothness. Reroute width/height/layout are editable from its right-click menu.
- **Connection preservation on delete**: *Keep all links when deleting nodes* (default on) auto-reconnects the input and output of a deleted middle node so the chain survives.
- Snapping aids while wiring: *Snap highlights node* and *Auto snap link to node slot* (both default on).

### Groups & frames, notes

- **Group / frame**: **Ctrl/Cmd + G** adds a frame around the selection. *Group selected nodes padding* (default 10, range 0–100) sets the frame margin; *Double click group title to edit* (default on) renames it. Groups move their contents together and can be recolored.
- **Notes**: ComfyUI ships a core **Note** node (plain free-text annotation, no inputs/outputs) and a **MarkdownNote** node (Markdown-formatted annotation) for documenting workflows on-canvas (these are nodes, not frame text). Both are documented under `docs.comfy.org/built-in-nodes/`.

### Subgraphs (vs. the older "group node")

Subgraphs collapse a selection into a single reusable node and are distinct from frames. (Subgraph features are versioned by **frontend** version in the feature docs; the bundled-ComfyUI changelog dates are given below.)

- **Subgraph Support** landed in **v0.3.51** (Aug 20 2025); the feature requires frontend version **1.24.3** or later.
- **Subgraph Publish** (publish a subgraph into the Node Library) shipped in **v0.3.63** (Oct 6 2025); publishing requires frontend **1.27.7** or later.
- **Subgraph Widget Editing** via a new **Parameters panel** ("Edit Subgraph Widgets") arrived in **v0.3.66** (Oct 21 2025).
- A subgraph can be **unpacked** back into its constituent nodes on the main graph, via the right-click menu or the selection toolbox **Unpack subgraph** action.

### Multi-select, copy/paste (connection-preserving), grid snap

- **Select all**: Ctrl/Cmd + A. **Add to selection**: Ctrl/Cmd + Click or Shift + Click. **Move many**: Shift + Drag. Box-select by dragging on empty canvas.
- **Copy/paste**:
  - **Ctrl/Cmd + C → Ctrl/Cmd + V** — paste **without** maintaining connections.
  - **Ctrl/Cmd + C → Ctrl/Cmd + Shift + V** — **connection-preserving** paste: maintains connections from unselected node outputs.
- **Grid snap**: *Always snap to grid* (default off → hold **Shift** to snap; on → always snap). *Snap to grid size* default 10 (range 1–500).
- **Delete**: Delete / Backspace (selected nodes). **Backspace** with nothing relevant selected clears the entire workflow (the canonical shortcut for "Clear workflow" is plain **Backspace**).

### Node search & the Node Library

- **Quick search to add a node**: **double-click empty canvas** (or release a dragged link with the search-box action). Provides fuzzy search with filters.
- **Node Library sidebar** (toggle **N**): hierarchical, searchable tree of all Comfy Core and custom nodes, with bookmarks/customizable folders, grouping, and sorting; published subgraphs appear here too.
- **Refresh node definitions**: **R**.

### Sidebars, queue & history panels, bottom panel

Left navigation entries: **ASSETS** (generated images/videos and other assets), **Nodes**, **Models**, **Workflows** (locally saved), and **Templates**. Toggleable panels:

| Panel | Toggle key | Contents |
|---|---|---|
| Queue | **Q** | Pending, running (with progress), and completed/failed tasks; browse history outputs |
| Workflows | **W** | Locally saved user workflows |
| Node Library | **N** | All core + custom nodes; search/filter/bookmark |
| Model Library | **M** | Models under `ComfyUI/models` |
| Log / bottom panel | **Ctrl/Cmd + \`** | Runtime logs / console |

The bottom-right **Canvas navigation** controls switch pan/move mode, toggle the **minimap**, and toggle link visibility. *Show graph canvas menu* (default on) governs the bottom-right menu; *Show canvas info on bottom left corner (fps, etc.)* (default on) shows FPS and similar. **F** toggles full-screen focus mode. The bottom-left toolbar includes Help, Console, Shortcuts, and Settings buttons; the **Shortcut Panel** was added in **v0.3.51** (Aug 20 2025).

### Minimap

The workflow **Mini Map** was added in **v0.3.51** (Aug 20 2025), toggled from the bottom-right canvas navigation controls, giving an overview-and-jump view of large graphs.

### Queue execution shortcuts

| Shortcut (Win/Linux · macOS) | Action |
|---|---|
| Ctrl+Enter · Cmd+Enter | Queue prompt |
| Ctrl+Shift+Enter · Cmd+Shift+Enter | Queue prompt (Front) |
| Ctrl+Alt+Enter · Cmd+Alt+Enter | Interrupt |

### Templates insertion

**Templates** are built-in starter workflows accessible from the left sidebar. The **Template Modal Redesign** (new browser with advanced filtering by model tags and categories) shipped in **v0.3.66** (Oct 21 2025). (A "Create Video" entry was later added to the Essentials tab in a 2026 release — *not part of v0.3.76*.) Selecting a template loads/inserts that workflow onto the canvas.

### Undo / redo

- Canvas: **Ctrl/Cmd + Z** undo, **Ctrl/Cmd + Y** redo.
- Mask Editor has its own history: **Ctrl+Z** undo, **Ctrl+Shift+Z** or **Ctrl+Y** redo.

### Keybindings & command palette

Shortcuts are user-customizable in **Settings → Keybinding** (open settings with **Ctrl/Cmd + ,**); hover a command and click the edit icon to rebind. Extensions register commands and keybindings via `app.registerExtension({ commands: [...], keybindings: [...] })`; a command object is `{ id, label, function }` and a keybinding maps a `combo: { key, ctrl?, shift?, alt?, meta? }` to a `commandId`. Per the docs: keybindings defined in ComfyUI core **cannot be overwritten by extensions**, and some combinations are **reserved by the browser (e.g. Ctrl+F) and cannot be overridden**; if multiple extensions register the same keybinding, the behavior is undefined. The canonical docs describe this programmatic command API but do **not** document a Spotlight-style command-palette UI in core (*unverified* whether a searchable command menu exists beyond the node-search box).

Selected canvas/UI keybindings:

| Shortcut (Win/Linux · macOS) | Action |
|---|---|
| Space (hold + drag) | Pan canvas |
| Alt += · Opt += | Zoom in |
| Alt +- · Opt +- | Zoom out |
| . (period) | Fit view to selected nodes |
| Ctrl+Shift+Drag | Fast-zoom (setting, default on) |
| Ctrl/Cmd+A | Select all |
| Ctrl/Cmd+M | Mute (Never) toggle |
| Ctrl/Cmd+B | Bypass toggle |
| Ctrl/Cmd+G | Add frame to selection |
| Alt/Opt+C | Collapse / expand |
| P | Pin / unpin |
| Double-click LMB | Quick node search |
| Ctrl/Cmd+S · Ctrl/Cmd+O | Save · Load workflow |

### Pointer & trackpad behavior

*Enable trackpad gestures* (default on) gives two-finger pinch-zoom and two-finger pan. Click-vs-drag is tuned by *Pointer click drift delay* (150 ms), *Pointer click drift (maximum distance)* (6 px), and *Double click interval (maximum)* (300 ms). *Canvas zoom speed* default 1.1 (range 1.01–2.5). Performance knobs: *Low quality rendering zoom threshold* (0.6, range 0.1–1.0), *Maximum FPS* (0 = screen refresh, range 0–120), and *Enable DOM element clipping* (default on).

### Integrated Mask Editor

A built-in, GPU-accelerated mask/inpaint tool attached to the **Load Image** node (works in Graph Mode and App Mode). Open it via the selection toolbox **Mask** button, the image-overlay "Edit or mask image" icon (gallery hover), or right-click → **Open in Mask Editor**.

**Tools** (left panel): **Mask Pen** (paint mask), **Paint Pen** (paint on the RGB layer for touch-ups/inpainting), **Eraser**, **Paint Bucket** (flood-fill by color similarity with a tolerance control; click to fill or erase masked regions), **Color Select** (mask all pixels matching a target color, via Simple HSL or LAB matching).

**Brush settings** (Mask Pen / Paint Pen / Eraser): Shape (Arc/round or Rect/square), Color (hex picker), Thickness 1–250 px, Opacity 0–1, Hardness 0–1 (1 = hard edge, 0 = very soft), Step Size 1–100 (spacing between brush dabs); plus a "Reset to Default" button.

**Layers**: Mask layer (adjustable opacity; Black / White / Negative overlay modes), Paint layer, and Base Image layer — each independently toggleable, with "Activate Layer" to choose the drawing target.

**Top bar**: Undo, Redo, Rotate Left/Right (90°), Mirror Horizontal/Vertical, Invert, Clear, Save, Cancel (rotate/mirror affect all three layers).

**In-editor navigation**: Space+Drag pan; Ctrl+Scroll zoom; click the zoom % to reset to 100%; **Alt+Right-click+Drag** adjusts the brush (left/right changes size, up/down changes hardness). Global settings *Brush adjustment speed multiplier* (0.1–2.0, default 1.0) and *Lock brush adjustment to dominant axis* (default on) tune that gesture. **Save** commits the mask and closes; **Cancel** discards.

### Nodes 2.0 (new renderer)

**Nodes 2.0** (public beta, **v0.3.76**, Dec 2 2025) replaces LiteGraph.js Canvas rendering with a **Vue-based architecture**. Motivation: the Canvas path was a development bottleneck where small UI changes "could take days to implement." Benefits cited: faster feature development, dynamic widgets, expandable nodes, and richer/more flexible components. It ships in Comfy Desktop, portable, and stable releases but is still "optimizing toward Canvas-level performance"; some custom nodes may require updates, and minor visual issues can appear at extreme zoom or in very large workflows. The classic LiteGraph renderer remains; toggle via the ComfyUI logo menu → **Nodes 2.0**. (The same v0.3.76 release also added a **Linear mode** beta, enabled by assigning a hot-key in Keybinding.)

---

## <a id="image-generation-pipeline"></a>Image Generation Pipeline

ComfyUI's image-generation pipeline is the classic diffusion stack expressed as discrete nodes: load a model (checkpoint or split UNet/CLIP/VAE), encode text into CONDITIONING, prepare a latent, denoise it with a sampler, then decode the latent back to pixels with the VAE. Everything below is verified against the canonical source in `comfyanonymous/ComfyUI` (`comfy/samplers.py`, `nodes.py`, `comfy_extras/nodes_custom_sampler.py`, etc.) and `docs.comfy.org`, as of the `master` branch in June 2026.

### The minimal pipeline (core nodes)

A standard txt2img graph is: `CheckpointLoaderSimple → CLIPTextEncode (×2, positive/negative) → EmptyLatentImage → KSampler → VAEDecode → SaveImage`. The KSampler consumes `MODEL`, two `CONDITIONING` inputs, and a `LATENT`, and emits a denoised `LATENT`.

### Model / checkpoint / UNet loaders

| Node | Inputs | Outputs | Notes |
|------|--------|---------|-------|
| `CheckpointLoaderSimple` | `ckpt_name` | `MODEL`, `CLIP`, `VAE` | The standard all-in-one loader for SD1.x/2.x/SDXL/SD3/etc. checkpoints. |
| `CheckpointLoader` | `config_name`, `ckpt_name` | `MODEL`, `CLIP`, `VAE` | **Deprecated** (`DEPRECATED = True`); takes an explicit YAML config. |
| `UNETLoader` | `unet_name`, `weight_dtype` | `MODEL` | Loads a bare diffusion model (e.g. Flux, SD3 split weights) from the `diffusion_models` folder. `weight_dtype`: `default`, `fp8_e4m3fn`, `fp8_e4m3fn_fast`, `fp8_e5m2`. |
| `DiffusersLoader` | `model_path` | `MODEL`, `CLIP`, `VAE` | **Deprecated** (`DEPRECATED = True`); loads HF-Diffusers-format folders. |

Note: the node ComfyUI calls the "diffusion model" loader is `UNETLoader` internally (display name "Load Diffusion Model"). It is the entry point for models distributed as standalone transformer weights (Flux, SD3.5, Lumina, HiDream, Qwen Image), where CLIP/VAE are loaded separately.

### Text-encoder / CLIP loaders

| Node | Inputs | Output | Use |
|------|--------|--------|-----|
| `CLIPLoader` | `clip_name`, `type`, (`device`) | `CLIP` | Single text encoder. The `type` enum (verbatim from `nodes.py`, June 2026): `stable_diffusion`, `stable_cascade`, `sd3`, `stable_audio`, `mochi`, `ltxv`, `pixart`, `cosmos`, `lumina2`, `wan`, `hidream`, `chroma`, `ace`, `omnigen2`, `qwen_image`, `hunyuan_image`, `flux2`, `ovis`, `longcat_image`, `cogvideox`, `lens`, `pixeldit`, `ideogram4`, `boogu`. (This list grows over time — check the current `nodes.py`.) |
| `DualCLIPLoader` | `clip_name1`, `clip_name2`, `type`, (`device`) | `CLIP` | Two encoders. The `type` enum (verbatim): `sdxl`, `sd3`, `flux`, `hunyuan_video`, `hidream`, `hunyuan_image`, `hunyuan_video_15`, `kandinsky5`, `kandinsky5_image`, `ltxv`, `newbie`, `ace`. (e.g. Flux = CLIP-L + T5-XXL.) |
| `TripleCLIPLoader` | `clip_name1`, `clip_name2`, `clip_name3` | `CLIP` | Three encoders (SD3 = CLIP-L + CLIP-G + T5-XXL). Defined in `comfy_extras/nodes_sd3.py`. |
| `CLIPTextEncode` | `clip`, `text` | `CONDITIONING` | The universal positive/negative prompt encoder. |

Architecture-specific encoders exist where the prompt needs to be split per-encoder: `CLIPTextEncodeSD3` (`clip_l` / `clip_g` / `t5xxl` + `empty_padding` with options `none` / `empty_prompt`), `CLIPTextEncodeFlux` (`clip_l` / `t5xxl` / `guidance`), `CLIPTextEncodeSDXL`, and `CLIPTextEncodeSDXLRefiner`.

### VAE encode / decode (including tiled)

| Node | Inputs | Output |
|------|--------|--------|
| `VAELoader` | `vae_name` | `VAE` (the name list hardcodes `pixel_space`, and exposes TAESD tiny-VAE entries when matching `vae_approx` encoder/decoder files are present) |
| `VAEEncode` | `pixels` (IMAGE), `vae` | `LATENT` |
| `VAEDecode` | `samples` (LATENT), `vae` | `IMAGE` |
| `VAEEncodeTiled` | `pixels`, `vae`, `tile_size`, `overlap`, `temporal_size`, `temporal_overlap` | `LATENT` |
| `VAEDecodeTiled` | `samples`, `vae`, `tile_size`, `overlap`, `temporal_size`, `temporal_overlap` | `IMAGE` |
| `VAEEncodeForInpaint` | `pixels`, `vae`, `mask`, `grow_mask_by` | `LATENT` |

Tiled variants trade speed for VRAM: the image/latent is processed in overlapping tiles, so large resolutions decode without OOM. `temporal_size`/`temporal_overlap` exist because the same nodes serve video latents.

### Empty latents & architecture-aware latent channels

| Node | Inputs (defaults) | Output | Channels |
|------|-------------------|--------|----------|
| `EmptyLatentImage` | `width`=512, `height`=512, `batch_size`=1 | `LATENT` | 4-channel (SD1.x/2.x/SDXL) |
| `EmptySD3LatentImage` | `width`=1024, `height`=1024, `batch_size`=1 | `LATENT` | 16-channel `[B,16,H/8,W/8]` (SD3/3.5, Flux) — in `nodes_sd3.py` |
| `EmptyFlux2LatentImage` | `width`=1024, `height`=1024, `batch_size`=1 | `LATENT` | Flux 2 — in `nodes_flux.py` |

The channel difference matters: SD3 and Flux use a 16-channel latent, so feeding `EmptyLatentImage` (4-ch) to a Flux/SD3 sampler produces wrong results — use `EmptySD3LatentImage`.

### Latent operations (core)

| Node | Key inputs | Notes |
|------|-----------|-------|
| `LatentUpscale` | `samples`, `upscale_method`, `width`, `height`, `crop` | `upscale_method`: `nearest-exact`, `bilinear`, `area`, `bicubic`, `bislerp`. `crop`: `disabled`, `center`. |
| `LatentUpscaleBy` | `samples`, `upscale_method`, `scale_by` | Same methods; scales by factor (`scale_by` default 1.5). |
| `LatentComposite` | `samples_to`, `samples_from`, `x`, `y`, `feather` | Paste one latent onto another. |
| `LatentBlend` | `samples1`, `samples2`, `blend_factor` | Linear blend (default 0.5). |
| `LatentCrop` | `samples`, `width`, `height`, `x`, `y` | Crop region. |
| `LatentFromBatch` | `samples`, `batch_index`, `length` | Slice a batch. |
| `RepeatLatentBatch` | `samples`, `amount` | Duplicate into a batch. |
| `LatentRotate` | `samples`, `rotation` (`none`/`90 degrees`/`180 degrees`/`270 degrees`) | |
| `LatentFlip` | `samples`, `flip_method` (`x-axis: vertically`, `y-axis: horizontally`) | |

### The KSampler family

**`KSampler`** — the workhorse. Inputs (from `nodes.py`, matching docs.comfy.org): `model` (MODEL), `seed` (INT, 0…0xffffffffffffffff), `steps` (INT, default 20, 1–10000), `cfg` (FLOAT, default 8.0, 0–100, step 0.1), `sampler_name` (`comfy.samplers.KSampler.SAMPLERS`), `scheduler` (`comfy.samplers.KSampler.SCHEDULERS`), `positive`/`negative` (CONDITIONING), `latent_image` (LATENT), `denoise` (FLOAT, default 1.0, 0–1). Output: `LATENT` (`samples`). It always adds full noise then denoises from `(1−denoise)` of the schedule — `denoise < 1.0` is the standard img2img knob (lower values preserve the structure of the initial image).

**`KSamplerAdvanced`** — same core but replaces `denoise` with manual noise/step control: `add_noise` (`enable`/`disable`), `noise_seed`, `steps`, `cfg`, `sampler_name`, `scheduler`, `positive`, `negative`, `latent_image`, `start_at_step` (default 0), `end_at_step` (default 10000), `return_with_leftover_noise` (`disable`/`enable`). This is what enables multi-pass / base+refiner workflows: stage one ends early with `return_with_leftover_noise=enable`, stage two starts mid-schedule with `add_noise=disable`.

### Decomposed / custom sampling (the SAMPLER / SIGMAS / GUIDER / NOISE graph)

ComfyUI's advanced path (in `comfy_extras/nodes_custom_sampler.py`) splits the KSampler's internals into separate typed sockets so each piece is swappable:

- **`SamplerCustomAdvanced`** — the assembler. Inputs: `noise` (NOISE), `guider` (GUIDER), `sampler` (SAMPLER), `sigmas` (SIGMAS), `latent_image` (LATENT). Outputs: `output` (LATENT), `denoised_output` (LATENT). (Confirmed on docs.comfy.org.)
- **`SamplerCustom`** — a simpler variant that still takes `cfg`/`positive`/`negative` inline plus `sampler` + `sigmas`. Inputs: `model`, `add_noise`, `noise_seed`, `cfg`, `positive`, `negative`, `sampler`, `sigmas`, `latent_image`. Outputs: `output`, `denoised_output`.

**NOISE producers:** `RandomNoise` (input `noise_seed` → NOISE), `DisableNoise` (no input → NOISE, for noise-free passes), `AddNoise` (`model`, `noise`, `sigmas`, `latent_image` → LATENT).

**SAMPLER producers:** `KSamplerSelect` (`sampler_name` → SAMPLER) plus parameterized wrappers: `SamplerEulerAncestral`, `SamplerEulerAncestralCFGPP`, `SamplerDPMPP_SDE`, `SamplerDPMPP_2S_Ancestral`, `SamplerDPMPP_2M_SDE` (`solver_type`, `eta`, `s_noise`, `noise_device`), `SamplerDPMPP_3M_SDE`, `SamplerDPMAdaptative`, `SamplerLMS`, `SamplerER_SDE`, `SamplerSASolver`, `SamplerSEEDS2`.

**SIGMAS producers (schedulers):**

| Node | Inputs |
|------|--------|
| `BasicScheduler` | `model`, `scheduler`, `steps`, `denoise` (uses any of the named schedulers below) |
| `KarrasScheduler` | `steps`, `sigma_max`, `sigma_min`, `rho` |
| `ExponentialScheduler` | `steps`, `sigma_max`, `sigma_min` |
| `PolyexponentialScheduler` | `steps`, `sigma_max`, `sigma_min`, `rho` |
| `SDTurboScheduler` | `model`, `steps`, `denoise` |
| `BetaSamplingScheduler` | `model`, `steps`, `alpha`, `beta` |
| `VPScheduler` | `steps`, `beta_d`, `beta_min`, `eps_s` |
| `LaplaceScheduler` | `steps`, `sigma_max`, `sigma_min`, `mu`, `beta` |

**SIGMAS manipulators:** `SplitSigmas` (`sigmas`, `step` → high/low SIGMAS), `SplitSigmasDenoise` (`sigmas`, `denoise`), `FlipSigmas`, `SetFirstSigma`, `ExtendIntermediateSigmas`, `ManualSigmas`, `SamplingPercentToSigma`.

**GUIDER producers (where CFG lives in the custom path):**

| Node | Inputs | Purpose |
|------|--------|---------|
| `BasicGuider` | `model`, `conditioning` | No-negative / guidance-distilled models (e.g. Flux dev, Schnell, SD-Turbo). |
| `CFGGuider` | `model`, `positive`, `negative`, `cfg` | Standard classifier-free guidance. |
| `DualCFGGuider` | `model`, `cond1`, `cond2`, `negative`, `cfg_conds`, `cfg_cond2_negative`, `style` (`regular`/`nested`) | Two-conditioning guidance (e.g. Hunyuan-style). |

(`comfy_extras/nodes_custom_sampler.py` also registers two additional guider-related nodes — `CFGOverride` and `DualModelGuider` — beyond the three above.)

### CFG / guidance details

- In the **classic** KSampler, `cfg` (classifier-free guidance) blends conditional vs unconditional predictions; default 8.0 for SD, but Flux dev typically uses ~1.0 with a separate **`FluxGuidance`** node (`conditioning`, `guidance` default 3.5 → CONDITIONING) that bakes a guidance value into the embedding. `FluxDisableGuidance` removes it; `CLIPTextEncodeFlux` carries `guidance` inline (default 3.5). Both are in `comfy_extras/nodes_flux.py`.
- **`RescaleCFG`** (`model`, `multiplier`, default 0.7) corrects over-saturation at high CFG.
- SD3 ships **`SkipLayerGuidanceSD3`** (experimental; inputs `model`, `layers`, `scale`, `start_percent`, `end_percent`); flow-matching models use shift nodes — `ModelSamplingSD3` (`shift`, default 3.0), `ModelSamplingFlux` (`max_shift` 1.15, `base_shift` 0.5, `width`, `height`), `ModelSamplingAuraFlow` (`shift` 1.73), `ModelSamplingStableCascade` (`shift`, default 2.0) — to set the noise schedule the sampler then walks.

### Full sampler list (`comfy.samplers.KSampler.SAMPLERS`)

This is `KSAMPLER_NAMES` plus `ddim`, `uni_pc`, `uni_pc_bh2`, verbatim from `comfy/samplers.py` (44 entries total):

`euler`, `euler_cfg_pp`, `euler_ancestral`, `euler_ancestral_cfg_pp`, `heun`, `heunpp2`, `exp_heun_2_x0`, `exp_heun_2_x0_sde`, `dpm_2`, `dpm_2_ancestral`, `lms`, `dpm_fast`, `dpm_adaptive`, `dpmpp_2s_ancestral`, `dpmpp_2s_ancestral_cfg_pp`, `dpmpp_sde`, `dpmpp_sde_gpu`, `dpmpp_2m`, `dpmpp_2m_cfg_pp`, `dpmpp_2m_sde`, `dpmpp_2m_sde_gpu`, `dpmpp_2m_sde_heun`, `dpmpp_2m_sde_heun_gpu`, `dpmpp_3m_sde`, `dpmpp_3m_sde_gpu`, `ddpm`, `lcm`, `ipndm`, `ipndm_v`, `deis`, `res_multistep`, `res_multistep_cfg_pp`, `res_multistep_ancestral`, `res_multistep_ancestral_cfg_pp`, `gradient_estimation`, `gradient_estimation_cfg_pp`, `er_sde`, `seeds_2`, `seeds_3`, `sa_solver`, `sa_solver_pece`, `ddim`, `uni_pc`, `uni_pc_bh2`.

Notes: `_gpu` variants generate stochastic noise on the GPU; `_cfg_pp` variants apply CFG++; ancestral/SDE samplers inject noise each step (non-deterministic w.r.t. step count). `ddim` is implemented as `ksampler("euler", inpaint_options={"random": True})` — i.e. euler with the random-inpaint option enabled.

### Full scheduler list (`comfy.samplers.KSampler.SCHEDULERS`)

From `SCHEDULER_HANDLERS` keys in `comfy/samplers.py` (9 entries; `SCHEDULER_NAMES = list(SCHEDULER_HANDLERS)`):

`simple`, `sgm_uniform`, `karras`, `exponential`, `ddim_uniform`, `beta`, `normal`, `linear_quadratic`, `kl_optimal`.

(`normal` is the architecture's native schedule; `karras` and `exponential` are the common quality choices for DPM-family samplers.)

### Supported model architectures (core)

From the ComfyUI README Features list, these run in core without extra custom nodes. The README lists image-generation models and image-editing models separately, and names them generically (it does *not* enumerate every Flux/HiDream/Qwen sub-variant in the bullet list).

Image generation (verbatim names):

- **SD1.x, SD2.x** (incl. unCLIP)
- **SDXL, SDXL Turbo** (+ SDXL Refiner)
- **Stable Cascade**
- **SD3 and SD3.5**
- **Pixart Alpha and Sigma**
- **AuraFlow**
- **HunyuanDiT**
- **Flux**
- **Lumina Image 2.0**
- **HiDream**
- **Qwen Image**
- **Hunyuan Image 2.1**
- **Flux 2**
- **Z Image**
- **Ernie Image**

Image editing (listed separately in the README):

- **Omnigen 2**
- **Flux Kontext**
- **HiDream E1.1**
- **Qwen Image Edit**

The README explicitly states: *"NOTE: There are many more models supported than the list below, if you want to see what is supported see our templates list inside ComfyUI."* The granular sub-variants (Flux dev/schnell/Fill/Canny/Redux, Flux 2 Klein, HiDream I1/O1, Qwen Image Edit 2509, Z Image Turbo, etc.) appear on `comfy.org/p/supported-models/` and the in-app **Templates** browser rather than in the README bullets.

### Custom-node-only architectures

- **SANA** (NVIDIA) — **not core**. Support is provided through the `ComfyUI_ExtraModels` family of custom nodes (the original is `city96/ComfyUI_ExtraModels`; SANA support is actively maintained in forks such as `Efficient-Large-Model`/`lawrence-cj`, with a refactor toward better native integration in progress). SANA uses a 32×-spatial-compressed DC-AE latent (its own VAE) and a Gemma2-2B-IT text encoder. (Model details per ComfyUI issue #5785, which is the SANA feature request; the ExtraModels-routing and engine specifics come from the ExtraModels/NVlabs Sana ComfyUI docs, not from issue #5785 itself.)
- **Kolors**, **MiaoBi**, generic **DiT/PixArt/HunYuanDiT** model loaders — `city96/ComfyUI_ExtraModels` currently advertises support for DiT, PixArt, HunYuanDiT, MiaoBi, and a few VAEs. Note that PixArt and HunyuanDiT now also have *core* paths per the README, so ExtraModels is mainly the route for models core hasn't absorbed (e.g. Kolors). Always confirm against the current Templates list, since core support migrates over time.

### Practical takeaways

- Use **`KSampler`** for normal txt2img/img2img; reach for **`KSamplerAdvanced`** or the **`SamplerCustomAdvanced`** graph only when you need multi-pass, custom sigma schedules, or no-negative guiders.
- For **Flux/SD3** remember the 16-channel `EmptySD3LatentImage`, the matching `DualCLIPLoader`/`TripleCLIPLoader`, and guidance via `FluxGuidance`/`BasicGuider` (Flux dev) rather than high `cfg`.
- The decomposed nodes all speak typed sockets — `NOISE`, `SAMPLER`, `SIGMAS`, `GUIDER` — so a scheduler from one family and a sampler from another mix freely through `SamplerCustomAdvanced`.

---

## <a id="conditioning-structural-control"></a>Conditioning & Structural Control

In ComfyUI, "conditioning" is a first-class data type (`CONDITIONING`) that flows on its own wire color. Almost every steering technique below is just a transformation of a conditioning tensor: you start from a `CLIP Text Encode (Prompt)` node, then combine, mask, time-range, or augment the result before feeding the `positive`/`negative` inputs of a `KSampler`. ControlNet, T2I-Adapter, GLIGEN, and unCLIP all attach their guidance *to* a conditioning. In the current ComfyUI source these nodes live under the `model/conditioning/...` node-category namespace (e.g. `model/conditioning`, `model/conditioning/transform`, `model/conditioning/controlnet`, `model/conditioning/gligen`) — not a bare `conditioning/` category. Node names, parameter names, defaults, and ranges below are taken from the ComfyUI source (`nodes.py`, `comfy_extras/`) and the official examples/docs sites; IP-Adapter is a third-party node and is marked as such.

### CLIP Text Encode & prompt-weighting syntax

The core text node is **`CLIP Text Encode (Prompt)`** (class `CLIPTextEncode`, category `model/conditioning`). It encodes a `text` (STRING, multiline, `dynamicPrompts=True`) against a `clip` (CLIP) model and outputs a single `CONDITIONING`. The CLIP encoder turns your words into the embedding the diffusion UNet cross-attends to.

Prompt syntax supported by core ComfyUI (documented on the BlenderNeko ComfyUI docs):

| Syntax | Effect |
|---|---|
| `(word:1.2)` | Increase attention weight on `word` to 1.2 |
| `(word:0.8)` | Decrease attention weight |
| `(word)` | Shorthand for default weight `1.1` (`(flower)` == `(flower:1.1)`) |
| `((flowers:1.2):.5)` | Nested weights **multiply** → effective 0.6 |
| `\(1990\)` | Escape to render a literal parenthesis |
| `embedding:name` | Inject a textual-inversion embedding from `ComfyUI/models/embeddings` |
| `{day\|night\|morning}` | Dynamic-prompt wildcard — picks one per queue run |

- `Ctrl+Up` / `Ctrl+Down` on selected text inserts/adjusts the weight syntax automatically; the up/down step amount is configurable in settings.
- Embedding architecture must match the checkpoint (SD1.5 embeddings don't work on SDXL).
- (Note: the canonical docs document the *syntax* but do not formally specify how ComfyUI's weight normalization math differs from A1111 — treat cross-tool weight equivalence as unverified.)
- For SDXL there is a separate dual-encoder node, **`CLIP Text Encode (SDXL)`** (class `CLIPTextEncodeSDXL`) and **`CLIP Text Encode (SDXL Refiner)`** (class `CLIPTextEncodeSDXLRefiner`), both under category `model/conditioning/stable diffusion`. The SDXL node exposes the dual `text_g`/`text_l` prompts plus size-conditioning fields (`width`, `height`, `crop_w`, `crop_h`, `target_width`, `target_height`, all default 1024 except the crops at 0); the Refiner node exposes a single `text`, `ascore` (default 6.0), `width`, and `height`.

### Conditioning combine / average / concat / zero-out

These live under `model/conditioning/transform`. They are how you merge or blend multiple text encodes.

| Display name (class) | Inputs | Behavior |
|---|---|---|
| **Conditioning (Combine)** (`ConditioningCombine`) | `conditioning_1`, `conditioning_2` | Concatenates the two conditioning **lists** so the sampler honors both — used to stack multiple area/mask conditionings into one |
| **Conditioning (Average)** (`ConditioningAverage`) | `conditioning_to`, `conditioning_from`, `conditioning_to_strength` (FLOAT, default 1.0, 0.0–1.0, step 0.01) | Weighted average of the two embeddings; `conditioning_to_strength` is the blend toward `_to` |
| **Conditioning (Concat)** (`ConditioningConcat`) | `conditioning_to`, `conditioning_from` | Concatenates `_from` onto `_to` along the token dimension (one longer prompt sequence rather than a list) |
| **Conditioning Zero Out** (`ConditioningZeroOut`) | `conditioning` | Returns a zeroed embedding of the same shape — a clean empty/neutral conditioning (commonly for negatives on models that want a true-empty negative) |

Practical distinction: **Combine** keeps two separate conditionings active in parallel (good for area composition); **Concat** fuses them into a single longer token stream; **Average** interpolates between them.

### Area / regional / mask prompting

All under `model/conditioning/transform`. These spatially scope a conditioning to a rectangle or an arbitrary mask, then you typically `Conditioning (Combine)` them and feed the result as `positive`.

| Display name (class) | Key params (defaults / ranges) |
|---|---|
| **Conditioning (Set Area)** (`ConditioningSetArea`) | `width`/`height` (INT, default 64, min 64, step 8), `x`/`y` (INT, default 0, min 0, step 8), `strength` (FLOAT, default 1.0, 0.0–10.0, step 0.01) |
| **Conditioning (Set Area with Percentage)** (`ConditioningSetAreaPercentage`) | `width`/`height`/`x`/`y` are FLOAT fractions (default `width`/`height` 1.0, `x`/`y` 0, range 0–1.0, step 0.01); `strength` 0.0–10.0 |
| **Conditioning (Set Mask)** (`ConditioningSetMask`) | `mask` (MASK), `strength` (FLOAT, default 1.0, 0.0–10.0), `set_cond_area` (`"default"` or `"mask bounds"`) |

Notes from the official area-composition example:
- Each area carries its own prompt; you combine several so different regions render different content (the canonical demo splits an image into four areas: "night / evening / day / morning").
- "Stable diffusion creates its most consistent images when generating square images with resolutions of close to 512×512" — so keeping the subject area square/near-512×512 improves consistency on non-square canvases.
- The example does a second (higher-resolution) pass; it notes that *without* area prompts SD "tries to make the overall image consistent with itself" (which can, e.g., merge hair colors across regions). This is described as observed behavior, not as a recommended seam-harmonization recipe.
- `Set Mask` with `set_cond_area = "mask bounds"` restricts sampling to the mask's bounding box; `"default"` applies over the full canvas weighted by the mask.

### Conditioning timestep range

**Conditioning Set Timestep Range** (`ConditioningSetTimestepRange`, category `model/conditioning/transform`): `conditioning`, `start` (FLOAT, default 0.0, 0.0–1.0, step 0.001), `end` (FLOAT, default 1.0, 0.0–1.0, step 0.001). It limits *when* a conditioning is active across the sampling schedule (fractions of total steps). Combine two timestep-ranged conditionings to swap prompts mid-generation (e.g. prompt A for steps 0–0.5, prompt B for 0.5–1.0).

### ControlNet (apply + loaders + the model family)

ControlNet adds a parallel control branch to the UNet so an input control image (edge map, depth, pose, etc.) steers structure. Loaders and apply nodes:

| Display name (class) | Notes |
|---|---|
| **Load ControlNet Model** (`ControlNetLoader`, category `model/loaders`) | `control_net_name` from `ComfyUI/models/controlnet`. Also loads **T2I-Adapter** files (same node). |
| **Load ControlNet Model (diff)** (`DiffControlNetLoader`, category `model/loaders`) | Takes a `model` input; for "diff" ControlNets that need the base model weights to reconstruct. |
| **Apply ControlNet** (`ControlNetApplyAdvanced`, category `model/conditioning/controlnet`) | The current/recommended apply node (display name "Apply ControlNet"). |
| **Apply ControlNet (DEPRECATED)** (`ControlNetApply`, category `model/conditioning/controlnet`) | Legacy single-conditioning apply; flagged `deprecated = True` in source. |

**Apply ControlNet** (`ControlNetApplyAdvanced`) inputs: `positive` (CONDITIONING), `negative` (CONDITIONING), `control_net` (CONTROL_NET), `image` (IMAGE), `strength` (FLOAT, default 1.0, 0.0–10.0, step 0.01), `start_percent` (FLOAT, default 0.0, 0.0–1.0, step 0.001), `end_percent` (FLOAT, default 1.0, 0.0–1.0, step 0.001), and an **optional `vae`** (used by ControlNets that operate in latent space, e.g. some FLUX/SD3 and inpaint ControlNets). Outputs both modified `positive` and `negative`. `start_percent`/`end_percent` gate the control to a slice of the schedule.

Key behaviors (from the official ControlNet examples/tutorial):
- **Apply ControlNet does NOT preprocess** — per the docs, "The ControlNetApply node will not convert regular images into depthmaps, canny maps and so on for you." You must feed an already-prepared control image. The community packs **ComfyUI ControlNet aux** (`comfyui_controlnet_aux`) and **ComfyUI-Advanced-ControlNet** are commonly used for the full preprocessor set.
- Chain multiple **Apply ControlNet** nodes to stack several ControlNets/adapters.
- The ControlNet model "is run once every iteration" (hence the speed cost), versus a T2I-Adapter which "runs once in total."
- Model files go in `ComfyUI/models/controlnet`.

**Model family** (the control modalities): canny (edges), depth (depthmap), openpose (pose keypoints), scribble, lineart / anime lineart, MLSD (straight lines), HED/PiDi/soft-edge, normal map, segmentation, tile, inpaint. For SDXL, stability.ai released **Control-LoRA** variants (rank 256 and rank 128) that are much smaller than full ControlNets.

**Union / ProMax ControlNet** — a single model handling many modalities, selected via **Set Union ControlNet Type** (`SetUnionControlNetType`, category `model/conditioning/controlnet`): `control_net` + `type` = `"auto"` plus the keys of `UNION_CONTROLNET_TYPES`, which are exactly: `openpose`, `depth`, `hed/pidi/scribble/ted`, `canny/lineart/anime_lineart/mlsd`, `normal`, `segment`, `tile`, `repaint`.

**Inpaint ControlNet (AliMama)** — **Apply ControlNet Inpainting (AliMama)** (`ControlNetInpaintingAliMamaApply`, category `model/conditioning/controlnet`): `positive`, `negative`, `control_net`, `vae`, `image`, `mask`, `strength` (default 1.0, 0.0–10.0, step 0.01), `start_percent`/`end_percent` (0.0–1.0, step 0.001). Purpose-built apply node for the AliMama FLUX inpaint ControlNet.

### T2I-Adapter

T2I-Adapters are loaded with the **same `Load ControlNet Model` node** and applied with the **same `Apply ControlNet` node** as ControlNets — the docs state "T2I-Adapters are used the same way as ControlNets in ComfyUI: using the ControlNetLoader node." The architectural difference (from the official Depth T2I-Adapter tutorial and examples):

- T2I-Adapter is tiny — "only about 77M parameters (approximately 300MB in size)" vs full ControlNets — and runs **once total** rather than once per iteration, so its "inference speed is about 3 times faster than ControlNet" with near-zero generation-speed penalty.
- ControlNet gives more precise control in some cases; T2I-Adapter is the "lightweight control" option.
- Adapter modalities (per the tutorial): **Depth, Line Art (Canny/Sketch), Keypose, Segmentation (Seg), Color.** Example file: `t2iadapter_depth_sd15v2.pth` placed in `models/controlnet/`.

### IP-Adapter (image prompting — third-party)

IP-Adapter ("image prompt adapter") transfers subject/style from a reference image via CLIP-Vision embeddings injected into UNet cross-attention. **It is not in core ComfyUI** — the reference implementation is the custom node pack **`cubiq/ComfyUI_IPAdapter_plus`** (install into `custom_nodes/`). Models go in `ComfyUI/models/ipadapter` (create it if absent).

Main nodes:
- **IPAdapter Unified Loader** — auto-loads the matching IP-Adapter + CLIP-Vision stack by preset; daisy-chain its `ipadapter` in/out across multiple apply nodes to avoid double-loading.
- **IPAdapter Model Loader** — loads only the IP-Adapter model file (manual file selection).
- **IPAdapter Advanced** — the full apply node.

Key params: `weight` (start ~0.8 for linear), `weight_type` (e.g. `linear`, `ease in/out`, `weak input`, and SDXL-only `style transfer`), `combine_embeds` for multiple refs (`concat`, `average`, `subtract`), `start_at`/`end_at` (schedule gating), and `embeds_scaling` (e.g. `K+mean(V) w/ C penalty`, which the docs note "grants good quality at high weights (>1.0)"). **IPAdapter FaceID** variants additionally require the **InsightFace** library (per the README: "FaceID models require `insightface`"). (Note: the project's `NODES.md` is explicitly incomplete, so the full enumerated option lists for `weight_type`/`embeds_scaling` should be confirmed against the node UI in your installed version.)

### GLIGEN (grounded layout)

GLIGEN places named concepts at specific boxes — "The text box GLIGEN model lets you specify the location and size of multiple objects in the image." Models go in `ComfyUI/models/gligen`.

- **Load GLIGEN Model** (`GLIGENLoader`, category `model/loaders`): `gligen_name`.
- **Apply GLIGEN Text Box** (`GLIGENTextBoxApply`, category `model/conditioning/gligen`): `conditioning_to`, `clip`, `gligen_textbox_model` (GLIGEN), `text` (multiline), and a box defined by `width`/`height` (INT, default 64, min 8, step 8) and `x`/`y` (INT, default 0, min 0, step 8). You write your full prompt normally, then add a GLIGEN box per object to pin where it appears.

### Inpainting & outpainting

Three latent strategies for inpainting:

1. **VAE Encode (for Inpainting)** (`VAEEncodeForInpaint`, category `model/latent`): `pixels`, `vae`, `mask`, `grow_mask_by` (INT, default 6, 0–64, step 1). Encodes the image but masks the latent so the masked region is regenerated; `grow_mask_by` expands the mask for a clean transition. Often paired with a dedicated inpainting checkpoint (the example uses an SD v2 inpainting model), though the docs note "It also works with non inpainting models."
2. **Set Latent Noise Mask** (`SetLatentNoiseMask`, category `model/latent`): `samples` (LATENT), `mask`. Lighter approach — keeps the full encoded latent and only restricts where noise is applied, so unmasked pixels are better preserved. Pair with a lower `denoise` on the KSampler.
3. **InpaintModelConditioning** (`InpaintModelConditioning`, category `model/conditioning`): `positive`, `negative`, `vae`, `pixels`, `mask`, `noise_mask` (BOOLEAN, default True). Bakes the inpaint image+mask into the conditioning the way modern inpaint-aware models (SD3, FLUX Fill) expect, outputting modified positive/negative plus a latent.

Masks come from **Load Image** → right-click → **Open in MaskEditor**, or from the image's alpha channel ("the alpha channel is what we will be using as a mask for the inpainting").

**Outpainting** is inpainting on padded canvas. **Pad Image for Outpainting** (`ImagePadForOutpaint`, category `image/transform`): `image`, `left`/`top`/`right`/`bottom` (INT, default 0, step 8), `feathering` (INT, default 40, step 1). It "automatically pad[s] the image for outpainting while creating the proper mask," outputting the padded `IMAGE` and a `MASK` marking the new (empty) region — feed both into VAE Encode (for Inpainting) → KSampler. Higher feathering smooths the seam.

### Masks & mask operations

Most mask utilities live under `image/mask`; the two composite-masked nodes live elsewhere (`LatentCompositeMasked` under `model/latent`, `ImageCompositeMasked` under `image/compositing`). Masks are single-channel 0–1 tensors.

| Display name (class) | Purpose / key params |
|---|---|
| **Convert Image to Mask** (`ImageToMask`) | `channel` = red/green/blue/alpha |
| **Convert Mask to Image** (`MaskToImage`) | mask → 3-channel image |
| **Convert Image Color to Mask** (`ImageColorToMask`) | `color` (INT, 0–0xFFFFFF) match |
| **Create Solid Mask** (`SolidMask`) | `value` 0.0–1.0, `width`/`height` (default 512) |
| **Invert Mask** (`InvertMask`) | `1.0 - mask` |
| **Crop Mask** (`CropMask`) | `x`,`y`,`width`,`height` |
| **Combine Masks** (`MaskComposite`) | `destination`,`source`,`x`,`y`,`operation` = multiply/add/subtract/and/or/xor |
| **Feather Mask** (`FeatherMask`) | `left`,`top`,`right`,`bottom` edge falloff (default 0) |
| **Grow Mask** (`GrowMask`) | `expand` (dilate +, erode −), `tapered_corners` (BOOLEAN, default True) |
| **Threshold Mask** (`ThresholdMask`) | `value` binarize threshold (default 0.5, 0.0–1.0) |
| **Latent Composite Masked** (`LatentCompositeMasked`) | composite latents through a mask |
| **Image Composite Masked** (`ImageCompositeMasked`) | composite images through a mask |

(Note: `Blur Image` / `ImageBlur` is an image filter under `image/postprocessing`, not a mask node — it was removed from this table to avoid the implication that it lives under the mask category.)

### unCLIP / image conditioning

unCLIP models are "versions of SD models that are specially tuned to receive image concepts as input" alongside text. Flow:

1. **Load unCLIP Checkpoint** (`unCLIPCheckpointLoader`, category `model/loaders`): `ckpt_name`. unCLIP checkpoints bundle a CLIP-Vision encoder.
2. **CLIP Vision Encode** (`CLIPVisionEncode`, category `model/conditioning`): `clip_vision`, `image`, `crop` (`center` or `none`) → `CLIP_VISION_OUTPUT`.
3. **unCLIP Conditioning** (`unCLIPConditioning`, category `model/conditioning`): `conditioning`, `clip_vision_output`, `strength` (FLOAT, default 1.0, **−10.0 to 10.0**, step 0.01), `noise_augmentation` (FLOAT, default 0.0, 0.0–1.0, step 0.01). Per the docs, "noise_augmentation controls how closely the model will try to follow the image concept. The lower the value the more it will follow the concept." Multiple unCLIP conditionings / images can be combined; the docs note it "doesn't blend the images together in the traditional sense but actually picks some concepts from both and makes a coherent image."

Unlike ControlNet/T2I-Adapter (which work on any model), unCLIP image conditioning **requires an unCLIP-tuned checkpoint** — it cannot be bolted onto an arbitrary model.

---

## <a id="lora-model-merging-model-surgery"></a>LoRA, Model Merging & Model Surgery

Everything in this section ships in **ComfyUI core** unless explicitly marked otherwise. Node parameters, categories, and defaults below were read directly from the master branch of `comfyanonymous/ComfyUI` (`comfy_extras/*.py`, `nodes.py`, `comfy/lora.py`, `comfy/weight_adapter/`) as of June 2026. Most of these nodes do not retrain anything — they wrap the loaded `MODEL`/`CLIP` object in a *patch* (a deferred weight modification or a UNet/attention hook) that takes effect at sample time. That is why almost all of them take a `MODEL` in and return a `MODEL` out, and can be freely chained.

### How model patching works conceptually

A ComfyUI `MODEL` is a `ModelPatcher` wrapping the diffusion network. "Surgery" nodes call `model.clone()` and register either:

- **Weight patches** — additive deltas applied to named weights (LoRA, hypernetwork, merge nodes). Lazy: applied when weights load to the GPU.
- **`set_model_*` patches** — runtime hooks into the forward pass (`set_model_unet_function_wrapper`, `set_model_attn1_patch`, `set_model_output_block_patch`, `set_model_sampler_post_cfg_function`, etc.). These power FreeU, PAG, SAG, Deep Shrink, HyperTile, ToMe, and CFG rescaling.

Because each node clones and re-patches, **order in the chain rarely matters for additive weight patches but can matter for forward-pass hooks**. All patch nodes are non-destructive to the upstream model object.

### LoRA & LyCORIS loaders

| Node | Category | Inputs | Returns | Notes |
|---|---|---|---|---|
| `LoraLoader` | `model/loaders` | `model`, `clip`, `lora_name`, `strength_model` (FLOAT, default 1.0, −100→100, step 0.01), `strength_clip` (FLOAT, default 1.0, −100→100, step 0.01) | `MODEL`, `CLIP` | The standard loader. Patches both UNet and text encoder. Strengths may be negative. |
| `LoraLoaderModelOnly` | `model/loaders` | `model`, `lora_name`, `strength_model` | `MODEL` | Subclass of `LoraLoader`; its `load_lora_model_only` calls `load_lora(model, None, …, strength_clip=0)`. Use for diffusion models with no CLIP on the same graph (e.g. Flux/SD3 UNet-only flows, or video models). |

- LoRAs load from `ComfyUI/models/loras` (including subfolders, plus any `extra_model_paths.yaml` entries). A UI refresh may be needed after dropping in new files.
- **Stacking** is done by chaining multiple `LoraLoader` nodes (`model→model`, `clip→clip`). The official docs explicitly endorse this — "If you need to load multiple LoRA models, you can directly chain multiple nodes together." There is no built-in "lora stack" array node in core.
- **LyCORIS is natively supported.** `comfy/lora.py` `load_lora` plus the `comfy/weight_adapter/` registry parse the formats. The adapter classes defined in `comfy/weight_adapter/__init__.py` are `LoRAAdapter`, `LoHaAdapter`, `LoKrAdapter`, `GLoRAAdapter`, `OFTAdapter`, and `BOFTAdapter`, but the active `adapter_maps` registry only wires up LoRA, LoHa, LoKr, and OFT — `GLoRA` and `BOFTAdapter` are commented out ("`## We disable not implemented algo for now`"). Core `load_lora` also directly handles `.alpha`, **DoRA** (`.dora_scale`), `.diff`/`.diff_b`, `.w_norm`/`.b_norm`, and `.set_weight`. Key-name mapping covers diffusers (`lora_unet_*`/`lora_te_*`), `lycoris_*`, OneTrainer (`lora_transformer_*`), and per-architecture conventions (SD3, Flux, HunyuanVideo, HiDream, Mochi, ACEStep, QwenImage, etc.).

### Hypernetworks

| Node | Category | Inputs | Returns |
|---|---|---|---|
| `HypernetworkLoader` | `model/loaders` | `model`, `hypernetwork_name`, `strength` (FLOAT, default 1.0, −10→10, step 0.01) | `MODEL` |

Loads from `ComfyUI/models/hypernetworks`. Clones the model and patches the cross/self-attention layers (`attn1`, `attn2`) with the hypernetwork at the given strength. This is the legacy SD1.x-era technique; it is still in core but rarely used with modern architectures.

### Embeddings / Textual Inversion

There is **no loader node** — embeddings are invoked inline in the prompt text of any CLIP text-encode node. Place `.pt`/`.safetensors` files in `ComfyUI/models/embeddings`, then:

- `embedding:SDA768` or `embedding:SDA768.pt` — extension optional
- `(embedding:SDA768:1.2)` — standard prompt-weighting syntax applies
- Position matters: per the official examples, "embeddings are basically custom words so where you put them in the text prompt matters" — e.g. `red embedding:cat` reads differently than `embedding:cat red`.

The keyword is replaced with the learned token vectors at encode time. Works in both positive and negative prompts.

### Model merging — simple, arithmetic, and CLIP

All in category `model/merging`. Merge nodes operate on the patch/weight level and are previewed live; nothing is written to disk until you run a Save node.

| Node (display name → mapping) | Inputs | Weighting math |
|---|---|---|
| `ModelMergeSimple` | `model1`, `model2`, `ratio` (FLOAT 0→1, default 1.0, step 0.01) | model2 applied at `(1−ratio, ratio)`. ratio=1.0 → pure model2; 0.0 → pure model1. |
| `ModelMergeBlocks` | `model1`, `model2`, `input`, `middle`, `out` (each FLOAT 0→1, default 1.0) | Different blend ratio per UNet block group, matched by key name. |
| `ModelSubtract` (mapping `ModelMergeSubtract`) | `model1`, `model2`, `multiplier` (FLOAT −10→10, default 1.0) | `(−multiplier, multiplier)` → model1 − model2·multiplier. |
| `ModelAdd` (mapping `ModelMergeAdd`) | `model1`, `model2` | weights `(1.0, 1.0)`. |
| `CLIPMergeSimple` | `clip1`, `clip2`, `ratio` | Same as ModelMergeSimple but for CLIP. Excludes `position_ids` and `logit_scale`. |
| `CLIPSubtract` (mapping `CLIPMergeSubtract`) | `clip1`, `clip2`, `multiplier` | CLIP difference. |
| `CLIPAdd` (mapping `CLIPMergeAdd`) | `clip1`, `clip2` | Adds two text encoders. |

Note the display-name vs. mapping-name split: the subtract/add nodes register under `ModelMergeSubtract`/`ModelMergeAdd`/`CLIPMergeSubtract`/`CLIPMergeAdd` but their Python classes are `ModelSubtract`/`ModelAdd`/`CLIPSubtract`/`CLIPAdd`.

The classic **"add difference"** recipe — `(inpaint_model − base_model) * 1.0 + other_model` — is built by feeding `ModelMergeSubtract` into `ModelMergeAdd`, per the official examples page ("If you are familiar with the 'Add Difference' option in other UIs this is how to do it in ComfyUI").

### Model merging — architecture-aware (per-block)

These inherit `ModelMergeBlocks` and live in category `model/merging/model specific`. Each exposes one FLOAT ratio (0→1) **per named block** of that specific architecture, for surgical block-by-block merges. Full set in core (verified against `nodes_model_merging_model_specific.py`):

- **Image UNet/DiT:** `ModelMergeSD1`, `ModelMergeSD2` (SD1 and SD2 share blocks: `time_embed.`, `label_emb.`, `input_blocks.0–11.`, `middle_block.0–2.`, `output_blocks.0–11.`, `out.`), `ModelMergeSDXL` (input/output blocks 0–8), `ModelMergeSD3_2B` (`joint_blocks.0–23.`), `ModelMergeSD35_Large` (`joint_blocks.0–37.`), `ModelMergeAuraflow` (`double_layers.0–3.`, `single_layers.0–31.`), `ModelMergeFlux1` (`double_blocks.0–18.`, `single_blocks.0–37.`, plus `img_in.`/`time_in.`/`guidance_in`/`vector_in.`/`txt_in.`/`final_layer.`), `ModelMergeQwenImage` (`transformer_blocks.0–59.`).
- **Cosmos:** `ModelMergeCosmos7B` (`blocks.block0–27.`), `ModelMergeCosmos14B` (`blocks.block0–35.`), `ModelMergeCosmosPredict2_2B` (`blocks.0–27.`), `ModelMergeCosmosPredict2_14B` (`blocks.0–35.`).
- **Video:** `ModelMergeMochiPreview` (`blocks.0–47.`), `ModelMergeLTXV` (`transformer_blocks.0–27.`), `ModelMergeWAN2_1` (`blocks.0–39.`; the 1.3B model uses 30 blocks, the 14B model 40, and the I2V variant adds `img_emb.`).

### Saving merged / extracted models

| Node | Category | Default `filename_prefix` | Saves |
|---|---|---|---|
| `CheckpointSave` (display "Save Checkpoint") | `model/merging` | `checkpoints/ComfyUI` | Full model + CLIP + VAE → one `.safetensors`, with modelspec metadata (SDXL/SD3/SVD-aware, prediction type) and the embedded workflow. |
| `ModelSave` | `model/merging` | `diffusion_models/ComfyUI` | UNet/diffusion weights only. |
| `CLIPSave` | `model/merging` | `clip/ComfyUI` | Text encoder(s), handling multiple encoder prefixes. |
| `VAESave` | `model/merging` | `vae/ComfyUI_vae` | VAE only. |
| `LoraSave` (display "Extract and Save Lora") | `experimental` | `loras/ComfyUI_extracted_lora` | **LoRA extraction** via SVD from a model/CLIP *difference*. Params: `rank` (INT, default 8, 1→4096), `lora_type` (`standard` / `full_diff`), `bias_diff` (BOOL, default True), optional `model_diff`, `text_encoder_diff`. |

Practical guidance from the canonical examples page: a Save node is usually left **muted** while you tune ratios, then unmuted for a single run. Merges are written in the inference precision (typically fp16); launch with `--force-fp32` for 32-bit merges. Saved checkpoints go to `output/checkpoints/` by default and embed the full workflow.

### Runtime model patches — guidance & quality

All take `MODEL`→`MODEL`. Categories vary; experimental ones are flagged in-UI.

| Node | Category | Key params (defaults) | What it does |
|---|---|---|---|
| `FreeU` | `model/patch/unet` | `b1` 1.1, `b2` 1.2, `s1` 0.9, `s2` 0.2 (all 0→10, step 0.01) | Scales the first half of backbone feature channels (b1/b2) and Fourier-filters skip connections (s1/s2) in UNet output blocks. Targets `model_channels×4` and `×2`. |
| `FreeU_V2` | `model/patch/unet` | `b1` 1.3, `b2` 1.4, `s1` 0.9, `s2` 0.2 | Adaptive variant: scales by normalized hidden-state statistics instead of a fixed multiply. Generally the recommended version. |
| `PerturbedAttentionGuidance` (PAG) | `model/patch/unet` | `scale` 3.0 (0→100, step 0.01) | Generates a degraded prediction by replacing self-attention with an identity map, then guides away from it via a post-CFG function. Improves structure/coherence; raises compute (extra model pass). |
| `SelfAttentionGuidance` (SAG) | `experimental` | `scale` 0.5 (−2→5, step 0.01), `blur_sigma` 2.0 (0→10, step 0.1, advanced) | Records mid-block attention, builds an adversarially blurred image from it, applies during the post-CFG path. |
| `RescaleCFG` | `model/patch` | `multiplier` 0.7 (0→1, step 0.01) | Rescales guidance by matching the std-dev of the CFG result to the conditional output — counters oversaturation/burn at high CFG. |
| `PerpNeg` (deprecated) / `PerpNegGuider` | `experimental` | `PerpNeg`: `neg_scale` 1.0 (0→100). `PerpNegGuider`: `cfg` 8.0 (0→100), `neg_scale` 1.0 | Perpendicular-negative guidance. `PerpNeg`'s display name is "Perp-Neg (DEPRECATED by Perp-Neg Guider)"; prefer `PerpNegGuider`, which outputs a `GUIDER` for the custom-sampling graph. |
| `ModelNoiseScale` | `model/patch` | `noise_scale` 1.0 (0→64) | Sets absolute training noise scale (per the in-code tooltip, e.g. HiDream-O1 base 8.0, dev 7.5). |

PAG and SAG hook the post-CFG path; RescaleCFG hooks the CFG result. Note PAG and SAG roughly add inference cost because they require an additional perturbed forward pass.

### Runtime model patches — resolution & performance

| Node | Category | Key params (defaults) | What it does |
|---|---|---|---|
| `PatchModelAddDownscale (Kohya Deep Shrink)` | `model/patch/unet` | `block_number` 3 (1→32), `downscale_factor` 2.0 (0.1→9.0, step 0.001), `start_percent` 0.0, `end_percent` 0.35, `downscale_after_skip` True, `downscale_method` & `upscale_method` ∈ `bicubic`/`nearest-exact`/`bilinear`/`area`/`bislerp` | Downscales the latent inside a chosen UNet block for the early sampling window, enabling coherent high-res generation (high-res-fix style) without doubling memory. Active only between start/end percent of the schedule. |
| `HyperTile` | `model/patch/unet` | `tile_size` 256 (1→2048), `swap_size` 2 (1→128), `max_depth` 0 (0→10), `scale_depth` False | Splits attention into random tiles to speed up high-res sampling and cut VRAM. Patches `attn1` via `set_model_attn1_patch`/`set_model_attn1_output_patch`. |
| `TomePatchModel` (Token Merging / ToMe) | `model/patch/unet` | `ratio` 0.3 (0→1, step 0.01) | Merges redundant tokens before attention to speed sampling; ratio = fraction of tokens merged. |
| `TorchCompileModel` | `experimental` | `backend` ∈ `inductor`/`cudagraphs` | Wraps the model in `torch.compile` (clones with `disable_dynamic=True`) for a one-time-warmup speedup. A guard filter skips `transformer_options` so conditioning changes don't trigger recompiles. |

### Sampling-regime patches (ModelSampling*)

These reconfigure the model's noise schedule / prediction type — required when a checkpoint's training regime differs from the default, or to retrofit techniques like LCM or zSNR. Category `model/patch` (or architecture-specific subcategory).

| Node | Category | Params (options / defaults) |
|---|---|---|
| `ModelSamplingDiscrete` | `model/patch` | `sampling` ∈ `eps`, `v_prediction`, `lcm`, `x0`, `img_to_img`, `img_to_img_flow`; `zsnr` BOOL default False (advanced) |
| `ModelSamplingContinuousEDM` | `model/patch` | `sampling` ∈ `v_prediction`, `edm`, `edm_playground_v2.5`, `eps`, `cosmos_rflow`; `sigma_max` 120.0, `sigma_min` 0.002 |
| `ModelSamplingContinuousV` | `model/patch` | `sampling` ∈ `v_prediction`; `sigma_max` 500.0, `sigma_min` 0.03 |
| `ModelSamplingStableCascade` | `model/patch/stable cascade` | `shift` 2.0 (0→100) |
| `ModelSamplingSD3` | `model/patch/stable diffusion` | `shift` 3.0 |
| `ModelSamplingAuraFlow` | `model/patch` | `shift` 1.73 |
| `ModelSamplingFlux` | `model/patch/flux` | `max_shift` 1.15, `base_shift` 0.5, `width` 1024, `height` 1024 — resolution-dependent dynamic shift |
| `ModelComputeDtype` | `advanced/debug` | `dtype` ∈ `default`/`fp32`/`fp16`/`bf16` (debug aid) |

For Flux specifically, note the separate `FluxGuidance` node (category `model/conditioning/flux`, `guidance` FLOAT default 3.5, 0→100, step 0.1) which embeds the distilled-guidance value into the **conditioning**, not the model — distinct from `ModelSamplingFlux`, which sets the noise shift on the model. Both are typically used together for Flux dev.

### Upscaling with a model

| Node | Category | Inputs / outputs |
|---|---|---|
| `UpscaleModelLoader` | `model/loaders` | `model_name` (from `ComfyUI/models/upscale_models`) → `UPSCALE_MODEL` |
| `ImageUpscaleWithModel` | `image/upscaling` | `upscale_model`, `image` → `IMAGE` |

`ImageUpscaleWithModel` runs ESRGAN-class super-resolution models (e.g. RealESRGAN, 4x-UltraSharp). It applies the model's native scale factor (often 4×) and uses **tiled processing (512×512 tiles, 32-px overlap)** to bound VRAM, halving the tile size (down to a 128 floor) on OOM. To hit an arbitrary target size, follow it with a plain `ImageScale`/`ImageScaleBy` resize.

### Core vs. custom nodes — quick orientation

- **All nodes above ship in core** (`comfy_extras/` or `nodes.py`). No custom packs are required for LoRA/LyCORIS loading, hypernetworks, embeddings, the full merge/save suite, FreeU/FreeU_V2, PAG, SAG, RescaleCFG, Deep Shrink, HyperTile, ToMe, TorchCompile, the ModelSampling* family, LoRA extraction, or upscale-with-model.
- **Community packs** commonly *extend* this surface: multi-LoRA "stack" nodes, LoRA block-weight (LBW) editors with per-block sliders, and granular ModelMergeBlocks UIs are popular custom-node additions, but the per-architecture `ModelMerge*` nodes already give block-level control in core.
- `RescaleCFG` was first published as an experiment in the separate `comfyanonymous/ComfyUI_experiments` repo (`sampler_rescalecfg.py`); the equivalent now ships in core `comfy_extras/nodes_model_advanced.py` — use the core version.

---

## <a id="beyond-images-video-audio-3d"></a>Beyond Images: Video, Audio, 3D

ComfyUI is not image-only. The same graph/latent/sampler machinery drives video, audio, and 3D, and a growing roster of model families ship as **core nodes** (no custom-node install) with official example workflows. The dividing line matters: some ecosystems people associate with ComfyUI (AnimateDiff, CogVideoX) are **custom-node-only**, while others (Wan, Hunyuan, LTX-Video, Mochi, Cosmos, SVD, Stable Audio, ACE-Step, Stable Zero123/SV3D, Hunyuan3D-2) are built into core. This section is precise about which is which, with exact node names sourced from the ComfyUI source tree and official docs.

> Canonical reference points used throughout: the official example gallery (`comfyanonymous.github.io/ComfyUI_examples/`), the docs (`docs.comfy.org`), and the core source (`comfy_extras/*.py`, plus `comfy_api/latest/_ui.py` for the audio save helper). The example index lists exactly these non-image categories: **Stable Video Diffusion, Mochi, Lightricks LTX-Video, Hunyuan Video, Nvidia Cosmos, Nvidia Cosmos Predict2, Wan 2.1, Wan 2.2, Audio Models, 3d, Hunyuan3D 2.0** — CogVideoX and AnimateDiff are *not* on that list.

### Core vs custom-node, at a glance

| Media | Model family | Status in core | Notes |
|---|---|---|---|
| Video | Stable Video Diffusion (SVD / SVD-XT) | **Core** | `ImageOnlyCheckpointLoader`, `VideoLinearCFGGuidance`, `SVD_img2vid_Conditioning` |
| Video | Wan 2.1 / Wan 2.2 | **Core** | MoE high/low-noise experts (2.2 14B); T2V, I2V, FLF2V, TI2V-5B |
| Video | HunyuanVideo | **Core** | T2V + I2V (v1 "concat", v2 "replace") |
| Video | LTX-Video | **Core** | dedicated `LTXV*` nodes; very fast |
| Video | Mochi 1 (Genmo) | **Core** | `EmptyMochiLatentVideo` |
| Video | Nvidia Cosmos (1.0) & Cosmos Predict2 | **Core** | `EmptyCosmosLatentVideo`, `CosmosImageToVideoLatent`, `CosmosPredict2ImageToVideoLatent` |
| Video | **CogVideoX** | **Custom-node only** | via `kijai/ComfyUI-CogVideoXWrapper` (diffusers-backed); *not* a core example |
| Video | **AnimateDiff** | **Custom-node only** | via `Kosinkadink/ComfyUI-AnimateDiff-Evolved`; *not* a core example |
| Audio | Stable Audio Open 1.0 | **Core** | `EmptyLatentAudio`, `VAEDecodeAudio` |
| Audio | ACE-Step v1 | **Core** | `TextEncodeAceStepAudio`, `EmptyAceStepLatentAudio` |
| 3D | Stable Zero123 | **Core** | `StableZero123_Conditioning` |
| 3D | SV3D | **Core** | `SV3D_Conditioning` |
| 3D | Hunyuan3D-2 / 2mv (mesh) | **Core (geometry only)** | `VAEDecodeHunyuan3D`, `VoxelToMesh`, `SaveGLB` — no native texture/material yet |
| 3D | InstantMesh, TripoSR, 3DGS, NeRF, CRM | **Custom-node only** | via `MrForExample/ComfyUI-3D-Pack` |

---

### Video

The shared pattern across every core video model: a **latent with a temporal dimension** (created by an `Empty*LatentVideo` node whose `length` is the frame count), sampled with the normal `KSampler`, decoded by the model's VAE, then turned into frames. `length=1` on most of these latent nodes degenerates to a single image.

#### Stable Video Diffusion (SVD) — image-to-video
Source: official video examples page, with node details confirmed against `comfy_extras/nodes_video_model.py`. Checkpoints go in `ComfyUI/models/checkpoints/`:
- `svd.safetensors` — 14-frame model
- `svd_xt.safetensors` — 25-frame model

Key core nodes and params:
- **`ImageOnlyCheckpointLoader`** — loads the SVD checkpoint with `output_clipvision=True`, returning MODEL / CLIP_VISION / VAE (it bundles the image-conditioning CLIP-vision encoder).
- **`VideoLinearCFGGuidance`** — linearly ramps CFG across frames: the first frame uses `min_cfg` (default `1.0`) and the scale rises linearly to the sampler's `cfg` on the last frame. Improves SVD sampling quality. (`VideoTriangleCFGGuidance` is the sibling variant.)
- **`SVD_img2vid_Conditioning`** exposes **`video_frames`** (default 14), **`motion_bucket_id`** (default 127; higher = more motion), **`fps`** (default 6; higher = less choppy), and **`augmentation_level`** (default 0.0; more noise = output diverges more from the init image).

#### Wan 2.1 / Wan 2.2 (Alibaba) — native, MoE
Source: `docs.comfy.org/tutorials/video/wan/wan2_2`. Native; templates under **Workflow → Browse Templates → Video**. Wan 2.2's headline is a **Mixture-of-Experts (MoE)** denoiser split into a **high-noise expert** and a **low-noise expert**, divided according to denoising timestep. Models live in the standard `models/diffusion_models/`, `models/vae/`, `models/text_encoders/` dirs. Text encoder is **`umt5_xxl_fp8_e4m3fn_scaled.safetensors`** (loaded via the `Load CLIP` / `CLIPLoader` node).

Wan 2.2 variants and files:
- **TI2V-5B** (hybrid text+image-to-video): `wan2.2_ti2v_5B_fp16.safetensors` + **`wan2.2_vae.safetensors`** (high-compression VAE; the docs say it "should fit well on 8GB vram with the ComfyUI native offloading").
- **T2V-14B**: `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` + `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors`, with `wan_2.1_vae.safetensors`.
- **I2V-14B**: `wan2.2_i2v_high_noise_14B_fp16.safetensors` + `wan2.2_i2v_low_noise_14B_fp16.safetensors`, with `wan_2.1_vae.safetensors`.

Wan-specific core nodes:
- **`Wan22ImageToVideoLatent`** — builds the I2V latent in the 5B TI2V workflow.
- **`WanFirstLastFrameToVideo`** — first/last-frame (FLF2V) interpolation.
- Notably, the empty-latent node reused in the **14B T2V and 14B I2V** templates is **`EmptyHunyuanLatentVideo`** (the Hunyuan latent node doubles as the generic video latent here — a real ComfyUI quirk worth knowing). The 5B TI2V workflow uses `Wan22ImageToVideoLatent` instead.

Wan 2.1 is likewise native; the TI2V-5B (Wan 2.2) is the headline ~8GB-VRAM option, while the 14B variants need more. Wan 2.2 TI2V-5B is licensed Apache-2.0.

#### HunyuanVideo (Tencent) — native, 13B DiT
Source: `docs.comfy.org/tutorials/video/hunyuan/hunyuan-video`. A ~13B **DiT (Diffusion Transformer)** with a 3D VAE and MLLM text encoders for image-video-text alignment. Shared models:
- Text encoders: `clip_l.safetensors` + `llava_llama3_fp8_scaled.safetensors` → `models/text_encoders/`, loaded with **`DualCLIPLoader`**.
- VAE: `hunyuan_video_vae_bf16.safetensors` → `models/vae/`.

Variants:
- **T2V**: diffusion model `hunyuan_video_t2v_720p_bf16.safetensors`.
- **I2V** needs CLIP-vision `llava_llama3_vision.safetensors` → `models/clip_vision/`, plus one of two diffusion models:
  - **v1 "concat"** (`hunyuan_video_image_to_video_720p_bf16.safetensors`) — better motion fluidity, weaker image adherence.
  - **v2 "replace"** (`hunyuan_video_v2_replace_image_to_video_720p_bf16.safetensors`) — better image adherence, seemingly less dynamic.

Core node: **`EmptyHunyuanLatentVideo`** (sets resolution + `length`; `length=1` yields a still image). Default templates target 720p clips.

#### LTX-Video (Lightricks) — native, fast
Source: `docs.comfy.org/tutorials/video/ltxv` (documented at v0.9.5). Files:
- Checkpoint `ltx-video-2b-v0.9.5.safetensors` → `checkpoints/`
- Text encoder `t5xxl_fp16.safetensors` → `text_encoders/`

Dedicated core nodes: **`LTXVConditioning`**, **`EmptyLTXVLatentVideo`**, **`LTXVImgToVideo`**. Workflow variants: T2V, I2V, and multi-frame control (start + end frame guidance). Practical note from the docs: **LTX-Video wants long, descriptive prompts** for good results. It's a highly efficient model and the lightest of the core video families on VRAM.

#### Mochi 1 (Genmo) — native, AsymmDiT 10B
Source: `comfyanonymous.github.io/ComfyUI_examples/mochi/`; the `length` constraints below come from `comfy_extras/nodes_mochi.py`. Split files (from `Comfy-Org/mochi_preview_repackaged`):
- `diffusion_models/mochi_preview_bf16.safetensors`
- `text_encoders/t5xxl_fp16.safetensors`
- `vae/mochi_vae.safetensors`
- Or the all-in-one `mochi_preview_fp8_scaled.safetensors` (fp8 = faster/less VRAM, lower quality than the 16-bit files).

Core latent node: **`EmptyMochiLatentVideo`** (`length` default 25, min 7, step 6). Mochi's frame count follows the **7 + 6n** rule (valid lengths 7, 13, 19, 25, …), which the node enforces via its min/step and the internal `((length - 1) // 6) + 1` latent math.

#### Nvidia Cosmos — native (1.0 and Predict2)
Source: `comfyanonymous.github.io/ComfyUI_examples/cosmos/`; node names and defaults from `comfy_extras/nodes_cosmos.py`. Core supports the **7B and 14B** diffusion models in both **Text2World** (= text-to-video) and **Video2World** (= image/video-to-video) flavors. Files:
- Text encoder **`oldt5_xxl_fp8_e4m3fn_scaled.safetensors`** → `models/text_encoders/`. Critical gotcha called out in the docs: **`oldt5_xxl` is T5XXL 1.0, NOT the T5XXL 1.1 used by FLUX and other models — they are not interchangeable.**
- VAE `cosmos_cv8x8x8_1.0.safetensors` → `models/vae/`.
- Diffusion models e.g. `Cosmos-1_0-Diffusion-7B-Text2World.safetensors`, `Cosmos-1_0-Diffusion-7B-Video2World.safetensors` → `models/diffusion_models/`.

Core nodes (defaults from source):
- **`EmptyCosmosLatentVideo`** — T2V latent; node defaults `width=1280`, `height=704`, `length=121`. `width`/`height` step by 16 (must be multiples of 16); `length` steps by 8.
- **`CosmosImageToVideoLatent`** — I2V/interpolation; same `width=1280`/`height=704`/`length=121` defaults, with optional `start_image` and `end_image` inputs.
- **`CosmosPredict2ImageToVideoLatent`** — the newer **Cosmos Predict2** family's I2V latent node (documented at `docs.comfy.org/built-in-nodes/CosmosPredict2ImageToVideoLatent`); defaults `width=848`, `height=480`, `length=93` (step 4), with optional `start_image`/`end_image`. Outputs `samples` + `noise_mask`.

#### Custom-node video ecosystems (NOT core)
- **AnimateDiff** — the motion-module approach for animating SD1.5/SDXL. In ComfyUI this is **`Kosinkadink/ComfyUI-AnimateDiff-Evolved`** plus typically `ComfyUI-VideoHelperSuite` for video I/O. It is *not* in core and not on the official example index.
- **CogVideoX** (Tsinghua/Zhipu) — used via **`kijai/ComfyUI-CogVideoXWrapper`** (a diffusers-backed wrapper exposing `CogVideoXModelLoader`, `CogVideoXImageEncode`, `CogVideoSampler`, `CogVideoDecode`, `CogVideoXImageToVideo`, `CogVideoTextEncode`, etc.). Actively maintained, but not core and not on the example index.

---

### Audio

Audio is a first-class latent type in core. The audio nodes live in **`comfy_extras/nodes_audio.py`** (verified against `master`), and the metadata-embedding helper they call lives in **`comfy_api/latest/_ui.py`**. Two model families ship with official examples.

#### Models
- **Stable Audio Open 1.0** (Stability) — `stable_audio_open_1.0.safetensors` → `models/checkpoints/`, with text encoder `t5_base.safetensors` → `models/text_encoders/`. Typical pipeline: `CheckpointLoaderSimple` → `CLIPTextEncode` (pos/neg) → `EmptyLatentAudio` → `KSampler` → **`VAEDecodeAudio`** → a Save Audio node.
- **ACE-Step v1** (ACE Studio + StepFun, Apache-2.0) — `ace_step_v1_3.5b.safetensors` → `models/checkpoints/`. It's a music model with **lyrics + style tags** (source: `docs.comfy.org/tutorials/audio/ace-step/ace-step-v1`). Pipeline uses:
  - **`TextEncodeAceStepAudio`** — fields **`tags`** (style descriptors, comma-separated, e.g. "electronic, pop, female voice") and **`lyrics`** (supports structure tags like `[verse]`/`[chorus]`/`[bridge]` and per-language codes like `[zh]`/`[ko]`/`[ja]`).
  - **`EmptyAceStepLatentAudio`** — controls track **duration**.
  - **`LatentOperationTonemapReinhard`** — `multiplier` controls vocal prominence (higher = more prominent).
  - For **audio-to-audio**, feed `LoadAudio` and lower the `KSampler` `denoise` (lower = closer to source).

#### Core audio nodes (current master)
The audio toolkit goes well beyond load/save. From `nodes_audio.py`:

| Node (class) | Display name | Role |
|---|---|---|
| `EmptyLatentAudio` | Empty Latent Audio | seed an empty audio latent (duration) |
| `ConditioningStableAudio` | ConditioningStableAudio | Stable Audio conditioning |
| `VAEEncodeAudio` | VAE Encode Audio | waveform → latent |
| `VAEDecodeAudio` | VAE Decode Audio | latent → waveform |
| `VAEDecodeAudioTiled` | VAE Decode Audio (Tiled) | memory-friendly decode |
| `SaveAudioAdvanced` | Save Audio (Advanced) | **current recommended save node** (choose format) |
| `SaveAudio` | Save Audio (FLAC) **(DEPRECATED)** | legacy FLAC save |
| `SaveAudioMP3` | Save Audio (MP3) **(DEPRECATED)** | legacy MP3 save |
| `SaveAudioOpus` | Save Audio (Opus) **(DEPRECATED)** | legacy Opus save |
| `PreviewAudio` | Preview Audio | in-graph playback |
| `LoadAudio` | Load Audio | read an audio file |
| `RecordAudio` | Record Audio | capture from mic |
| `TrimAudioDuration` | Trim Audio Duration | cut |
| `SplitAudioChannels` / `JoinAudioChannels` | Split / Join Audio Channels | channel ops |
| `AudioConcat` | Concatenate Audio | sequence two clips |
| `AudioMerge` | Merge Audio | overlay/mix |
| `AudioAdjustVolume` | Adjust Audio Volume | gain |
| `EmptyAudio` | Empty Audio | silent buffer |
| `AudioEqualizer3Band` | Audio Equalizer (3-Band) | EQ |

> **Deprecation note (verified on `master`, 2026-06):** the three single-format `SaveAudio*` nodes are labeled DEPRECATED (`is_deprecated=True`) in favor of **`SaveAudioAdvanced`**, which exposes a format selector (FLAC/MP3/Opus) and conditional quality params. Older tutorials/templates still wire `SaveAudio`/`SaveAudioMP3`; they continue to function but new graphs should use the advanced node.

#### FLAC (and MP3/Opus) with embedded workflow
The same "the file *is* the workflow" trick ComfyUI uses for PNG works for audio. The shared `AudioSaveHelper.save_audio()` (in `comfy_api/latest/_ui.py`; the `nodes_audio.py` save nodes call it via `UI.AudioSaveHelper.get_save_audio_ui()`) serializes the run's `prompt` and `extra_pnginfo` to JSON and writes them into the **container metadata** of the output file:

```python
metadata = {}
if not args.disable_metadata and cls is not None:
    if cls.hidden.prompt is not None:
        metadata["prompt"] = json.dumps(cls.hidden.prompt)
    if cls.hidden.extra_pnginfo is not None:
        for x in cls.hidden.extra_pnginfo:
            metadata[x] = json.dumps(cls.hidden.extra_pnginfo[x])
# ... output_container.metadata[key] = value
```

This applies to **FLAC, MP3, and Opus** (written via PyAV container metadata), so dragging a saved `.flac` (or `.mp3`/`.opus`) back onto the ComfyUI canvas restores the full graph — exactly as the official audio example page notes ("the following flac audio file contains a workflow, you can download it and load it or drag it on the ComfyUI interface"). Default save format for the legacy `SaveAudio` node is `format="flac"`. Metadata embedding can be turned off globally with the `--disable-metadata` launch flag.

---

### 3D

Two distinct things live under "3D" in core: (1) **diffusion models that generate novel views / meshes** (Stable Zero123, SV3D, Hunyuan3D-2), and (2) a **3D viewport/IO toolkit** (Load3D/Preview3D family) for feeding meshes in and rendering them out. The heavy reconstruction zoo (InstantMesh, TripoSR, Gaussian Splatting, NeRF) is **custom-node** territory.

#### Novel-view & mesh diffusion (core)

**Stable Zero123** — `comfyanonymous.github.io/ComfyUI_examples/3d/`. Single image → views from other angles. Checkpoint `stable_zero123.ckpt` → `models/checkpoints/`. Core conditioning nodes (from `comfy_extras/nodes_stable3d.py`):
- **`StableZero123_Conditioning`** — inputs `clip_vision`, `init_image`, `vae`, `width`/`height` (default 256, step 8), `batch_size`, `elevation` and `azimuth` (each −180…180°, in degrees). Outputs `positive`, `negative`, `latent`.
- **`StableZero123_Conditioning_Batched`** — same, plus `elevation_batch_increment` / `azimuth_batch_increment` to sweep angles across a batch.

**SV3D** (Stable Video 3D) — orbit-style multiview, built on the SVD/video machinery. Node confirmed in `comfy_extras/nodes_stable3d.py` (note: the 3d example page documents Stable Zero123 only, not SV3D):
- **`SV3D_Conditioning`** — inputs `clip_vision`, `init_image`, `vae`, `width`/`height` (default 576), **`video_frames`** (default 21), `elevation` (−90…90°). Outputs `positive`, `negative`, `latent`. (Note the narrower elevation range and the `video_frames` input vs Zero123 — SV3D produces an orbit "video" of views.)

**Hunyuan3D-2 / 2mv** (Tencent) — `docs.comfy.org/tutorials/3d/hunyuan3D-2`. **Native, but geometry only — the docs state ComfyUI "does not yet support texture and material generation."** Image (or multi-view) → mesh. Checkpoints (e.g. `hunyuan3d-dit-v2.safetensors`, `hunyuan3d-dit-v2-mv.safetensors`, `hunyuan3d-dit-v2-mv-turbo.safetensors`) → `models/checkpoints/`. Pipeline nodes:
- **`ImageOnlyCheckpointLoader`** → **`Hunyuan3Dv2Conditioning`** (or **`Hunyuan3Dv2ConditioningMultiView`**) → **`EmptyLatentHunyuan3Dv2`** → **`ModelSamplingAuraFlow`** + **`KSampler`** → **`VAEDecodeHunyuan3D`** → **`VoxelToMesh`** → **`SaveGLB`**.
- Output `.glb` files go to **`ComfyUI/output/mesh/`**. For PBR texturing you need community nodes.

#### 3D viewport & IO nodes (core)
Documented under `docs.comfy.org/built-in-nodes/`. These are the mesh ingestion / preview / export side:

- **`Load3D`** — loads a model from `ComfyUI/input/3d/` (or via upload). Supported formats: **`.gltf`, `.glb`, `.obj`, `.fbx`, `.stl`**. Inputs: `model_file`, `width`/`height` (canvas, INT default 1024, range 1–4096). **Seven outputs:** `image` (rendered view), `mask`, `mesh_path`, `normal`, `lineart`, `camera_info` (type `LOAD3D_CAMERA`), and `recording_video` (type `VIDEO`, only when a recording exists). The interactive viewport supports view controls, camera settings, lighting, video recording, and **export to GLB/OBJ/STL**. Render material modes: **Original, Normal, Wireframe, Lineart**.
- **`Load3DAnimation`** — same idea for animated meshes; loads models with animations and previews them in-node. Same supported formats as Load3D.
- **`Preview3D`** — previews a 3D model given a `model_file` (a path under `ComfyUI/output/`) and `camera_info`; supports the same formats as Load3D.
- **`Preview3DAnimation`** — documented built-in node for previewing animated 3D outputs; takes `camera_info` plus a model-file path under `ComfyUI/output`.

These viewport nodes are the bridge between ComfyUI's 2D image graph and 3D assets: `Load3D`'s `image`/`normal`/`lineart`/`mask` outputs feed straight into ControlNet/IP-Adapter image pipelines, and its `camera_info` can drive view-conditioned generation. The render-mode outputs (normal, lineart) are commonly used as ControlNet conditioning for re-texturing a 3D model in image space.

#### Custom-node 3D (NOT core)
- **`MrForExample/ComfyUI-3D-Pack`** — the large suite for actual 3D *reconstruction*: InstantMesh, TripoSR, CRM, 3D Gaussian Splatting (3DGS), Instant-NGP / NeRF, plus mesh + UV-texture processing (and many newer models — TRELLIS, Hunyuan3D 2.1 with texturing, StableFast3D, LGM, etc.). None of this is in core; install separately.

---

### Practical takeaways
- **Check the example index before assuming "native."** If a model isn't on `comfyanonymous.github.io/ComfyUI_examples/`, it's almost certainly a custom node (AnimateDiff, CogVideoX, InstantMesh/TripoSR, Hunyuan3D texturing).
- **Latent length = frames.** Every core video model uses an `Empty*LatentVideo` node; `length=1` collapses to a still. Respect per-model constraints (Mochi's 7+6n; Cosmos's width/height ×16).
- **Watch the text encoder traps:** Cosmos needs *old* T5XXL 1.0 (`oldt5_xxl`), not the FLUX T5XXL 1.1; HunyuanVideo uses a dual `clip_l` + `llava_llama3` stack via `DualCLIPLoader`.
- **Saved audio carries its workflow** (FLAC/MP3/Opus), and prefer `SaveAudioAdvanced` over the now-deprecated `SaveAudio*` nodes.
- **Hunyuan3D core = geometry only**; texturing still needs community nodes.

---

## <a id="workflow-management-formats"></a>Workflow Management & Formats

A ComfyUI workflow is the node graph itself, treated as a portable, reproducible artifact. The same graph can exist in two distinct JSON shapes, can be embedded inside generated media so an output image *is* the workflow, can be loaded from a shipped Templates library, and can be packaged into reusable subgraph blueprints. This section covers each representation and the mechanics that move a workflow between them.

> Version note: terminology and features here are dated where the canonical source is version-specific. ComfyUI's frontend ships as a separate pip package (`comfyui-frontend-package`) versioned independently from the Python backend, so a given menu label depends on the frontend version installed.

### The two JSON formats: graph (UI) format vs API "prompt" format

ComfyUI serializes a workflow in two incompatible JSON formats. Both use the `.json` extension but contain different data.

| | Graph / UI ("Save") format | API / "prompt" format |
|---|---|---|
| Purpose | Re-open and edit in the frontend graph editor | Submit programmatically to the backend |
| Produced by | `File → Save` / `Ctrl+S` | `File → Export Workflow (API)` |
| Top-level shape | Object with `version`, `state`, `nodes`, `links`, `groups`, etc. | Flat object keyed by node ID |
| Node keying | `nodes` array; each node has an `id` | Numeric node ID strings as object keys |
| Layout/visual data | Included (`pos`, `size`, `color`, groups, reroutes) | Excluded entirely |
| Per-node fields | `type`, `pos`, `size`, `flags`, `order`, `mode`, `properties`, `inputs`, `outputs`, `widgets_values` | `inputs`, `class_type`, `_meta` |

Per the canonical docs, the API format "omits UI metadata (positions, colors, groups, node sizes) that is only needed for visual editing in the frontend."

**API format node structure** — each node is keyed by its numeric ID; connections are `[node_id, output_slot]` arrays:

```json
"3": {
  "inputs": {
    "seed": 156680208700286,
    "steps": 20,
    "cfg": 8,
    "sampler_name": "euler",
    "scheduler": "normal",
    "denoise": 1,
    "model": ["4", 0],
    "positive": ["6", 0]
  },
  "class_type": "KSampler",
  "_meta": { "title": "KSampler" }
}
```

`["4", 0]` means "output slot 0 of node 4." `class_type` is the registered node class name; `_meta.title` carries the display title.

**Exporting the API format**: the current docs give the menu path `File → Export Workflow (API)`. (Older frontend builds labeled this differently and gated the API export behind an "Enable Dev Mode Options" setting; the cited canonical page no longer mentions a dev-mode gate, so treat the dev-mode requirement as historical/version-dependent rather than current.) The API format is what must be submitted when calling ComfyUI programmatically — whether through the Cloud API or running your own server.

### Graph (UI) format — canonical schema (Workflow JSON v1)

The canonical spec at `docs.comfy.org/specs/workflow_json` defines schema version `1` (`"version"`: type `number`, `"const": 1`).

**Required top-level keys:** `version`, `state` (object), `nodes` (array).

**Optional top-level keys:** `config`, `groups`, `links`, `reroutes`, `extra`, `models`.

- **`state`** — workflow counters (object, `additionalProperties: true`, all fields optional): `lastNodeId`, `lastLinkId`, `lastGroupid`, `lastRerouteId` (all numbers). (Note the schema spelling `lastGroupid`.) These replaced the older flat `last_node_id`/`last_link_id` fields.
- **`nodes[]`** — each node requires `id` (integer or string), `type` (string), `pos` (array of 2 numbers or object with keys `"0"`/`"1"`), `size` (same shape as `pos`), `flags` (object), `order` (number), `mode` (number), `properties` (object). Optional: `inputs` (array), `outputs` (array), `widgets_values` (array or object), `color` (string), `bgcolor` (string).
  - `flags` carries `collapsed`, `pinned`, `allow_interaction`, `horizontal`, `skip_repeated_outputs` (all optional booleans; `additionalProperties: true`).
  - `mode` is the node's execution mode (e.g. normal vs. bypass/mute).
  - Inputs require `name` + `type`; optional `link` (number/null), `slot_index`. Outputs require `name` + `type`; optional `links[]`, `slot_index`.
- **`links[]`** — each link requires `id` (number), `origin_id`, `origin_slot`, `target_id`, `target_slot` (each integer or string), and `type` (string, array of strings, or number); optional `parentId` (number).
- **`reroutes[]`** — each requires `id` (number), `pos`; optional `parentId`, `linkIds` (array of numbers or null).
- **`groups[]`** — each requires `title` (string), `bounding` (exactly 4 numbers); optional `color`, `font_size`, `locked`.
- **`config`** — optional object (or null) with `links_ontop`, `align_to_grid` (booleans).
- **`models[]`** — declares required model files for reproducibility; each requires `name`, `url` (URI), `directory`; optional `hash`, `hash_type`. Strict schema (`additionalProperties: false`).

### Workflow embedded in output metadata (the "workflow-in-a-PNG" mechanism)

ComfyUI's saver nodes embed the full workflow into generated media so the output file doubles as the workflow file. Verified from the `SaveImage` class in core `nodes.py`:

```python
"hidden": { "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO" }
...
metadata = None
if not args.disable_metadata:
    metadata = PngInfo()
    if prompt is not None:
        metadata.add_text("prompt", json.dumps(prompt))
    if extra_pnginfo is not None:
        for x in extra_pnginfo:
            metadata.add_text(x, json.dumps(extra_pnginfo[x]))
img.save(..., pnginfo=metadata, compress_level=self.compress_level)
```

Key facts:
- Two hidden inputs are injected at execution time on saver nodes: `prompt` (the API/prompt-format graph) and `extra_pnginfo` (which contains the `workflow` key holding the full graph/UI-format JSON). The PNG therefore carries **both** formats.
- For PNG these are written as **tEXt chunks** via PIL's `PngInfo` class — one `prompt` chunk and one chunk per `extra_pnginfo` key (notably `workflow`), each a `json.dumps` string. In core `SaveImage.__init__`, `self.compress_level = 4`.
- Embedding is gated by the `--disable-metadata` server flag (`args.disable_metadata`). With it set, no workflow is embedded.

**Per-format embedding container:**

| Format | Saver node | Metadata mechanism |
|---|---|---|
| PNG | `SaveImage` | PNG `tEXt` chunks (PIL `PngInfo`) — `prompt` + `workflow` |
| WebP (animated) | `SaveAnimatedWEBP` | EXIF metadata (PIL EXIF; the JPEG/EXIF APP1 segment carries a hard ~65,535-byte ceiling) |
| FLAC (audio) | `SaveAudio` (now marked deprecated — see below) | container metadata; saver carries the same hidden `prompt`/`extra_pnginfo` inputs |
| MP3 / Opus (audio) | `SaveAudioMP3`, `SaveAudioOpus`, `SaveAudioAdvanced` | container metadata; same hidden `prompt`/`extra_pnginfo` inputs |
| MP4 / video | video savers (incl. partner/custom nodes) | container metadata |

The FLAC round-trip is canonical: ComfyUI commit `4650e7d` is titled *"Save and load workflow from the flac files output by SaveAudio."* The audio saver nodes expose the same hidden `prompt`/`extra_pnginfo` inputs as `SaveImage`. Note the current source state: the FLAC `SaveAudio` node is now `is_deprecated=True` with display name "Save Audio (FLAC) (DEPRECATED)," and the audio savers were migrated to the V3 IO schema (`hidden=[IO.Hidden.prompt, IO.Hidden.extra_pnginfo]`); `SaveAudioMP3`, `SaveAudioOpus`, and `SaveAudioAdvanced` (format-selectable: FLAC/MP3/Opus) are the current siblings.

**Restoring the graph:** drag the saved image/audio/video onto the ComfyUI canvas, or use `Workflows → Open` (`Ctrl+O`). The docs state: "Images containing workflow JSON in their metadata can be directly dragged into ComfyUI or loaded using the menu `Workflows` -> `Open (ctrl+o)`." You can also paste raw workflow JSON text directly with `Ctrl+V`.

**Caveat (practical):** metadata survives only on the *original* file. Browsers, chat apps, and galleries frequently re-encode to WebP/JPEG or strip EXIF/tEXt on download, which destroys the embedded graph — which is why workflows are often shared as standalone `.json` alongside the preview image.

### Templates browser & built-in templates

The Templates browser is the in-app catalog of ComfyUI's natively supported model workflows plus example workflows contributed by custom nodes.

- **Open it:** click the **Templates** icon in the sidebar, or `Workflow → Browse Workflow Templates`.
- **Organization:** grouped by task/category; custom-node example templates appear under a category named after the node. Custom-node templates support only a single directory level under the `templates` folder (no nested subdirectories) and only JSON-format templates.
- **Preview:** the repo defines six thumbnail variant types — `image` (default), `compareSlider` (before/after), `video` (webp animation), `hoverDissolve` (dissolves to a 2nd image on hover), `audio` (playback controls), and `zoomHover` / `hoverZoom` (zooms more on hover). (The repo README uses `zoomHover` in examples.)
- **Automatic model checking:** loading a template makes ComfyUI "automatically check whether all required model files exist," prompting a download if missing. On the **Desktop** app the program downloads the files automatically; on other builds the browser downloads the file and the user places it under the matching folder in `ComfyUI/models`. Missing-file detection "only checks whether there is a file with the same name in the corresponding top-level directory" (not subfolders) — if a model already lives in a subfolder, dismiss the popup and select it manually in the loader node.
- **Model metadata source:** templates embed model info in each loader node's `properties.models[]` field — `name` (file name), `url` (a direct download link, **Hugging Face or Civitai only**), `directory` (subfolder under `ComfyUI/models`). The model format "must be a safe format such as `.safetensors` or `.sft`." Formats like `.gguf` "are considered unsafe; when embedded they will be flagged as unsafe and the link will not be shown."

**Where templates ship:** the `Comfy-Org/workflow_templates` GitHub repo, distributed as the `comfyui-workflow-templates` PyPI package. The repo holds workflow JSON files, matching thumbnails named `{template_name}-{counter}.{ext}` (e.g. `name-1.png`, `name-2.png`), a `templates/index.json` manifest (fields include `name`, `description`, `mediaType`, `mediaSubtype`, optional `tutorialUrl`, optional `thumbnailVariant`), and a `bundles.json` grouping templates into media packages (e.g. `media-image`, `media-video`); a separate `blueprints_bundles.json` covers subgraph blueprints. Contribution rules for *official* templates: author the workflow with `--disable-all-custom-nodes` (no third-party nodes), embed model metadata (`name`/`url`/`hash`/`hash_type`/`directory`) in loader nodes, bump the version in `pyproject.toml`, and fully test as a new user (delete models/inputs and re-run).

**Template Library redesign (0.3.66, posted Oct 21, 2025):** restyled library with filters by **Model**, **Use Case**, and **License** (free/paid), and sort by **Newest / Default / Model Size / A→Z**, plus richer tags. (Sorting by VRAM is "not fully supported yet.")

### Subgraphs & blueprints

A **subgraph** packages a set of nodes into a single reusable subgraph node — "a folder for your workflow." A **subgraph blueprint** is a subgraph saved to the node library so it can be reused like any built-in node across workflows.

- **Version requirements (canonical):** the subgraph feature requires frontend ≥ 1.24.3; editing subgraph parameters from the parameters panel (without entering the subgraph) requires ComfyUI ≥ 0.3.66; the Subgraph Blueprint (publish-to-library) feature requires frontend ≥ 1.27.7.
- **Create:** select nodes → click the subgraph icon in the toolbar; ComfyUI auto-creates the subgraph from the selection's inputs/outputs.
- **Edit:** double-click the empty area inside the subgraph (not on widgets) or click its edit button to enter; navigate nested levels via the on-canvas navigation bar; exit via the navigation bar or `Esc`. Right-click exposed connection points to rename/delete slots.
- **Edit Subgraph Widgets (0.3.66):** select a subgraph and open the parameters panel ("Edit Subgraph Widgets") to reorder widgets (right-click-and-hold drag) and toggle visibility (eye icon) without entering the subgraph.
- **Unpack:** right-click → "Unpack subgraph" (or the selection-toolbox button) to explode it back into individual nodes.
- **Format:** subgraph JSON "use[s] the same format as workflow JSON files."

**Publishing a blueprint (Subgraph Publishing, 0.3.63, posted Oct 6, 2025):** use the publish icon on the **Selection Toolbox** (the redesigned toolbox added new icons and an expandable menu). By default the blueprint takes the subgraph node's name. Published blueprints appear under **Node Library → Subgraph Blueprints** and can be used like a normal node; each added instance is isolated (editing one doesn't affect others). Edit via the node library's edit button, then preview at the parent level; save with the save button or `Ctrl+S`.

**Distributing blueprints with custom nodes:** a node developer drops `.json` files into a `subgraphs/` folder inside the custom-node directory (e.g. `ComfyUI-MyCustomNodeModule/subgraphs/My_upscale_subgraph.json`). "ComfyUI scans all custom node directories for subgraph files and serves them via the `/global_subgraphs` API endpoint." Subgraph JSON files "use the same format as workflow JSON files." (The canonical `custom-nodes/subgraph_blueprints` page does **not** mention a `comfyui-subgraph-blueprints` PyPI package — treat that claim as unverified.)

### Save / open / browse & workflow management UI

- **Sidebar panels (left):** **Assets** (generated images/videos/other assets), **Nodes** (native + third-party node library), **Models** (detected model info), **Workflows** (locally saved workflows — browse/search/filter), **Templates** (built-in templates).
- **Save:** `Workflow → Save` / `Save As` (or `Ctrl+S`). Saved JSON lands in the user workflows directory — on portable Windows: `ComfyUI_windows_portable\ComfyUI\user\default\workflows`.
- **Open / Load:** open from the Workflows sidebar; `Workflows → Open` (`Ctrl+O`); drag a `.json` or a workflow-embedded image onto the canvas; or paste JSON with `Ctrl+V`. Loading an image parses its embedded metadata to rebuild all nodes and their settings.
- **Tabs:** a multi-workflow tab bar lets several workflows be open at once (open/close/switch/reorder), with a modified-state indicator.
- **Refresh:** press `r` to refresh node definitions and the model list (e.g. after downloading new models).

### Versioning & reproducibility

ComfyUI does not version-control workflows itself; reproducibility is encoded *inside* the workflow JSON:

- **Per-node provenance:** a node's `properties` can record `cnr_id` (the source package, e.g. `"comfy-core"`) and `ver` (the version, e.g. `"0.3.26"`) so a workflow declares which node/package version it expects. Example: `"properties": {"Node name for S&R": "SaveWEBM", "cnr_id": "comfy-core", "ver": "0.3.26"}`. (These `properties` fields are not enumerated in the workflow_json spec — `properties` is an open object — but are present in shipped workflows and used for reproducibility.)
- **Model declarations:** the top-level `models[]` array (and template loader `properties.models`) record `name`/`url`/`directory` (+ optional `hash`/`hash_type`) so the exact checkpoints/VAEs/LoRAs can be re-fetched.
- **Frontend vs backend versions:** because `comfyui-frontend-package` is versioned separately from the backend, a workflow's available editor features depend on the installed frontend version, not the ComfyUI core version alone.

### Sharing & reproducing a workflow

A workflow is reproduced by any of:

1. **The graph-format `.json`** — full editable graph (positions, groups, node versions, model URLs). Best for sharing an editable workflow.
2. **A workflow-embedded original output** (PNG/WebP/FLAC/MP4) — drag back in to restore both the prompt and graph formats, provided metadata wasn't stripped in transit.
3. **The API-format `.json`** — for programmatic submission to `POST /prompt`.
4. **A Template or published Subgraph Blueprint** — for canonical/reusable building blocks.

**Programmatic reproduction (`POST /prompt`):** the API-format graph is the request body. Canonical routes (from the docs Routes page):

| Route | Method | Purpose |
|---|---|---|
| `/prompt` | POST | Queue a workflow; body `{prompt, client_id}`; returns `prompt_id` + `number` (queue position), or `error` + `node_errors` on validation failure |
| `/prompt` | GET | Current queue status / execution info |
| `/queue` | GET / POST | Read queue state; manage (clear pending/running) |
| `/interrupt` | POST | Stop the current execution |
| `/history` | GET / POST | GET queue history; POST to clear history or delete a history item |
| `/history/{prompt_id}` | GET | Queue history for one prompt |
| `/view` | GET | Fetch a generated file |
| `/upload/image` | POST | Upload an input image |
| `/object_info`, `/object_info/{node_class}` | GET | Node-type schemas (all / one) |
| `/ws` | WebSocket | Real-time `status`, `execution_start`, `execution_cached`, `executing`, `progress`, `executed` events |

---

## <a id="extensibility-and-the-custom-node-ecosystem"></a>Extensibility & the Custom-Node Ecosystem

ComfyUI is extended along three axes: a **Python backend node contract** (the V1 dict-based API and the newer V3 `io.Schema` API), a **JavaScript frontend extension API** (`app.registerExtension`), and **distribution + tooling** (the Comfy Registry, ComfyUI-Manager, and comfy-cli). All facts below are drawn from `docs.comfy.org`, the `comfyanonymous/ComfyUI` and `Comfy-Org/*` repos, and `blog.comfy.org`.

### The Python custom-node contract (V1 / dict API)

A custom node is a plain Python class. The framework discovers it through two module-level dictionaries that the package's `__init__.py` exports.

| Member | Kind | Purpose |
| --- | --- | --- |
| `INPUT_TYPES` | `@classmethod` | Returns a dict with key `"required"`, plus optional `"optional"` and `"hidden"`. Each entry is a tuple `(type, options_dict)`. Optional inputs are included in the call only if connected. |
| `RETURN_TYPES` | tuple of `str` | Output socket types. A node with no outputs must still set `RETURN_TYPES = ()`. Single output needs a trailing comma: `("IMAGE",)`. |
| `RETURN_NAMES` | tuple of `str` | Output slot labels. "If omitted, the names are simply the `RETURN_TYPES` in lowercase." |
| `FUNCTION` | `str` | Name of the method to call, e.g. `FUNCTION = "execute"`. Called with **named** arguments (all required + hidden inputs, plus connected optional inputs); returns a tuple matching `RETURN_TYPES`. |
| `CATEGORY` | `str` | Path in the "Add Node" menu, e.g. `"examples/trivial"`. |
| `OUTPUT_NODE` | `bool` | Default `False`. Per `node_typing.py`: "Flags this node as an output node, causing any inputs it requires to be executed." |

**Registration mappings** (in `__init__.py`, taken from the walkthrough):

```python
NODE_CLASS_MAPPINGS = {"Example": Example, "Image Selector": ImageSelector}
NODE_DISPLAY_NAME_MAPPINGS = {"Example": "Example Node"}   # optional, UI labels
WEB_DIRECTORY = "./web/js"                                  # serves frontend .js
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]
```

`NODE_CLASS_MAPPINGS` keys are the node identifiers recorded in workflow JSON; `NODE_DISPLAY_NAME_MAPPINGS` is optional and is not required to be listed in `__all__` (the walkthrough's `__all__` omits it).

**Optional/advanced class attributes** (names and descriptions verbatim from `comfy/comfy_types/node_typing.py`, master branch):

| Attribute | Type | Docstring (verbatim) |
| --- | --- | --- |
| `IS_CHANGED` (classmethod) | — | Passed the same arguments as `FUNCTION`. Returns *any* Python object, compared against the previous run; despite the name it "should not return a `bool`." Return `float("NaN")` to force a re-run every time. |
| `VALIDATE_INPUTS` (classmethod) | — | Runs before execution; returns `True` or an error-message string. Only receives inputs defined as **constants** in the workflow (values from other nodes are *not* available). An `input_types` arg receives a dict of {connected-input-name: output-type}. If the function takes `**kwargs`, it "will receive *all* available inputs and all of them will skip validation." |
| `INPUT_IS_LIST` | `bool` | "A flag indicating if this node implements the additional code necessary to deal with OUTPUT_IS_LIST nodes." |
| `OUTPUT_IS_LIST` | `tuple[bool, ...]` | "A tuple indicating which node outputs are lists, but will be connected to nodes that expect individual items." |
| `DEPRECATED` | `bool` | "Flags a node as deprecated, indicating to users that they should find alternatives to this node." |
| `EXPERIMENTAL` | `bool` | "Flags a node as experimental, informing users that it may change or not work as expected." |
| `API_NODE` | `Optional[bool]` | "Flags a node as an API node." |
| `DESCRIPTION` | `str` | "Node description, shown as a tooltip when hovering over the node." |
| `OUTPUT_TOOLTIPS` | `tuple[str, ...]` | "A tuple of strings to use as tooltips for node outputs, one for each item in RETURN_TYPES." |
| `SEARCH_ALIASES` | list of `str` | "A list of alternative names users might search for when looking for this node." |

(`node_typing.py` also defines `DEV_ONLY` — "hiding it from search/menus unless dev mode is enabled.")

**Hidden inputs** are runtime-injected values declared under the `"hidden"` key of `INPUT_TYPES`: `UNIQUE_ID` ("the unique identifier of the node… matches the `id` property of the node on the client side"), `PROMPT` ("the complete prompt sent by the client to the server"), `EXTRA_PNGINFO` ("a dictionary that will be copied into the metadata of any .png files saved"), and `DYNPROMPT` (an instance of `comfy_execution.graph.DynamicPrompt`).

**Datatypes & widgets** — the `IO` enum in `node_typing.py` defines a large set of socket types, including `IMAGE` (`torch.Tensor`, shape `[B,H,W,C]`), `LATENT` (a `dict` containing a `torch.Tensor` of shape `[B,C,H,W]`), `MASK`, `AUDIO`, `MODEL`, `CLIP`, `CLIP_VISION`, `VAE`, `CONDITIONING`, `CONTROL_NET`, `STYLE_MODEL`, `GLIGEN`, `UPSCALE_MODEL`, `LORA_MODEL`, the custom-sampling types `NOISE`/`SAMPLER`/`SIGMAS`/`GUIDER`, the primitives `INT`/`FLOAT`/`STRING`/`BOOLEAN`/`COMBO`, plus others (`VIDEO`, `WEBCAM`, `POINT`, `BBOX`, `SEGS`, `FACE_ANALYSIS`, …) and the meta-types `ANY` (`"*"`), `NUMBER` (`"FLOAT,INT"`), and `PRIMITIVE` (`"STRING,FLOAT,INT,BOOLEAN"`). `COMBO` is declared as a *list of values* rather than a type string, e.g. `("ckpt_name": (folder_paths.get_filename_list("checkpoints"), ))` or `("play_sound": (["no","yes"], {}))`. The wildcard `"*"` (`ANY`) accepts any connection. `InputTypeOptions` keys documented in `node_typing.py` include: `default`, `defaultInput` (`@deprecated` in v1.16, replaced by `forceInput`), `forceInput`, `lazy`, `rawLink`, `tooltip`, `socketless`, `widgetType`; numeric `min`/`max`/`step`/`round`; `label_on`/`label_off` (BOOLEAN); `multiline`/`placeholder`/`dynamicPrompts` (STRING); plus `image_upload`, `control_after_generate`, `options` (COMBO), `multi_select`, and `remote`.

**Lazy evaluation** lets a node skip computing inputs it won't use: mark an input lazy with `("IMAGE", {"lazy": True})`, then implement a `check_lazy_status` method — an *instance* method in V1, **not** a classmethod — that receives the same arguments as the main function (with `None` for un-evaluated lazy inputs) and returns a list of input names still needing evaluation. The docs' examples are `ModelMergeSimple` (ratio `0.0`/`1.0`), image interpolation (ratio/mask entirely `0.0`/`1.0`), and switch nodes. The docs state: "There is very little cost in making an input lazy. If it's something you can do, you generally should."

### The V3 node schema (`io.Schema`) — current, still experimental

A newer node API consolidates everything that V1 spread across dicts and class attributes into a single `io.Schema` object, imported from `comfy_api.latest` (with namespaces `io`, `ui`). Status (as of mid-2026): **V3 is experimental** — the migration doc states "Version `v0_0_2` is the current (and first) API version so more changes will be made to it without warning" — and **V1 remains supported** (migration is optional, though "future extensions to node features will only be added to V3 schema").

```python
from comfy_api.latest import ComfyExtension, io, ui

class InvertImage(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MyPack_InvertImage", display_name="Invert Image",
            category="my_pack/image", description="Inverts the colors.",
            inputs=[io.Image.Input("image")],
            outputs=[io.Image.Output(display_name="inverted")],
        )
    @classmethod
    def execute(cls, image) -> io.NodeOutput:
        return io.NodeOutput(1.0 - image, ui=ui.PreviewImage(1.0 - image, cls=cls))
```

Key V3 differences:
- **Execution method is fixed to `execute`** (classmethod, may be `async`); no `FUNCTION` string.
- `io.Schema` flags replace V1 attributes: `is_output_node`, `is_experimental`, `is_deprecated`, `is_dev_only`, `is_api_node`, `not_idempotent`, `accept_all_inputs`, `is_input_list`, `search_aliases`, and `enable_expand`.
- Typed I/O builders: `io.Image.Input("image")`/`io.Image.Output()`, `io.Int.Input("count", default=1, min=0, max=100)`, `io.Float/String/Boolean.Input`, `io.Combo.Input`, plus advanced `io.MultiType.Input`, `io.MatchType` (with `Template`), `io.Autogrow` (with `TemplatePrefix`/`TemplateNames`), `io.DynamicCombo` (with `Option`), and `io.Custom("MY_TYPE")`. Input params include `optional`, `tooltip`, `lazy`, `raw_link`, `force_input`, `socketless`, and `advanced`.
- **Hidden inputs** declared via `hidden=[io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.extra_pnginfo]` (also `dynprompt`, `auth_token_comfy_org`, `api_key_comfy_org`) and read through `cls.hidden.*`.
- Renamed special methods: `validate_inputs`, `check_lazy_status` (now a classmethod), and **`fingerprint_inputs`** (V3 replacement for `IS_CHANGED`), all classmethods.
- **Package entry point** is a `ComfyExtension` subclass implementing `async on_load()` and `async get_node_list()`, exposed via `async def comfy_entrypoint()` — replacing the `NODE_CLASS_MAPPINGS` dict for V3 packs.
- `ui.*` helpers (`ui.PreviewImage`, `ui.PreviewMask`, `ui.PreviewAudio`, `ui.PreviewText`, `ui.PreviewUI3D`, plus `ui.ImageSaveHelper`/`ui.AudioSaveHelper`) wrap the UI payload returned in `io.NodeOutput`.

### The JavaScript frontend extension API

The frontend is a separate project (`Comfy-Org/ComfyUI_frontend`). Extensions register against the global app object:

```js
import { app } from "../../scripts/app.js";
app.registerExtension({ name: "MyExt", /* hooks + UI registrations */ });
```

**Lifecycle hooks** (canonical names, per the hooks page; async unless noted):

| Hook | Signature | Fires |
| --- | --- | --- |
| `init` | `async init()` | When the Comfy webpage loads/reloads — after the graph is created but before nodes are registered. |
| `addCustomNodeDefs` | `async addCustomNodeDefs(defs)` | During page-load — lets an extension inject node definitions. |
| `getCustomWidgets` | `async getCustomWidgets()` | During page-load — retrieve custom widget definitions. |
| `beforeRegisterNodeDef` | `async beforeRegisterNodeDef(nodeType, nodeData, app)` | Once for each node type. The most-used hook; `nodeType.prototype` edits apply to all instances. |
| `registerCustomNodes` | `async registerCustomNodes()` | During page-load — finalize custom-node registration. |
| `beforeConfigureGraph` | `async beforeConfigureGraph()` | Before a graph is configured (on load and on workflow load). |
| `nodeCreated` | `async nodeCreated(node)` | When a specific node instance is created. |
| `loadedGraphNode` | `loadedGraphNode(node)` (sync) | Per node after it loads, during the configure sequence. |
| `afterConfigureGraph` | `async afterConfigureGraph()` | After graph configuration completes. |
| `setup` | `async setup()` | At the end of startup; good for event listeners / global menu edits. |

(Execution-time events are surfaced through the API event handlers rather than `registerExtension` hooks; `beforeQueued`/`afterQueued` are not documented as lifecycle hooks on the hooks page. *(unverified as registerExtension hooks)*)

The `javascript_objects_and_hijacking` page **deprecates monkey-patching**: "Hijacking/monkey-patching functions on `app` or prototypes is deprecated and subject to change," and "Hijacking prototype methods on `ComfyNode` or `LGraphNode` is deprecated" — directing developers to the official extension hooks and APIs below instead.

**Programmatic UI registration** (via the `registerExtension` config or `app.extensionManager`):

- **Settings** — a `settings: []` array of objects `{ id, name, type, defaultValue, onChange(newVal, oldVal), category, tooltip, attrs, options }`. `type` ∈ `boolean | text | number | slider | combo | color | image | hidden`. Read/write at runtime via `app.extensionManager.setting.get('id')` and `await app.extensionManager.setting.set('id', value)` (the setter is async).
- **Commands** — `commands: [{ id, label, function }]`.
- **Keybindings** — `keybindings: [{ combo: { key, ctrl?, shift?, alt?, meta? }, commandId }]`.
- **Sidebar tabs** — `app.extensionManager.registerSidebarTab({ id, icon, title, tooltip, type, render(el) })`.
- **Bottom panel tabs** — `bottomPanelTabs: [{ id, title, type, render(el) }]`.
- **Topbar menu** — `menuCommands: [{ path: [...], commands: [...] }]`, where `commands` is a list of command **IDs** (defined separately in `commands`) mapped into the menu hierarchy given by `path`.
- **About-page badges** — `aboutPageBadges: [{ label, url, icon }]` (`icon` is a PrimeVue icon class, e.g. `"pi pi-home"`).
- **Toasts** — `app.extensionManager.toast.add({ severity, summary, detail, life, closable, group, ... })`, where `severity` ∈ `success | info | warn | error | secondary | contrast`; plus `toast.addAlert(msg)`, `toast.remove(t)`, `toast.removeAll()`.
- **Dialogs** — `app.extensionManager.dialog.prompt({ title, message, defaultValue })` → `Promise<string | null>`; `app.extensionManager.dialog.confirm({ title, message, type?, itemList?, hint? })` → `Promise<boolean | null>`, where `type` ∈ `default | overwrite | delete | dirtyClose | reinstall`.

The `app` object also exposes (per the hijacking page) `app.canvas` (an `LGraphCanvas`, with `node_over`/`selected_nodes`), `app.graph` (the `LGraph`), `app.ui`, `app.graphToPrompt()`, and `app.queuePrompt()`. A React/TypeScript starter exists at `Comfy-Org/ComfyUI-React-Extension-Template`.

### Custom server routes & node-driven WebSocket messages

The server is an aiohttp app. Custom nodes add HTTP routes through the `PromptServer` singleton:

```python
from server import PromptServer
from aiohttp import web
routes = PromptServer.instance.routes

@routes.post('/my_new_path')
async def my_function(request):
    data = await request.post()
    return web.json_response({})
```

`@routes.get` / `@routes.post` decorate functions on `PromptServer.instance.routes`. Standard server endpoints (per `comms_routes`) include `/prompt` (POST; returns `prompt_id` + `number`, or `error`/`node_errors`), `/queue`, `/interrupt`, `/object_info` (and `/object_info/{node_class}`), and the `/ws` WebSocket.

The WebSocket carries JSON messages typed (per `comms_messages`): `status`, `execution_start`, `execution_error`, `execution_interrupted`, `execution_cached`, `execution_success`, `executing`, `executed`, and `progress`. A node can push its own message to the client mid-execution via `PromptServer.instance.send_sync(event, data)` (a `sid` argument can target a specific client). In V3, runtime progress is reported through `ComfyAPI`: `await api.execution.set_progress(value=i, max_value=total, preview_image=img)` (the preview image is optional).

### The Comfy Registry

The **Comfy Registry** (`registry.comfy.org`) is the public catalog that powers ComfyUI-Manager. The overview page frames it around three features:

- **Node Versioning** — registry nodes are **semantically versioned** (MAJOR.MINOR.PATCH). Once a version is published it **cannot be changed**, so workflow JSON can pin an exact, reproducible version.
- **Node Security** — "All nodes will be scanned for malicious behaviour such as custom pip wheels, arbitrary system calls, etc." Nodes that pass get a verification flag (checkmark) "beside their name on the UI-manager."
- **Search** — search across all nodes on the Registry.

Each custom node has a "globally unique name [that] allows Comfy Workflow JSON files to uniquely identify any custom node."

**Configuration is via `pyproject.toml`:**

`[project]` section:
- `name` (required) — the node ID. Must be < 100 chars; only alphanumerics, hyphens, underscores, and periods; no consecutive special chars; cannot start with a number/special char; case-insensitive comparison. Best practice: "Don't include 'ComfyUI' in the name."
- `version` (required) — SemVer X.Y.Z.
- `description` (recommended), `license` (`{ file = "LICENSE" }` or `{ text = "MIT License" }`), `requires-python` (e.g. `">=3.8,<3.11"`), `dependencies` (may pin e.g. `comfyui-frontend-package>=1.20.0`), `classifiers` (OS classifiers plus accelerator classifiers — NVIDIA CUDA, AMD ROCm, Intel Arc, Apple Metal, Huawei Ascend NPU).
- `[project.urls]` — `Repository` (required), `Documentation`, `Bug Tracker` (recommended).

`[tool.comfy]` section:
- `PublisherId` (required) — your unique publisher identifier, typically your GitHub username; it appears after the `@` on your registry profile page and cannot be changed later (it's used in the node's URL).
- `DisplayName` (optional), `Icon` (SVG/PNG/JPG/GIF, max 400×400, square), `Banner` (SVG/PNG/JPG/GIF, 21:9), `requires-comfyui` (supported operators `<`, `>`, `<=`, `>=`, `~=`, `<>`, `!=`, and ranges), and `includes` (force-add otherwise-ignored folders, e.g. `includes = ['dist']`).

### comfy-cli (publishing & node management)

`pip install comfy-cli` provides a CLI front-end ("We use `cm-cli` for installing custom nodes"):

| Command | Purpose |
| --- | --- |
| `comfy install` (`--fast-deps` uses `uv` for the initial ComfyUI install) | Install ComfyUI (and Manager) locally. |
| `comfy launch` | Start the server. |
| `comfy node install/update/show/simple-show` | Manage custom nodes. |
| `comfy node bisect start/good/bad/reset` | Binary-search which custom node causes a bug. |
| `comfy node save-snapshot` / `restore-snapshot` | Capture / restore the installed node set. |
| `comfy node init` | Scaffold `pyproject.toml` (pre-fills `version = "1.0.0"`; leaves `name`, `PublisherId`, `DisplayName` for you). |
| `comfy node publish` / `comfy registry publish` | Publish to the Registry (prompts for the API key). |
| `comfy model download --url ... --relative-path models/checkpoints` | Download models. |

**Publishing flow:** create a publisher at `registry.comfy.org`, generate an API key, run `comfy node init`, fill in `PublisherId`, then `comfy node publish` (manual) or set up GitHub Actions. Exclude tracked-but-unwanted files with `.comfyignore` (gitignore syntax, layered on top of `.gitignore`; folders in `[tool.comfy].includes` are force-included). For automation, add `.github/workflows/publish_action.yml` using the **`Comfy-Org/publish-node-action@main`** action with the API key in a GitHub secret named `REGISTRY_ACCESS_TOKEN`; the workflow runs on `workflow_dispatch` and on pushes to `main` that change `pyproject.toml`.

**Partner-node generation (Beta)** is also in comfy-cli: `comfy generate <model_alias>` calls Comfy's hosted partner models from the terminal (aliases include `flux-pro`, `nano-banana`, `seedance`, `grok`/`grok-edit`/`grok-video`, `flux-kontext`, `kling`, `luma`, `dalle`, `ideogram-edit`), with subcommands `list` / `schema` / `upload` / `resume`, and an API key set via `export COMFY_API_KEY=comfyui-...`.

### ComfyUI-Manager

`ComfyUI-Manager` (Comfy-Org) is the in-app extension that installs, removes, disables, and enables custom nodes and surfaces Registry data. Notable features:

- **Install Missing Custom Nodes** — "displays a list of extension nodes that contain nodes not currently present in the workflow" and offers installation.
- **Snapshot Manager** — save/restore the full installed-node state. Snapshots are stored at `<USER_DIRECTORY>/__manager/snapshots` for ComfyUI v0.3.76+ (formerly `<USER_DIRECTORY>/default/ComfyUI-Manager/snapshots`).
- **Database modes** — *Channel (1day cache)* (default), *Local*, *Channel (remote)*.
- **Network modes** (`config.ini`): `public`, `private` (closed network with a `channel_url`), `offline`.
- **Security levels** gating risky features: `strong` ("doesn't allow high and middle level risky feature"), `normal` (blocks high-risk; allows middle-risk such as uninstall/update and installing default-channel nodes), `normal-` (blocks high-risk only when `--listen` is specified and doesn't start with `127.`), `weak` ("all feature is available"). High-risk = e.g. downloading models not in `.safetensors` format and not in the default channel list.
- **Granular install gates** decoupled from security level: `allow_git_url_install` (Install via Git URL for unregistered repos) and `allow_pip_install` (standalone pip) — both loopback-only and default-deny (must be set to the string `true` in `config.ini`).
- **cm-cli** — "a tool is provided that allows you to use the features of ComfyUI-Manager without running ComfyUI." comfy-cli's `--uv-compile` delegates to Manager's unified resolver, which batch-resolves all custom-node dependencies via `uv pip compile` (requires ComfyUI-Manager v4.1+).

### API / Partner nodes

**Partner nodes** (a.k.a. API nodes, flagged by `API_NODE` / `is_api_node`) call paid, hosted models through Comfy's own infrastructure. They are **completely optional**, and "ComfyUI will always remain fully open-source and free for local users"; they can be disabled entirely with `--disable-api-nodes`. Bring-your-own-API-key support was announced as planned ("coming soon") in the launch blog.

- **Auth & cost**: log in with a Comfy account (Settings → User) and keep a credit balance > 0. Credits are prepaid via Stripe (Settings → Credits). Monthly credits expire at the end of the billing period; top-up credits expire one year from purchase. Credits "are not intended to be used as a negative balance," though race conditions can produce a temporary negative. The launch blog states "We charge the same as the original price for each API."
- **Network constraints**: API access requires a secure context — local `127.0.0.1`/`localhost`, or an API Key for non-whitelisted hosts. Partner nodes won't work under `--listen` on a LAN without API-key auth. In V3, the runtime injects `io.Hidden.auth_token_comfy_org` / `io.Hidden.api_key_comfy_org`.
- **Providers/models** named in the launch blog (`comfyui-native-api-nodes`): Black Forest Labs **Flux** (1.1[pro] Ultra, .1[pro]), **Kling** (2.0/1.6/1.5 + effects), **Luma** (Photon, Ray2, Ray1.6), **MiniMax**, **PixVerse** (V4 + effects), **Recraft** (V3/V2), **Stability AI** (Stable Image Ultra, SD 3.5 Large), Google **Veo2**, **Ideogram** (V3/V2/V1), **OpenAI** (GPT-4o image), and **Pika** (2.2). The current model list and pricing live on the Registry. (The launch blog does **not** list Runway.)

### Core vs. custom-node summary

- **Shipped in core:** the V1 and V3 node contracts, `PromptServer`/aiohttp routing + WebSocket, the `app.registerExtension` frontend API and `extensionManager` (settings/commands/keybindings/sidebar/bottom-panel/toast/dialog), and partner/API nodes.
- **Separate official tooling (not core runtime):** the Comfy Registry (`registry.comfy.org`), **ComfyUI-Manager** (installed into `custom_nodes/`), and **comfy-cli** (`pip install comfy-cli`). The "Install Missing Custom Nodes," snapshot, security-level, and dependency-resolution features come from ComfyUI-Manager, not core ComfyUI.

---

## <a id="platform-api-deployment"></a>Platform, API & Deployment

ComfyUI ships as a Python backend (`main.py`) that serves an HTTP + WebSocket API and a web frontend. The same workflow JSON runs across every deployment surface below — the Desktop app, a manual/portable install, headless server mode, and Comfy Cloud — because they all wrap the identical execution engine. All facts below are drawn from `docs.comfy.org`, the `comfyanonymous/ComfyUI` and `Comfy-Org` GitHub repos, `comfy.org/cloud`, and `blog.comfy.org`. Version-specific figures are date-stamped; verified June 2026.

### Deployment surfaces at a glance

| Surface | What it is | Bundles | Auth/setup |
|---|---|---|---|
| **Manual / portable** | `git clone` + `python main.py`, or the Windows portable zip | Nothing — you supply Python, PyTorch, models | None built in |
| **Comfy Desktop** | Electron one-click installer (Win/macOS/Linux), auto-updating | Embedded Python (managed by `uv`), ComfyUI, ComfyUI_frontend, ComfyUI-Manager | Local-only by default |
| **comfy-cli** | `pip`-installable CLI that installs/launches/manages ComfyUI | Drives a normal ComfyUI install | None built in |
| **Comfy Cloud** | Officially hosted ComfyUI in the browser, no GPU needed | 900+ models + popular custom nodes pre-installed | Comfy account (credits) |

### ComfyUI Desktop (one-click app)

Distributed by Comfy-Org as an Electron application (`Comfy-Org/desktop`), built with electron-builder/ToDesktop and using `electron-updater` for auto-updates.

- **Platforms:** Windows (NSIS `.exe`, x64/ARM64), macOS (`.dmg`, Apple Silicon M1+), Linux. macOS requires **macOS 13 (Ventura)+** on **Apple Silicon (M1 or later)** — Intel Macs are not supported; Windows requires **Windows 10 or later** (x64 or ARM64). At least **~4.85 GB disk recommended per installation**. A dedicated NVIDIA/AMD GPU is recommended but not required.
- **What it bundles:** an embedded **Python** environment whose dependencies are installed/managed by **`uv`** (Astral's installer), the stable ComfyUI release, the `ComfyUI_frontend`, and **ComfyUI-Manager** (gated behind the `--enable-manager` feature flag). On startup it `uv`-installs dependencies and launches the ComfyUI server process — the Electron shell is a manager/wrapper around the normal backend.
- **Auto-update:** the app auto-checks for updates; when one is ready you click the "Desktop Update Ready" button (or use Settings → Updates) and it restarts to install. A toggle controls "Automatically install Desktop updates." (The exact set of components auto-updated — ComfyUI stable, Manager, the `uv` executable — and the precise updater cache path are not spelled out in the canonical Windows/macOS install docs; treat those specifics as **(unverified)**.)
- **Data locations (Desktop):**
  - Installations: `%USERPROFILE%\ComfyUI-Installs` (Win) / `~/ComfyUI-Installs` (mac), default
  - Shared model library + input/output: `%USERPROFILE%\ComfyUI-Shared` / `~/ComfyUI-Shared`
  - App settings/installation records/logs: `%APPDATA%\Comfy Desktop` / `~/Library/Application Support/Comfy Desktop`
  - The Desktop variant reads its extra-paths file as **`extra_models_config.yaml`** under `%APPDATA%\ComfyUI` (Win, i.e. `…\AppData\Roaming\ComfyUI`) / `~/Library/Application Support/ComfyUI` (mac), reachable via **Help → Open Folder → extra_model_paths.yaml**. (Desktop launches the backend with an explicit `--extra-model-paths-config` pointing at this file; don't overwrite the install-generated config — append to it.)

### Comfy Cloud (officially hosted)

Comfy Cloud (`docs.comfy.org/get_started/cloud`) is the official hosted ComfyUI — "the cloud version of ComfyUI with the same features as the local version," running the **same workflow JSON** with zero install and no local GPU.

- **Hardware (per `blog.comfy.org`):** NVIDIA **RTX 6000 Pro (Blackwell)** GPUs, **96 GB VRAM** and **180 GB RAM** per unit; described as "approximately twice as fast as A100s," which they replaced (rolled out late Nov 2025 at no additional charge).
- **Pre-installed:** **900+ supported models** ("Over 900 supported models," per the free-tier announcement) plus a curated set of the most-used community custom nodes ("Pre-loaded models. Pre-installed custom nodes."), and 350+ built-in templates. Open models cited include **Wan 2.2, Flux, LTX, Qwen**; partner/API models include **Nano Banana, Seedance, Seedream, Grok, Kling, Hunyuan 3D**. "Every model on Comfy Cloud is cleared for commercial use. No license ambiguity."
- **Limits:** "one active job at a time" (higher tiers / parallel runs noted as coming); per-workflow runtime raised to **1 hour** on the **Pro plan starting Dec 8, 2025** (up from a previous 30 min). Billing is GPU-time-based: "Build and edit workflows for free — credits are consumed only when the GPU runs"; you aren't charged while models download.
- **Pricing (date-stamped):** credit-based at **~0.266 credits/sec** (as of 2026-01-23, after an ~30% GPU-price cut from the prior **0.39 credits/sec** rate of Nov 25, 2025). Plan pool examples from the Dec 8, 2025 changes: Standard = **4,200 credits/mo**; Founder's Edition = **5,460** (4,200 + 30%, for pre-Nov-25 subscribers who keep an active Standard subscription); **Pro** plan adds 1-hour runs; **Creator** plan adds importing your own LoRAs from **CivitAI** (HuggingFace support noted as coming). A **Free tier** (added later) grants **400 credits/month**, no card required, with access to the same models/nodepacks (credit amounts for Pro/Creator are not published on the cited pages — **(unverified)**).

#### Comfy Cloud MCP server

A separate **Model Context Protocol** server (`Comfy-Org/comfy-cloud-mcp`, **closed beta — invite-only with a per-user feature flag** as of mid-2026) connects AI agents to Comfy Cloud so they can generate images/video/audio/3D, search models/nodes/templates, and run workflows from chat.

- **Endpoint:** `https://cloud.comfy.org/mcp` (HTTP transport).
- **Clients:** **Claude Code and Claude Desktop** (OAuth sign-in); the docs note "more clients coming." (Cursor/Amp support is not stated in the canonical MCP-server doc — **(unverified)**.)
- **Tools / slash commands:** `generate-image`, `generate-video`, `generate-audio`, `generate-3d`, `remove-background`, `upscale-image`, `search-models`, `search-nodes`, `search-templates`, `help`. In the Claude Code plugin these are exposed as namespaced slash commands (e.g. `/comfy-cloud:generate-image`).
- **Auth:** OAuth for supported clients (one-time browser sign-in, automatic token refresh — in Claude Code, `/mcp` → comfy-cloud → Authenticate); for headless/CI use an API key from `platform.comfy.org/profile/api-keys` (keys start with `comfyui-`) via `claude mcp add --transport http comfy-cloud https://cloud.comfy.org/mcp -H "X-API-Key: comfyui-…"`.
- **Install (Claude Code):** `/plugin marketplace add Comfy-Org/comfy-skills` then `/plugin install comfy-cloud@comfy-skills` (or connection-only: `claude mcp add --transport http comfy-cloud https://cloud.comfy.org/mcp`).

### REST / HTTP API surface

The server (default `127.0.0.1:8188`) exposes routes registered in `server.py`. Submitting a workflow uses the **API-format JSON** ("Save (API Format)" in the UI), which is the node-graph dict keyed by node id — distinct from the editor's `.json` workflow file.

| Method + Path | Purpose |
|---|---|
| `POST /prompt` | Queue a workflow. Body includes the `prompt` (API-format graph), optional `client_id`, `extra_data`. Returns `{"prompt_id", "number"}` on success; `{"error", "node_errors"}` on validation failure. |
| `GET /prompt` | Current queue/execution status (`exec_info` with `queue_remaining`). |
| `GET /queue` | Current queue state (running + pending). |
| `POST /queue` | Manage queue: clear pending/running, or delete items. |
| `GET /history` / `GET /history/{prompt_id}` | Completed-run history with outputs + metadata. |
| `POST /history` | Clear history or delete a history item. |
| `GET /view` | Fetch an output/input/temp file by `filename`, `subfolder`, `type` (`input`/`output`/`temp`). |
| `GET /view_metadata/{folder_name}` | Embedded metadata for a model file. |
| `POST /upload/image` | Upload an image (`multipart/form-data`); used to feed `LoadImage`. |
| `POST /upload/mask` | Upload a mask onto an existing input image. |
| `GET /object_info` / `GET /object_info/{node_class}` | Full (or single) node-type schema: inputs, outputs, widget definitions — the basis for any client that builds graphs dynamically. |
| `GET /system_stats` | Python version, devices, VRAM/RAM stats. |
| `POST /interrupt` | Stop the current workflow execution. |
| `POST /free` | Free memory by unloading specified models. |
| `GET /embeddings` | List available textual-inversion embedding names. |
| `GET /extensions` | List extensions that register a `WEB_DIRECTORY`. |
| `GET /models` / `GET /models/{folder}` | List model folder types / files in a folder. |
| `GET /features` | Server feature flags/capabilities. |
| `GET /workflow_templates` | Map of custom-node modules to their template workflows. |
| `GET/POST/DELETE /userdata/{file}`, `GET /userdata`, `GET /v2/userdata`, `POST /userdata/{file}/move/{dest}` | User-scoped settings/workflow file storage (see Userdata). `GET /v2/userdata` is the enhanced variant that lists files *and* directories in a structured format. |
| `GET/POST /users` | Get user info / create a user (POST is multi-user mode only). |

### WebSocket API (real-time progress + previews)

Clients connect to `GET /ws?clientId=…`. If `clientId` is omitted the server assigns one (`uuid4().hex`); if supplied, the server re-uses that session id. The server pushes JSON text frames and binary frames. Documented JSON message `type`s and their `data`:

- **`status`** — `{exec_info: {queue_remaining}}` (when the queue state changes)
- **`execution_start`** — `{prompt_id}` (when a prompt is about to run)
- **`execution_cached`** — `{prompt_id, nodes}` (nodes skipped via cache, at the start of execution)
- **`executing`** — `{node, prompt_id}` (`node` is `None`/null when the run completes)
- **`progress`** — `{node, prompt_id, value, max}` (e.g. sampler step counter; requires the progress hook)
- **`executed`** — `{node, prompt_id, output}` (only when a node returns a UI element)
- **`execution_success`** — `{prompt_id, timestamp}`
- **`execution_error`** — `{prompt_id, …}`
- **`execution_interrupted`** — `{prompt_id, node_id, node_type, executed}`

**Binary frames** carry live latent previews. `server.py` sends them using the `BinaryEventTypes` enum (imported from the `protocol` module): `PREVIEW_IMAGE`, `UNENCODED_PREVIEW_IMAGE`, and `PREVIEW_IMAGE_WITH_METADATA` (plus a `TEXT` type). Each frame is prefixed with a 4-byte big-endian event header (`struct.pack(">I", event)`); image payloads carry a further `struct.pack(">I", type_num)` sub-header (1 = JPEG, 2 = PNG), and the metadata variant prepends a length-prefixed JSON blob before the image bytes. Whether previews are sent depends on `--preview-method` (see flags). Custom nodes/extensions can emit arbitrary message types via `PromptServer.instance.send_sync("my.custom.message", data)`.

### Headless / server mode

`python main.py` with no GUI auto-launch is the headless server. Common production launch:

```
python main.py --listen 0.0.0.0 --port 8188 --disable-auto-launch
```

`--listen` defaults to `127.0.0.1` (loopback only); passing it with no argument defaults to `0.0.0.0,::` (all IPv4 + IPv6 interfaces), exposing it on the network. `--disable-auto-launch` stops it opening a browser. For TLS, pass `--tls-keyfile` + `--tls-certfile` (both required together). The full API above is available headless; clients drive generation entirely over `POST /prompt` + `/ws`.

### comfy-cli (lifecycle management)

`comfy-cli` (`Comfy-Org/comfy-cli`, PyPI `comfy-cli`, requires Python 3.10+) is the official CLI. Install via `pip install comfy-cli` (also `pipx install comfy-cli` / `uv tool install comfy-cli`, or the Homebrew tap `Comfy-Org/comfy-cli`). Key commands:

- `comfy install` — download + set up the latest ComfyUI and ComfyUI-Manager. Flags: `--skip-manager`, `--workspace <path>`, `--fast-deps` (uv-based dependency resolution), `--nvidia`/`--amd`/`--cpu`, `--version`, `--pr "#1234"`.
- `comfy launch` — start the server with the correct Python. Pass through to `main.py` after `--` (e.g. `comfy launch -- --listen 0.0.0.0 --port 8188`); `--background` detaches.
- `comfy stop` — stop a background instance.
- `comfy set-default` — set the active install; `comfy env` — show environment config.
- `comfy node install <name>` — manage custom nodes.
- `comfy model download --url <url> --relative-path models/checkpoints` — download models.
- `comfy run` / `comfy workflow …` — execute/manage workflows.
- `comfy generate …` (beta) — one-shot calls to hosted partner nodes (flags include `--prompt`, `--image`, `--width`, `--height`, `--download`, `--json`, `--async`, `--api-key`); subcommands `list`, `schema`, `upload`, `resume`.
- `comfy setup` — interactive wizard for local/cloud routing, authentication, and agent-skill install.
- Global selectors: `--workspace <path>`, `--recent`, `--here`.

### Model management & directories

Models live under `ComfyUI/models/` in type-specific subfolders. Core directories include: `checkpoints`, `loras`, `vae`, `controlnet`, `clip` (a.k.a. `text_encoders`), `clip_vision`, `unet` / `diffusion_models`, `embeddings`, `upscale_models`, `hypernetworks`, `gligen`, `configs`, `diffusers`, `vae_approx`, plus custom-node-added types.

**`extra_model_paths.yaml`** (root of a manual install; `extra_model_paths.yaml.example` ships as a template) registers external search paths so you can share one model library across ComfyUI instances or with other UIs (A1111/WebUI):

```yaml
my_custom_config:
  base_path: /path/to/models
  is_default: true        # listed first / used as default save dir (e.g. for downloads)
  checkpoints: models/checkpoints/
  loras: |                # pipe = multiple dirs for one type
    models/Lora
    models/LyCORIS
  vae: models/vae/
  controlnet: models/controlnet/
  custom_nodes: /path/to/extra_custom_nodes
```

You can stack multiple named blocks (the shipped example uses `a111:`, `comfyui:`, `other_ui:`) in one file; each key maps a model type to a subdir relative to `base_path`. A restart is required after edits. Point the loader at a specific file with `--extra-model-paths-config <path>` (loads one or more files), or relocate everything with `--base-directory` (models, custom_nodes, input, output, temp, user) and per-folder overrides `--output-directory`, `--input-directory`, `--temp-directory` (each "Overrides --base-directory"). Models can be downloaded via `comfy model download`, ComfyUI-Manager, or the API-node/template flows.

### Multi-GPU, VRAM & offload modes

VRAM modes are **mutually exclusive**. Note: there is **no `--normalvram` flag in core** — normal VRAM is the default behavior, and passing `--normalvram` is a frequent Desktop crash cause.

| Flag | Effect (verbatim help) |
|---|---|
| `--gpu-only` | "Store and run everything (text encoders/CLIP models, etc... on the GPU)." |
| `--highvram` | "By default models will be unloaded to CPU memory after being used. This option keeps them in GPU memory." |
| `--lowvram` | "Doesn't do anything if dynamic vram is enabled. If dynamic vram isn't being used this option makes the text encoders run on the CPU." |
| `--novram` | "When lowvram isn't enough." |
| `--cpu` | "To use the CPU for everything (slow)." |

Related memory controls: `--reserve-vram <GB>` (reserve VRAM for the OS/other software), `--async-offload [NUM_STREAMS]` (default 2 streams, enabled by default on Nvidia) / `--disable-async-offload`, `--enable-dynamic-vram` / `--disable-dynamic-vram`, `--disable-smart-memory` (aggressively offload to RAM), `--disable-pinned-memory`, `--fast-disk`, `--mmap-torch-files` / `--disable-mmap`. Caching (mutually exclusive): `--cache-ram` (default, RAM-pressure based), `--cache-classic` (old aggressive style), `--cache-lru <N>`, `--cache-none` (lowest RAM/VRAM, re-executes every node).

**Device selection:** `--cuda-device <id[,id]>` (which CUDA device(s) to use; all others hidden), `--default-device <id>` (others stay visible), `--cuda-malloc`/`--disable-cuda-malloc`, `--directml [DEVICE]` (Windows DirectML), `--oneapi-device-selector` (Intel). Core has no single "spread one model across N GPUs" flag; multi-GPU is typically done by running multiple instances pinned via `--cuda-device`, or with custom nodes.

**Attention backends (mutually exclusive):** `--use-pytorch-cross-attention` (PyTorch SDPA), `--use-split-cross-attention`, `--use-quad-cross-attention` (sub-quadratic), `--use-flash-attention`, `--use-sage-attention`; xformers is used automatically when available and can be turned off with `--disable-xformers`. `--force-upcast-attention` / `--dont-upcast-attention` control precision upcasting.

**Precision flags:** global `--force-fp16` / `--force-fp32`; UNet `--fp16-unet`/`--bf16-unet`/`--fp32-unet`/`--fp64-unet`/`--fp8_e4m3fn-unet`/`--fp8_e5m2-unet`/`--fp8_e8m0fnu-unet`; VAE `--fp16-vae`/`--bf16-vae`/`--fp32-vae`/`--cpu-vae`; text-encoder `--fp16-text-enc`/`--bf16-text-enc`/`--fp32-text-enc`/`--fp8_e4m3fn-text-enc`/`--fp8_e5m2-text-enc`; plus `--force-channels-last` and `--fast` (experimental opts: `fp16_accumulation`, `fp8_matrix_mult`, `cublas_ops`, `autotune`).

**Previews:** `--preview-method {none,auto,latent2rgb,taesd}` (default `none`) and `--preview-size <px>` (default 512) control the live latent preview pushed over the WebSocket.

### Userdata & settings persistence

User-scoped data (UI settings, saved workflows) persists under the **user directory** (`--user-directory`, default `ComfyUI/user/`) and is read/written through `/userdata` routes. `--multi-user` "Enables per-user storage" (each user gets isolated settings/workflows, with `/users` for create/list) — but note this is storage partitioning, **not authentication**. On Desktop, settings/logs live under `Comfy Desktop` in the platform app-data dir (paths above).

### Self-host & auth posture

ComfyUI core has **no built-in web-UI authentication or password protection** — anyone who can reach the host/port can use it. The official guidance is to keep it on `127.0.0.1`/`localhost`. The **Comfy account / API key** (`platform.comfy.org`, `api.comfy.org`) exists for **credit-based partner/API nodes** (closed models like Nano Banana, Kling), not for protecting the local server.

Practical hardening:
- Bind to loopback and front it with a **reverse proxy** (Nginx/Caddy/Traefik) enforcing HTTP basic-auth or OAuth (the recommended production pattern).
- `--enable-cors-header [origin]` for controlled cross-origin API access (omit origin to allow all, `*`); `--tls-keyfile`/`--tls-certfile` for HTTPS; `--max-upload-size <MB>` (default 100) to bound uploads.
- `--disable-api-nodes` "Disable loading all api nodes. Also prevents the frontend from communicating with the internet"; `--disable-all-custom-nodes` / `--whitelist-custom-nodes` constrain what code loads (supply-chain surface).
- For per-user login, a **community custom node** (`ComfyUI-Login`) adds basic password/token auth — it is **not** part of core.

---

## <a id="recent-evolution-2025-2026"></a>Recent Evolution (2025–2026)

ComfyUI moves fast. Through 2025–2026 it shipped roughly weekly point releases (the `0.3.x` line in 2025, renumbered into a `0.x` line starting around December 2025), each adding new model-day support, node-schema migrations, and frontend rewrites. Every claim below is date-stamped to the version it landed in, per the official changelog at `docs.comfy.org/changelog`. Treat anything here as a moving target — features described as "beta" or "experimental" frequently graduate or change within a release or two.

> Sourcing note: all facts are from canonical Comfy-Org sources (`docs.comfy.org`, `blog.comfy.org`, `github.com/comfyanonymous/ComfyUI`). Where the changelog and a blog post disagree on a date, the changelog version-stamp is used.

### V3 node schema rollout

The biggest backend story is the migration to the **V3 node schema** ("Nodes v3"), a ground-up redesign of how custom nodes are authored. It first appeared as a definition in **v0.3.48 (Aug 2, 2025)** — "implementation of next-generation node schema system."

What V3 actually changes (per `docs.comfy.org/custom-nodes/v3_migration`):

- **Stateless class-method design.** A V3 node inherits from `io.ComfyNode`. There is no instance state — `__init__` has no effect because everything is a class method. The docs are explicit: *"Node objects do not expose 'state' — `def __init__(self)` will have no effect on what is exposed in the node's functions, as all of them are class methods."* This is the enabling change for distributed/parallel execution: the same node code can run on an isolated process or a separate machine.
- **`define_schema(cls)` returns an `io.Schema`.** Instead of the V1 `INPUT_TYPES` dict, V3 declares structured fields: `node_id` (globally unique), `display_name`, `category` (defaults to `"sd"`), `description`, `inputs`, `outputs`, `hidden`, plus boolean flags like `is_output_node`, `is_api_node`, `is_experimental`, `is_deprecated`, `not_idempotent`, `is_input_list`, and `accept_all_inputs`.
- **Inputs/outputs are objects, not strings.** V3 uses typed objects such as `io.Image.Input("image")` instead of V1's `"IMAGE"` dict entries. The docs put it as: *"Inputs and Outputs defined by objects instead of a dictionary."*
- **The execute method is fixed.** It must be named `execute`, is a `@classmethod`, and returns an `io.NodeOutput` (which can carry a UI preview). It may be declared `async`.
- **Hidden inputs via `cls.hidden`.** Declared in the schema's `hidden` list (e.g. `io.Hidden.unique_id`, `io.Hidden.prompt`), accessed as `cls.hidden.unique_id`, etc.
- **Import path:** `from comfy_api.latest import ComfyExtension, io, ui` (or a pinned version, e.g. `comfy_api.v0_0_2`).

Core categories were converted in waves through late 2025:

| Version | Date | V3 conversions |
|---|---|---|
| v0.3.52 | Aug 23, 2025 | String nodes, Google Veo API, Ideogram API |
| v0.3.60 | Sept 23, 2025 | MiniMax API, Cosmos, conditioning, CFG, Canny |
| v0.3.62 | Sept 30, 2025 | "Converted some core nodes to V3 schema" |
| v0.3.65 | Oct 14, 2025 | Model downscale, LoRA extraction, compositing, latent ops, SD3/SLG, Flux, upscale models, HunyuanVideo |
| v0.3.66 | Oct 21, 2025 | ControlNet nodes |
| v0.3.67 | Oct 28, 2025 | Tripo and Gemini API nodes |
| v0.15.0 | Feb 24, 2026 | AudioEncoderOutput V3 compatibility |

V3 capability kept expanding into 2026: `MatchType`, `DynamicCombo`, and `Autogrow` support in **v0.4.0 (Dec 10, 2025)**, and advanced widget support for input classes in **v0.10.0 (Jan 21, 2026)**.

### Async node execution + partial execution

These two backend features arrived together in mid-2025 and are the plumbing behind non-blocking API nodes and faster multi-stage workflows.

- **Async node functions** — **v0.3.45 (Jul 21, 2025)**: "Full support for asynchronous node functions with earlier execution optimization."
- **Async API nodes** — **v0.3.50 (Aug 13, 2025)**: "Introduction of asynchronous API nodes, enabling non-blocking workflow execution." This is what lets a remote API call (e.g. a cloud video generation) run without freezing the rest of the graph.
- **Partial execution (backend)** — **v0.3.48 (Aug 2, 2025)**: "New backend support for partial workflow execution," for efficient multi-stage workflows.
- **Partial execution (frontend)** — shipped alongside the subgraph release (announced Aug 7, 2025): select an output node at the end of a branch and click the green play icon in the selection toolbox to run just that branch.
- **Enhanced subgraph execution** — **v0.3.68 (Nov 5, 2025)** added support for *multiple runs within a single workflow*.

Comfy has publicly framed async + stateless V3 nodes as foundations for future **parallel execution across machines** (per the V1→V3 migration rationale and the May 2025 partner-nodes post, which listed "parallel execution within a workflow" as coming). Note the May 2025 blog post specifically says "parallel execution within a workflow," not "distributed execution across machines."

### Subgraphs (general availability)

Subgraphs let you box-select a cluster of nodes and collapse them into a single reusable "super-node" — Comfy's own framing is *"'LEGO' blocks."*

- **Subgraph support** landed in **v0.3.51 (Aug 20, 2025)** and was announced as officially available on **Aug 7, 2025** (`blog.comfy.org/p/subgraph-official-release`).
- **How to create:** box-select nodes → click the **Subgraph** button in the selection toolbox. Click the icon on the subgraph node to enter edit mode; inside are **Input slots** (data from outside) and **Output slots** (data going outside) you wire up to expose externally. The docs note it *"feels like a folder — you can dive inside and edit."*
- **Subgraph Publish** — **v0.3.62 (Sept 30, 2025)**: publish a subgraph to the node library. Published subgraphs appear under **Node Library → Subgraph Blueprints**. (Detailed further in `blog.comfy.org/p/comfyui-0363-subgraph-publishing`, **v0.3.63, Oct 6, 2025**.)
- **Subgraph Widget Editing** — **v0.3.66 (Oct 21, 2025)**: edit subgraph parameters directly from a new Parameters panel without entering the subgraph.
- **Blueprints directory** for built-in templates added in **v0.9.2 (Jan 15, 2026)**; subgraph-blueprint categorization improved in **v0.15.0 (Feb 24, 2026)**.

### API nodes (Partner Nodes) launch

Native, first-party nodes that call paid third-party model APIs from inside a normal ComfyUI graph. The launch came with a brand refresh: a connected-blocks wordmark *"a nod to the graphs at the heart of ComfyUI,"* with a tilt for *"a touch of 90s anime and Y2K energy."*

- **Initial launch — May 6, 2025** (`blog.comfy.org/p/comfyui-native-api-nodes`): GPT-Image-1 launched "last week," then **65 nodes across 11 model families** (the post describes "62 new nodes" on top of GPT-Image-1, summarized as "11 models, 65 nodes"): Black Forest Labs (Flux 1.1 [pro] Ultra, Flux .1 [pro]), Kling (2.0/1.6/1.5 + effects), Luma (Photon, Ray2, Ray1.6), MiniMax (T2V/I2V), PixVerse (V4 + effects), Recraft (V3/V2), Stability AI (Stable Image Ultra, SD 3.5 Large), Google Veo2, Ideogram (V3/V2/V1), OpenAI GPT-4o image, Pika 2.2. This release also added a **first-class `VIDEO` type** to ComfyUI.
- **Pricing:** Comfy charges *"the same as the original price for each API,"* paid via credits. Partner nodes are optional; **core ComfyUI stays free and open-source** (*"ComfyUI will always be free and open-source!"*).
- **Wave 2 — May 27, 2025** (`blog.comfy.org/p/comfyui-api-nodes-wave-2-is-live`) added LLM nodes (Google Gemini 2.5 Pro/Flash; OpenAI GPT-4.1, 4o, o1, o3, o4), RunwayML Gen-4 / Gen-4 Turbo / Gen-3 Alpha Turbo, Vidu (marked "coming soon"), and **3D asset generation** (Hyper3D Rodin with Sketch/Regular/Smooth/Detailed presets; Tripo 3D V1.4/V2.0/V2.5 with rigging, texture editing, mesh refinement).

The partner-node catalog then grew nearly every release. A representative slice:

| Version | Date | Notable API/partner nodes added |
|---|---|---|
| v0.3.40 | Jun 5, 2025 | BFL API refinement for Flux Kontext |
| v0.3.51 | Aug 20, 2025 | GPT-5, Kling V2-1, MiniMax Hailuo, Vidu |
| v0.3.53 | Aug 28, 2025 | Google Gemini Image ("nano-banana") |
| v0.3.59 | Sept 10, 2025 | ByteDance Seedream 4.0 |
| v0.3.62 | Sept 30, 2025 | Rodin3D Gen-2, Wan2.5 Image-to-Image |
| v0.13.0 | Feb 10, 2026 | Kling V3, O3 |
| v0.21.1 | May 13, 2026 | Flux2ImageNode, GrokImageEditNodeV2, ByteDanceSeedreamNodeV2, OpenAI Image, Claude LLM |
| v0.23.0 | Jun 1, 2026 | OpenRouter LLM, Rodin2.5, Krea2, Tripo3D P1, Flux Virtual Try-On & Erase |
| v0.24.0 | Jun 3, 2026 | Ideogram V4, WAN2.7, SeeDance 2.0 |
| v0.25.0 | Jun 16, 2026 | Bria (background) nodes, Gemini Text, Runway Aleph2, Krea 2 Medium Turbo |
| v0.25.1 | Jun 16, 2026 | Kling V3-Turbo |

### Comfy Cloud

A hosted ComfyUI: the same node graph, run on Comfy's GPUs with no local install.

- **Out of beta — Mar 4, 2026** (`blog.comfy.org/p/comfy-cloud-is-out-of-beta-and-its`).
- **Hardware:** NVIDIA Blackwell **RTX 6000 Pro**, **96 GB VRAM**, **180 GB system RAM**.
- **Pricing:** pay-per-use — *"you're only charged for active GPU time while a workflow is actually running."* Building/tweaking parameters is free; *"the meter starts when you hit run."* A free tier launched the week of the announcement; paid plans unlock longer runtimes and more API-node credits.
- **Custom nodes:** "the custom nodes powering ~90% of local workflows" are available, with custom LoRA uploads from Hugging Face and Civitai.
- **Models:** open-source (Qwen, LTX 2, Hunyuan) and closed-source (Nano Banana 2, Grok, Kling 3.0).

### Rewritten frontend (Nodes 2.0)

The headline frontend rewrite is **Nodes 2.0**.

- **Nodes 2.0 public beta** shipped in **v0.3.76 (Nov 26, 2025)** and was explained in depth on **Dec 5, 2025** (`blog.comfy.org/p/comfyui-node-2-0`).
- **Architectural change:** the node system moves *"from LiteGraph.js Canvas rendering to a Vue-based architecture"* — away from Canvas2D + LiteGraph toward Vue components, enabling expandable nodes, dynamic widgets, and richer interaction patterns.
- **Not a forced migration:** the legacy canvas stays (*"No forced migration"*). Toggle via the ComfyUI logo menu → "Nodes 2.0." Desktop support came later (the Dec 2025 post notes desktop "coming soon").
- **v0.3.76 also brought:** Linear mode (beta), a new workflow **progress panel**, and an **Assets sidebar**.
- An earlier UI wave in **v0.3.51 (Aug 20, 2025)** had already added a bottom shortcut panel, **Standard Canvas Mode**, a **workflow mini map**, and **workflow tab preview**.

### Templates system

Built-in, version-pinned workflow templates (a separate `comfyui-workflow-templates` package).

- **Template Modal Redesign** — **v0.3.66 (Oct 21, 2025)**: a new template browser with filtering by **model tags and categories**.
- **Blueprints directory** for built-in templates — **v0.9.2 (Jan 15, 2026)**.
- Templates ship pinned per release and bump frequently (e.g. workflow templates updated to v0.9.75 in v0.21.0, May 11, 2026). New model-day support almost always arrives with a matching template bump. *(Specific per-release template version numbers vary; consult the changelog entry for the exact pin.)*

### The wave of new model-day support

ComfyUI's defining habit is same-day (or near-same-day) support for newly released open models, with the matching sampler/scheduler nodes. By architecture family:

**Flux**
- BFL API refinement for **Flux Kontext** (v0.3.40, Jun 5, 2025).
- **NAG** (Nesterov-accelerated gradient) guidance for all Flux-based models (v0.14.0, Feb 17, 2026).
- **Flux2 Klein** major new model family (v0.9.2, Jan 15, 2026); **Flux2 LyCORIS LoKr** support (v0.11.0, Jan 27, 2026); `FluxKVCache` node for Flux 2 Klein (v0.17.0, Mar 13, 2026).

**WAN (Wan2.x video)**
- Base WAN support (v0.3.46, Jul 28, 2025); **WAN 2.2 Fun Camera** (v0.3.51, Aug 20, 2025); Wan2.2 5B fun-control/fun-inpaint + `WanSoundImageToVideoExtend` (v0.3.55, Aug 29, 2025); **Wan2.2 Animate** (v0.3.60, Sept 23, 2025).

**Hunyuan**
- Hunyuan Image 2.1 + Hunyuan 3D 2.1 (v0.3.58, Sept 6, 2025); **HunYuan 3D 2.0** (v0.3.70, Nov 19, 2025); **HunyuanVideo 1.5** (v0.3.71, Nov 21, 2025).

**Qwen**
- **Qwen-Image** with LoRA loading (v0.3.50, Aug 13, 2025); **Qwen-Image-Edit** (v0.3.51, Aug 20, 2025); Qwen Image ControlNet integration (v0.3.52, Aug 23, 2025); **Qwen Image Edit 2509** (v0.3.60, Sept 23, 2025).

**LTX (LTXV)**
- **LTXV 2** model support (v0.8.0, Jan 7, 2026); LTX2 Tiny VAE (`taeltx_2`) (v0.11.0, Jan 27, 2026); EasyCache LTX2 support (v0.13.0, Feb 10, 2026).

**Other notable model days:** Cosmos Predict2 2B/14B (v0.3.41, Jun 17, 2025); Chroma Radiance + HuMo (v0.3.60, Sept 23, 2025); Z-Image (v0.3.75, Nov 26, 2025); Kandinsky 5.0 (v0.4.0, Dec 10, 2025) and Z-Image Fun Control Union 2.0 (v0.5.0, Dec 17, 2025); ACE-Step 1.5 audio (v0.12.0, Feb 3, 2026); Ideogram 4 as a NextDiT/Lumina2-family single-stream DiT with a Qwen3-VL-8B text encoder (v0.24.0, Jun 3, 2026).

**Samplers/schedulers added in this window:** ER-SDE (migrated VE→VP) (v0.3.44, Jul 8, 2025); **SA-Solver** + `SamplingPercentToSigma` (v0.3.45, Jul 21, 2025); rectified-flow SEEDS and multistep DPM++ SDE, plus `ModelSamplingContinuousEDM`'s `cosmos_rflow` option (v0.3.41, Jun 17, 2025); **DPM++ 2M SDE Heun (RES)** (v0.3.53, Aug 28, 2025); `ManualSigmas` node (v0.7.0, Dec 31, 2025); `Ideogram4Scheduler` (with `DualModelGuider`, `CFGOverride`) (v0.24.0, Jun 3, 2026).

### Performance flags worth knowing

| Flag / feature | Version | Date |
|---|---|---|
| `--whitelist-custom-nodes` (with `--disable-all-custom-nodes`) | v0.3.44 | Jul 8, 2025 |
| Sage Attention 3 support; NVFP4 (fp4 matmul) checkpoints | v0.8.0 | Jan 7, 2026 |
| Dynamic VRAM becomes the default | v0.16.0 | Mar 5, 2026 |
| `--fp16-intermediates`, `--enable-dynamic-vram` | v0.18.0 | Mar 21, 2026 |
| `--reserve-vram`, `--vram-headroom`, `--high-ram` | v0.25.0 | Jun 16, 2026 |

Earlier memory work includes Mixed-Precision Quantization and RAM Pressure Cache Mode in **v0.3.68 (Nov 5, 2025)**, and pinned memory enabled by default for NVIDIA/AMD GPUs in **v0.3.69 (Nov 18, 2025)**.

> Bottom line: the 12 months ending mid-2026 turned ComfyUI from a single-machine canvas into a platform — a stateless V3 node model and async execution underneath, subgraphs and a Vue-based frontend on top, a paid API-node + hosted-cloud business alongside the free core, and same-day support for nearly every major open model release.

---

## <a id="api-nodes-partner-nodes-credits"></a>API Nodes / Partner Nodes and the Comfy Account & Credits Layer

ComfyUI is fully open-source and runs every model locally for free. **Partner Nodes** (the docs use "Partner Nodes" and "API Nodes" interchangeably; the implementation lives in `comfy_api_nodes/`) are a separate, opt-in, account-gated layer that lets a workflow call **closed-source, third-party hosted models** — Nano Banana, Seedance, GPT-Image, Veo, Kling, Hunyuan3D, etc. — directly inside the graph, billed against a prepaid Comfy credit balance. They are explicitly optional: per the docs, "Partner Nodes are completely optional" and ComfyUI "will always remain fully open-source and free." This is the commercial/business surface that brokers SOTA proprietary models without the user managing per-provider API keys.

### What Partner Nodes are

Per `docs.comfy.org/tutorials/partner-nodes/overview`, Partner Nodes are "a set of special nodes that connect to external API services, allowing you to use closed-source or third-party hosted AI models directly in your ComfyUI workflows." They give "access to external state-of-the-art AI models without complex API key setup." Concretely:

- **No per-provider keys to manage.** Authentication is handled through your single Comfy account; you don't paste a Kling key, a Google key, an OpenAI key, etc.
- **They run on Comfy's servers, not your GPU.** The node POSTs to the provider's hosted API on your behalf and returns the result into the graph as a normal `IMAGE`/`VIDEO`/`AUDIO`/3D output.
- **They compose with local nodes** — this is the headline "hybrid" pattern: the docs' canonical example is "using GPT-Image-1 to generate a base image, then transforming it into video with a local `wan` node." You can mix a paid closed model and a free local model in one graph.

### The provider/model catalog (verified in `comfy_api_nodes/`)

Each provider is one Python module under `comfy_api_nodes/` in `github.com/comfyanonymous/ComfyUI`. The directory listing confirms these provider files (node ids/display names verified from source):

| Provider (file) | Representative models / node ids |
|---|---|
| Google (`nodes_gemini.py`) | **Nano Banana** = `gemini-2.5-flash-image` / `gemini-3.1-flash-image-preview`; text via `GeminiNode`, `GeminiNodeV2` ("Gemini 3.1 Pro", "Gemini 3.1 Flash-Lite") |
| Google (`nodes_veo2.py`) | `VeoVideoGenerationNode` — Veo `veo-2.0-generate-001`, `veo-3.0/3.1-generate`, `veo-3.1-fast`, `veo-3.1-lite` |
| ByteDance (`nodes_bytedance.py`, `nodes_bytedance_llm.py`) | **Seedance 2.0 / 2.0 Fast** video, **Seedream 4.0/4.5/5.0** image, Seed LLM |
| OpenAI (`nodes_openai.py`, `nodes_sora.py`) | **GPT-Image-1**, DALL·E 2/3, GPT text models, **Sora-2** video |
| Anthropic (`nodes_anthropic.py`) | Claude Opus / Sonnet / Haiku (text) |
| xAI (`nodes_grok.py`) | Grok |
| OpenRouter (`nodes_openrouter.py`) | OpenRouter-brokered text models |
| BFL (`nodes_bfl.py`) | Flux (`flux-dev`, `flux-pro-1.1`, `flux-2-pro`, `flux-2-max`); e.g. `FluxProUltraImageNode` |
| Kling (`nodes_kling.py`) | `KlingTextToVideoNode`, `KlingImage2VideoNode`, `KlingOmniPro*`, camera-control nodes |
| Runway (`nodes_runway.py`) | Gen3a Turbo, Gen4 Turbo, Aleph |
| Luma (`nodes_luma.py`) | Ray-2, Photon-1 |
| MiniMax / Hailuo (`nodes_minimax.py`) | Hailuo-02 |
| Pixverse (`nodes_pixverse.py`), Vidu (`nodes_vidu.py`), LTXV (`nodes_ltxv.py`) | video |
| Stability (`nodes_stability.py`) | SD3.5 Large, Stable Audio 2.5 |
| Recraft (`nodes_recraft.py`), Ideogram (`nodes_ideogram.py`), Reve (`nodes_reve.py`), Krea (`nodes_krea.py`), Magnific (`nodes_magnific.py`) | image gen / upscale |
| ElevenLabs (`nodes_elevenlabs.py`) | TTS, STT |
| Tencent **Hunyuan3D** (`nodes_hunyuan3d.py`) | `TencentTextToModelNode`, `TencentImageToModelNode`, `TencentModelTo3DUVNode`, `Tencent3DTextureEditNode`, `Tencent3DPartNode`, `TencentSmartTopologyNode` |
| Meshy (`nodes_meshy.py`), Tripo (`nodes_tripo.py`), Rodin (`nodes_rodin.py`) | 3D (text/image → model) |
| Topaz (`nodes_topaz.py`) | video/image enhance/upscale |
| Others | Beeble, Bria, Hitpaw, Quiver, Sonilo, Wavespeed |

> Note: **Hunyuan3D** Partner Nodes register under `Tencent*` node ids (Tencent operates Hunyuan), and **Nano Banana** is a Google Gemini image model — it has no standalone "NanoBanana" file; it's selected as a model option inside the Gemini nodes.

### Prerequisites to use a Partner Node

1. **Recent ComfyUI.** Latest version required; docs recommend the `nightly` build "since the release version may not be updated in a timely manner." (Minimum noted elsewhere: ComfyUI v0.3.0 + frontend ≥ 1.17.11.)
2. **A logged-in Comfy account** with a **credit balance > 0**.
3. **Network access** to the API service (some regions need a proxy) over **HTTPS**.

### Login, account, and the API-Key path

- **Direct login** (email / Google / GitHub) is available via **`Settings → User`** (gear icon or `Ctrl + ,`), but only when ComfyUI is served from a whitelisted origin — **`127.0.0.1` or `localhost`** only. The docs explicitly **do not support `--listen`** (LAN access) for direct Partner-Node login.
- **API-Key login** is the supported path for non-whitelisted / LAN hosts. This is the **ComfyUI Account API Key**, generated at **`https://platform.comfy.org/login`**.
- **Two different keys — don't confuse them.** The account API Key (for *consuming* paid Partner Nodes) is **NOT** the **Registry Publishing API Key** used by developers to publish custom nodes (`/registry/publishing`).
- **Security warnings:** non-HTTPS / insecure contexts risk "Authentication may be stolen" and "Your account may be maliciously used, resulting in financial losses." Don't log in on public devices.

### Programmatic API-Key integration (`/prompt`)

To run a workflow containing Partner Nodes from a server/script, the account API key is passed in the **`extra_data`** field of the POST `/prompt` payload — **not** an `Authorization` header or query param. Exact field name: **`api_key_comfy_org`** (route `/development/comfyui-server/api-key-integration`):

```python
payload = {
    "prompt": prompt,                       # workflow in API format, may contain e.g. FluxProUltraImageNode
    "extra_data": {
        "api_key_comfy_org": "comfyui-87d01e28d*******"
    }
}
# POST {SERVER_URL}/prompt
```

The account must hold sufficient credits for the Partner Nodes in that prompt.

### Credits: the billing model

Credits are a **prepaid** currency. "We use a prepaid system, so there will be no unexpected charges." They work across both Comfy Cloud and Comfy Desktop. Conversion rate (from `tutorials/partner-nodes/pricing`): **211 credits = 1 USD**.

**Two credit types with different expirations:**

| Type | Expiration |
|---|---|
| **Monthly credits** (from a subscription/billing period) | Expire at the **end of your billing period** |
| **Top-up credits** (one-off purchase) | Expire **1 year** from date of purchase |

**Buying & viewing** (`Settings → Credits`, visible only after logging in via `Settings → User`): set an amount, Buy, pay via **Stripe** (card; WeChat/Alipay available when paying in Comfy Credits). A **Credit History** view tracks usage.

**Cost estimation before running:** each Partner Node shows a **price badge** — "Check the price badge on the API node to estimate the cost." Actual cost varies with image size, frame count, token count, generation quantity, etc. The pricing page bills per the unit appropriate to the model: **per run, per second, per frame, per megapixel, or per 1M tokens**. Token-priced providers (Anthropic, OpenAI, Google, ByteDance, OpenRouter) bill "the same underlying USD usage as the public API" — e.g. Claude Sonnet ≈ 633 credits / 1M input + 3165 / 1M output; Kling video v3 ≈ 17.72–35.45 credits/sec; Veo 3.0 ≈ 42.2–337.6 credits/run; Ideogram V3 ≈ 18.1 credits/run; Pika 2.2 i2v (720p/5s) ≈ 42.2 credits/run. (Prices change; treat the live pricing page as canonical.)

### Negative balance, race conditions, and refunds (the sharp edges)

- **A run can push you negative.** "Due to race conditions where partner nodes don't always report costs before execution, a single execution may consume more credits than your remaining balance and temporarily result in a negative balance."
- **Negative balance blocks further use.** "When your balance is negative, you will not be able to run Partner Nodes until you top up and restore a positive balance."
- **Not a credit line.** "Credits are not intended to be used as a negative balance or credit line."
- **No refunds** (general), except genuine technical errors → `support@comfy.org`.
- **Non-transferable.** Credits "cannot be transferred to other users" and are tied to the logged-in account.
- **No device limit.** "We do not limit the number of devices that can log in."

### Turning the whole layer off: `--disable-api-nodes`

A single launch flag removes the entire commercial surface. From `comfy/cli_args.py`, the flag's help is verbatim:

> `--disable-api-nodes` — "Disable loading all api nodes. Also prevents the frontend from communicating with the internet."

This is the privacy/air-gap switch: it not only unloads every Partner Node but also stops the **frontend** from talking to the internet.

```bash
# Manual / source install
python main.py --disable-api-nodes

# Windows portable — edit run_*.bat:
.\python_embeded\python.exe -s ComfyUI\main.py --listen --windows-standalone-build --disable-api-nodes
```

### How this fits the bigger picture

- **Local pipeline (free, your GPU)** and **Partner Nodes (paid, hosted)** are deliberately interoperable — the intended pattern is hybrid graphs: a SOTA closed model for one step (e.g. Nano Banana / GPT-Image base frame, or a Hunyuan3D mesh) feeding a free local node (`wan`, KSampler, upscalers) for the rest.
- **Limitations to flag:** Partner Nodes require credits (not free), require connectivity to the provider, and — as of the current docs — you generally **cannot supply your own provider API keys** (BYOK is described as under consideration); billing flows through Comfy credits instead. LAN serving needs the API-Key login path, not direct login.

---

## <a id="mcp-agent-driven-operation"></a>MCP and Agent-Driven Operation

ComfyUI's normal operating mode assumes a human at the node graph: you drag nodes, wire links, and press **Run**. The Model Context Protocol (MCP) surface inverts that. It exposes ComfyUI as a set of callable tools that an AI agent (Claude Code, Claude Desktop, Cursor, Amp) drives from a chat session — no canvas, no manual wiring. You ask for an image, video, audio clip, or 3D mesh in natural language; the agent selects models, builds or fetches a workflow, submits it, polls the job, and hands back the output. This section covers the official Comfy Cloud MCP server, its tool surface, and the community MCP ecosystem that targets local/self-hosted installs.

### Comfy Cloud MCP server (official)

The official server is documented at `docs.comfy.org/development/cloud/mcp-server` and lives in the `Comfy-Org/comfy-cloud-mcp` repository. Per the docs it is **closed beta, invite-only** — access requires a per-user feature flag, and it is a **cloud-only feature** (not available in self-hosted ComfyUI). Without access you join the waitlist at `form.typeform.com/to/hHmvw1UH`.

- **Remote MCP endpoint:** `https://cloud.comfy.org/mcp` (HTTP transport — a remote MCP server, not a local stdio process).
- **Auth:** Claude Code and Claude Desktop sign in with **OAuth** — a one-time browser sign-in with automatic token refresh, so no API key is needed for those clients. Headless/CI usage authenticates with an **API key** (format `comfyui-…`) generated at `platform.comfy.org/profile/api-keys`.
- **Prerequisites:** a Comfy Cloud account with beta access; an active subscription is required to actually submit workflows (cloud GPU time).

### Installing the Cloud MCP

There are two documented install paths. The canonical docs path (`docs.comfy.org`) uses the official plugin marketplace; the repo README documents an install-script path.

**Plugin path (Claude Code, from the docs):**

```
/plugin marketplace add Comfy-Org/comfy-skills
/plugin install comfy-cloud@comfy-skills
```

This adds both the MCP connection and the slash commands in one step. To attach the server without the slash commands:

```
claude mcp add --transport http comfy-cloud https://cloud.comfy.org/mcp
```

Add `-s user` to make it available across all projects. For headless/CI, pass the key as a header:

```
claude mcp add --transport http comfy-cloud https://cloud.comfy.org/mcp -H "X-API-Key: comfyui-…"
```

**Claude Desktop:** open **Customize → Connectors → + → Add custom connector**, set the **Remote MCP server URL** to `https://cloud.comfy.org/mcp`, click **Add**, and complete OAuth sign-in. Slash commands do not work in Claude Desktop; it drives the underlying MCP tools through natural language only.

**Install-script path (repo README):** a `curl … install.sh | bash` (macOS/Linux) or `irm … install.ps1 | iex` (Windows PowerShell) installer that auto-detects the MCP client (Claude Code, Cursor, Amp), prompts for the Comfy API key, and configures the remote server with no Node.js required.

> Note: the two canonical sources disagree on the slash-command prefix. The docs page lists commands under `/comfy-cloud:` (e.g. `/comfy-cloud:generate-image`); the repo README lists them under `/comfy-` (e.g. `/comfy-generate-image`). Treat `docs.comfy.org` as authoritative for the OAuth/plugin install, and check `/comfy-cloud:help` (or `/comfy-help`) in your client for the exact strings your installed build registers.

### Slash commands (Claude Code only)

Per the docs (`/comfy-cloud:` prefix):

| Command | Function |
|---|---|
| `/comfy-cloud:generate-image` | Generate, edit, or modify an image |
| `/comfy-cloud:generate-video` | Generate, edit, or extend a video |
| `/comfy-cloud:generate-audio` | Generate audio |
| `/comfy-cloud:generate-3d` | Generate a 3D model |
| `/comfy-cloud:remove-background` | Remove an image background |
| `/comfy-cloud:upscale-image` | Upscale an image |
| `/comfy-cloud:search-models` | Search available models |
| `/comfy-cloud:search-nodes` | Search for nodes |
| `/comfy-cloud:search-templates` | Find pre-built workflows |
| `/comfy-cloud:help` | See what you can do |

The repo README additionally documents `/comfy-generate-3d` producing GLB/FBX/OBJ meshes and a `/technique-combine-people` command for compositing multiple people.

### MCP tool surface (repo README)

The slash commands are convenience wrappers; the underlying tools are what the agent calls (and what Claude Desktop uses directly):

- **Workflow generation:** `submit_workflow`, `get_job_status`, `get_output`, `cancel_job`, `get_queue`
- **Partner APIs (no cloud GPU cost):** `partner_generate` — routes to hosted partner models including Flux Pro, Nano Banana, Grok, GPT-image-1, Ideogram, and Seedream. This is the "Partner" path: instead of spending Comfy Cloud GPU time on a diffusion workflow, the agent calls a partner provider's hosted API.
- **Input handling / chaining:** `upload_file`, `use_previous_output` (feed one job's output into the next without round-tripping bytes through the agent)
- **Discovery:** `search_models`, `search_nodes`, `search_templates`, and `cql` (a Comfy query language for structured catalog search)
- **Saved workflows:** `save_workflow`, `list_saved_workflows`, `get_saved_workflow`, `run_saved_workflow` — persist a built graph and re-run it by name in later sessions
- **Feedback (beta):** `submit_feedback`, `report_session_summary`; survey at `links.comfy.org/cloudmcpbeta`

The typical agent loop is: `search_templates`/`search_models` → build or fetch a workflow → `submit_workflow` (or `partner_generate`) → `get_job_status` poll → `get_output`, optionally `save_workflow` for reuse and `use_previous_output` to chain.

### Community MCP servers (local / self-hosted)

The Cloud MCP is invite-only and cloud-bound. The community ecosystem fills the local/self-hosted gap by wrapping a running ComfyUI's HTTP API as MCP tools.

- **`artokun/comfyui-mcp`** — a Claude Code plugin **plus** MCP server for local and remote ComfyUI (Mac/Linux/Windows, RunPod, VPS). It advertises ~88–89 MCP tools, 22 AI skills, 11 slash commands, and 4 autonomous agents. It connects via ComfyUI's REST endpoints (`/object_info`, `/free`, `/system_stats`, `/prompt`) plus the WebSocket for live progress, auto-detecting port (8188 or 8000) and install path. Tool groups span high-level generation (`generate_image`, `generate_with_controlnet`, `generate_with_ip_adapter`, `generate_audio`), execution (`enqueue_workflow`, `get_job_status`, `get_queue`, `cancel_job`, `validate_workflow`, `visualize_workflow` → Mermaid), model management (`search_models`, `download_model`, `download_civitai_model`, `list_local_models`), custom-node lifecycle (`install_custom_node`, `update_custom_node`, `scaffold_custom_node`, `publish_custom_node`, plus `bisect_start`/`bisect_good`/`bisect_bad` to isolate a faulty node), and asset iteration (`view_image`, `list_assets`, `regenerate`). It also supports a cloud mode via `COMFYUI_API_KEY`, so one config can target local, remote, and cloud installs. Installed as `npx -y comfyui-mcp` in `~/.claude/settings.json` or via `/plugin marketplace add artokun/comfyui-mcp`.

- **`joenorton/comfyui-mcp-server`** — a lightweight Python server for a **local** ComfyUI on port 8188 (`python main.py --port 8188`). The MCP server itself runs over **streamable-HTTP** at `http://127.0.0.1:9000/mcp` (`"type": "streamable-http"`, with `"type": "http"` also accepted). Tools include `generate_image`, `generate_song`, `regenerate`, `view_image`, job management (`get_queue_status`, `get_job`, `cancel_job`, `list_assets`, `get_asset_metadata`), config (`list_models`, `get_defaults`, `set_defaults`), workflow control (`list_workflows`, `run_workflow`), and publishing (`get_publish_info`, `set_comfyui_output_root`, `publish_asset`). It uses workflow JSON with `PARAM_*` placeholders for auto-discovery, and treats assets as session-scoped (expiring after 24h). Run with `python server.py` after `pip install -r requirements.txt`.

- **`jonpojonpo/comfy-ui-mcp-server`** — oriented toward **context management** rather than execution: note-taking and summarization to keep an agent aware of project goals across a workflow session, complementary to an execution-focused server.

### Why this mode matters

Every other ComfyUI domain assumes a human reading the canvas. The MCP surface is a fully non-visual operating mode: discovery (`search_models`/`search_nodes`/`search_templates`/`cql`), execution (`submit_workflow`/`partner_generate`), chaining (`use_previous_output`), and persistence (`save_workflow`/`run_saved_workflow`) are all reachable from chat. That makes ComfyUI scriptable from an agent — batch generation, programmatic model/node discovery, and reproducible saved pipelines — without anyone opening the graph editor. The official Cloud MCP adds OAuth and a managed GPU backend; the community servers bring the same agent-driven loop to a local box you already run.

---

## <a id="queue-history-execution-control-ux"></a>Queue, History & Execution Control UX

This section covers the user-facing run-management surface of ComfyUI: how you queue, batch, prioritize, cancel, replay, and partially execute workflows. It is distinct from the execution engine itself (topology resolution, the `IS_CHANGED` cache, lazy evaluation) — here the concern is the controls a user actually touches to *drive* runs, not how the backend computes them.

All behavior below is sourced from the official documentation at `docs.comfy.org`, the `Comfy-Org/ComfyUI_frontend` and `comfyanonymous/ComfyUI` repos, and the official changelog. Where a feature has a meaningful version gate, the version is called out.

### The run/queue control area

The run controls live in the **Right Control Area** of the top header bar (the menu-bar region described in the Interface Overview as "Run and queue control management, where you can run workflows and view the queue"). The primary action is the **Queue** (a.k.a. **Queue Prompt** / "Add Prompt Word Queue") button, which serializes the current graph into a prompt and appends it to the pending queue.

| Action | Default keybinding (Win/Linux) | Default keybinding (macOS) | Notes |
|---|---|---|---|
| Queue prompt (append to end) | `Ctrl + Enter` | `Cmd + Enter` | Adds current graph to the back of the pending queue |
| Queue prompt (Front) | `Ctrl + Shift + Enter` | `Cmd + Shift + Enter` | Inserts at the front of the pending queue (highest priority) |
| Interrupt | `Ctrl + Alt + Enter` | `Cmd + Alt + Enter` | Cancels the currently *running* job |
| Toggle queue sidebar | `Q` | `Q` | Opens/closes the queue/history side panel |

Keybindings are user-customizable from Settings → Keybinding.

### Execution modes (Auto Queue)

Beyond a single click, the Queue button exposes automatic re-queueing modes (surfaced under the queue button's options / "Additional Options"). The two non-default modes are:

- **instant** — continuously re-queues the workflow, running back-to-back without further clicks. Stays in this mode until you switch back to the normal Queue mode.
- **change** — automatically queues a new run whenever a node parameter changes, so edits trigger regeneration without an explicit click.

The default mode is a plain single-shot Queue (one click → one batch of runs).

### Batch count vs. batch size

These are two different multipliers and are commonly conflated:

- **Batch count** — how many times the graph is enqueued per Queue click. Each is a separate queue entry. This is governed by the **Batch Count Limit** setting (default `100`), which caps how many tasks a single click can add, guarding against accidentally flooding the queue.
- **Batch size** — how many images a single graph run produces in one pass (set on the latent/empty-latent node, not the queue button).

Concretely: batch size 2 × batch count 3 → the 2-image graph runs 3 times → 6 images total, across 3 queue entries.

### The pending queue and prioritization

The queue is a FIFO list of pending prompts with two visible states:

- **Running** — the job currently executing (one at a time).
- **Waiting / Pending** — jobs awaiting their turn.

You can influence ordering at enqueue time via **Queue (Front)** (`Ctrl/Cmd + Shift + Enter`), which jumps the new prompt to the front of the pending list rather than the back.

### Interrupt, cancel, and clearing

ComfyUI distinguishes the *running* job from the *pending* queue, and the controls act on different scopes:

- **Interrupt / Cancel current run** (`Ctrl/Cmd + Alt + Enter`) — stops the job currently executing. The next item in the pending queue then promotes into the running slot. Backend-side this corresponds to the `/api/interrupt` route.
- **Clear Pending Tasks / Clear Queue** — removes all *pending* entries. Critically, this does **not** stop the currently running job — that job runs to completion; only the waiting entries are dropped.

So "clear queue" and "interrupt" are independent: clearing empties the waiting list, interrupting kills the active run.

### History and re-running

Finished jobs are retained as **history**, accessible from the queue/history side panel (`Q`) and the History view. Each finished entry stores the output preview(s) and the full workflow that produced it. From a history item you can:

- **Load** — restore that run's workflow and parameters back into the canvas, so you can re-run or tweak it.
- Drag a history thumbnail back into the canvas to restore its originating workflow.
- **Delete** an individual record, or **Clear History** to purge all.

The amount of history kept in the sidebar is controlled by the **Queue History Size** setting (default `100`). Larger values keep more entries but increase page-load memory cost.

### Partial Execution (run only the chain to a selected output)

Partial Execution lets you run only the dependency sub-graph leading to one selected output node, instead of the whole workflow — useful for iterating on or debugging one branch without re-paying the cost of unrelated branches.

How it works:

- Select an **output node** (a terminal node such as a **Save Image** or **Preview Image** node — i.e. a node the backend treats as an output).
- When the selected node qualifies, the **node selection toolbox** shows a **green triangle** button.
- Clicking the green triangle queues only the branch from the upstream sources through to that selected output node. Other output branches are skipped.

The toolbox button only appears when the selected node is an output node; for non-output nodes the option is unavailable.

Version gates (this is the load-bearing part — the feature shipped in stages):

- **Backend support** for partial workflow execution landed in **ComfyUI `v0.3.48`** (changelog dated 2025-08-02), described as enabling efficient processing of multi-stage workflows.
- The frontend **green-triangle toolbox control** was introduced around frontend **`v1.23.4`**.
- Early frontend builds had a defect where "Execute to selected output nodes" actually ran the *entire* workflow anyway (tracked in `Comfy-Org/ComfyUI_frontend` issues #5391 / #5394). The official docs state the related defects were not fully fixed until around frontend **`v1.24.3`**.

Practical guidance: if partial execution appears to run the whole graph, the cause is almost always an outdated frontend — update to **v1.24.3 or later**. Note that third-party node packs that override execution (e.g. rgthree's "Queue to selected output nodes," or some custom output nodes) historically needed to be updated to cooperate with the native partial-execution path.

### Relationship to adjacent domains

- The **Execution Engine & Graph Model** owns *what* gets computed (topological order, caching via `IS_CHANGED`, lazy inputs). This section owns *how a human drives those computations* — enqueue, batch, prioritize, interrupt, replay.
- The **Canvas UX** owns node placement and the node toolbox as a surface, but the run-management semantics of the green-triangle button (which chain executes, version gates) belong here.

---

## <a id="installation-runtime-distribution-desktop"></a>Installation, Runtime Distribution & ComfyUI Desktop

ComfyUI ships through several distinct distribution channels, each documented as its own tree at [docs.comfy.org](https://docs.comfy.org/) and each with materially different capabilities and constraints. The same workflow engine (`main.py` + the web frontend) sits underneath all of them, but how it is packaged, where it stores models/outputs, how it updates, and what hardware runs it differ sharply. The four channels are: **ComfyUI Desktop** (a managed launcher application), **ComfyUI Portable** (a self-contained Windows package), **Manual install** (git clone into your own Python environment), and **Comfy Cloud** (browser-hosted, no local GPU). A fifth tool, **comfy-cli**, automates the local install/launch flows.

### Distribution channels at a glance

| Channel | Platforms | GPU | Updates | Multi-instance | Internet required |
|---|---|---|---|---|---|
| **Desktop** | Windows 10+ (x64/ARM64), macOS 13+ (Apple Silicon) | Local (NVIDIA/AMD, optional) | In-app auto/manual updater | Yes (built-in installation manager) | No (after install) |
| **Portable** | Windows only | Local (NVIDIA/AMD/Intel/CPU) | `update/*.bat` scripts | Manual (multiple extracts) | No |
| **Manual** | Windows / Linux / macOS | Local (any PyTorch backend) | `git pull` + `pip install` | Manual (separate clones/venvs) | No |
| **Comfy Cloud** | Any browser | Hosted (RTX 6000 Pro Blackwell) | Managed by Comfy Org | N/A | Yes (always) |
| **comfy-cli** | Any (Python 3.9+) | Local (you provide CUDA/ROCm) | `comfy` commands | Manages installs | For partner-node generation |

### ComfyUI Desktop — the managed launcher

Comfy Desktop is not just "ComfyUI with an installer." Per the [Desktop docs](https://docs.comfy.org/installation/desktop/windows), it is a **multi-installation manager**: a launcher application that creates, runs, and switches between multiple independent ComfyUI instances, with shared model and I/O directories layered across them.

**Platforms and requirements:**
- **Windows:** Windows 10 or later, x64 or ARM64. NSIS `.exe` installer from [comfy.org/download](https://comfy.org/download). Minimum ~4.85 GB disk per installation. Dedicated GPU recommended but optional.
- **macOS:** macOS 13 (Ventura) or later, **Apple Silicon (M1+) required** (no Intel Mac support). `.dmg` drag-to-Applications install; first launch requires approval in System Settings → Privacy & Security.

**The multi-instance + shared-resource model** is the defining capability that separates Desktop from portable/manual. Each installation is independent (its own custom nodes and settings), but model libraries and input/output directories are shared across all of them. Storage layout:

| Data | Windows | macOS |
|---|---|---|
| Installations (instances, custom nodes) | `%USERPROFILE%\ComfyUI-Installs` | `~/ComfyUI-Installs` |
| Shared resources (model library, input/output) | `%USERPROFILE%\ComfyUI-Shared` | `~/ComfyUI-Shared` |
| App settings, logs, installation registry | `%APPDATA%\Comfy Desktop` | `~/Library/Application Support/Comfy Desktop` |

**Other Desktop-specific behaviors:**
- **Updates:** a "Desktop Update Ready" button for quick updates, plus a Settings → Updates panel to check manually and toggle automatic updates ("Restart & Update").
- **Legacy migration:** Desktop can auto-detect and migrate an existing "Legacy Desktop" install — preserving custom nodes, workflows, models, and settings — while keeping the legacy install as a backup.
- **Extra model paths:** Desktop writes its extra-model-paths config to a different location than manual installs — `%APPDATA%\Roaming\ComfyUI\extra_models_config.yaml` (Windows) or `~/Library/Application Support/ComfyUI/extra_models_config.yaml` (macOS), rather than `ComfyUI/extra_model_paths.yaml`.
- **Uninstall caveat:** removing the app (Windows Apps / Trash) deletes only the launcher. The `*-Installs`, `*-Shared`, and settings directories persist and must be deleted manually for a full removal.

### ComfyUI Portable (Windows)

The [portable build](https://docs.comfy.org/installation/comfyui_portable_windows) is a standalone 7z archive bundling ComfyUI with an embedded Python (`python_embeded`) — no separate Python install. GPU-specific downloads ship from GitHub releases (e.g., CUDA 13.0 / Python 3.13 for modern RTX, CUDA 12.6 / Python 3.12 for GTX 10-series and older; plus AMD ROCm and Intel variants).

Directory layout after extraction:
```
ComfyUI_windows_portable/
├── ComfyUI/              # the program
├── python_embeded/       # bundled Python
├── update/               # update scripts
├── run_nvidia_gpu.bat
└── run_cpu.bat
```

- **Run:** double-click `run_nvidia_gpu.bat` (or `run_amd_gpu.bat` / `run_intel_gpu.bat` / `run_cpu.bat`). Ready when the console prints `To see the GUI go to: http://127.0.0.1:8188`. The command window must stay open.
- **Update:** `update/update_comfyui.bat` (latest commit), `update_comfyui_stable.bat` (latest stable release), `update_comfyui_and_python_dependencies.bat` (repairs the embedded env).
- **LAN access:** edit the `.bat` to add `--listen` (alongside `--windows-standalone-build`), which binds `0.0.0.0:8188`.
- **Shared models:** copy `extra_model_paths.yaml.example` to `extra_model_paths.yaml` to point at models from a WebUI/other install; restart to apply.

### Manual install

Per the [manual install docs](https://docs.comfy.org/installation/manual_install), this is the most portable path (Windows/Linux/macOS) and the one with the most control:

1. Create an isolated environment (docs use Miniconda: `conda create -n comfyenv && conda activate comfyenv`).
2. `git clone https://github.com/Comfy-Org/ComfyUI.git`.
3. Install PyTorch for your backend:
   - **NVIDIA:** `pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130`
   - **AMD:** `pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm7.2`
   - **Apple Silicon:** `conda install pytorch-nightly::pytorch torchvision torchaudio -c pytorch-nightly`
4. `pip install -r requirements.txt`, then `python main.py`.

Update by `git pull` + re-running `pip install -r requirements.txt` inside the active venv. Windows users need the Microsoft Visual C++ Redistributable. Note the canonical repo is now `Comfy-Org/ComfyUI` (the `comfyanonymous/ComfyUI` repo remains the upstream the frontend defaults to via `--front-end-version comfyanonymous/ComfyUI@latest`).

### Server configuration — startup flags

All local channels run the same server and accept the same CLI args (run `python main.py --help`; full reference at [Startup Flags](https://docs.comfy.org/development/comfyui-server/startup-flags), source of truth `comfy/cli_args.py`). The server defaults to `http://127.0.0.1:8188`. Flags that matter most for deployment/distribution:

- **Networking:** `--listen [IP]` (default `127.0.0.1`; bare flag = all interfaces), `--port` (default `8188`), `--tls-keyfile` / `--tls-certfile` (HTTPS), `--enable-cors-header [ORIGIN]`, `--max-upload-size`.
- **Directories (key for shared-resource setups):** `--base-directory` (one root for models/custom_nodes/input/output), `--output-directory`, `--input-directory`, `--temp-directory`, `--user-directory`, `--extra-model-paths-config`.
- **Headless/server:** `--disable-auto-launch` (don't open a browser), `--multi-user` (per-user storage), `--dont-print-server`, `--windows-standalone-build` (portable convenience).
- **VRAM modes (mutually exclusive):** `--gpu-only`, `--highvram`, `--normalvram`, `--lowvram`, `--novram`, `--cpu`, plus `--reserve-vram`.
- **Custom node control:** `--disable-all-custom-nodes`, `--whitelist-custom-nodes`, `--enable-manager` / `--disable-manager-ui`, `--disable-api-nodes` (cuts all internet communication from API nodes).

### comfy-cli — install/launch automation

[comfy-cli](https://docs.comfy.org/comfy-cli/getting-started) (`pip install comfy-cli`, or `brew install comfy-org/comfy-cli/comfy-cli`) scripts the local-install lifecycle and can also call hosted partner nodes without a running ComfyUI:
- `comfy install` (needs a Python 3.9+ env; you supply CUDA/ROCm), `comfy launch`.
- `comfy node install <NAME>` (custom nodes, via cm-cli), `comfy model download --url <url> --relative-path models/checkpoints`.
- `comfy generate <model-alias>` (beta) to hit hosted partner endpoints (Flux, DALL·E, Stability, Runway, …) directly from the shell.

### Comfy Cloud — browser-hosted runtime

[Comfy Cloud](https://comfy.org/cloud/) (out of beta as of March 2026, per the [announcement](https://blog.comfy.org/p/comfy-cloud-is-out-of-beta-and-its)) runs the same ComfyUI workflow engine in the browser with **no local install or GPU**. This is the most distinct channel — different hardware, different billing, different constraints from any local distribution.

- **Hardware:** NVIDIA Blackwell **RTX 6000 Pro** GPUs, **96 GB VRAM**, **180 GB RAM** — sized for heavy video/upscaling/multi-model pipelines that local consumer GPUs can't hold.
- **Billing:** pay only for **active GPU time while a workflow runs** — building, parameter tweaking, and idle time are free. Credit model (~211 credits = 1 USD; ~0.39 credits/sec of run time). Plans include a free tier plus paid tiers for longer runtimes, more API-node credits, and team billing. Top-up credits are valid 1 year and don't roll over with monthly plans.
- **Custom nodes & models:** the most-used community custom nodes (covering ~90% of local workflows) are preloaded with no setup; built-in access to open models (Qwen, LTX 2, Hunyuan) and closed models / partner nodes (Nano Banana 2, Veo, Sora, Kling 3.0, Grok). **Bring-your-own LoRAs** via HuggingFace/Civitai integration or direct upload.
- **Constraints vs local:** not every custom node is available; local-filesystem patterns don't translate (e.g., writing/reading arbitrary text files for nodes like TextLoadFile, and controlling output filenames, are limited compared to a local install). Always requires connectivity.

### Choosing a channel

- **Desktop** — easiest GUI path with a built-in updater; the only channel with native multi-instance management and a shared model/output library across instances; legacy-migration support. Windows or Apple Silicon Mac only.
- **Portable** — Windows-only, zero-Python-setup, fully self-contained; good for a single quick local instance or a USB-portable setup.
- **Manual** — maximum control and the only first-class path on Linux and Intel Macs; required for server/headless deployments where you script startup flags.
- **comfy-cli** — automation/CI and reproducible installs; thin wrapper over the manual flow plus hosted generation.
- **Comfy Cloud** — no local hardware, big-VRAM GPUs on demand, pay-per-run; best for heavy video/multi-model work or running the same pipeline anywhere, at the cost of filesystem flexibility and full custom-node coverage.

---

## <a id="manager-model-node-management"></a>ComfyUI Manager & Model/Node Management Infrastructure

This is the first-party ecosystem plumbing that end users rely on to *install, update, and reproduce* workflows — distinct from authoring custom nodes. It spans three tools (ComfyUI-Manager, `cm-cli`, and `comfy-cli`), the Comfy Registry backend, and the on-disk model layout that loader nodes read from.

### The three layers

| Layer | What it is | Canonical home |
|---|---|---|
| **ComfyUI-Manager** | The in-app GUI extension for installing/updating/disabling/uninstalling custom nodes and models, snapshot management, and missing-node detection on workflow load. | `github.com/ltdrdata/ComfyUI-Manager` |
| **`cm-cli`** | Manager's own headless CLI (`python cm-cli.py …`) for performing every Manager operation without launching the ComfyUI GUI. | `ComfyUI-Manager/docs/en/cm-cli.md` |
| **`comfy-cli`** | The official Comfy-Org CLI (`pip install comfy-cli`). `comfy install` bootstraps ComfyUI + Manager together; its `comfy node …` subcommands wrap `cm-cli` under the hood. | `docs.comfy.org/comfy-cli` |
| **Comfy Registry** | The public backend database of published custom nodes (`registry.comfy.org`) that powers Manager's catalog, versioning, and security scanning. | `docs.comfy.org/registry/overview` |

### Installing ComfyUI-Manager

Per the project README, four supported paths — the recommended one is the official CLI:

- **comfy-cli (recommended):** `pip install comfy-cli` then `comfy install` (installs ComfyUI and Manager together).
- **Git:** `git clone https://github.com/ltdrdata/ComfyUI-Manager comfyui-manager` into `ComfyUI/custom_nodes`.
- **Portable Windows:** run `install-manager-for-portable-version.bat`.
- **Linux venv:** `install-comfyui-venv-linux.sh`.

Path requirement is strict: the folder must be `ComfyUI/custom_nodes/comfyui-manager` — not `ComfyUI-Manager-main` or a nested directory. As of **v3.3.2** Manager officially integrates `https://registry.comfy.org/` as its backend, and the Desktop build ships a **New UI** Manager by default (the older interface is the **Legacy UI**).

### Custom-node management via the Manager GUI

- **Install Custom Nodes** dialog lists catalog nodes with status `Installed` / `Install` / `Try Install`; conflicted nodes show a yellow background, non-default-channel nodes a red background.
- **Install Missing Custom Nodes** scans the loaded workflow and offers to install any extension whose nodes aren't present — the core "I opened someone's workflow and half the nodes are red" recovery path.
- Manager understands several repo-level files when installing: `pyproject.toml` (the registry spec file), `node_list.json` (manual node listing for non-standard repos), `requirements.txt` (auto-`pip install`ed), and `install.py` (auto-executed on install).
- A **restart** of ComfyUI is required for newly installed nodes to register.

### Security levels and install gating

Manager classifies operations by risk and gates them through `security_level` in `config.ini`:

| `security_level` | Behavior |
|---|---|
| `strong` | Blocks high- and middle-risk features |
| `normal` | Blocks high-risk only; allows middle-risk |
| `normal-` | Blocks high-risk only when `--listen` is bound to a non-`127.x` address |
| `weak` | All features available |

Risk tiers: **High** = downloading non-`safetensors` models not in the default channel; **Middle** = uninstall/update, default-channel node install, fix nodes, snapshots, restart; **Low** = updating ComfyUI itself.

Two install paths are decoupled from `security_level` via dedicated booleans under `[default]`, both defaulting to `false` and effective only on loopback (`127.x`):

- `allow_git_url_install` — enables "Install via Git URL" and batch installs of repos not in the catalog.
- `allow_pip_install` — enables the standalone pip-install feature.

### Network modes and database channels

`network_mode` in `config.ini` controls outbound access:

- `public` — normal public-network use.
- `private` — closed network using a private node DB via `channel_url` (cache-backed).
- `offline` — no external connections (cache only).

The catalog DB is fetched per a channel mode selectable in the UI: `DB: Channel (1day cache)` (default; refreshes on cache expiry), `DB: Local` (Manager's bundled data, refreshed only with Manager updates), and `DB: Channel (remote)` (always fetch latest). **Fetch Updates** pulls update metadata; the **Update** button applies it. Useful environment variables: `COMFYUI_PATH`, `GITHUB_ENDPOINT` and `HF_ENDPOINT` (reverse-proxy mirrors for GitHub / Hugging Face).

The `config.ini` itself lives in a protected path: `<USER_DIRECTORY>/__manager/` on ComfyUI v0.3.76+ (older builds used `<USER_DIRECTORY>/default/ComfyUI-Manager/`). Companion files in that directory include `channels.list`, `pip_overrides.json`, `pip_blacklist.list`, and `pip_auto_fix.list`.

### Snapshots — reproducing an environment

Manager can capture the full installed-node + pip state as a **snapshot** (stored under `<USER_DIRECTORY>/default/ComfyUI-Manager/snapshots`). **Restore** doesn't act immediately; it writes `startup-scripts/restore-snapshot.json`, which is applied on the next ComfyUI startup and then auto-deleted. This is the mechanism that lets a workflow's exact node set be rebuilt on a fresh machine.

### `cm-cli` — Manager without the GUI

Run as `python cm-cli.py [OPTIONS]`. Core verbs operate on named nodes or the `all` selector:

```
python cm-cli.py [install|reinstall|uninstall|update|disable|enable|fix] <node_name> ... \
  [--channel <name>] [--mode remote|local|cache]
python cm-cli.py update all --channel recent --mode remote
```

Inspection and snapshot/dependency operations:

- `show` / `simple-show` with a selector: `installed`, `enabled`, `disabled`, `not-installed`, `all`, `snapshot`, `snapshot-list`.
- `save-snapshot [--output <file.json|.yaml>]`.
- `restore-snapshot <file> [--pip-non-url] [--pip-non-local-url] [--pip-local-url] [--user-directory] [--restore-to]` (the `--pip-*` flags select which classes of pip packages to restore).
- `restore-dependencies` — reinstall deps when nodes are present but their packages are missing (the standard fix for cloud/ephemeral instances).
- `cli-only-mode [enable|disable]` and `clear` (cancels scheduled install/update/restore operations).

### `comfy-cli` — the official wrapper

`comfy node …` mirrors `cm-cli` (and calls it internally): `install`, `update`, `uninstall`, `reinstall`, `enable`, `disable`, `fix`, plus `show` / `simple-show` taking the same selectors. The dependency-from-workflow commands are the headline reproducibility feature:

- `comfy node deps-in-workflow --workflow <wf.json|.png> --output <file>` — extract the node dependencies a workflow needs (works on a PNG with embedded workflow metadata).
- `comfy node install-deps [--deps <file.json>] [--workflow <wf.json|.png>]` — install everything a workflow requires.
- `comfy node restore-dependencies`, `comfy node save-snapshot [--output …]`, `comfy node restore-snapshot <PATH>`.

### Model asset management

ComfyUI discovers models by **type-keyed subfolder** under `ComfyUI/models/`. Loader nodes (named "Load…") read the dropdown contents from the matching folder. Standard subfolders:

| Subfolder | Holds |
|---|---|
| `checkpoints/` | Main diffusion checkpoints |
| `loras/` | LoRA weights |
| `vae/` | VAE models |
| `controlnet/` | ControlNet models |
| `clip/` | CLIP text encoders |
| `clip_vision/` | CLIP vision models |
| `embeddings/` | Textual-inversion embeddings |
| `upscale_models/` | ESRGAN/RealESRGAN/SwinIR upscalers |
| `diffusion_models/` (a.k.a. `unet/`) | Standalone UNet/diffusion models |
| `hypernetworks/`, `gligen/`, `configs/` | Hypernetworks, GLIGEN, config files |

Workflow: drop the file into the right subfolder, add the loader node, pick the model from its dropdown. If files were added while ComfyUI was running, **restart** or press **`r`** to refresh the lists.

**Downloading models** from the CLI:

```
comfy model download --url <url> --relative-path models/checkpoints
comfy model list   [--relative-path models/checkpoints]
comfy model remove [--relative-path …] [--model-names "<file1> <file2>"]
```

Manager also exposes an **Install Models** dialog (same DB-mode controls as the node installer) for pulling catalog models into the correct folder.

### Sharing model folders across installs — `extra_model_paths.yaml`

To avoid duplicating large weights, ComfyUI reads extra search roots from a YAML config (copy `extra_model_paths.yaml.example` → `ComfyUI/extra_model_paths.yaml` for portable/manual installs). Desktop uses `extra_models_config.yaml` under the platform app-data dir (`%APPDATA%\ComfyUI\` on Windows, `~/Library/Application Support/ComfyUI/` on macOS), editable via a menu item.

```yaml
my_custom_config:
    base_path: YOUR_PATH
    checkpoints: models/checkpoints/
    loras: |
        models/Lora
        models/LyCORIS        # pipe notation = multiple search paths per type
my_custom_nodes:
    custom_nodes: /path/to/extra_custom_nodes   # extra node search dir (not the default install path)
```

This is the standard way to share a single model library with Automatic1111/Forge. Changes require a ComfyUI restart; on Desktop, *add to* existing paths rather than overwriting them.

### The Comfy Registry — versioning and security

The Registry is the public, semver-versioned node database that Manager queries. Because **a published version is immutable** and **workflow JSON records the node version used**, a saved workflow can be reproduced reliably; publishers can deprecate or lock versions (deprecation surfaces an upgrade prompt to users). Each node has a **globally unique name**, so workflow files reference custom nodes without collisions.

Publishing flow (`comfy-cli`):

1. `comfy node init` — scaffold metadata into `pyproject.toml`.
2. Fill `pyproject.toml`: `[project]` `name` (unique, immutable), `version` (semver, e.g. `"1.0.0"`), `description`, `license`, `dependencies` (auto-filled from `requirements.txt`), `[project.urls]`; and `[tool.comfy]` `PublisherId` (the `@handle`, immutable), `DisplayName`, `Icon` (SVG/PNG/JPG/GIF, max 800×400).
3. `comfy node publish` — prompts for the API key (generated at `registry.comfy.org`), packages git-tracked files (refined by a `.gitignore`-style `.comfyignore` plus `[tool.comfy].includes`).
4. **GitHub Action** `Comfy-Org/publish-node-action@main` (in `.github/workflows/publish_action.yml`, secret `REGISTRY_ACCESS_TOKEN`) auto-publishes when `version` bumps on `main`.

**Security scanning** (per the Registry standards): submissions are rejected for `eval`/`exec` (RCE risk), `subprocess`-based runtime pip installs (deps must go through Manager to prevent supply-chain attacks), and code obfuscation. Verified nodes get a check-icon flag in Manager; forks must use clearly distinct names and offer real functional differences.

---

## Glossary

### Glossary

- **Node** — A single typed operation in the graph (load a model, encode a prompt, sample). Has typed inputs and outputs; the basic unit you wire together.
- **Workflow** — The node graph itself, treated as a portable, reproducible artifact. Saveable as JSON and often embeddable inside its own output media.
- **DAG (directed acyclic graph)** — The shape of a workflow; the execution engine resolves topology over this and runs nodes in dependency order.
- **KSampler** — The core denoising node: takes a model, conditioning, and a latent, and iteratively denoises it over N steps with a chosen sampler/scheduler.
- **Latent** — The compressed tensor representation the sampler works in. Images are encoded into latent space by the VAE and decoded back out after sampling.
- **VAE (Variational Auto-Encoder)** — Encodes pixels into latent space and decodes latents back to pixels; the bridge between the image you see and the tensor the sampler edits.
- **Checkpoint** — A packaged model file bundling the UNet (diffusion model), CLIP (text encoder), and usually a VAE; loaded as the starting point of the image pipeline.
- **CLIP / Text Encode** — The text encoder; the `CLIP Text Encode (Prompt)` node turns a prompt into a `CONDITIONING` tensor.
- **CONDITIONING** — A first-class ComfyUI data type (its own wire color) carrying the steering signal; most control techniques are transformations of a conditioning tensor.
- **ControlNet** — A conditioning adapter that steers generation from a structural input (pose, depth, edges, etc.) rather than text alone.
- **IP-Adapter** — An image-prompt adapter that injects visual reference (style/subject from an image) into conditioning.
- **LoRA (Low-Rank Adaptation)** — A small add-on weight patch applied to a base model to shift style or subject; stackable in core nodes.
- **Weight adapter** — The core mechanism (in `comfy/weight_adapter/`) for applying LoRA-style and related low-rank patches to model weights.
- **Model merging** — Combining two or more checkpoints/models (block- or weight-level) into a new model via core surgery nodes.
- **Widget** — An inline input control on a node (slider, dropdown, text field, seed) for values not supplied by a wire.
- **Reroute** — A pass-through node used purely to redirect/organize wires for graph readability; carries no logic.
- **Bypass** — A node state that disables a node's effect while leaving it in the graph, passing input through so you can A/B steps without deleting them.
- **Subgraph** — A reusable group of nodes packaged as a single collapsible unit, letting a workflow nest a sub-pipeline as one node.
- **Node expansion** — An execution-engine feature where a node returns a new sub-graph at runtime, expanding into additional nodes during execution.
- **ExecutionBlocker** — An engine sentinel a node can output to halt propagation down a branch, pruning downstream execution for that path.
- **IS_CHANGED** — The cache key a node declares so the engine knows whether its inputs changed; unchanged nodes are skipped on re-run.
- **Lazy evaluation** — The engine only evaluates inputs a node actually needs, skipping computation for branches whose outputs are unused.
- **Queue** — The run-management surface where workflows are enqueued, batched, prioritized, and cancelled.
- **History** — The record of past runs you can inspect and replay from the run-control UX.
- **Templates** — A shipped library of starter workflows loadable directly into the canvas.
- **API (workflow) format** — The graph serialized in the prompt-execution JSON shape used by the HTTP/WebSocket API, distinct from the richer UI JSON shape.
- **API node / Partner node** — An opt-in, account-gated node (in `comfy_api_nodes/`) that calls a closed-source hosted model, metered by credits.
- **Credits** — The metered currency consumed by API/Partner nodes; the account layer that sits above the free local boundary.
- **Comfy Cloud** — The optional hosted runtime that runs the same workflow JSON without a local install.
- **The Registry (Comfy Registry)** — The first-party backend for publishing and distributing custom nodes; the source ComfyUI-Manager and `comfy-cli` install from.
- **ComfyUI-Manager** — The in-app tool for installing, updating, and reproducing custom nodes and models.
- **comfy-cli / cm-cli** — Command-line tools for managing ComfyUI installs, nodes, and models (`comfy-cli` is the general CLI; `cm-cli` is the Manager's CLI).
- **`app.registerExtension`** — The JavaScript frontend extension entry point for adding UI, hooks, and behavior to the editor.
- **io.Schema (V3 node API)** — The newer typed Python node-authoring API, succeeding the V1 dict-based contract for defining custom nodes.
- **MCP (Model Context Protocol)** — The surface that exposes ComfyUI as callable tools so an AI agent can drive the graph programmatically.
- **LiteGraph.js** — The Comfy-Org fork of litegraph.js that historically rendered the node canvas, now driven by the Vue/TypeScript frontend.

---

## Sources (canonical only)

- https://blenderneko.github.io/ComfyUI-docs/Interface/Textprompts/
- https://blog.comfy.org/p/comfy-cloud-is-out-of-beta-and-its
- https://blog.comfy.org/p/comfy-cloud-new-features-and-pricing
- https://blog.comfy.org/p/comfy-raises-17m-funding
- https://blog.comfy.org/p/comfyui-0363-subgraph-publishing
- https://blog.comfy.org/p/comfyui-0366-updates
- https://blog.comfy.org/p/comfyui-api-nodes-wave-2-is-live
- https://blog.comfy.org/p/comfyui-native-api-nodes
- https://blog.comfy.org/p/comfyui-node-2-0
- https://blog.comfy.org/p/comfyui-raises-30m-to-scale-open
- https://blog.comfy.org/p/dependency-resolution-and-custom
- https://blog.comfy.org/p/free-tier-arrives-in-comfy-cloud
- https://blog.comfy.org/p/subgraph-official-release
- https://comfy.org/cloud/
- https://comfy.org/cloud/pricing/
- https://comfy.org/download
- https://comfy.org/p/supported-models/
- https://comfyanonymous.github.io/ComfyUI_examples/
- https://comfyanonymous.github.io/ComfyUI_examples/3d/
- https://comfyanonymous.github.io/ComfyUI_examples/area_composition/
- https://comfyanonymous.github.io/ComfyUI_examples/audio/
- https://comfyanonymous.github.io/ComfyUI_examples/controlnet/
- https://comfyanonymous.github.io/ComfyUI_examples/cosmos/
- https://comfyanonymous.github.io/ComfyUI_examples/gligen/
- https://comfyanonymous.github.io/ComfyUI_examples/inpaint/
- https://comfyanonymous.github.io/ComfyUI_examples/mochi/
- https://comfyanonymous.github.io/ComfyUI_examples/model_merging/
- https://comfyanonymous.github.io/ComfyUI_examples/unclip/
- https://comfyanonymous.github.io/ComfyUI_examples/video/
- https://docs.comfy.org/
- https://docs.comfy.org/built-in-nodes/CosmosPredict2ImageToVideoLatent
- https://docs.comfy.org/built-in-nodes/KSampler
- https://docs.comfy.org/built-in-nodes/Load3D
- https://docs.comfy.org/built-in-nodes/Load3DAnimation
- https://docs.comfy.org/built-in-nodes/LoraLoader
- https://docs.comfy.org/built-in-nodes/LoraLoaderModelOnly
- https://docs.comfy.org/built-in-nodes/MarkdownNote
- https://docs.comfy.org/built-in-nodes/Preview3D
- https://docs.comfy.org/built-in-nodes/Preview3DAnimation
- https://docs.comfy.org/built-in-nodes/SamplerCustomAdvanced
- https://docs.comfy.org/built-in-nodes/SaveAudio
- https://docs.comfy.org/built-in-nodes/sampling/ksampler
- https://docs.comfy.org/changelog
- https://docs.comfy.org/comfy-cli/getting-started
- https://docs.comfy.org/comfy-cli/reference
- https://docs.comfy.org/custom-nodes/backend/datatypes
- https://docs.comfy.org/custom-nodes/backend/expansion
- https://docs.comfy.org/custom-nodes/backend/lazy_evaluation
- https://docs.comfy.org/custom-nodes/backend/more_on_inputs
- https://docs.comfy.org/custom-nodes/backend/server_overview
- https://docs.comfy.org/custom-nodes/js/javascript_about_panel_badges
- https://docs.comfy.org/custom-nodes/js/javascript_bottom_panel_tabs
- https://docs.comfy.org/custom-nodes/js/javascript_commands_keybindings
- https://docs.comfy.org/custom-nodes/js/javascript_dialog
- https://docs.comfy.org/custom-nodes/js/javascript_hooks
- https://docs.comfy.org/custom-nodes/js/javascript_objects_and_hijacking
- https://docs.comfy.org/custom-nodes/js/javascript_overview
- https://docs.comfy.org/custom-nodes/js/javascript_settings
- https://docs.comfy.org/custom-nodes/js/javascript_toast
- https://docs.comfy.org/custom-nodes/js/javascript_topbar_menu
- https://docs.comfy.org/custom-nodes/subgraph_blueprints
- https://docs.comfy.org/custom-nodes/v3_migration
- https://docs.comfy.org/custom-nodes/walkthrough
- https://docs.comfy.org/development/api-development/workflow-api-format
- https://docs.comfy.org/development/cloud/mcp-server
- https://docs.comfy.org/development/comfyui-server/api-key-integration
- https://docs.comfy.org/development/comfyui-server/comms_messages
- https://docs.comfy.org/development/comfyui-server/comms_overview
- https://docs.comfy.org/development/comfyui-server/comms_routes
- https://docs.comfy.org/development/comfyui-server/startup-flags
- https://docs.comfy.org/development/core-concepts/links
- https://docs.comfy.org/development/core-concepts/models
- https://docs.comfy.org/development/core-concepts/nodes
- https://docs.comfy.org/development/core-concepts/workflow
- https://docs.comfy.org/get_started/cloud
- https://docs.comfy.org/installation/comfyui_portable_windows
- https://docs.comfy.org/installation/desktop/macos
- https://docs.comfy.org/installation/desktop/windows
- https://docs.comfy.org/installation/install_custom_node
- https://docs.comfy.org/installation/manual_install
- https://docs.comfy.org/interface/credits
- https://docs.comfy.org/interface/features/partial-execution
- https://docs.comfy.org/interface/features/subgraph
- https://docs.comfy.org/interface/features/template
- https://docs.comfy.org/interface/maskeditor
- https://docs.comfy.org/interface/nodes-2
- https://docs.comfy.org/interface/overview
- https://docs.comfy.org/interface/settings/comfy
- https://docs.comfy.org/interface/settings/lite-graph
- https://docs.comfy.org/interface/shortcuts
- https://docs.comfy.org/interface/user
- https://docs.comfy.org/registry/overview
- https://docs.comfy.org/registry/publishing
- https://docs.comfy.org/registry/specifications
- https://docs.comfy.org/registry/standards
- https://docs.comfy.org/specs/workflow_json
- https://docs.comfy.org/tutorials/3d/hunyuan3D-2
- https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1
- https://docs.comfy.org/tutorials/basic/image-to-image
- https://docs.comfy.org/tutorials/controlnet/depth-t2i-adapter
- https://docs.comfy.org/tutorials/partner-nodes/overview
- https://docs.comfy.org/tutorials/partner-nodes/pricing
- https://docs.comfy.org/tutorials/video/hunyuan/hunyuan-video
- https://docs.comfy.org/tutorials/video/ltxv
- https://docs.comfy.org/tutorials/video/wan/wan2_2
- https://github.com/Comfy-Org/ComfyUI-Manager
- https://github.com/Comfy-Org/ComfyUI-React-Extension-Template
- https://github.com/Comfy-Org/ComfyUI/blob/master/extra_model_paths.yaml.example
- https://github.com/Comfy-Org/ComfyUI_frontend
- https://github.com/Comfy-Org/ComfyUI_frontend/issues/5391
- https://github.com/Comfy-Org/ComfyUI_frontend/issues/5394
- https://github.com/Comfy-Org/comfy-cli
- https://github.com/Comfy-Org/comfy-cli/blob/main/README.md
- https://github.com/Comfy-Org/comfy-cloud-mcp
- https://github.com/Comfy-Org/litegraph.js
- https://github.com/Comfy-Org/workflow_templates
- https://github.com/MrForExample/ComfyUI-3D-Pack
- https://github.com/NVlabs/Sana/blob/main/asset/docs/ComfyUI/comfyui.md
- https://github.com/artokun/comfyui-mcp
- https://github.com/city96/ComfyUI_ExtraModels
- https://github.com/comfyanonymous/ComfyUI
- https://github.com/comfyanonymous/ComfyUI/blob/master/LICENSE
- https://github.com/comfyanonymous/ComfyUI/blob/master/README.md
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy/cli_args.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy/comfy_types/node_typing.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy/samplers.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_custom_sampler.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_flux.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_model_advanced.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_sd3.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/nodes.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/requirements.txt
- https://github.com/comfyanonymous/ComfyUI/commit/4650e7d
- https://github.com/comfyanonymous/ComfyUI/issues/10329
- https://github.com/comfyanonymous/ComfyUI/issues/5785
- https://github.com/comfyanonymous/ComfyUI/issues/9007
- https://github.com/comfyanonymous/ComfyUI/pull/2666
- https://github.com/comfyanonymous/ComfyUI/pull/931
- https://github.com/comfyanonymous/ComfyUI/tree/master/comfy_api_nodes
- https://github.com/comfyanonymous/ComfyUI_examples/blob/master/textual_inversion_embeddings/README.md
- https://github.com/comfyanonymous/ComfyUI_experiments
- https://github.com/cubiq/ComfyUI_IPAdapter_plus/blob/main/NODES.md
- https://github.com/joenorton/comfyui-mcp-server
- https://github.com/jonpojonpo/comfy-ui-mcp-server
- https://github.com/kijai/ComfyUI-CogVideoXWrapper
- https://github.com/ltdrdata/ComfyUI-Manager/blob/main/README.md
- https://github.com/ltdrdata/ComfyUI-Manager/blob/main/docs/en/cm-cli.md
- https://raw.githubusercontent.com/Comfy-Org/comfy-cloud-mcp/main/README.md
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/README.md
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy/cldm/control_types.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy/cli_args.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy/lora.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy/samplers.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy/weight_adapter/__init__.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_api/latest/_ui.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_execution/caching.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_execution/graph.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_execution/graph_utils.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_audio.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_clip_sdxl.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_controlnet.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_cosmos.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_flux.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_freelunch.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_hypernetwork.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_hypertile.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_lora_extract.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_mask.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_mochi.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_model_advanced.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_model_downscale.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_model_merging.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_model_merging_model_specific.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_pag.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_perpneg.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_sag.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_stable3d.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_tomesd.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_torch_compile.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_upscale_model.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_video_model.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/execution.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/nodes.py
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/server.py
- https://raw.githubusercontent.com/cubiq/ComfyUI_IPAdapter_plus/main/README.md
- https://raw.githubusercontent.com/joenorton/comfyui-mcp-server/main/README.md
- https://www.comfy.org/

---

## Fact-check log

- **Overview & Philosophy:** Sampler list was stale/incomplete: the draft presented a sampler list as the canonical set but omitted entries present in current comfy/samplers.py. Added the missing samplers exp_heun_2_x0, exp_heun_2_x0_sde, dpmpp_2m_sde_heun_gpu, res_multistep_cfg_pp, res_multistep_ancestral, res_multistep_ancestral_cfg_pp, gradient_estimation_cfg_pp, and reproduced the full KSAMPLER_NAMES + ddim/uni_pc/uni_pc_bh2 list verbatim.
- **Overview & Philosophy:** Quote 'a job title in demand' corrected to the verbatim source wording 'a job title in high demand' (blog.comfy.org $30M post).
- **Overview & Philosophy:** The $17M seed round was attributed only loosely and implicitly to the cited $30M blog post, which does not contain it. Verified and re-sourced to the canonical blog.comfy.org/p/comfy-raises-17m-funding post: $17M announced September 16 2025, investors Pace Capital, Chemistry, Abstract Ventures (and Essence VC). Previously the draft gave no investor detail for the seed.
- **Overview & Philosophy:** KSampler input list in the draft omitted sampler_name and scheduler (it listed only model, positive, negative, latent_image, seed, steps, cfg, denoise). Corrected to the full documented required-input set including sampler_name and scheduler (docs.comfy.org/built-in-nodes/KSampler).
- **Overview & Philosophy:** Homepage production-user list expanded to match comfy.org, which lists more named companies (Amazon Studios, Apple, Autodesk, Netflix, Nike, Pixomondo, Tencent, Ubisoft) and the exact category labels (VFX & Animation; Advertising & Creative Studios; Gaming; eCommerce & Fashion). The draft's subset was accurate but partial.
- **Overview & Philosophy:** Removed the unverifiable claim that native model support 'typically lands in core within days of a model's release' and that the project 'reschedules around major model drops' — neither is stated in canonical sources. Kept the verified weekly-release-targeting-Monday and ~2-week-stable-version facts from the README.
- **Overview & Philosophy:** Softened/clarified the README hardware lines to match exact README wording: AMD is 'Experimental: Windows and Linux, RDNA 3, 3.5 and 4 only' (draft implied ROCm Windows was only experimental for RDNA 3/3.5/4); NVIDIA portable note (RTX 20+ main, 10-series/older via CUDA 12.6 portable) added from README. Cambricon MLU and Iluvatar Corex support confirmed present in README (draft was correct).
- **Overview & Philosophy:** Frontend-to-PyPI claim made specific and verified against requirements.txt: the published package is 'comfyui-frontend-package' (pinned in core requirements alongside comfyui-workflow-templates and comfyui-embedded-docs). Draft said the bundle is published to PyPI without naming the package.
- **Overview & Philosophy:** Desktop install row corrected: README/docs do not restrict desktop to Apple Silicon only — listed as Windows + macOS, beta. Removed the unverified 'no Linux prebuilds yet' and 'built from the stable core release' specifics that were not confirmed in the fetched canonical pages.
- **Overview & Philosophy:** Funding round detail corrected/expanded: the $30M round is led by Craft (with Pace Capital, Chemistry, TruArrow and others) per the canonical blog post; added announcement date April 24 2026 and the verbatim 'bringing our total funding to $47 million'.
- **Overview & Philosophy:** Adjusted founder framing to what is canonically verifiable: comfyanonymous as creator and Yannik Marek as a named cofounder (confirmed in the $30M blog post). Removed the unsupported characterization of it beginning strictly as a 'single-developer' repo (not stated in fetched sources).
- **Overview & Philosophy:** Added the docs' verbatim self-descriptions actually found on docs.comfy.org ('a node-based interface and inference engine for generative AI'; 'The most powerful open source node-based application for generative AI') and corrected the earlier loose paraphrase.
- **Execution Engine & Graph Model:** PR attribution was wrong: the draft said the execution inversion shipped via 'PR #931 ... merged ~Aug 2024.' PR #931 ('Node Expansion, While Loops, Components, and Lazy Evaluation', by guill) was CLOSED WITHOUT MERGING on 2024-01-29. The core engine inversion actually merged as PR #2666 ('Execution Model Inversion', guill, merged 2024-08-15). Corrected every reference, including the Version-stamping section.
- **Execution Engine & Graph Model:** ExecutionBlocker location was wrong: draft said it is 'in comfy_execution/graph'. It is defined in comfy_execution/graph_utils.py (line 140) and imported into execution.py. caching.py even carries the note that the code 'got moved to graph_utils.py'. Corrected.
- **Execution Engine & Graph Model:** The run loop was misattributed: draft said ExecutionList's 'main loop in execute (async)' drives the run. ExecutionList has no execute method; it provides stage_node_execution / complete_node_execution / unstage_node_execution. The actual loop is PromptExecutor.execute_async in execution.py, which dispatches on ExecutionResult (PENDING -> unstage, SUCCESS -> complete). Rewrote that bullet.
- **Execution Engine & Graph Model:** ExecutionBlocker attribute clarified: its only attribute is `message`. The draft's `r.block_execution` is a separate field on the V3 NodeOutput (not on ExecutionBlocker) — kept but disambiguated to avoid implying ExecutionBlocker has a block_execution attribute.
- **Execution Engine & Graph Model:** VALIDATE_INPUTS error-type list was incomplete/slightly off: the per-input error types in execution.py are required_input_missing, bad_linked_input, return_type_mismatch, custom_validation_failed, value_not_in_list (draft omitted bad_linked_input). Prompt-level errors also include exception_during_validation (added). All verified by grep against execution.py.
- **Execution Engine & Graph Model:** Cache-key class list: added the other real classes in caching.py (CacheKeySet base, Unhashable, NullCache) for accuracy and corrected RAMPressureCache description to 'extends LRUCache' with the actual 1.3x old-workflow OOM multiplier (RAM_CACHE_OLD_WORKFLOW_OOM_MULTIPLIER) and CPU-tensor RAM scoring, rather than the vaguer 'tensor size, age' phrasing.
- **Execution Engine & Graph Model:** Minor wording fixes: --cache-ram metavar is 'GB' and the flag belongs to a mutually-exclusive group named cache_group; the `front` flag works by negating `number` (priority), not literally 'insert at front' — clarified. /prompt success response actually includes node_errors alongside prompt_id and number (verified in server.py); added.
- **Execution Engine & Graph Model:** io.Schema field list completed to match the V3 migration Schema reference: added description, search_aliases, is_input_list, is_dev_only (draft was missing some); confirmed enable_expand IS a real Schema field (it is).
- **Execution Engine & Graph Model:** comfy_entrypoint clarified: docs say it 'can be either async or not' (draft implied it must be async); only get_node_list is required to be async. Corrected.
- **Execution Engine & Graph Model:** The blog 'dependency-resolution-and-custom' was over-credited: it is the Nodes-V3 proposal/announcement and does NOT document the topological-sort execution internals. Re-scoped its use to the V3 rationale (stable versioned API, parallel/out-of-process execution) only.
- **Execution Engine & Graph Model:** Async pending-task tracking detail corrected: unfinished tasks are tracked via execution_list.add_external_block(unique_id) (stored in pending_async_nodes), then awaited via resolve_map_node_over_list_results — draft's 'get_output_data returns a has_pending_tasks flag' was loosely stated; tightened to the actual mechanism.
- **Execution Engine & Graph Model:** Verified-correct claims left intact (no change needed): the /prompt body fields, all WebSocket message types and fields, the 'intentionally no way to stop ExecutionBlocker from propagating forward' quote (it IS on the Lazy Evaluation docs page), LoadImage.IS_CHANGED returning a SHA-256 hex digest, the cache flag defaults (active ~10% RAM min2/max10GB, inactive ~100% max96GB), --high-ram implying --cache-classic, the --cache-none/#10329 for-loop breakage, NOT_IDEMPOTENT appending node_id, lazy {'lazy':True}/check_lazy_status semantics, rawLink in Datatypes, and the asyncio.run RuntimeError gotcha (issue #9007).
- **Node Editor & Canvas UX:** litegraph repo stale: draft said the canvas was 'a fork maintained in Comfy-Org/litegraph.js'. That repo is now ARCHIVED; the fork was merged into the frontend monorepo at ComfyUI_frontend/src/lib/litegraph (published as @comfyorg/litegraph). Corrected.
- **Node Editor & Canvas UX:** Subgraph Support version wrong: draft said 'Subgraph Support landed in v0.3.61 (Sep 30 2025)'. The changelog and comfy.org blog ('ComfyUI 0.3.51: Subgraph, New Manager UI, Mini Map and More') put Subgraph Support in v0.3.51 (Aug 20 2025). Corrected, and added the canonical frontend requirement (1.24.3+).
- **Node Editor & Canvas UX:** 'Create Video' template claim wrong: draft said v0.3.76 (Dec 2 2025) 'added a Create Video entry to the essentials tab'. The verbatim v0.3.76 changelog does NOT contain 'Create Video'; that entry was added in a 2026 release (~v0.21.x, May 2026). Removed the false v0.3.76 attribution.
- **Node Editor & Canvas UX:** Clear-graph shortcut wrong: draft said 'Ctrl + Delete/Backspace clears the whole graph'. The shortcuts doc lists 'Clear workflow' as plain Backspace (Delete/Backspace deletes selected nodes; Backspace with nothing relevant selected clears the workflow). Corrected.
- **Node Editor & Canvas UX:** Lifecycle badge overclaim: draft listed a 'life-cycle badge' as a visible node-anatomy badge with mode setting None/Hide built-in/Show all. The core-concepts/nodes page documents only Node ID and Node source badges; only the Node SOURCE badge mode setting is documented with the None/Hide built-in/Show all options. A 'Node life cycle badge mode' SETTING exists on the lite-graph settings page (default Show all). Reworded to attribute these correctly.
- **Node Editor & Canvas UX:** Subgraph Publish frontend requirement clarified: confirmed v0.3.63 (Oct 6 2025) but added the canonical frontend requirement (1.27.7+ for publishing) and replaced the draft's vague 'frontend ~v0.3.51 era' unpack-version note with the canonical statement that subgraph requires frontend 1.24.3+ and unpack is via right-click / selection toolbox.
- **Node Editor & Canvas UX:** Subgraph Publish/Toolbox Redesign date confirmed as v0.3.63 (Oct 6 2025) against the comfy.org blog title 'ComfyUI 0.3.63: Subgraph Publishing, Selection Toolbox Redesign' (one WebFetch pass erroneously reported v0.3.62; verified the correct value is v0.3.63).
- **Node Editor & Canvas UX:** Minor wording aligned to canonical labels: 'Add frame to selection' for Ctrl+G (docs wording), 'Edit or mask image' overlay button name, exact setting label 'Pointer click drift (maximum distance)' and 'Double click interval (maximum)', and added value ranges (group padding 0-100, low-quality threshold 0.1-1.0, max FPS 0-120) from the lite-graph settings page.
- **Node Editor & Canvas UX:** Framed v0.3.x stamps as ComfyUI release/changelog versions (the docs.comfy.org changelog tracks bundled-ComfyUI releases) while keeping the separate frontend version numbers (1.24.3 / 1.27.7) that the subgraph feature docs use, since the draft conflated the two numbering schemes under 'frontend vX'.
- **Image Generation Pipeline:** DiffusersLoader: draft presented it as a normal loader; canonical nodes.py marks it DEPRECATED (DEPRECATED = True). Corrected, and changed its input label to model_path.
- **Image Generation Pipeline:** CLIPLoader type enum was incomplete/stale: draft listed a subset ending in 'flux2, and others'. Replaced with the verbatim current enum from nodes.py, which now also includes ovis, longcat_image, cogvideox, lens, pixeldit, ideogram4, boogu.
- **Image Generation Pipeline:** DualCLIPLoader type enum was incomplete: draft listed 'sdxl, sd3, flux, hunyuan_video, hidream, hunyuan_image, ltxv, ace, and others'. Replaced with verbatim current enum: sdxl, sd3, flux, hunyuan_video, hidream, hunyuan_image, hunyuan_video_15, kandinsky5, kandinsky5_image, ltxv, newbie, ace.
- **Image Generation Pipeline:** DualCFGGuider: draft omitted the 'style' input (options regular/nested) present in the canonical node. Added it.
- **Image Generation Pipeline:** README model-support claims overstated: draft listed specific Flux variants (dev/schnell/Fill/Canny/Redux/Kontext) and HiDream I1/E1.1/O1 and 'Qwen Image (incl. Edit / Layered)' and 'Flux 2 (incl. Klein)' as if verbatim from the README. The README bullets name them generically ('Flux', 'Flux 2', 'HiDream', 'Qwen Image') and list editing models (Omnigen 2, Flux Kontext, HiDream E1.1, Qwen Image Edit) in a separate section. 'Qwen Image Layered' is not in the README. Z Image and Ernie Image confirmed present. Rewrote the section to match the README's actual structure and moved sub-variants to the supported-models page / Templates browser. Also corrected the README NOTE quote to the exact wording.
- **Image Generation Pipeline:** SANA attribution to issue #5785 was incorrect: #5785 is only a feature request providing model facts (DC-AE 32x latent, Gemma2-2B-IT). It does NOT state that SANA requires ComfyUI_ExtraModels or that 'only Flow-Euler KSampling is wired up'. Re-sourced: ExtraModels (city96) supports DiT/PixArt/HunYuanDiT/MiaoBi; SANA support lives in forks (Efficient-Large-Model/lawrence-cj) and is being refactored. Removed the unverifiable 'only Flow-Euler' claim and fixed the citation boundaries.
- **Image Generation Pipeline:** Kolors/ExtraModels section: draft's 'HunYuanDiT (legacy path)' phrasing and DC-AE wording cleaned up; clarified that PixArt and HunyuanDiT now have core paths per the README so ExtraModels is mainly for models core hasn't absorbed.
- **Image Generation Pipeline:** Added confirmed defaults that the draft left vague: scale_by 1.5, blend_factor 0.5, ModelSamplingStableCascade shift 2.0, RescaleCFG multiplier 0.7, EmptyFlux2LatentImage defaults 1024x1024x1, CLIPTextEncodeFlux guidance default 3.5, CLIPTextEncodeSD3 empty_padding options (none/empty_prompt), SkipLayerGuidanceSD3 input list. None contradicted the draft; they fill verified detail.
- **Image Generation Pipeline:** 'ddim is implemented as euler with random inpaint options' was slightly imprecise; replaced with the exact code form ksampler('euler', inpaint_options={'random': True}).
- **Image Generation Pipeline:** Noted the two extra custom-sampler nodes confirmed present in canonical source (CFGOverride, DualModelGuider) that the draft did not mention.
- **Conditioning & Structural Control:** Category namespace was wrong throughout. The draft repeatedly claimed conditioning nodes live under 'conditioning/' and stated 'which is why they appear under the conditioning/ node category.' Canonical nodes.py shows the namespace is 'model/conditioning/...': CLIPTextEncode/CLIPVisionEncode/unCLIPConditioning/InpaintModelConditioning are 'model/conditioning'; Combine/Average/Concat/ZeroOut/SetArea/SetAreaPercentage/SetMask/SetTimestepRange are 'model/conditioning/transform'; ControlNet apply/union/AliMama nodes are 'model/conditioning/controlnet'; GLIGENTextBoxApply is 'model/conditioning/gligen'. Rewrote the intro and tagged every node with its real category.
- **Conditioning & Structural Control:** Loader categories were unstated/implied wrong. ControlNetLoader, DiffControlNetLoader, GLIGENLoader, unCLIPCheckpointLoader are all 'model/loaders' (not bare 'loaders'); added explicitly.
- **Conditioning & Structural Control:** SDXL text-encode node display names were wrong. Draft said 'CLIP Text Encode SDXL' / 'CLIP Text Encode SDXL Refiner'; canonical display names are 'CLIP Text Encode (SDXL)' (class CLIPTextEncodeSDXL) and 'CLIP Text Encode (SDXL Refiner)' (class CLIPTextEncodeSDXLRefiner), category 'model/conditioning/stable diffusion'. Added exact param list (text_g/text_l, width/height/crop_w/crop_h/target_width/target_height defaults; refiner ascore default 6.0).
- **Conditioning & Structural Control:** Area-composition second-pass claim was unsupported/overstated. Draft asserted 'A common pattern is area-prompting on the first pass, then a second pass without area prompts (lower denoise) so SD harmonizes the seams.' The canonical example does not recommend this; its second pass is for resolution increase, and the 'consistency' effect is described as observed behavior (can merge hair colors), not a seam-harmonization recipe. Rewrote to match the source and added the verbatim 512x512 consistency quote.
- **Conditioning & Structural Control:** ImagePadForOutpaint feathering range note removed an unverifiable specific. Draft suggested 'Higher feathering (~50-80)'; that specific recommendation is not in canonical sources. Kept default=40 (verified) and generic 'higher feathering smooths the seam' without the invented numeric range.
- **Conditioning & Structural Control:** SolidMask display name corrected from 'Solid Mask' to canonical 'Create Solid Mask'; added value 0.0-1.0 and default width/height 512.
- **Conditioning & Structural Control:** MaskComposite display name: confirmed canonical display is 'Combine Masks' (draft already noted this) and kept; clarified GrowMask tapered_corners is BOOLEAN default True and ThresholdMask default 0.5.
- **Conditioning & Structural Control:** ImageBlur / 'Blur Image' removed from the mask-operations table. It is not a mask node; in current ComfyUI it is an image filter under 'image/postprocessing'. Listing it under 'image/mask' was misleading; added a note explaining the removal.
- **Conditioning & Structural Control:** Embedding file-extension claim trimmed. Draft asserted embeddings load as '.safetensors/.pt/.bin' from the embeddings folder; the cited BlenderNeko syntax doc only documents the 'embedding:name' syntax and folder, not the extension set, so the unverifiable extension list was removed.
- **Conditioning & Structural Control:** ConditioningSetMask/SetArea strength max confirmed at 10.0 (already correct in draft) and ConditioningSetAreaPercentage defaults clarified (width/height default 1.0, x/y default 0). VAEEncodeForInpaint grow_mask_by (default 6, 0-64), InpaintModelConditioning noise_mask (default True), unCLIPConditioning strength (-10.0 to 10.0) all verified against source — kept.
- **Conditioning & Structural Control:** IP-Adapter option lists flagged as needing UI confirmation. The project's NODES.md is explicitly incomplete and does not fully enumerate weight_type / embeds_scaling; added a caveat. FaceID->InsightFace requirement and models/ipadapter path confirmed from the README. Removed the unverifiable claim that 'IPAdapter Advanced' is a 'drop-in replacement for the removed IPAdapter Apply' since neither NODES.md nor README documents an 'IPAdapter Apply' removal.
- **Conditioning & Structural Control:** GLIGEN/inpaint/unCLIP descriptive claims replaced with verbatim canonical quotes where the draft paraphrased (e.g. GLIGEN 'specify the location and size of multiple objects', inpaint 'It also works with non inpainting models', unCLIP noise_augmentation behavior).
- **LoRA, Model Merging & Model Surgery:** FreeU/RescaleCFG origin claim was wrong: the draft said both 'originated in the separate comfyanonymous/ComfyUI_experiments repo.' Verified against that repo — it contains RescaleCFG (sampler_rescalecfg.py) but NOT FreeU. Rewrote the final bullet to credit only RescaleCFG's experiments-repo origin and removed the unverifiable claim about FreeU originating there.
- **LoRA, Model Merging & Model Surgery:** weight_adapter registry: the draft said GLoRAAdapter and BOFTAdapter 'exist in the source but are disabled.' Clarified per comfy/weight_adapter/__init__.py — all six classes (incl. GLoRAAdapter, BOFTAdapter) are defined and present in the `adapters` list/__all__; it is specifically the active `adapter_maps` dispatch that comments out GLoRA and BOFT ('## We disable not implemented algo for now'). Corrected the wording to reflect that distinction.
- **LoRA, Model Merging & Model Surgery:** SAG blur_sigma: added the verified step value (0.1) and 'advanced' flag that the draft omitted (range −2→5 / 0→10 were already correct).
- **LoRA, Model Merging & Model Surgery:** ModelMergeSimple/ModelMergeBlocks: added the verified step 0.01 on ratio (draft omitted step on the simple-merge ratio).
- **LoRA, Model Merging & Model Surgery:** PerpNeg display name: draft labeled it loosely as 'PerpNeg (deprecated)'. Added the exact source display name 'Perp-Neg (DEPRECATED by Perp-Neg Guider)' and the is_deprecated=True confirmation; also corrected neg_scale max to 100 (verified).
- **LoRA, Model Merging & Model Surgery:** Subtract/Add merge nodes: clarified the display-name vs NODE_CLASS_MAPPINGS-name split — mapping names are ModelMergeSubtract/ModelMergeAdd/CLIPMergeSubtract/CLIPMergeAdd while the Python classes are ModelSubtract/ModelAdd/CLIPSubtract/CLIPAdd (draft had the relationship inverted in the parenthetical).
- **LoRA, Model Merging & Model Surgery:** Cosmos Predict2 block ranges: added the verified explicit ranges (CosmosPredict2_2B blocks.0–27, CosmosPredict2_14B blocks.0–35) that the draft left unspecified.
- **LoRA, Model Merging & Model Surgery:** ImageUpscaleWithModel: added the verified OOM behavior (tile halves down to a 128-px floor) and removed the unverifiable search-alias claim ('upscale', 'super resolution', 'hires') which is not in the canonical node source.
- **LoRA, Model Merging & Model Surgery:** PAG/SAG cost claim: softened 'roughly double inference cost' to 'roughly add inference cost' since the exact 2x figure is not stated in canonical source (both still require an extra perturbed forward pass, which is verified).
- **LoRA, Model Merging & Model Surgery:** ModelComputeDtype/ModelNoiseScale: confirmed both live in nodes_model_advanced.py with the categories the draft gave (advanced/debug and model/patch respectively); attributed the HiDream noise-scale figures to the in-code tooltip rather than stating them as bare fact.
- **Beyond Images: Video, Audio, 3D:** Preview3D input parameter was wrong: draft said it takes a `mesh_path` (string); canonical docs (docs.comfy.org/built-in-nodes/Preview3D) call the input `model_file`, a path under `ComfyUI/output/`. Corrected.
- **Beyond Images: Video, Audio, 3D:** Preview3DAnimation was described as 'experimental'; it is a documented built-in node page (docs.comfy.org/built-in-nodes/Preview3DAnimation) with no 'experimental' qualifier. Removed the qualifier and corrected the description (camera_info + model-file path under ComfyUI/output).
- **Beyond Images: Video, Audio, 3D:** SV3D was attributed to the 3d example page, but that page documents Stable Zero123 only. SV3D_Conditioning is verified instead from comfy_extras/nodes_stable3d.py; fixed the attribution and added a note that the example page does not cover SV3D.
- **Beyond Images: Video, Audio, 3D:** Audio metadata-embedding code was attributed to comfy_extras/nodes_audio.py 'verified against master.' On current master that logic has moved to comfy_api/latest/_ui.py (AudioSaveHelper.save_audio); nodes_audio.py now only calls UI.AudioSaveHelper.get_save_audio_ui(). Updated the source attribution; the quoted snippet itself was confirmed accurate in _ui.py.
- **Beyond Images: Video, Audio, 3D:** CogVideoX wrapper node name `CogVideoImageEncode` was incorrect; the actual node is `CogVideoXImageEncode` (with the X). Corrected, and added CogVideoTextEncode for completeness.
- **Beyond Images: Video, Audio, 3D:** CogVideoX wrapper was called 'a Diffusers wrapper'; the repo uses diffusers as a dependency but the README does not frame it strictly as a Diffusers wrapper. Softened to 'diffusers-backed' and noted it is actively maintained.
- **Beyond Images: Video, Audio, 3D:** Cosmos dims claim ('docs recommend height=704, length=121, width 704 or 1280; dims must be multiples of 16') was imprecise. Per comfy_extras/nodes_cosmos.py the node defaults are width=1280, height=704, length=121; width/height step by 16 (multiples of 16) but length steps by 8 (not a multiple of 16). Clarified, and added CosmosPredict2 defaults (848x480, length 93 step 4) plus the samples/noise_mask outputs.
- **Beyond Images: Video, Audio, 3D:** SVD node attribution: ImageOnlyCheckpointLoader and VideoLinearCFGGuidance were attributed to the video example page, but the page only mentions VideoLinearCFGGuidance and the param descriptions, not ImageOnlyCheckpointLoader by name. Re-sourced node details to comfy_extras/nodes_video_model.py, added SVD_img2vid_Conditioning (the node that actually exposes video_frames/motion_bucket_id/fps/augmentation_level) with verified defaults (14/127/6/0.0), and corrected the CFG description to use min_cfg default 1.0 rather than asserting an unsourced ~2.5 endpoint value.
- **Beyond Images: Video, Audio, 3D:** Mochi: added the source-verified EmptyMochiLatentVideo constraints (default 25, min 7, step 6) and noted the 7+6n rule is enforced via min/step plus the internal ((length-1)//6)+1 math, since the example page itself does not state the 7+6n rule.
- **Beyond Images: Video, Audio, 3D:** Stable Audio pipeline: kept CheckpointLoaderSimple but clarified that node names/pipeline come from source + ACE-Step docs, since the audio EXAMPLE page does not list node names, tags/lyrics fields, or the pipeline (it only covers model downloads and the workflow-embedded flac).
- **Beyond Images: Video, Audio, 3D:** Wan licensing/VRAM claim was slightly loose ('Wan 2.1 ... 1.3B variant runs on ~8GB VRAM ... License is Apache-2.0'). The wan2_2 doc canonically states TI2V-5B fits ~8GB and is Apache-2.0; reframed the VRAM/license note around what the cited Wan 2.2 doc actually says rather than unsourced Wan 2.1 1.3B specifics.
- **Beyond Images: Video, Audio, 3D:** 3D-Pack: noted that it also includes many newer models (TRELLIS, Hunyuan3D 2.1 with texturing, StableFast3D, LGM, etc.) and that NeRF support is via Instant-NGP, per the repo README, for accuracy.
- **Workflow Management & Formats:** Export menu path corrected: docs say 'File → Export Workflow (API)', not 'File → Export (API)'. Also softened the 'Enable Dev Mode Options' claim — the current cited canonical page shows no dev-mode gate, so it is now framed as historical/version-dependent rather than a current requirement.
- **Workflow Management & Formats:** SaveAudio status updated: current core source marks the FLAC 'SaveAudio' node as is_deprecated=True (display name 'Save Audio (FLAC) (DEPRECATED)'), and the audio savers now use the V3 IO schema (hidden=[IO.Hidden.prompt, IO.Hidden.extra_pnginfo]). Added the sibling nodes SaveAudioMP3, SaveAudioOpus, and SaveAudioAdvanced (format-selectable FLAC/MP3/Opus), which the original draft omitted.
- **Workflow Management & Formats:** Per-format embedding table fixed: the draft listed a generic 'image savers' row for JPEG/WebP. Core ships SaveAnimatedWEBP (WebP via EXIF); there is no built-in plain-JPEG saver in nodes_images.py. Replaced the vague row with the actual node and noted EXIF as the mechanism (the ~65,535-byte EXIF/APP1 ceiling is a true general fact, retained).
- **Workflow Management & Formats:** comfyui-subgraph-blueprints PyPI package: NOT mentioned anywhere in the canonical docs/custom-nodes/subgraph_blueprints page. Marked explicitly as unverified rather than stated as fact.
- **Workflow Management & Formats:** Subgraph blueprint distribution example path corrected to match the canonical doc: 'ComfyUI-MyCustomNodeModule/subgraphs/My_upscale_subgraph.json' (the draft used 'ComfyUI-MyModule/subgraphs/My_upscale.json').
- **Workflow Management & Formats:** /history route: added POST method (clear history / delete a history item), which the canonical routes page documents but the draft listed only as GET.
- **Workflow Management & Formats:** Template thumbnail variants: confirmed and corrected naming to the repo's actual variant identifiers (image, compareSlider, video, hoverDissolve, audio, and zoomHover/hoverZoom). The draft's prose names ('compare-slider', 'hover-dissolve', 'hover-zoom') were paraphrases; aligned to the canonical camelCase identifiers and noted the repo README uses 'zoomHover'.
- **Workflow Management & Formats:** Templates browser open path corrected to 'Templates icon in the sidebar' (the draft said 'left sidebar'; docs say 'sidebar') and added the canonical custom-node template constraint (single directory level, JSON only).
- **Workflow Management & Formats:** Model metadata URL sources clarified per docs: url must be a direct download link, Hugging Face or Civitai only (draft said 'Hugging Face or Civitai only' which is correct — retained and tightened with 'direct download link, not a repository page').
- **Workflow Management & Formats:** Added blueprints_bundles.json to the workflow_templates repo description (present in the repo, omitted by the draft) and tightened the contribution rules to the canonical wording (--disable-all-custom-nodes, pyproject.toml version bump, test-as-new-user).
- **Workflow Management & Formats:** cnr_id/ver provenance: confirmed as real shipped properties fields and kept, but added a clarification that these are not enumerated in the workflow_json spec (properties is an open object) — they were presented in the draft as if spec-defined.
- **Workflow Management & Formats:** Schema state field spelling preserved as 'lastGroupid' (lowercase 'id'), which is the actual schema spelling — flagged in-text so it isn't 'corrected' to lastGroupId later.
- **Workflow Management & Formats:** Version-note line about FLAC commit and 'metadata survives only on the original file' caveat: changed '(canonical & practical)' to '(practical)' since the re-encode/stripping caveat is practitioner knowledge, not a quote from a canonical ComfyUI page.
- **Extensibility & the Custom-Node Ecosystem:** Registry 'three pillars' mislabeled: draft listed 'Semantic versioning / Immutable versions / Security scanning'; the overview page's three features are 'Node Versioning / Node Security / Search'. Reframed to match canonical pillar names while keeping the SemVer/immutability/scanning substance (all verified).
- **Extensibility & the Custom-Node Ecosystem:** COMBO declaration example was malformed: draft showed ('ckpt_name', (folder_paths.get_filename_list('checkpoints'),)). Canonical datatypes page shows the type as a list, e.g. ('ckpt_name': (folder_paths.get_filename_list('checkpoints'), )) and (['no','yes'], {}). Corrected.
- **Extensibility & the Custom-Node Ecosystem:** menuCommands (topbar) shape was wrong: draft used {id, label, function}. The topbar menu page documents menuCommands as {path: [...], commands: [...]} where commands is a list of command IDs (the {id,label,function} shape belongs to the separate `commands` array). Corrected.
- **Extensibility & the Custom-Node Ecosystem:** Partner-node provider list overstated/stale vs the cited blog: blog names Veo2 (not generic 'Veo'), OpenAI GPT-4o image (not generic 'OpenAI'), and Pika 2.2; it does NOT list Runway. Removed Runway, made the model versions specific, and noted the blog omits Runway.
- **Extensibility & the Custom-Node Ecosystem:** beforeQueued/afterQueued: draft asserted they 'are also available' as execution hooks. The javascript_hooks page does not document them as registerExtension lifecycle hooks; marked '(unverified as registerExtension hooks)' and noted execution events use the API event handlers.
- **Extensibility & the Custom-Node Ecosystem:** Monkey-patching deprecation + app.canvas/app.graph etc. were attributed to the docs generally near the hooks section; re-sourced explicitly to the javascript_objects_and_hijacking page (which is where the deprecation notes and the app.* property descriptions actually live and which is cited).
- **Extensibility & the Custom-Node Ecosystem:** execution_error over the WebSocket: draft hedged ('also flow over the same channel'). Confirmed via comms_messages, which lists execution_error, execution_interrupted and execution_success as first-class message types; added them and removed the hedge.
- **Extensibility & the Custom-Node Ecosystem:** send_sync signature: draft showed send_sync(event, data, sid) as if sid were required; comms_messages shows the common form send_sync(event, data) with sid optional for targeting a client. Clarified.
- **Extensibility & the Custom-Node Ecosystem:** Added V3 schema flag enable_expand and V3 input param `advanced`, both present in the v3_migration doc but missing from the draft's lists.
- **Extensibility & the Custom-Node Ecosystem:** comfy install --fast-deps / --uv-compile: not on the comfy-cli getting-started page but confirmed in the comfy-cli README (fast-deps uses uv for initial install; uv-compile delegates to ComfyUI-Manager v4.1+). Kept with correct sourcing; clarified --fast-deps is for the initial ComfyUI install specifically.
- **Extensibility & the Custom-Node Ecosystem:** Datatypes/InputTypeOptions lists expanded to match node_typing.py verbatim (added IO types such as LORA_MODEL, CLIP_VISION, CONTROL_NET, STYLE_MODEL, GLIGEN, UPSCALE_MODEL, VIDEO, etc.; added option keys round, socketless, widgetType, image_upload, control_after_generate, multi_select, remote; noted defaultInput is @deprecated for forceInput).
- **Extensibility & the Custom-Node Ecosystem:** DYNPROMPT added to the hidden-inputs list (documented in more_on_inputs alongside PROMPT/UNIQUE_ID/EXTRA_PNGINFO); FUNCTION named-args behavior clarified per server_overview.
- **Platform, API & Deployment:** MCP clients overstated: draft claimed 'Cursor, Amp, and other MCP clients' are supported, but the canonical mcp-server doc only lists Claude Code and Claude Desktop (OAuth) with 'more clients coming.' Corrected to those two and marked Cursor/Amp (unverified).
- **Platform, API & Deployment:** MCP tools/slash commands: clarified that the bare tool names (generate-image, etc.) are exposed in the Claude Code plugin as namespaced slash commands (e.g. /comfy-cloud:generate-image), per the canonical doc.
- **Platform, API & Deployment:** MCP beta status: refined 'closed beta as of mid-2026, feature-flag gated' to the doc's exact framing — closed beta, invite-only with a per-user feature flag.
- **Platform, API & Deployment:** BinaryEventTypes attribution: draft said server.py 'defines' the enum; the enum is imported from the protocol module and used/sent in server.py. Corrected wording, and documented the actual 4-byte struct.pack('>I', event) frame header plus the per-image type_num sub-header (1=JPEG, 2=PNG) and the length-prefixed metadata variant, per server.py source.
- **Platform, API & Deployment:** Comfy Cloud runtime cap: draft phrased it as 'per-workflow runtime cap raised to 60 minutes (Pro plan).' Corrected to the blog's wording: workflows can run up to 1 hour on the Pro plan starting Dec 8, 2025 (up from 30 min).
- **Platform, API & Deployment:** Comfy Cloud GPU comparison: tightened '~2x faster than the A100s it replaced' to the blog's exact phrasing ('approximately twice as fast as A100s').
- **Platform, API & Deployment:** Comfy Cloud billing/limits: replaced loose paraphrases with the exact comfy.org/cloud quotes — 'one active job at a time,' 'Build and edit workflows for free — credits are consumed only when the GPU runs,' and 'Every model on Comfy Cloud is cleared for commercial use.'
- **Platform, API & Deployment:** 900+ models claim: confirmed canonically ('Over 900 supported models' on blog.comfy.org free-tier post) rather than left as an unsourced figure; also added the 350+ templates and 400-credit Free tier from the same canonical post.
- **Platform, API & Deployment:** Pro/Creator plan credit amounts: draft implied specific pools; canonical pages do not publish Pro/Creator credit amounts, so those are marked (unverified). Standard (4,200) and Founder's (5,460) are confirmed.
- **Platform, API & Deployment:** Desktop bundled Python version: draft asserted 'Python 3.12+'; the canonical Windows/macOS install docs do not state a Python version, so the specific version claim was removed (kept 'embedded Python managed by uv').
- **Platform, API & Deployment:** Desktop platform reqs: tightened to the docs' exact wording — Windows 10 or later (x64/ARM64), macOS 13 (Ventura)+ on Apple Silicon (M1 or later, Intel unsupported), ~4.85 GB/install.
- **Platform, API & Deployment:** Desktop auto-update specifics: the precise list of auto-updated components and the '%LOCALAPPDATA%\@comfyorgcomfyui-electron-updater' cache path are not in the canonical install docs; marked those specifics (unverified).
- **Platform, API & Deployment:** ComfyUI-Manager on Desktop: draft said 'installed via pip when --enable-manager is set'; corrected to 'gated behind the --enable-manager feature flag' (the pip-install mechanism detail is not stated canonically).
- **Platform, API & Deployment:** Desktop extra-paths file: confirmed the Desktop filename is extra_models_config.yaml under AppData\Roaming\ComfyUI (Win) / Library/Application Support/ComfyUI (mac), reachable via Help -> Open Folder; added the note that Desktop launches with an explicit --extra-model-paths-config and the install-generated config should be appended to, not overwritten.
- **Platform, API & Deployment:** Flag help text: replaced several paraphrased help strings with verbatim cli_args.py text (--highvram, --lowvram, --gpu-only, --cpu, --novram, --async-offload default/Nvidia note, --reserve-vram, --cuda-device/--default-device visibility behavior, --extra-model-paths-config 'one or more files', per-directory 'Overrides --base-directory').
- **Platform, API & Deployment:** --listen no-arg behavior: corrected to the precise default ('0.0.0.0,::', all IPv4+IPv6) rather than just '0.0.0.0'.
- **Platform, API & Deployment:** Route descriptions: aligned POST /interrupt ('stop the current workflow execution'), POST /free ('free memory by unloading specified models'), POST /queue ('clear pending/running'), and POST /users (create user, multi-user only) with the canonical comms_routes wording; added that GET /v2/userdata is the structured files+directories variant.
- **Platform, API & Deployment:** comfy generate flags: corrected the flag list to what the canonical getting-started page shows (--prompt, --image, --width, --height, --download, --json, --async, --api-key; subcommands list/schema/upload/resume). Removed the unverified --model flag and COMFY_API_KEY env-var claim; removed the unverified 'uses cm-cli internally' / 'comfy node registry' detail.
- **Platform, API & Deployment:** comfy install flags: added --pr and noted Python 3.10+ requirement, both from canonical sources; kept the Homebrew tap (Comfy-Org/comfy-cli) which the getting-started page confirms.
- **Platform, API & Deployment:** Self-host posture: removed the specific claim that 'the partner-node (cloud API) path is documented as not supported over --listen LAN access' — this exact statement was not confirmable on the cited canonical pages.
- **Recent Evolution (2025–2026):** Nodes 2.0 public beta date/version was WRONG. Draft said it shipped in v0.3.51 (Aug 20, 2025). The changelog stamps the 'New UI: Nodes 2.0 public beta' to v0.3.76 (Nov 26, 2025), and the dedicated blog post is dated Dec 5, 2025. Corrected to v0.3.76.
- **Recent Evolution (2025–2026):** The v0.3.51 UI feature list was WRONG. Draft attributed Linear mode, the workflow progress panel, and the Assets sidebar to v0.3.51 — the changelog stamps all three to v0.3.76. v0.3.51 actually added the bottom shortcut panel, Standard Canvas Mode, the workflow mini map, and tab preview. Rewrote the frontend section accordingly.
- **Recent Evolution (2025–2026):** MatchType/DynamicCombo/Autogrow version was WRONG. Draft said v0.6.0 (Dec 24, 2025); changelog stamps it to v0.4.0 (Dec 10, 2025). Corrected.
- **Recent Evolution (2025–2026):** --whitelist-custom-nodes version was badly WRONG. Draft said v0.12.0 (Feb 3, 2026); changelog stamps 'New --whitelist-custom-nodes argument pairs with --disable-all-custom-nodes' to v0.3.44 (Jul 8, 2025). Corrected in the performance-flags table.
- **Recent Evolution (2025–2026):** 'Enhanced subgraph execution (multiple runs within a single workflow)' version was WRONG. Draft said v0.21.0 (May 11, 2026); changelog stamps it to v0.3.68 (Nov 5, 2025). Corrected.
- **Recent Evolution (2025–2026):** Ideogram 4 / NextDiT / Lumina2 / Qwen3-VL-8B text-encoder detail was attributed to the WRONG version. Draft said v0.9.1 (Jan 13, 2026); v0.9.1 was only an 'LTXAV memory estimation' bump. The full NextDiT/Lumina2/Qwen3-VL-8B description is stamped to v0.24.0 (Jun 3, 2026). Corrected in the model-support section.
- **Recent Evolution (2025–2026):** DPM++ 2M SDE Heun (RES) sampler version was WRONG. Draft said v0.7.0 (Dec 31, 2025); the changelog attributes 'DPM++ 2M SDE Heun (RES) Sampler by @Balladie' to v0.3.53 (Aug 28, 2025). (v0.17.0, Mar 13, 2026, also references a RES sampler entry, but the original introduction is v0.3.53.) Corrected.
- **Recent Evolution (2025–2026):** ManualSigmas node version was WRONG. Draft said v0.22.0 (May 20, 2026); changelog stamps 'Added ManualSigmas node for sampling control' to v0.7.0 (Dec 31, 2025). Corrected.
- **Recent Evolution (2025–2026):** Pinned memory was incorrectly lumped into v0.3.68. The changelog stamps Mixed-Precision Quantization and RAM Pressure Cache Mode to v0.3.68 (Nov 5, 2025), but 'Pinned Memory Enabled by Default for NVIDIA and AMD GPUs' to v0.3.69 (Nov 18, 2025). Split into two entries.
- **Recent Evolution (2025–2026):** The V3-conversion table row 'v0.3.57 (Sept 4, 2025) Assorted core nodes' was UNVERIFIABLE — v0.3.57 has no V3-conversion entry in the changelog. The 'converted some core nodes to V3 schema' line is stamped to v0.3.62 (Sept 30, 2025). Replaced the v0.3.57 row with the v0.3.62 row.
- **Recent Evolution (2025–2026):** 'WAN2.6 ReferenceToVideo (v0.3.58, Sept 6, 2025)' was UNVERIFIABLE — v0.3.58 lists Hunyuan Image 2.1 and Hunyuan 3D 2.1 but no WAN ReferenceToVideo entry. Removed the WAN2.6 ReferenceToVideo claim from the WAN model line.
- **Recent Evolution (2025–2026):** Frontend package version progression (v1.28.8 -> v1.35.9 -> v1.42.15 tied to specific core releases) was UNVERIFIABLE from the changelog, which does not consistently version-stamp the bundled frontend (only sporadic mentions like 'Frontend patched to 1.36.14' in v0.9.0). Removed the unsupported frontend-version progression line.
- **Recent Evolution (2025–2026):** Specific pinned template versions ('v0.9.92 at v0.12.0', 'v0.9.94 at v0.25.0') did not match the changelog, which shows template updates to 0.1.36/0.1.37/0.1.39 at v0.12.0 and workflow templates to v0.9.75 at v0.21.0. Replaced the precise (unmatched) numbers with a verifiable example and a note to consult the changelog for exact pins.
- **Recent Evolution (2025–2026):** v0.3.40 wording softened: draft said 'BFL API for Flux Kontext'; the changelog phrasing is 'BFL API Optimization: Refined support for Kontext models.' Changed to 'BFL API refinement for Flux Kontext.'
- **Recent Evolution (2025–2026):** v0.3.62 partner-node entry 'WAN Image-to-Image' clarified to 'Wan2.5 Image-to-Image' per the changelog ('Wan2.5 Image-to-Image API node').
- **Recent Evolution (2025–2026):** Qwen-Image base model attribution corrected from v0.3.51 to v0.3.50 (Aug 13, 2025), where the changelog stamps 'Qwen Image Model Support ... including proper LoRA loading.' v0.3.51 is Qwen-Image-Edit.
- **Recent Evolution (2025–2026):** Partner-node table dates verified/adjusted: v0.13.0 = Feb 10, 2026 (kept); v0.23.0 = Jun 1, 2026 (kept); v0.25.0/v0.25.1 split (Kling V3-Turbo is v0.25.1, the rest v0.25.0); Pika and the original Stability AI model names retained from the launch blog post (not in the changelog, but canonical to blog.comfy.org).
- **Recent Evolution (2025–2026):** Distributed-execution framing softened: the May 2025 partner-nodes blog post says 'parallel execution within a workflow,' not 'distributed execution across machines.' Added an explicit note to that effect.
- **Recent Evolution (2025–2026):** Subgraph descriptions tightened to canonical phrasing: 'LEGO blocks' and 'feels like a folder' are direct from the subgraph blog post; input/output slots described as Comfy phrases them ('data coming from outside' / 'going outside').
