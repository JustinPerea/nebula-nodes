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

### Pending

- A product decision: which token scope Settings asks for.
- A product decision: whether Settings says the token goes to Speridlabs'
  Space.
- A product decision: whether agents ask before runs that can bill a PRO
  account (Hugging Face bills past the quota); the spend gate admits them
  at $0 today.
- The design reviewer: the token-unusable line and the remaining Idol lines
  that aren't ruled copy (curly quotes only).
- The first live run: confirm the duration texts, and whether an anonymous
  run can fit 120 s at all (if not, readiness must say a token is needed).


## Round 3 (2026-10-30): review fixes, GM's r3 copy, and the token requirement (r4)

Built from the round 3 brief, the three round 2 reviews and GM's rulings
(gm-pr203-r2, r3, r4), copy verbatim.

### The token is required now (GM r4)

The Space asks for 120 s a call, and `spaces` 0.51.3 multiplies that by the
GPU's `duration_factor` (1.5 on "NVIDIA RTX PRO 6000 Blackwell Server
Edition", 1.0 on H200). The ZeroGPU docs now name half a Blackwell as the
default size, so a run most likely asks for 180 s, more than the 2-minute
unauthenticated allowance. The source lines and the runs-a-day table are in
`docs/model-providers/speridlabs/idol.md` ("Why a token is required"), to be
confirmed by the first live run's error text.

- The route is keyed: `keys: ["HF_TOKEN"]`, `envKeyName` and
  `directKeyName` `["HF_TOKEN"]`, and a new route field `missingKeyLine`
  carrying GM's lock reason. `node_route.missing_key_line_for` and
  `directRoute.routeMissingKeyLine` use it only when the key is the one
  thing missing, and on Auto only when every route has one.
- Run is disabled without the token on the selection toolbar, the Inspector
  and the context menu (`lib/runKeyLock.ts`), once Settings have loaded.
  Agent and CLI runs get the same line from the engine's preflight before any
  request (a test counts zero HTTP requests).
- The handler's anonymous branch stays as a backstop; its duration line
  still shows if a run slips through.
- Switching back to keyless, if the live run shows 120 s, is the route's own
  change (idol.md lists it); the keyless rules keep their tests through
  `keyless_idol()` and `_keyless_idol()`.
- The `hf-space` handler is exempt from "a route's provider is its key's
  provider" (Speridlabs bills nothing; the key is the person's Hugging Face
  token), in both `routes_problems` and `check-node-contracts.mjs`.
- Desktop credential lists are unchanged (`HF_TOKEN` was already there).

### What changed, by item

1. **M1**: `X-HF-Authorization` to every Space request, `Authorization` only
   to huggingface.co (`_headers`).
2. **M2**: with a token, the IP-only quota texts map to token-not-applied.
3. **L3**: the Space reads as missing by `huggingface_hub`'s rule (404,
   RepoNotFound, or a 401 without the bad-credentials message), with GM's
   one line for anonymous and signed-in runs.
4. **L4**: with a token, a 401 or 403 from the Hub, info, upload, call or
   stream is the token refused.
5. **L5**: the PLY header is checked as it arrives; too many Gaussians or a
   declared size over the cap is "too large", a Content-Length that
   disagrees or a body past the header's size is "can't read". round3d2's
   `_download_ply` exclusion is gone (no longer needed).
6. **L6, L7 (docs)**: 120 s, or 180 s on Blackwell, with sources; the
   unauthenticated "2 minutes | Low" row is back, noting it may not apply to
   server-side calls; no derived run count is stated as fact.
7. **Token trimming** in Settings (`saveKey`), PUT `/api/settings` and
   `credentials_update`, the settings check and the handler; GM's two
   character lines (the field's "paste it here", the card's "paste it in
   Settings").
8. **N9, N10**: the CLI quotes the node id; -0.0 is sent as 0.0; a padded
   result URL is refused.
9. **Agents' billing note**: `describe_node` adds `billing` on Space routes
   (the ZeroGPU docs' $1 per 10 minutes past the quota on PRO, Team and
   Enterprise; Nebula prices it at $0). The spend gate is unchanged, pending
   a product decision on whether agents ask before runs that can bill a PRO
   account.
10. **Dialog**: the focus trap treats the dialog itself as outside (Tab goes
    to the first control, Shift+Tab to the last); every failure line is
    centred in the stage in the neutral colour, the toolbar status is empty,
    there is no reset; no download for a gone or a load failure; GM's No
    WebGL2 line; a load failure gets "Nebula couldn’t load this splat. Try
    again in a moment." and Try again, which remounts the viewer and keeps
    focus in the dialog; another node's gone splat gets GM's line k. The
    late-cancel path disposes quietly.
11. **Framing at the extremes**: the radius is at least 3 times the
    98th-percentile Gaussian scale, so one Gaussian or a splat whose centres
    are all equal opens outside it; orbit zooms in to 0.2 of the radius;
    near and far follow the object's scale (1 mm and 10 km both frame).
12. **Copy**: "Speridlabs" on the full World v2 summary; readiness with a
    token shows only "Runs on your own Hugging Face allowance."; "Explore
    “{name}” in 3D"; no "Splat download" label; GM's lines 4a-k; "open
    Details to see why".
13. **Docs**: spatial-foundation (framing, the v1-style card, real-GPU
    timing), idol.md (step 2's quote, the GPU-limit rule, the token-refused
    row), the user guide (seed range, "small free daily allowance", no "any
    seed works"), PROVIDER-ROUTES, MCP-SETUP, the pricing notes.

### Decisions and corrections

- **M21 stays an equivalent mutant**: dropping `math.isfinite` changes
  nothing, because NaN fails `low <= value <= high` and so does infinity.
- **The focus trap fix covers the World v1 dialog too**: both use
  `hooks/useDialogFocusTrap.ts`.
- **Round 2's notes overclaimed**: "every card line in the idol.md table"
  wasn't all GM's; the token-unusable line was mine. GM's r2 character lines
  replace it now.
- **A base flake fixed**: the WorldEnvironmentViewer test's R3F mock made a
  new `get` per call, which re-ran the load effect on each render and failed
  the camera test under load. The mock's `get` is stable now, as R3F's is.
- **The backend trims `HF_TOKEN` on save** (PUT `/api/settings` and the
  desktop `credentials_update`), so a token saved by an agent's settings
  write or an older client is clean too, not only the Settings field's.
- **The billing note is facts, not a gate**: it says who can bill and how
  much; whether agents ask before runs that can bill a PRO account is a
  product decision still pending.
- **`fetchFailure` is module-private** (react-refresh lint: a component file
  exports only components and types).

### Live check (isolated, 2026-10-30)

Backend 8793 (temp HOME, settings, state and output; outbound HTTP to a dead
proxy) and Vite 5793, headless Chrome on the real GPU (ANGLE Metal, Apple M5
Max), 8000-8010, 5173 and every Hugging Face host blocked (the 8000 canary
was blocked). No request reached a Hugging Face host and Run was never
clicked. The token phase used a fake token saved through PUT
`/api/settings` with spaces and a line break around it; settings.json held
it trimmed.

- Without a token: the Settings row reads "Hugging Face / Needed to run
  Idol." with "Add key"; readiness reads "Hugging Face token · Needs a
  Hugging Face token" (warning) with GM's detail; the selection toolbar's
  and the context menu's Run are disabled with GM's lock reason; the
  switcher row shows GM's note and "Add key →".
- With the token: readiness shows only "Runs on your own Hugging Face
  allowance."; Run is enabled; the switcher shows "Connected".
- One Gaussian opens outside it (47% of the stage height), 4,096 Gaussians
  at one centre fill 63%, and the 1 mm and 10 km objects frame like the
  1 m one (75%, the same as the synthetic ball).
- Gone, damaged, a 500, and no WebGL 2 each show their own line, centred
  (0 px off) in the neutral colour, with an empty status and no reset;
  download only for damaged and no WebGL 2. Try again on the 500 loaded
  the splat in 1.4 s, with focus still in the dialog.
- 0 page errors.


## Round 4 (2026-10-30): review fixes and GM's r5 and r6 rulings

Built from the round 4 brief and GM's r5 and r6 rulings, copy verbatim.

### Nothing runs without the token (GM r6)

- `lib/runKeyLock.ts` holds every lock line: the node's own
  (`routeKeyLockReason`), the canvas's (`canvasKeyLockReason`, "You can run
  this canvas after you add your Hugging Face token in Settings.") and
  Accept's (`acceptKeyLockLine`, "You can accept this after you add your
  Hugging Face token in Settings."). `keyLockedProps` gives a locked control
  `aria-disabled`, the reason as `aria-describedby` and `data-key-locked`
  (one not-allowed cursor, in `styles/disabled-buttons.css`). Nothing is
  natively disabled, so every locked Run keeps its focus and its tooltip.
- The toolbar's Run locks for the whole canvas and reads the lock reason as
  its scope line. The selection toolbar, Inspector and context menu lock a
  node's run when it would run Idol (Idol itself or a node it feeds,
  through `nodesThatRun`).
- Every run path in the store (`refuseKeyLockedRun`, ahead of the
  unchosen-model check) shows the line as a neutral (`info`) notice and
  sends nothing: Cmd+Enter, the palette's "Run graph", a node's own run.
- Proposal Accept locks on the first still-not-ready run node whose route
  needs the key (`useProposalReadiness`). The backend refusal stays.
- `nebula quick` and `/api/quick` refuse before the spend check with
  "Nothing ran, so nothing was spent." plus the route's line.

### What changed, by item

1. **GM r5/r6 copy**: readiness "Hugging Face token · Needed"; the Auto row
   "Auto · needs a key"; the switcher's key button "Add key for Hugging Face
   in Settings"; the chip's name "Provider for X: Auto." plus the lock
   reason, never "Can't run"; GM's node description; "a few runs a day";
   "Nebula couldn’t download the splat. Try again."
2. **Keyless strings** stay in code behind the route switch, unshown, with a
   neutral TODO to re-rule them with the design reviewer using the first
   live run's numbers.
3. **Signed-in duration**: shows the token-not-applied line
   (`duration_token_not_applied_error`); the signed-in duration line stays in
   code, unused.
4. **Settings check**: `ProviderCheck.refuse_before_sending` refuses a token
   with an inner bad character with the Settings field's line, without a
   request. `get_api_key` treats a whitespace-only key as unset.
5. **Missing Space**: `hub_says_missing` follows `huggingface_hub` 2.4.0's
   order (GatedRepo, "Access to this resource is disabled.", RepoNotFound,
   then a 401 that isn't the bad-token message). A bare 404 isn't missing.
6. **Download**: asks for `Accept-Encoding: identity`; Content-Length is
   compared only for an uncompressed body; a gzip or deflate body is kept.
7. **×20,000 object**: `objectUnitScale` draws an object at unit radius
   before framing, so the zoom-out limit stays in range.
8. **OrbitControls** are made in an effect and disposed; StrictMode's second
   render left a copy that doubled every wheel step.
9. **The failure line is announced once** (no `aria-describedby` on a
   failure; the alert carries it).
10. **Agents' billing note**: find_nodes rows, start_here, `nebula info`
    (BILLING line) and SKILL.md.
11. **Docs**: idol.md (switching back to keyless in four steps, admission
    separate from the charge, the runs-a-day table as a floor, the
    `duration_factor` sources), PROVIDER-ROUTES, the Speridlabs guide,
    spatial-foundation. Private tracker ids and names are gone.

### Decisions and corrections

- **Toolbar.test's store mock** now gives its node a `data.definitionId`:
  the toolbar reads node definitions for the canvas lock.
- **One click guard per surface**: SelectionToolbar's `runSelection` had a
  second `keyLock` check behind its only caller's; the mutation check showed
  it couldn't fail, so it's gone.
- **The live-check seed**: a project's snapshot is saved while it is open,
  then another project is opened and the seeded one opened again. Saving a
  project that isn't open is refused (409), and an open project's save is
  replaced by the live canvas on the next switch unless it is reopened.

### Seen in the live check, not changed

- Without the token, Idol counts as paid: the toolbar's chip reads "3 paid",
  the proposal "Runs 1 paid model", "No list price" and "Accept & run (1
  paid)". The cost row marks a route that can't run as paid with no price.
  Idol is free within the allowance; this needs a design ruling.
- The proposal bar sits above the 3D viewer dialog and covers its help line.

### Live check (isolated, 2026-10-30)

Backend 8793 (temp HOME, settings, state and output; outbound HTTP to a dead
proxy) and Vite 5793, headless Chrome on the real GPU (ANGLE Metal, Apple M5
Max); 8000-8010, 5173 and every Hugging Face host blocked (both canaries
blocked). No token. 0 Hugging Face requests, 0 run or accept requests, 0
page errors, 0 console errors. Run and Accept were never clicked.

- Readiness: "Hugging Face token · Needed", with GM's detail.
- Switcher: "Auto · needs a key", the Speridlabs row's note with "a few runs
  a day", "Add key for Hugging Face in Settings"; the chip's name ends with
  the lock reason.
- Selection toolbar Run (node), toolbar Run (canvas) and Accept: each
  aria-disabled, not disabled, `data-key-locked`, not-allowed cursor,
  focusable with `:focus-visible`, its line as title and description.
- Cmd+Enter and the palette's "Run graph": the canvas line as a polite
  status notice; no request.
- The ×20,000 object at the zoom-out limit fills 51% of the stage height,
  the same as the 1 m ball (51%); it opens at 79%, the same as the ball.
