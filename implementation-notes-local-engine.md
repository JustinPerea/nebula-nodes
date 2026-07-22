# Implementation Notes — Local ComfyUI Engine (Slice 1: Krea2 in a Nebula graph)

Branch: `feat/local-comfy-engine`. Goal: bake ComfyUI's sampler/loader/latent stack into Nebula as native nodes that run in-process alongside hosted BYOK nodes. Slice 1 = reproduce a known-good Krea2-Turbo render inside a Nebula graph.

## ✅ PROVEN (2026-06-28) — the engine works in-process
Standalone smoke (`scratchpad/krea2_smoke.py`) drives the 9 core comfy node classes from an embedded Python process and rendered a clean 1024×1024 Krea2 image on MPS in **57s** (8 steps, euler/simple, cfg 1.0). No web server, no asyncio, no custom-node loading. This de-risks the hardest, most uncertain part (comfy embedding + MPS numerics + the call contract) before any Nebula wiring.

Render params (the known-good chain, enhancer + LoRA bypassed for determinism):
`UNETLoader(krea2_turbo_bf16, default)` → `CLIPLoader(qwen3vl_4b_fp8_scaled, type=krea2)` → `VAELoader(qwen_image_vae)` → `CLIPTextEncode(clip, text)` → `ConditioningZeroOut` → `EmptyLatentImage(1024,1024,1)` → `KSampler(model, 397747871968973, 8, 1.0, euler, simple, pos, neg, lat, denoise=1.0)` → `VAEDecode(vae, latent)`.

## Decisions (not dictated by the spec)

1. **Runtime interpreter = the `comfyui` conda env** (`~/miniconda3/envs/comfyui/bin/python`, py 3.12.13, torch 2.12.1 + MPS, `comfy_aimdo`/`comfy_kitchen` present). This is the env ComfyUI itself runs on — proven to work. **Plan:** run Nebula's backend on this env (add the web deps it lacks: `fastapi uvicorn[standard] trimesh cairosvg pypdf python-multipart respx pytest-asyncio`), giving true in-process comfy. Rejected the alternative (install torch + comfy's aimdo/kitchen helpers into `backend/.venv`) — heavier, version-mismatch risk, replicates a multi-GB stack that already works in the comfyui env.
   - Miniconda **base** has torch but NOT `comfy_aimdo` → `comfy.model_management` import fails there. Must use the `comfyui` env.

2. **Pass live torch/model objects via a side-channel object store, NOT on the edge.** Nebula edges are serializable-only (`PortValueDict.value: str|list|dict|None`, enforced at 3 layers: Pydantic validation `engine.py:743`, WS `json.dumps` `main.py:743/763`, disk persist `main.py:1175`). So: new `backend/local_engine/object_store.py` holds `{handle: live_obj}`; producing handlers return `{"model": {"type":"MODEL","value":"obj://<runid>/<uuid>"}}` (a plain string that passes all 3 layers); consuming handlers resolve the handle back to the object. New port types MODEL/CLIP/VAE/CONDITIONING/LATENT are cosmetic on the wire (opaque strings the frontend won't render). Clear the store at `GraphCompleteEvent` to free VRAM.

3. **Opt local nodes out of the execution cache** (`LOCAL_NONCACHEABLE` guard at `engine.py` cache get `:488` + set `:747`). The sha256 key uses `json.dumps(default=str)` → an `obj://` handle is stable enough to never falsely hit, but caching the *output* would pin live GPU objects for the 1h TTL (VRAM leak). Cleanest: skip cache entirely for local nodes.

4. **Lazy torch import — singleton `LocalEngine` created on first local-node execution.** `main.py` has NO startup hook (boot = top-to-bottom import), so torch must never be imported at any module top-level reachable from boot. The handler module imports torch/comfy only inside `_ensure_engine()`, fired the first time a local node runs (`engine.py:740`). Hosted-only graphs never touch torch. Register the handler as a lazy closure inside `get_handler_registry`'s `if emit is not None:` block (`sync_runner.py`), importing the torch-bearing module *inside* the wrapper.

5. **Run blocking torch work off the event loop** via `asyncio.to_thread`, and force `max_parallel_nodes=1` for graphs containing local nodes (the scheduler runs up to 4 concurrent — 4 simultaneous model loads would blow shared VRAM). KSampler step previews: capture `loop = asyncio.get_running_loop()` BEFORE `to_thread`, then inside comfy's synchronous `callback(step,x0,x,total)` use `asyncio.run_coroutine_threadsafe(emit(StreamPartialImageEvent(...)), loop)` (NOT `create_task` — no loop on the worker thread).

6. **Embedding mechanics** (verified): `sys.path.insert(0, comfyPath)`; **do NOT** call `comfy.options.enable_args_parsing()` (keeps `cli_args` on `parse_args([])` so host argv is ignored); `import folder_paths` then `comfy.model_management` (device auto-detects MPS) then `from nodes import ...`. folder_paths defaults already resolve the symlinked Krea2 models (`models/diffusion_models`, `models/text_encoders`, `models/vae`, `models/loras`) — no `add_model_folder_path`, no `extra_model_paths.yaml`. comfyPath read from repo-root `settings.json` → `localEngine.comfyPath` (default `~/ComfyUI`).

## Changes / fixes outside the original recipe
- **`.detach()` before `.cpu().numpy()`** on the VAEDecode IMAGE tensor — it requires grad (agent recipe's `img[0].cpu().numpy()` raised `RuntimeError: Can't call numpy() on Tensor that requires grad`). Fixed.
- Harmless objc warning at import: `cv2` and `av` both ship `libavdevice` dylibs ("may cause spurious casting failures"). Cosmetic in this env; the render succeeded. Note for later if a crash surfaces.

## Surprises / gotchas to remember
- First sampling step is ~15s (MPS shader/graph compile), then ~5s/step → ~57s total for 8 steps incl. model load. Expect a cold-start cost on the first local generation per backend process.
- The partial-image `src` is rendered RAW by the frontend (`graphStore.ts:2799`, `DynamicNode.tsx:151`) — unlike the `executed` path it's not URL-rewritten. So KSampler previews must emit `src="/api/outputs/<rel>"` (compute `path.relative_to(OUTPUT_ROOT)`), not an absolute path.
- `backend/data/node_definitions.json` is GENERATED from `frontend/src/constants/nodeDefinitions.ts` via `npx tsx scripts/export-node-defs.ts` — never hand-edit the JSON. Two CI contract gates (`scripts/check-node-contracts.mjs` + `backend/tests/test_node_contracts.py`) enforce ID parity + handler coverage + the port-type whitelist.
- Adding the 5 port types touches 5 files (the proven Character/Moodboard path): `types/index.ts` (PortDataType union), `lib/portCompatibility.ts` (PORT_COLORS + COMPATIBILITY, both exhaustive Records), `scripts/check-node-contracts.mjs` (VALID_PORT_TYPES), `backend/tests/test_node_contracts.py` (VALID_PORT_TYPES).
- Local nodes must use `apiProvider:'utility'`, `envKeyName:[]`, `executionPattern` sync/async-poll; emit-needing handlers register as closures in `get_handler_registry`, not the static `SYNC_HANDLERS`.

## Slice plan
- **Slice 1 (now):** the 9-node Krea2 chain as real Nebula nodes, end-to-end in a graph, KSampler step previews, lazy engine. Verify in-browser.
- **Slice 2:** LoRA stacking (`LoraLoaderModelOnly`) + the Krea2T enhancer + resolution/switch wrappers (match the full saved workflow).
- **Slice 3:** decomposed sampling (SamplerCustomAdvanced) / ControlNet / SDXL-checkpoint path (`CheckpointLoaderSimple`).

## Docs to update (thesis pivot — keep in sync)
- `docs/research-2026-06/comfyui-flora-weave-nebula-4way-2026-06-28.md` §5 (moved local-diffusion from 🛑 "against thesis" to a built capability) — and the `flora-comfyui-gap-analysis.md` "🛑 out-of-scope by design" note. README local-first framing once Slice 1 lands.
