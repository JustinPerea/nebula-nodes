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
  switcher's key cell is empty without the key and "Connected" with it
  (round 2, GM), provider warnings skip it, and `instance_access` returns
  `free` without the key and `key` with it.
  `docs/PROVIDER-ROUTES.md` has a "Keyless routes" section.
- **Idol's axes are -Y up, +X forward** (+Z in round 1; round 2 moved it
  after renders of the backpack from each axis). `save_ply` writes (x, -z, y)
  from a z-up model and its comment says "y-up", but the Space's backpack
  example is upright only with -Y up. The viewer turns `upAxis` to Three's +Y
  and frames objects from the `forwardAxis` side.
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
  `huggingface.co` and `speridlabs-idol.hf.space` over HTTPS (round 2
  narrowed it from `*.hf.space`).

## Copy that GM may want to review

Round 1's readiness, switcher, Settings and card lines were replaced by GM's
(round 2 below). Still open:

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
- `test_speridlabs_idol.py` had 73 tests in round 1 (the report said 74).

## Round 2 (2026-10-29): review fixes and GM's rulings

Fixes for the round 1 review (security/backend, frontend/viewer,
contracts/MCP/docs), with GM's copy and design rulings built verbatim.

### What changed

- **ZeroGPU errors are told apart** (`zerogpu_kind`, from `spaces` 0.51.3
  `zero/client.py`). Only "exceeded your … quota", "runs limit" and "too
  many ZeroGPU credits" are the person's own quota. New kinds: no free GPU
  (busy), the Space's own limit, a token that didn't reach the Space, and a
  per-run duration over the allowance. `spaces` adds "Try re-running outside
  of examples" only when no `X-IP-Token` reached the Space; that marker
  separates the token-not-applied and Space-limit lines from busy.
- **The two duration lines can't be told apart from the text.** Both read
  "The requested GPU duration (Ns) is larger than the maximum allowed"; the
  line depends on whether Nebula sent `HF_TOKEN`. Built against the mock;
  the first live run should confirm.
- **401 or 403** from the Hub or `/gradio_api/info` with a token set is
  "Hugging Face didn’t accept your token". Without a token a Hub 401 is
  only skipped.
- **The token goes to two hosts only**: `huggingface.co` and
  `speridlabs-idol.hf.space`. A token that isn't printable ASCII is refused
  before any request (a line of my own: "Your Hugging Face token has a
  character a token can’t have. Paste it again in Settings.").
- **The image is read by Nebula** (`load_media` and `fetch_public_media`:
  no loopback, private hosts or plain http) and uploaded as `input.png` and
  the like, so the source URL, its query string and local file names never
  reach the Space. File paths are URL-quoted; an `http://` result URL falls
  back to HTTPS on the Space's own host.
- **Settings are range-checked** against the pinned bounds before any
  request; the line names the field by its Inspector label and limits. A
  bool, NaN, infinity or a fraction in a whole-number field is refused too.
- **Output names carry 8 hex** (`idol-seed42-262144-1a2b3c4d.ply`): two
  nodes with the same settings, run in sequence or in parallel, never share
  a file or a `.part`.
- **The World value**: `pointCount` is the file's own count, `forwardAxis`
  is `x`, session tags use node values (`mode:synthetic`).
- **Anonymous runs name the provider** (`called_provider` takes a keyless
  route's first optional key), so a failure line says "Hugging Face".
- **f_rest names**: both PLY checks want exactly `f_rest_0` to `f_rest_{n-1}`
  (any order); a gap, a stray index or a leading zero is refused before
  Spark reads it by name.
- **Object framing**: the bounding sphere (98th-percentile radius) at
  r / sin(half the narrower field of view) × margin, from 30° off the front
  and 15° above, no auto-rotate; orbit zooms out to 4 framing distances.
  World v1 framing is unchanged (its test still holds).
- **Viewer**: orbit only for objects (GM: Fly stays for World Labs scenes,
  so the fly-speed scaling in the review was dropped). Focus trap shared
  with the World v1 preview (`hooks/useDialogFocusTrap.ts`). Spark's
  "Worker terminate" rejections after our own dispose are marked handled
  (`lib/sparkDispose.ts`, that exact message only, 3 s). A 404 offers no
  download; the help text hides in error states. Canvas label "Backpack,
  interactive 3D object". "1 Gaussian".
- **PLY header before the download** (finding 21): `readBoundedAssetResponse`
  takes a `prefixCheck`; for a PLY it parses the first 64 KiB as they
  arrive and cancels the stream on a bad header, a declared size over the
  allowance, or a Content-Length that disagrees with the header. Spark's
  loader isn't involved: the check runs on our own bounded read, before
  Spark gets any bytes. The whole-file preflight still runs after.
- **Budget script**: the Spark cycle check moved to
  `scripts/check-chunk-cycles.mjs` and counts `export … from` re-exports as
  imports; `tests/chunkCyclesCheck.test.ts` feeds it fake chunks.
- **Agents**: `describe_node` gives a keyless route `optionalKeys: [{key,
  set}]`; `nebula info` prints `none (optional HF_TOKEN)`; `nebula keys`
  counts nodes that run without the key; `find_nodes` and `start_here` say
  "free" for a sourced $0; new `nebula splat <node>` prints the splat
  summary; the summary's file error has no absolute path.
- **Desktop**: 22 providers, `HF_TOKEN` included, in both desktop tests.
- **Docs**: no "2 minutes a day" (the anonymous allowance is small, each run
  reserves 120 s, maybe about one run a day, to confirm live); the gap row
  no longer says splats are closed; SKILL.md has `nebula splat`;
  PROVIDER-ROUTES and spatial-foundation follow the new key cell and axes.
- **NITs**: the BytePlus comment sits above BytePlus again; `createModels`
  pins "world labs" to exactly Idol instead of filtering.

### GM's rulings (PR #203 r1), built as written

Readiness "No key needed" with GM's detail; connection label "Hugging Face
token" with a muted "Optional"; the switcher row note; the key cell with no
third state (empty, or the green dot and "Connected"); Settings "Optional.
Gives Idol your own daily GPU time."; every card line in the idol.md table;
the Run chip and proposals say "$0", not "~$0"; the preview card reads like
World v1 (kind, name, "Idol · Speridlabs", Explore, "Splat · PLY"); the
dialog status "262,144 Gaussians · PLY", muted "Loading", or the failure
line; "Download splat"; GM's orbit hint. The "Too large" line names
Gaussians, the Inspector field that sets the size, so no line was held.

### Decisions not in the brief

- **The World v1-style card is for splat-only values.** A World v2 with a
  point cloud, depth, panorama or collider keeps the summary that lists
  them, with Explore on it.
- **Margin 1.3, not 1.15.** Measured live on the backpack: 1.15 filled 69%
  of the stage's height, 1.3 fills 60.5% (GM's ~60%). A ball-shaped splat
  fills about 75%.
- **A fraction in Steps or Seed gets the range line** ("must be between 10
  and 100"), as GM's line has no other wording for it.

### Live check (isolated, 2026-10-29)

Backend 8793 and Vite 5793, Chrome headless on the real GPU (ANGLE Metal,
Apple M5 Max), 8000-8010 and 5173 blocked (canary blocked), no request to
any Hugging Face host, no Run.

- Backpack (the Space's own example PLY): upright three-quarter view of its
  front, 60.5% of the stage height at 1440 and 60.4% at 1280; opened in
  0.74-0.94 s.
- Synthetic 262,144-Gaussian ball: 75.3% of the height; 0.32 s.
- A gone file: GM's 404 line, no download, no help. A damaged file: GM's
  line, download kept.
- 8 rapid open-and-close cycles: 0 page errors ("Worker terminate" gone).
- One 1280 pass opened the backpack in 69 s with the machine at load
  average 102 from other sessions; the next pass at normal load was 0.74 s.
- The app has no dark theme, so there are no dark shots.

### Waiting on GM or Justin

- TODO(Justin): which token scope Settings asks for.
- TODO(Justin): whether Settings says the token goes to Speridlabs' Space.
- TODO(Justin): agent runs on a PRO token, which Hugging Face can bill past
  the quota; the spend gate admits them at $0 today.
- GM: the token-unusable line and the remaining Idol lines that aren't
  GM's copy (curly quotes only).
- Justin's first live run: confirm the duration texts, and whether an
  anonymous run can fit 120 s at all (if not, readiness must say a token is
  needed, per GM).

