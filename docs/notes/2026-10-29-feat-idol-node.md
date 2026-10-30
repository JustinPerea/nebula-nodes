# feat/idol-node: the Idol node (Speridlabs, Hugging Face Space)

Base: main at a8798dc4. Image in, World v2 PLY splat out, run on Speridlabs'
own Space `speridlabs/idol`. No Idol run was started: the handler is built
and tested against the Space's pinned `/gradio_api/info` and mocked HTTP.

## Decisions taken (2026-10-29)

1. The Space is `routes[0]`, `maker: true`; Auto picks it.
2. A "Hugging Face" key provider holds an optional `HF_TOKEN`. It is not the
   node's `envKeyName`, so the node reads as free and runs anonymously
   without it.
3. The route is priced at a sourced $0 (ZeroGPU docs). The docs say that
   ZeroGPU overage can bill a PRO, Team or Enterprise person's own Hugging
   Face account.
4. The output is World v2: `assets.splats=[{id, format:'ply', asset,
   pointCount}]`, a coordinate system matching Idol's PLY axes, and session
   `{source:'generated', provider:'speridlabs', model:'idol'}`.

## Decisions not in the plan

- **Keyless routes are a route-table feature, not an Idol special case.** A
  route with `keys: []` and `optionalKeys` is runnable without a key in both
  `node_route.py` and `directRoute.ts`. Readiness reads "No key needed", the
  switcher's key cell reads "Optional key →", provider warnings skip it, and
  `instance_access` returns `free` without the key and `key` with it.
  `docs/PROVIDER-ROUTES.md` has a "Keyless routes" section.
- **Idol's axes are -Y up, +Z forward.** `save_ply` writes (x, -z, y) from a
  z-up model and its comment says "y-up", but the Space's backpack example
  is upright only with -Y up. The viewer turns `upAxis` to Three's +Y and
  frames objects from the `forwardAxis` side.
- **`randomize` is never sent true and isn't a setting.** The run cache keys
  on params, so a random seed would replay one result.
- **PLY preflight in both places.** `services/splat_ply.py` checks the file
  after download; `lib/splatPly.ts` checks it before Spark reads a byte.
  Both use the same rules and caps: 2,000,000 Gaussians, 128 MiB, and an
  exact length.
- **World Labs Export refuses a v2 World** with a person line (it only takes
  Marble's v1). A test checks that this is the only node with a World input.
- **Idol stays in Create Studio.** It's free, and Create already renders a
  World through `RepresentationViewer`.

## Surprises

- **Every World viewer was broken in production builds, on main too.** The
  error was "FullScreenQuad is not a constructor". Spark builds a
  `FullScreenQuad` when its module loads. Rolldown put three's
  `postprocessing/Pass.js` in the viewer's chunk, which imports
  `spark-vendor`, which imported it back. The fix keeps `Pass.js` in the
  `spark-vendor` group (`vite.config.ts`). `check-build-budget.mjs` now
  fails a build in which a `spark-vendor` chunk is in an import cycle. It
  was checked to fail on the unfixed build and pass on the fixed one.
- **The error-copy guards set the handler's shape.** round3c2 counts
  unlined raises, round3d2 wants `with_api_status` on status text and
  `with_call_facts` (or an exclusion) on caught errors, and round3f bans
  "run again" on card lines. Every error builder returns a wrapped literal
  and takes its detail by keyword. There are two `_WRAPPER_EXCLUSIONS`,
  both with reasons.
- **Slow first opens on SwiftShader.** These depend on order, not on the
  file. The first splat opened takes about 1 s, the second about 12 s, the
  third 52-111 s, and any re-open under 0.5 s. The PLY fetch is never more
  than 0.3 s. The heap stays at 13-17 MB and no canvas outlives its dialog.
  The cause is not found. See `docs/spatial-foundation.md`.

## Tradeoffs

- **Cancelling stops Nebula's wait, not the Space's job.** Gradio's `/call`
  API has no documented cancel.
- **No SPZ conversion.** The 262,144-Gaussian default opens in about 1 s
  when it's the first splat opened. Decide after a check on a real GPU.
- **The token is gated by hostname.** It goes only to
  `huggingface.co` and `*.hf.space` over HTTPS.

## Copy that GM may want to review

- Readiness: "No key needed" / "Runs without a key on a small shared daily
  allowance. Add a Hugging Face token in Settings to use your own."
- Switcher row: "Free on Hugging Face GPU time. Add a Hugging Face token for
  your own daily allowance." The key cell reads "Optional key →".
- Settings row: "Hugging Face" / "Optional: your own daily GPU time for
  Idol".
- Card error lines: the table in `docs/model-providers/speridlabs/idol.md`.
- World Labs Export: "World Labs Export only takes a world made by World Labs
  Environment. To keep this splat, download it from its card."

## Gates (isolated, 2026-10-29)

- tsc -b, lint and check-node-contracts pass.
- vite build plus the budget pass: 422,663 raw / 129,921 gzip, against
  421,038 / 129,437 at base.
- Full vitest: 8 tests in 5 files timed out while the backend suite ran in
  parallel. All 5 files pass when run alone (155/155).
- Full backend pytest (isolated): 11,992 passed.
- Mutation checks: 26/26 killed.
