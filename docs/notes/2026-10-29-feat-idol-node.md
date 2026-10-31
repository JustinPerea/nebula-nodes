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

## Round 5 (2026-10-30): one run-plan lock, dialogs over the bar, GM's r7 and r8

Built from the round 5 brief, review r4 and GM's r7 and r8 rulings, copy
verbatim. The "(1 paid)" labels stay as they are: GM moved "Accept and run"
to the later cost-row round.

### One rule for every scope (review r4 MEDIUM-1, GM r8 items 1-2)

- `lib/runKeyLock.ts` `runKeyLockLine(nodes, edges, scope, settings)` is the
  one lock: it reads the nodes the run would run (`lib/runScope`
  `nodesThatRun`) and locks only when one is a real Idol without its token.
  The toolbar's Run, the selection toolbar, the Inspector, the context menu
  and the store's run paths (Cmd+Enter, the palette, a node's run, a replay)
  all call it. `runKeyLockNodeLine` is the same rule with Idol's own line
  for every scope (Run History, the held "Run now").
- The bug was the toolbar alone: it locked over every node on the canvas,
  while the store already refused over the run plan. A canvas run skips an
  agent's placeholder and what needs it, so a placeholder Idol next to Text
  locked the toolbar while Cmd+Enter ran Text.
- **The two selection cases GM asked about: neither was the bug.** Export
  alone is locked because its run pulls in the Idol that feeds it. Export
  with Text is open because a selection runs only the selected nodes
  (`executeCluster`), so Idol isn't in its plan. Tests pin both, and both
  pass on f9124269.
- **Open for GM:** the person's own Run of a placeholder Idol, or of a node
  it feeds, locks. That run makes the placeholder real and runs it (the
  placeholder dialog first), and the backend refuses it the same way. Read
  literally, "a placeholder never locks anywhere" would leave that Run open
  to a sure refusal. Shot: `1440-r5-placeholder-direct-run.png`.
- The backend already validated after `_skip_placeholders`;
  `tests/test_idol_run_scope.py` pins both sides of it.

### Accept reads its own run (review r4 LOW-1, LOW-2)

- `lib/proposalAcceptLock.ts`: the canvas as Accept leaves it (the
  proposal's nodes at the values Accept writes, the proposed param changes,
  both sets of wires), over the run Accept starts (one node with what feeds
  it, several with their ancestors), with the keys set now. The bar's hook
  (`useProposalAcceptLock`) follows the settings, so removing the token
  locks Accept on a proposal made while it was set.
- The store's `accept` refuses the same way, before anything is sent, with
  GM's Accept line as a neutral notice. That covers every accept path.

### Run History and "Run now" (GM r8 item 3)

- Rerun, Retry and "Rerun with latest source", and the held "Run now", are
  aria-disabled, focusable, with Idol's line as title and description; a
  click does nothing. `runDeferred` and the replay paths refuse with a
  notice as the backstop.
- `historyRunKeyLock` lives in `lib/historyRunKeyLock.ts`, not the graph
  store. Imported from the 500 KB store, it made the ratchet's test G walk
  the store from RunHistoryPanel: 183 s for that one file, past the 120 s
  limit.

### Dialogs over the proposal bar (GM r7)

- The notice region takes no layer of its own (`position: absolute`,
  `z-index: auto`): a fixed box would make one layer of all its items. Each
  item carries its own: the notices `--sr-layer-notice` (20010, above every
  dialog, GM r25), the proposal bar the new `--sr-layer-proposal`, one under
  `--sr-layer-modal`, the lowest layer any modal uses (60). html, body and
  #root are the viewport and never scroll, so absolute places it as fixed
  did.
- A dialog's Tab order skips the bar (`noticeTabbables`); it sits under the
  scrim.
- Checked: every modal root in `tests/proposalBarStacking.test.ts` (the Idol
  and World v1 viewers, mesh viewer, prompt dialogs, command palette,
  keyboard shortcuts, model picker, result comparison, lightbox, Commons
  prompt, personal warning, onboarding, mask painter) is above the bar and
  under the notices. Live: the viewer and the palette over a live proposal,
  and a notice over the viewer.
- Follows from it: popovers at 60 or more (the provider switcher, the
  Commons leave menu), the following bar (1002), the chat model picker
  (1100) and the drag layer now draw over the bar where they meet it.
- At 1440×900 the 3D viewer's panel covers the bar's spot entirely, so the
  bar is not seen at all there; under the palette it shows dimmed through
  the scrim.

### The rest

- GM r8 item 4: a compressed download that won't decode (httpx
  `DecodingError`) says "Nebula couldn’t download the object from Idol. Try
  again in a minute." It keeps the call's facts (`with_call_facts`).
- GM r8 item 5: no run counts. The readiness detail is "Add your Hugging
  Face token in Settings to run Idol.", the switcher row "Free with a
  Hugging Face token."; idol.md has "Open: can a free account run Idol at
  all?"
- NIT-3, Spark's "No target" on Escape mid-drag: Spark 2.1.0's
  `driveSort` sets a timer that calls itself after the renderer is disposed.
  The teardown now cancels it (`stopSparkSorting`: clear the pending
  timeout, mark nothing dirty) before `disposeSparkQuietly`. Nothing is
  swallowed.
- NIT-1 (the orbit-sync deps mutation, M15) is killed by a camera-swap test.
- `nebula nodes` prints the `BILLING:` line; find_nodes and MCP-SETUP list
  `billing`.

### Tests and checks

- New tests fail on f9124269, except those that pin behaviour that was
  already right: the selection cases, the store's Cmd+Enter with a
  placeholder, the backend's run plan, the keyless helpers and the M15
  test. Those were checked by mutation instead.
- Mutations: 32 cases on the new guards, all killed.
- Two existing tests changed for the new layers. `agentPresenceFollowups.r27`
  put its notices in the first slot, which is now the bar's (skipped by a
  dialog's Tab order); it uses the canvas notice's slot.
  `agentPresenceFollowups.r34deferred` stands in uiStore as it stands in the
  graph store.
- Live check, isolated as round 4: 0 Hugging Face requests, 0 run or accept
  requests, 0 page or console errors, both canaries blocked.

### Follow-ups

- `uiStore` reads localStorage unguarded as it loads (`loadCanvasPref`,
  `loadOnboarded`). A tab with site data blocked throws there. Out of scope
  here; the other loaders already guard.
- The "(1 paid)" labels on a route that can't run, held for the cost-row
  round.

## Round 6 (2026-10-30): the bar between what the person opened and the chrome, GM's r9 and r10

Built from the round 6 brief, review r5 (stacking and a11y, run lock and
viewer, backend and docs) and GM's r9 and r10 rulings.

### The stacking rule (GM r10, r9 item 2)

- GM's rule, now the comment beside `--sr-layer-proposal`: anything the
  person opened draws above the proposal bar, and lasting chrome they didn't
  open draws under it.
- `--sr-layer-proposal` is `calc(var(--sr-layer-panel) - 1)` (9): under
  every panel, Settings, context menus and popovers, the chat model picker,
  the drag layer and every modal. The new `--sr-layer-ambient` (8) is one
  under it: the bottom bar (`.toolbar`) and the canvas tabs. The bottom
  bar's open Canvas actions keeps its popover layer (40), since the person
  opened it.
- The following bar keeps 1002 over a modal's scrim (the mask painter,
  review 3 LOW-3 of PR #200). With a proposal showing and no modal portal
  open, a `body:has(...)` rule drops it to the ambient layer, so where the
  two meet the proposal bar is on top. With a modal open the bar is under
  that modal's scrim anyway.
- Nothing stops at the bar's top edge (GM r10). Settings keeps its full
  height at 1280 (16 to 784 of 800).
- Make room (GM r9 item 2): the stack never grows into the top bars.
  `lib/bottomBar.ts` `keepNoticesBelowTopBars` writes `--notice-room` (from
  the region's bottom line up to `floatingTopLimit`, the line floating
  panels stop below) and caps the stack with it. Past it the region is
  `data-notice-crowded` and the stack scrolls. Items never shrink
  (`flex-shrink: 0`). Measured live at 1440×900: the following bar ends at
  64, the bar starts at 686, 622 px apart; with 14 probe notices the stack
  stops at 150 (the selection toolbar's line) and scrolls.
- Left as they were, since they never meet the bar: the workspace rail and
  panel launcher (12, left edge), the agent notes chip (46), the offline
  banner (10000, above dialogs by design).
- `tests/proposalBarStacking.test.ts` pins both sides. It checks the rule
  comment, the tokens, each surface GM named, the cascaded layer of the
  toolbar, the tabs and the following bar (with and without a proposal and
  a modal), the derived modal roots (review r5 NIT-1: every `<ModalPortal>`
  and `aria-modal="true"` element's layered root, so a new dialog is checked
  without a list), and no stacking context on the region, its stack or its
  slots (review r5 LOW-3, with the reason in noticeRegion.css).

### The bar behind page-hiding modals (review r5 MEDIUM-1, GM r10 item 2)

- `lib/modalFocus.ts` `hideBehind(own)` is the one isolate for the tour and
  the result comparison. Every body child behind the modal goes inert and
  aria-hidden, as before, and now the proposal bar's slot does too.
  `restore()` puts each element's own attributes back. The slot is the
  bar's container, so a leaving proposal's own `inert` is never touched.
- `inNoticeAboveDialogs(node)`, next to `noticeTabbables`: a notice yes, the
  bar no. The two modals' focus and key traps use it, and so does
  `noticeKeys`, which used to keep a key on the bar from reaching the
  dialog's trap (Enter then pressed Accept).
- On close, focus goes back to whatever opened the modal, never to the bar.
- Live (1440): with the tour open, the slot is inert and aria-hidden, the
  AX tree shows only the tour's three buttons, focusing Accept puts focus
  back on the card, and Enter sent nothing. A probe notice stayed usable.
  On close, focus is back on "Open help and onboarding".

### GM r9's other items

- Item 1, the locked text buttons. `.run-history__replay` (Rerun, "Retry
  failed", "Rerun with latest source") wasn't in
  `styles/disabled-buttons.css`. Its sheet's slava ink (`--sr-ink`) won, so
  a key-locked Rerun kept its white label. It is in the shared ghost list
  now, and its own `opacity: 0.4` is gone (the ratchet's sweep list shrank by
  one). "Run now" was already in the filled list. After the merge of #198
  the shared rule paints GM r33's tokens: Rerun and Retry take the ghost
  `--disabled-label`, "Run now" the filled `--disabled-fill-label` on
  `--disabled-fill`. Live (before the merge, same 0.55 white): locked Rerun
  `rgba(255, 255, 255, 0.55)` unfocused and focused, ring 2px white on top.
- Item 3, expiry with the viewer open: **no notice.** A proposal that
  expires (`pruneExpired`, or the backend's `proposalClosed` "expired")
  leaves the bar silently, viewer or not. Follow-up below, not built.
- Item 4: `tests/idolRunScope.test.tsx` pins the person's own run of a
  placeholder Idol: it locks with Idol's line and sends nothing.

### Found in the live check: Idol's not-ready line stayed after the token

- After adding the token in Settings, Accept unlocked but the bar still read
  "You can run Idol after you add your Hugging Face token in Settings."
  The backend sends Idol's route line as the row's `missing`, and
  `stillNotReady` only cleared rows worded "needs <key>". It now also clears
  a row whose `missing` is the node's own `missingKeyLine` once the key is
  set. The old test's fixture used find_nodes' wording; a new one uses the
  backend's.

### Run lock, viewer, storage, backend and docs

- LOW-1, Spark's running sort: `disposeSparkWhenSettled` waits for a sort
  already running (polls every 16 ms, gives up at 2 s) before disposing.
  The error filter is unchanged. Live: 6 Escape-mid-drag cycles, 0 page
  errors.
- LOW-2: the reviewer's probe is `tests/proposalRunScope.test.ts`, and a
  RunHistoryPanel test removes the token after the first render and sees
  Rerun relock.
- LOW-3: every localStorage read and write in uiStore is guarded with a safe
  default (an unreadable "onboarded" reads as done). The r34deferred mock is
  gone; `tests/uiStoreBlockedStorage.test.ts` imports the store with storage
  throwing.
- NIT-1: Run History's lock map is rebuilt from the records, the keys and
  `placeholderKey(nodes)` (the ids of the live placeholders), so a drag
  doesn't rebuild it. A replay with no lockable node returns at once
  (`canKeyLock`).
- Backend: idol.md points to L116 (the xlarge quote, checked at d035e18f) at
  both spots, and lists `nebula nodes` with its BILLING line. The three
  mixed tests are split into keyed and keyless halves. With step 1 applied
  in a scratch copy, every keyless test passed and 15 keyed tests failed, as
  step 3 says. The BILLING dedupe has a test: two rows with one note give
  one line naming both ids.

### Merge of main (#198, 38bb573a)

Merged `origin/main` into the branch in this round. Every conflict, and how
it was settled:

- `ContextMenu`, `SelectionToolbar`, `DeferredRunNotice`, `Inspector`,
  `RunHistoryPanel`: #198 put each run control on the canvas lock
  (`lock.act`, `lockedAction`, "You can rerun it when the run finishes.");
  this branch had a key lock on the same controls. One helper decides both
  now, `withKeyLock` in `lib/runKeyLock.ts`: the canvas lock first (a run
  going, the following bar, offline), then the control's own disabled state,
  then the missing key. A run going leads because it ends by itself; the
  token line comes back when it does (a RunHistoryPanel test pins both).
- `canvasProposals.ts` and `runScope.ts`: #198 moved the chip to
  `formatChipEstimate`, which writes a free run as "~$0". The PR #203 r1
  ruling keeps "$0" for a closed, sourced 0, so both call it after that
  check. #198's chip table (`tests/pr198Fix2Money.test.ts`) pinned a closed
  0–0 run chip and proposal card as "~$0"; it now expects "$0" for those
  two, and the shared formatter keeps "~$0". An open 0–0 is #198's
  "$0 + unpriced" (this branch's old "$0+" test moved to it). Open question
  for GM: the closed 0–0 chip's tooltip still reads "Estimated cost".
- `styles/disabled-buttons.css`: both lists kept, on #198's
  `:not([data-held-pending])`. Round 6 adds `.run-history__replay` to the
  ghost list.
- Auto-merged: `noticeRegion.css` (#198's agent-log clearance on `right`),
  the notice slots (the new scene slots). The held-notice 150 ms look
  doesn't touch the key lock: a key lock never sets `data-held-pending`.
- `tests/lockedTextButtonsInk.test.ts` reads #198's tokens.
- #198's lock ratchet (`agentPresenceFollowups.ratchet`, G) didn't know
  `withKeyLock` and flagged the four wrapped run controls. It counts
  `withKeyLock(<lock spread>, …)` from `lib/runKeyLock` now, as it counts
  `lockedAction`, and a new test reads its body: props a lock disabled come
  back unchanged, and it never writes `disabled`. A wrapper around a plain
  object, or one from another module, is still caught.
- #198's scan for ids in quotes (`test_pr198_fix12`) caught this branch's
  splat-summary 404, `Node '{node_id}' not found`; it reads
  `Node {node_id} not found` now, as main's do.
- Live check rerun on the merged tree (isolated 8793/5793): same numbers as
  before the merge (gap 622 at 1440, 522 at 1280; context menu z 40 and
  Settings z 30 over the bar; Rerun locked at 0.55 white, focused too; the
  tour hides the bar; Accept unlocked with no stale line after the fake
  token). In phase b the key field once didn't open in time, and saving
  the fake token failed three times with the browser's
  `ERR_FAILED` on `/api/settings` (the request never reached the backend)
  before it saved; the app's own `updateSettings` from the same page saved
  every time. Logged as a harness flake under load, not a merged-tree bug.

### Tests and checks

- New tests fail on 457da822, except those that pin behaviour that was
  already right: "Run now"'s grey label (it was already in the shared
  list), the placeholder's direct run, the reviewer's probe, Rerun
  relocking when the token goes, the backend splits and the BILLING dedupe.
  Those were checked by mutation.
- Changed for the new layers: `agentPresenceFollowups.r29` put its notices
  in the first slot (the bar's); it uses the canvas notice's slot, as r27
  does.

### Follow-ups

- A proposal that expires raises no notice, with the viewer open or not
  (GM r9 item 3). The bar just leaves. A notice ("Claude Code's proposal
  expired") would sit above dialogs.
- When the notices outgrow the room, the stack scrolls from the top (the
  bar first), so the newest notice at the bottom can be out of view until
  scrolled. That needs 10+ notices at once.

## Round 7 (2026-10-30): Idol back to keyless, agents ask first with a token, GM's r11 to r13

One live call with no token (approved by Justin) ran: every request 200,
27.6 s, a valid 65,536-Gaussian splat, the Space on `zero-a10g` and
`app.py` still at `duration=120`. The token-required state (rounds 4 to 6)
rested on the 180 s inference, so the route went back to keyless, the
original decision. idol.md's "What the live call showed" lists what it
didn't settle: 120 or 180 s, the pool a call with no X-IP-Token draws on,
the refusal texts, and whether a fine-grained token with no permissions
applies the person's quota.

### Keyless (brief section 0, GM r12)

- The route: `keys: []`, `optionalKeys: ["HF_TOKEN"]`, no `missingKeyLine`,
  empty `envKeyName` and `directKeyName`, in nodeDefinitions.ts and the JSON
  mirror. Route tables and MODEL_REFERENCE regenerated.
- Every no-token lock and refusal is gone: Run on every surface, the
  canvas's Run, Accept, Run History, `nebula quick` and the engine's
  preflight. No auth header goes out without a token.
- The key-lock machinery stays for keyed routes (`lib/runKeyLock`,
  `withKeyLock`, the history and proposal locks, the backend's
  `route_unavailable_line`). No shipped node has a `missingKeyLine` now, so
  its tests run on Idol's keyed shape made for the test
  (`frontend/tests/helpers/keyedSpace.ts`, `keyIdolInEachTest`).
- GM r12's copy, verbatim: readiness ("Hugging Face · Free" / "Hugging Face
  token · Saved"), the switcher and its Auto row, the Settings helper, the
  node description, the user guide's line and the no-token allowance-out
  line (the quota and the Space-limit refusals alike). No run counts and no
  allowance numbers in any copy. The refusal texts are re-ruled once one is
  seen live; nothing forces one.
- r1's error mapping is kept. That a server-side call carries no X-IP-Token
  and may draw on the Space's own pool is written as an inference.

### Agents ask first with a token (brief section 1)

- `RouteSpec.mayBillWithKey` (validated by the route checks: true only on a
  keyless route with `optionalKeys`). `node_route.may_bill` is true with
  one of its optional keys set; `agent_spend.decide` refuses an agent's run
  that includes such a node at any limit and says to propose it. The
  person's run passes. The price stays the sourced $0; spend tracking never
  counts it.
- Every agent route goes through `_require_spend_approval`, so execute,
  execute-node, graph/run (`nebula run`, MCP `run_nodes`) and quick are
  covered (`test_idol_may_bill.py`). Agent-facing text:
  `HF_SPACE_BILLING_NOTE`, describe_node, find_nodes, start_here, `nebula
  info`/`nodes`, SKILL.md, MCP-SETUP.md.

### GM r11: the money copy

- `node_route.key_billing` / `directRoute.keyBilling`: "mayCost" with the
  token, "free" without, None for any other route. The proposal's cost has
  `mayCostRuns` and `mayCost` [{name, account}]; `freeRuns` no longer
  counts them. `RunScopeSummary.mayCost` on the canvas side.
- Chips: "1 may cost" alone, "2 paid · 1 may cost" beside paid nodes with no
  list price. A priced chip keeps its amount and its tooltip ends with
  "Idol can use your Hugging Face credits." (a question for GM below).
  Without a token nothing is added, like any free node.
- Accept reads "Accept and run" with a count chip ("1 paid", "2 paid · 1
  may cost"). The bar's cost line: "Runs Idol · may use your Hugging Face
  credits", "Runs 2 paid models (google) and Idol · ~$0.40 · Idol may use
  your Hugging Face credits".
- The estimate line leaves Idol out (`main._estimate_proposal_run`): Idol
  alone has no estimate, so the bar shows only "expires in 8:01".
- "$0" by source, not value: `estimate_run` and the canvas's run scope say
  `sourcedZero` when every priced row is 0; its tooltip is "This costs
  nothing to run.". An estimate that rounds to zero keeps "~$0".
- The bar's inline lock line for a keyed route is the Accept line ("You can
  accept this after you add your Hugging Face token in Settings."),
  `notReadyBarLines`. The brief calls it moot for Idol; it is built for
  keyed routes since the machinery stays.
- Agent names never wrap: one `.agent-name` class (styles/agent-name.css)
  on every place a name is drawn, inline spans in sentences included.
  `tests/agentNameNoWrap.test.ts` lists them.

### One lock order (GM r11 item 3, review r6 LOW-1, LOW-2)

- `withKeyLock` now leads: a missing key comes first, then canvasLock's
  run, following, offline, then the control's own state. It strips the
  canvas-lock marks, so a key-locked control has no following or offline
  look, and it is focusable (aria-disabled).
- The toolbar's Run and Accept go through it too. The ratchet accepts
  `withKeyLock` only from `lib/runKeyLock` (anchored path).
- `tests/keyLockOrder.test.tsx` pins the order on the selection toolbar,
  the Inspector, the context menu, the deferred-run notice and the
  toolbar's Run, each running, following and offline, key missing and set
  (the Inspector's run lock, mutant M13, included). Accept and Run History
  have theirs in `ProposalBar.test.tsx` and `RunHistoryPanel.test.tsx`.

### Modals (GM r13, review r6 item 6)

- `ModalPortal` isolates the page behind any `aria-modal` dialog it holds
  (inert plus aria-hidden on every sibling, the canvas included), watching
  with a MutationObserver, and restores it on close. Notices stay reachable.
- Focus goes back to the opener, or to a `fallbackFocus` the dialog names.
  Out of scope but needed: the dialog's own cleanup runs before the
  portal's, while the page is still inert, so the onboarding tour's and
  ResultComparison's own focus return couldn't land. Both moved into
  ModalPortal, which quiets one focusin so the dialog's trap doesn't pull
  focus back.

### Stacking (GM r13, review r6 NITs)

- NIT-1: the Agent log's room was taken twice (the region cleared it and
  `body.agent-log-reserved .proposal-bar` shifted the bar again), so the bar
  sat 62 px off its stack at 1024. The bar rule is gone.
- NIT-2: the Updates list draws over the bar (it doesn't stop above the
  stack) and keeps its room; the arrival card still stops above it.
- The Agent log's layer follows its state: the collapsed chip and the
  "hidden" notice are ambient (8), under the bar; the expanded log is 11,
  over it. A test for each.
- NIT-4: a crowded stack is capped below the offline banner
  (`offlineBannerLine`, re-measured when the connection changes).
- NIT-5: `tests/runHistoryLockMemo.test.tsx` pins the lock map's deps at the
  panel: a drag reads nothing again, a placeholder reads it once more.

### Tests renamed (review r6 NIT-2)

- Tests that pin the keyed machinery say so ("a keyed Space route without
  its key (Idol's keyed shape)"); no test named "keyless" runs on a keyed
  route.

### Questions for GM

- A priced chip with Idol keeps its amount and says "may cost" only in the
  tooltip, not "~$0.40 · 1 may cost".
- The mixed cost line puts the amount before Idol's clause.
- The bar's actions wrap to a second row only when the who line and the
  buttons can't share one.
- `.agent-name` caps a very long custom name at 16em with an ellipsis.
- With no token, the Settings caveat (r11, unchanged per r12) still says
  "Idol runs on your Hugging Face allowance", where a run with no token uses
  the shared GPUs. And the saved row's manage view keeps the shared "Key
  page ↗" link that the edit view dropped.
- No shipped node has a sourced $0 except Idol, which the money copy now
  leaves out, so "$0" with "This costs nothing to run." can't show today.
  The rule stays for the next node priced at $0; the shot is staged.

### Found in the live check

- At 1024 the bar's text column collapsed to one character ("pro / poses"):
  `overflow-wrap: anywhere` on the column made every line's min-content a
  character wide, so the actions never wrapped. The "who" line is
  `white-space: nowrap` now, so the column is never narrower than it and
  the actions take their own row when both can't fit
  (`agentNameNoWrap.test.ts` pins the three rules).
- At 1024 the collapsed Agent log chip (z 8) and the bar (z 9) don't meet:
  the bar ends at x 618, the chip starts at 668. Nothing to move.

### Tests changed by the isolation

- ModalPortal now isolates the page behind the pin composer too. Five pin
  tests found its status line by role while it rendered inline (no notice
  region in the test), so behind the dialog; they mount NoticeRegion as the
  app does, where the line stays reachable.
- Two tests read the old "Accept & run (1 paid)"; they read "Accept and
  run" and the count chip.
- The helper `useKeyedIdol` became `keyIdolInEachTest` (the hooks lint rule read the
  `use` prefix as a React hook).

## Round 8 (2026-10-30): one cost class read live, GM r14 and r15, review 7

No live call to the Space. The live check ran on an isolated backend and Vite
with a fake token; nothing was run or accepted.

### One cost class, read with the keys set now (GM r15 items 1 and 2)

- `node_route.key_billing` (frontend `directRoute.keyBilling`) is the one
  answer for a `mayBillWithKey` route: "mayCost" with the token, "free"
  without. The chips, the bar's cost line, the ghost card, the confirm before
  the person runs over an agent's placeholder and the agent listing all read
  it.
- `canvas_proposals.cost_for` takes the person's keys as a required argument
  and `ProposalBook.view` as a required keyword; the keyless branch is gone.
  `backend/tests/test_cost_for_keys_ratchet.py` reads every backend caller
  (AST) and fails on a call without keys or with a literal `{}`/`None`; it
  proves itself on a planted file.
- A proposal's key-billing runs are re-read on every view (`live_cost`, from
  the params they were priced with, kept on the proposal as `key_params` and
  never shown), so adding or removing the token changes an open proposal's
  bar, chip, ghost card and listing (review 7, NIT-5). The canvas does the
  same once Settings has loaded (`canvasProposals.liveKeyBilling`,
  `hooks/useLiveProposalView.ts`).
- Ghost card: "may cost · Hugging Face" with the token, "free · Hugging
  Face" without. Its may-cost style is the neutral one: only `--paid` has a
  colour.
- Placeholder confirm: with no token an Idol placeholder adds no paid
  confirm; with one it is a "may cost" row and still asks (the button reads
  plain "Run", since no price is known). Until Settings has loaded, keys
  unread, it counts as paid, as before.

### GM r14 copy

- Settings helper wraps (`ProviderRow wrapSummary`, set when the summary is
  the note) and never ends in "…"; the new caveat verbatim.
- The mixed bar: line 1 "Runs 2 paid models and Idol · Idol may use your
  Hugging Face credits" (no provider tag; proposals without Idol keep theirs
  until the wording batch), line 2 "~$0.13 · List prices, not a quote ·
  expires in 14:59" (`canvasProposals.proposalMetaLine`). The bar still puts
  "Adds N nodes · " ahead of line 1 when the proposal adds nodes.
- Accept chip tooltip and the toolbar Run chip's tooltip:
  "“Nano Banana” and “Nano Banana 2” call paid providers. Estimated cost
  $0.13. Idol can use your Hugging Face credits." (`runScope.mixedCostTitle`,
  `canvasProposals.acceptChipTitle`). No "~" inside the sentence. The chip
  reads "~$0.13 + 1 may cost"; the Accept chip keeps its counts. The bare
  "Estimated cost" line is gone from the mixed tooltip; the tooltips with no
  Idol keep it.
- The Run button's title and screen-reader description put Idol's sentence
  after the estimate (review 7, NIT-4).
- Manage view: "Open Hugging Face tokens ↗" (the key's own link words) in
  place of "Key page ↗".
- `.agent-name`: every place that cuts it at 16em now carries the full name
  in both `title` and `aria-label` (15 spans; `agentNameNoWrap.test.ts`
  checks each).

### Staged code: what stayed (GM r14 item 6)

Both staged paths live in shared helpers, not Idol branches, so both stay:

- The sourced "$0" and its tooltip: `runScope` (`runChipLabel`,
  `runChipTitle`, `SOURCED_ZERO_TITLE`) and `canvasProposals.proposalEstimateLabel`.
  Any node priced at a sourced $0 reaches it.
- The key lock lines: `runKeyLock` (`runKeyLockLine`, `withKeyLock`) and
  `proposalAcceptLock`. Any keyed route without its key reaches them, through
  Run and through Accept.
- `frontend/tests/sharedKeyedPaths.test.ts` exercises each through the shared
  helper on a synthetic keyed route that isn't Idol
  (`synthetic-keyed-route`, `REPLICATE_API_TOKEN`), so a later Idol-only
  shortcut can't pass them and they can't rot.

### Agent surfaces (review 7, may-bill LOW-1, NIT-2, NIT-3, NIT-4, LOW-3)

- Billing text follows the token: "Free here: no HF_TOKEN is set, …" or "May
  cost here: the person's HF_TOKEN is set, …" (`main.hf_space_billing_note`),
  and `optionalKeys[].set` reads the shared predicate. MCP names
  `propose_change`; the CLI names `` `nebula propose` `` (`_cli_words`, also in
  `format_billing_line`). MCP docstrings for run_nodes, find_nodes,
  describe_node and propose_change say the classes are live.
- The refusal says why and what to do: Idol is in the run and the token is
  set; propose the run, or run only nodes that don't need it. The
  conservative rule (anything after Idol is refused too) is unchanged; it
  waits on a product decision.
- One "token is set and usable" predicate: `node_route.key_text`/`key_set`,
  frontend `directRoute.keyText`/`isKeySet`, both checked against
  `backend/tests/fixtures/key_text_cases.json`. The gate, the handler's
  `clean_token`, the settings auth header and character check, and Settings'
  save all use it, so a BOM or zero-width-only token is unset everywhere.
- Mutants from review 7 killed: the "every limit off" case and the Cinema
  shot route (`/api/cinema/generate-shot`), both now in
  `test_idol_may_bill.py`. Stale pointers fixed (mayBillWithKey's doc,
  `run_hf_space`'s docstring, the test module docstring, MCP-SETUP's "Accept &
  run (N…" and the main.py comment).

### Modals (GM r15 items 4 and 5; review 7 copy MEDIUM-1, LOW-1 to LOW-3, NITs)

- A press that closes a dialog no longer moves focus, fixed in ModalPortal
  for every dialog: the portal notes the pointerdown or mousedown being
  dispatched; when a dialog closes inside it, a mousedown's default is
  prevented, and for a pointerdown the mousedown still to come is prevented
  until the press ends. A grep finds three dialogs that close on a press: the
  command palette and the model picker (mousedown) and Keyboard shortcuts
  (pointerdown); the onboarding backdrop already prevents its own. The
  toolbar's and result card's outside-press menus aren't dialogs and keep
  their behaviour. The test runs the browser's default (a blur) by
  hand, since jsdom doesn't.
- Focus goes to the nearest opener still on the page, up the chain of
  dialogs (`openersOf`), then the dialog's fallback, with a visible ring
  (`focusVisible: true`). Live: palette opened from the rail's Search with
  the mouse, closed by a real mouse press on its backdrop: focus on Search,
  `:focus-visible`, a 2px outline.
- The return runs a microtask after the close. React hears no events during
  a commit, so a return made in the cleanup never reached the opener's own
  `onFocus` (NIT-5); and StrictMode's remount cancels the queued return, so
  "?" in dev keeps focus in Keyboard shortcuts (NIT-1). The quiet focusin is
  gone: `modalFocus.returnFocusTo` sets `isReturningFocus()` for the one
  call, and the onboarding and comparison traps ignore that move.
- `hideBehind` is reference-counted per element (`hiddenBy`), so stacked
  dialogs close in any order and leave the page as it was (LOW-2; 2 and 3
  dialogs, six orders). A dialog that becomes aria-modal after mount
  isolates the page (NIT-2, test added).
- The ratchet resolves an import to its real module path (`isLibModule`,
  posix resolution), so `../evil/lib/runKeyLock` no longer passes (LOW-1).

### Tests changed by the microtask return

- Ten existing tests read focus right after a close (OnboardingOverlay six,
  ResultComparison three, ResultsGallery one); each now flushes the
  microtask first (`await act(async () => {})`). modalPortalIsolation and
  proposalBarBehindModals do the same.
- `test_node_readiness.py` pins `services.settings`' direct imports; it now
  imports `services.node_route` for `key_text` (standard library only, no
  network), so the pin lists it.

### Mutants

- 41 written (16 backend, 25 frontend), all killed. Four needed more: the
  describe row's `optionalKeys[].set` read a raw truthy value (an
  invisible-only token case now pins it); StrictMode's cancelled return
  (the page's inertness alone stopped a stray return, so a dialog opened
  from a notice, which stays usable, pins it); the store passing the loaded
  keys to the placeholder confirm (`graphStore.idolPlaceholder.test.ts`);
  and the CLI words in `start_here`'s notes (the first mutant didn't
  compile).

### Questions for GM

- The ghost card's "may cost" style is neutral; only paid has a colour.
- A may-cost placeholder row in the confirm reads "may cost" with no price,
  so the confirm button reads plain "Run".
- Tooltips with no Idol in them still start with the bare "Estimated cost"
  line.
- "Adds N nodes · " stays ahead of the mixed line 1 when the proposal adds
  nodes.
- In the manage view the longer "Open Hugging Face tokens ↗" pushes
  "Remove" to a second row at Settings' width ("Key page ↗" fit on one).

## Round 9 (2026-10-30): one key state, one cost class, one tooltip formatter (GM r16, r17, review 8)

No live call to the Space. The live check ran on an isolated backend (8793)
and Vite (5793) with fake keys, ports 8000-8010 and 5173 blocked (canaries
blocked), every Hugging Face host blocked; nothing was run or accepted.

### One key state (GM r17 item 1; review 8, LOW-1)

- `services.settings.load_settings` returns every key as `node_route.key_text`
  gives it and drops one that's empty once trimmed. Every backend reader goes
  through it, so a token already stored as only spaces or invisible
  characters reads as unset everywhere: the gate, the handlers,
  `describe_node`, and the masked GET /api/settings the canvas caches. The
  GET mask no longer trims on its own (a mutant showed it was dead code once
  the load does it).
- PUT /api/settings and `/api/credentials/update` refuse such a key (400 and
  422) with "This key is only spaces or invisible characters once trimmed.
  Copy it again, then paste it here." and keep what was saved. Every other
  key is stored trimmed, not only `HF_TOKEN`. A Hugging Face token with a
  character no token has gets the Settings field's own line. GM hasn't
  worded the invisible-only line; only API callers see it, since the field
  disables Save.
- The switcher's "key is set" (`providerSwitch.isSet`) is
  `directRoute.isKeySet`; it used `.trim()`, which keeps a zero-width space.

### One cost class (review 8, LOW-3, NIT-1 and NIT-2)

- `may_bill` is `key_billing(...) == MAY_COST`. `main._space_billing` reads
  `key_billing` for the route (`describe_node` passes each route's id), so a
  keyed route on another handler gets its note from the class, not the
  handler.
- New `node_route.key_billing_account` and `key_billing_label` (frontend
  `keyBillingAccount`, `keyBillingLabel`) name the account and build the
  card's label for `cost_for`, `agent_spend.may_bill_reason`,
  `liveKeyBilling` and the Run chip. `mayCostAccount` is gone.
  `backend/tests/fixtures/key_billing_cases.json` (generated from the
  backend) pins both sides.
- Only `key_billing` reads `mayBillWithKey`: the backend ratchet
  (`test_cost_for_keys_ratchet.py`) and the frontend one
  (`tests/idolRound9.test.ts`) fail on any other reader, and each proves
  itself on planted files. The backend ratchet also catches `dict()` and a
  name bound to an empty mapping.
- Both billing notes now state the downstream rule: an agent can't run it
  "or any run that includes it, even for a node after it".

### The estimate and the re-ask (GM r17 item 2; review 8, LOW-2)

- `model_pricing.estimate_run` skips every key-billing node, so the
  proposal's, the run's and the placeholder confirm's estimates all leave
  Idol out (`_estimate_proposal_run`'s own filter is gone). The re-ask over
  an Idol-only placeholder has no total line, as the first ask.
- The 409 counts by class: "This run includes 1 node that may cost, …" or
  "2 paid nodes and 1 that may cost"; only paid placeholders keep the old
  sentence.

### One cost tooltip (GM r16 item 3, r17 items 3 and 4; review 8, copy LOW-1)

- `runScope.costTitle` builds every cost tooltip: line 1 names the paid
  nodes, priced or not, then the priced part as a sentence; each reason on
  its own line under it; the may-cost sentence last. `mixedCostTitle` and
  `paidChipTitle` are gone. `pricing.chipTitle`'s closed forms are
  sentences: "Estimated cost $0.13.", "Estimated cost $0.", "Estimated cost
  under $0.01.".
- Tooltips that changed:
  - Toolbar Run chip and the selection toolbar's chip (both
    `runChipTitle`): every form now leads with the paid nodes; "~$X" reads
    "“A” calls a paid provider. Estimated cost $X." (was the bare
    "Estimated cost"); "+ unpriced" adds the paid lead and the reason lines;
    "N paid" (nothing priced, or prices not loaded) now has a tooltip, the
    paid lead and its reasons; a past-the-ceiling chip has the paid lead
    (it had none); a sourced $0 reads "“A” calls a paid provider. This
    costs nothing to run.".
  - The mixed Run chip beside Idol no longer needs a priced line: with only
    unpriced paid nodes it reads "“Writer” calls a paid provider.\n“Writer”
    has no listed price.\nIdol can use your Hugging Face credits." (copy
    LOW-1; `runScope.test.ts` pins it).
  - The Accept chip: a tooltip whenever its count shows (it had one only
    with a may-cost node), from the same formatter, with the Run chip's
    reason lines. The live check read the same text on both chips.
- The Accept chip's reasons come from the backend: `estimate_run` returns
  `reasons` per node (noPrice, cantRun, awaitingInput, missingKey with its
  `keys`, leftOut with its `plus`), and `_proposal_cost` puts each paid
  node's on its cost entry as `reason`. Every run case in
  `pricing_cases.json` now has `expected.reason`, and both estimators are
  held to it. A proposal made before this falls back to "no listed price"
  for its unpriced refs. Reasons read left to right: a new node by its
  ghost's position, a canvas node by where it sits (`canvasAt`).
- Line 1 of the bar wraps and is never cut (GM r16 item 4): no rule for
  `.proposal-bar__summary` clips it (pinned); live at 760 px it took two
  lines, nothing clipped.

### Every tab hears a key change (review 8, NIT-3)

- PUT /api/settings, DELETE of a key and `/api/credentials/update` broadcast
  `{"type": "settingsChanged"}` with no values. `store/settingsChangedSocket.ts`
  (imported by App) turns it, and a reconnected socket, into the same
  'nebula:settings-saved' signal a save in this tab sends, so App's settings
  cache, provider readiness and the zoom manifest read GET /api/settings
  again.
- Live: an open proposal read "Accept and run 2 paid"; a PUT of a fake
  token from a second client flipped it to "Accept and run 2 paid · 1 may
  cost" and "Runs 2 paid models and Idol · Idol may use your Hugging Face
  credits" with no reload (a window marker survived, one navigation entry);
  a DELETE flipped it back. A backend test does the same with a real second
  socket.

### The refusal per surface (review 8, NIT-4)

- `agent_spend.propose_hint` is in MCP words: "Propose it instead:
  propose_change (run: n2). The person accepts on the canvas, and the
  canvas runs it." The quick hint names `edit_canvas`, then
  `propose_change (run: <node id>)`. `cli/formatter._cli_words` turns
  "propose_change (run: a, b)" into `` `nebula propose --note "<why>" --run a
  --run b` `` and `edit_canvas` into `nebula apply`; `cli/client._fail`
  prints every refusal through it.

### Manage view (GM r16 item 5)

- [Replace key] and [Remove] on one row; the key's page on its own line
  under "Saved key ending in …", as the edit view shows it. Every provider
  uses this component, so OpenAI and the rest put "Key page ↗" there too
  (its accessible name is now "Key page", the arrow hidden as on Hugging
  Face's). Live at Settings' 400 px: both buttons on one row, nothing
  wrapped or clipped, for Hugging Face and OpenAI. Krea's sign-in row and
  Nous's are separate components and unchanged.

### Review 8's coverage NITs

- `isReturningFocus` stays: with a comparison open, ordinary focus leaving
  it is pulled back, and `returnFocusTo` a target outside it isn't
  (`tests/modalFocusReturn.round9.test.tsx`, kills M18). A spy pins
  `focus({ preventScroll: true, focusVisible: true })` (kills M19). A Run
  History replay of the synthetic keyed route locks with its line
  (`sharedKeyedPaths.test.ts`, kills M21).

### Base check and mutants

- Every new behaviour test fails on b9a2ace9 (83 backend, 27 frontend). The
  three coverage pins for M18, M19 and M21 pass there, as they should: they
  pin code that was already right.
- 40 mutants written (22 backend, 18 frontend). First pass: B5 (the GET
  mask's own trim) survived and turned out to be dead code, now removed;
  B20 (no leftOut reason) and B22 (no reason on the entry) survived and
  have tests now; B11 needed a unique anchor. Second pass: all killed,
  except one equivalent mutant on the simplified mask (`v.strip()` on a
  value the load already trimmed).

### Questions for GM

- A sourced $0 now reads "“A” calls a paid provider. This costs nothing to
  run.", by the one rule. It reads oddly; say if a sourced $0 should drop
  the paid lead.
- "N paid" chips, which had no tooltip, now name their paid nodes and
  reasons.
- The invisible-only refusal line ("This key is only spaces or invisible
  characters once trimmed. Copy it again, then paste it here.") is mine.

## Round 10 (2026-10-30): one cost class with the plan and the sourced $0, refusals per surface, key changes in place (GM r18, r19, review 9)

No live call to the Space. The live check ran on an isolated backend (8793)
and Vite (5793) with fake keys, ports 8000-8010 and 5173 blocked (canaries
blocked), every Hugging Face host blocked; nothing was run or accepted.

### One cost class (GM r18 item 1, r19 item 1; review 9, cost MEDIUM-1)

- `model_pricing.cost_class` (frontend `lib/costClass.ts`) gives every node
  that calls a provider one class: a key-billing route's own (`mayCost` or
  `free`), else `plan` for a run on the Krea plan, else `free` for a sourced
  $0 (USD, exactly 0, nothing left out), else `paid`. `estimate_run`,
  `cost_for`, the billing note, the placeholder gate's lists, `live_cost`,
  `summarizeRunScope`, `liveKeyBilling` and the placeholder dialog read it.
  `pricing_cases.json` `classCases` pins both sides; `CLASS_PARTS` in
  `test_idol_round10.py` and `ALLOWED` in `tests/idolRound10.test.ts` fail on
  a second reader of `key_billing`/`uses_krea_account` that counts a node.
- A plan run is never paid: its own reason kind `plan` on both sides
  (`expected.reason` on the plan cases), the line "“Krea 2” runs on your
  Krea plan.", proposal entry `kind: "plan"` ("on Krea plan"), `planRuns`
  beside `paidRuns`. Chips: "2 paid · 1 on Krea plan", "1 on Krea plan",
  and beside a priced part "amount + N on Krea plan · N may cost".
- A sourced $0 is free: never in "N paid", the paid lead or the figure. Its
  proposal entry is "free · <provider>" with price {0, 0}. A run of only
  those reads "$0", tooltip "This costs nothing to run." alone.
- The placeholder dialog's gate reads no prices, so a run over an agent's
  placeholder on the Krea plan still asks, as before; a sourced $0
  placeholder (none ships today) would ask too. Left as is.
- Every tooltip keeps GM's order: paid lead, figure, reason lines, Idol's
  sentence. An unknown reason kind reads as "has no listed price" in both
  `entryReason` and `reasonSentences` (review 9, NIT-2).

### One formatter for the Run buttons (GM r19 items 2 and 3)

- `describeRunScope` is "Runs N nodes." and then `runChipTitle`: no
  per-node breakdown. Toolbar and selection toolbar titles and
  screen-reader text use it; only the costly-run confirm keeps per-node
  figures. The ratchet (`ALLOWED`) fails on a new caller of the sentence
  builders or of `formatUsdRange` outside the confirm and the two price
  rows.
- Accept: the chip's tooltip sits in a hidden span the button's
  `aria-describedby` names (after the key lock's line); the name stays the
  visible text.
- 760 px: `.proposal-bar__actions` shrinks to the bar and the primary
  button wraps; the chip moves under "Accept and run" (measured: 1440 and
  1024 one line, 760 own line, inside the bar, nothing clipped).

### Refusals worded where they are written (review 9, keys MEDIUM-1)

- `services/agent_words`: one table of each surface's calls, `surface()`
  from `X-Nebula-Surface` (the CLI sets `cli` on every request; anything
  else is MCP), `worded()`, `propose_run()`, and `cli_words()` for MCP-worded
  data the CLI prints (word boundaries; a name already beside its `nebula`
  command is kept). The two `_cli_words` tables are gone. `_fail` prints the
  detail as it came. The header is no agent marker; `person_gate` is
  untouched. Every `*_REFUSAL` is tested for both surfaces, and `nebula
  quick` now says `` `nebula create <id>` ``.

### Settings and the signal (review 9, keys LOW-1 to LOW-4, NITs; GM r19 items 5 to 7)

- `settingsChanged` goes through `broadcast_browser` (an agent socket never
  hears it) with `keys`: the names whose value changed (`_changed_keys`),
  never a value.
- Checks are kept; only a changed key's result clears: from the signal's
  keys, from a save here, and from any read that finds a key changed
  (`uiStore.setSettingsCache`, which used to clear them all). A check still
  running drops the result of a key changed meanwhile.
- An open panel re-reads on `remote`/`reconnect` and updates in place. A
  row with focus in it or its edit view open keeps its section (its status
  changes where it stands) until left; other rows move with the spring
  (`settings-row--moved`, off under reduced motion). Drafts are untouched.
  The tab badge counts keys as saved, so it can read one more than
  "Connected · N" while a row is held.
- Link names: `keyLink` on every provider, the provider's own word, shown
  in both views: "Open OpenAI keys ↗", "Open Replicate tokens ↗", "Open
  Google Cloud service accounts ↗", "Open fal.ai keys ↗" (fal.ai is the
  name, not a domain). "tokens" where the provider calls its credential a
  token (Replicate's API tokens, Hugging Face), else "keys"; Vertex takes a
  service-account file, so its page is "service accounts".
  The switcher's price rows are sentences (r19 item 4); "Priced from the
  input’s size when it runs." and "No list price for these settings." got
  periods to match.
- PUT and DELETE start from `load_saved_settings` (the file plus defaults),
  so untouched, unknown and non-string entries are written back as they
  were; keys are trimmed on read and on write.
- GM r18 item 3: PUT's 400 is "Nothing was saved because the key is empty
  once spaces and invisible characters are removed." The desktop bridge's
  422 uses the same constant but can't reach a person: Settings disables
  Save for such a key, and `settingsWrites.storableKey` (the backend's rule,
  `storeCases`) is checked before `bridge.set`. If it ever got through, the
  row would show "The key couldn't be saved. Your text is still here; try
  again."
- `describe_node`'s per-route billing row follows the class (review B12).

### Base check and mutants

- On 2bc98de3: 24 of 38 backend tests fail (the 14 that pass are coverage
  pins: storeCases, the ratchets' planted files, B12, MCP-worded quick);
  `idolRound10.test.ts` and the Settings file fail to import
  (`costClass`, `settingsSignal` don't exist), and 6 more frontend tests
  fail. The render pins for C8, N1, N4 and N8 pass there, as they should.
- 51 mutants (32 frontend, 19 backend), including review 9's C8, C11, C12,
  N1, N4, N8, B2 and B12. First pass: F3 (a $0 with a left-out cost), F28
  and F29 (switcher titles), B13 (`_fail` rewriting MCP words) survived; B6
  needed a unique anchor. Tests added; second pass: all killed, plus B6b
  (`live_cost`'s plan count).
- The full backend run caught two things the file-level runs didn't.
  `keyLink` sits after `label` in each catalog entry, because
  `test_error_copy_round3d` reads the label straight after the key. The
  signal test now waits for the hello's `proposalSync` before it starts
  listening: the hello goes through the socket's receive loop, the marker
  through the portal, so on a busy run the marker came back first and the
  tab wasn't the person's yet.

### Questions for GM

- The toolbar chip beside an unpriced part reads "$0.07 + unpriced + 1 on
  Krea plan" (the r14 "amount + N may cost" shape with the open suffix).
  Say if it should drop a "+".

## Round 11 (2026-10-30): one chip rule, merged reasons, Krea's one verb, every class in the CLI (GM r20, r21, review 10)

No live call to the Space or any provider. The live check ran on an
isolated backend (8793) and Vite (5793) inside a macOS `sandbox-exec`
profile that denies every outbound connection but localhost, with the dead
proxy kept as well. Canaries: a sandboxed Python reaching api.x.ai,
api.meshy.ai, api.ideogram.ai, huggingface.co and 1.1.1.1:443 got "Operation
not permitted"; the backend's own key check (`/api/health/providers?refresh=true`
with fake OpenAI, Google and Anthropic keys) answered "ConnectError: All
connection attempts failed" for each. The browser couldn't run inside the
sandbox (Chrome's own sandbox won't start nested), so it sends everything but
127.0.0.1:5793/8793 to a dead proxy; its canaries to 8000, 5173, api.x.ai and
api.meshy.ai were blocked. Nothing was run or accepted.

### One chip rule (GM r20)

- `costClass.costChip(money, classes)` writes every chip: "+" joins money
  (the amount and "unpriced", from `formatChipEstimate`), "·" joins classes
  (`classCounts`). The Run chip (`runChipLabel`) and the Accept chip
  (`acceptCountChip`) both use it: "$0.07 + unpriced · 1 on Krea plan",
  "2 paid · 1 on Krea plan", "~$0.13 · 1 may cost".
- That last one changes r14 item 4's "~$0.13 + 1 may cost" by the same
  rule; the user guide and idol.md say so. Question below.
- A sourced $0 shows no chip, as a free run doesn't (r20 item 1). Its Run
  button tooltip stays "This costs nothing to run."; a local free node's
  says "No paid providers.", as before. The bar's `proposalEstimateLabel`
  "$0" branch and the backend's `summarize_cost` `sourcedZero` branch were
  dead (a sourced $0 is never priced) and are gone (review 10, NIT-1);
  `classCases` pins `sourcedZero` beside a plan run (B4).

### Merged reason lines (GM r20 item 2)

- `costTitle` merges line 1 with the reason group naming exactly the paid
  nodes: "“Writer” and “Editor” call paid providers that have no listed
  price." Line 1 with a figure stays apart (the figure says more than the
  names), and so does any group naming other nodes. With only the merged
  line left, Idol's sentence joins it on the same line, as in the priced
  shape.
- noPrice uses GM's words (`PAID_NO_LISTED_PRICE`). Another kind uses
  `PAID_AND`: "“A” calls a paid provider and is priced from its input,
  which isn’t ready yet." That's builder's wording (question below).
- The backend gives the same reasons; `classCases` now carry
  `expected.reasons` and `expected.title`, read by both runners: the merged
  pair, a sourced $0 beside an unpriced node (merged), and a left-out cost
  beside a missing price (apart). `leftOut` is pinned (NIT-2).

### Quoted names, Krea's one verb (GM r20 item 3, r21)

- `node_readiness.instance_missing_line` quotes the name at the source, so
  every bar and layer warning has it: "“Krea 2” needs your Krea plan. Sign
  in to Krea in Settings." Route lines get the quoted title too
  (`route_unavailable_line(title=)`). A node with no name keeps "This node",
  unquoted. Agents keep `missing`; the HTTP and MCP answers carry the quoted
  `person` beside it (MCP-SETUP says so).
- "Sign in to Krea in Settings" everywhere that was "Connect your Krea
  account": the engine's preflight message, the connector's not-connected
  errors, MCP's Krea discovery hint (it still adds "Only the person can sign
  in to Krea" when the detail says "sign in"), the Inspector, provider
  readiness, the switcher ("“<Node>” runs on your Krea plan. Sign in to Krea
  in Settings, or choose another provider.", r21 item 6) and the Krea guide.
- The Krea key row is "Krea · API key" (r21 item 7). The key notices name a
  label that already ends in "key" once: "Krea · API key saved.", never
  "Krea · API key key saved." (`settingsWrites.keyNoun`; "Krea · usage key"
  had the same doubling before).
- "Add a Anthropic" is gone: the Settings fallback reads "Add your
  Anthropic API credential in Settings."; the other lines that put an
  article before a provider use `withArticle` ("an OpenAI", "an xAI").

### The CLI and the other agent surfaces (review 10, MEDIUM-1, LOW-1, LOW-2, NIT-4)

- `cli/formatter._cost_line` counts each class on its own, in GM r21 item
  1's words: "up to 1 paid run (fal) and 1 on the person's Krea plan, $0.03
  at list prices", "1 run on the person's Krea plan". A plan run is never
  free, never "runs locally", never in the figure. A free run that calls a
  provider names it from its entry's label ("1 free run (on fal.ai)").
- The journal's `proposal.created` has `planRuns` and `mayCostRuns` beside
  `paidRuns`. `start_here`, `nebula context` and `nebula look` print no run
  cost, and MCP's propose_change and get_proposal answers carry the counts
  as JSON, so nothing else needed a change.
- propose_change's description lists the classes from
  `model_pricing.CLASS_ENTRIES` (`<<COST_CLASSES>>`, filled in before the
  tool registers); a test holds the table to the four classes and to the
  keys `summarize_cost` writes.
- The words: `agent_words.WORDS` holds `projects` and `withdraw` too, and
  `main._start_node_notes`, `project_client` and `canvas_proposals`'
  READY_NODES_*/WITHDRAW_* read it. `/api/agent/start` and project_client
  read the CLI's `X-Nebula-Surface` header, the one signal; `via` is gone
  from the route, the client and the commands.
- `nebula run`'s refusal (the Idol gate and a spending limit) is pinned over
  HTTP with and without the header (B14).

### Cost class reads (review 10, LOW-3, NIT-3, NIT-5)

- `cost_for`'s route-table branch reads the params as the router does, with
  the connected inputs (`with_wired_blockers`): a connected end image or keyframes
  takes FLUX 3 Video off the plan, as the estimate says (B6 pinned both
  ways).
- A ghost card's tag is in its cost class (`canvas_proposals._ghost_cost`):
  the run entry's kind, else the estimate's class for the node alone.
- The placeholder dialog's row for a sourced $0 reads "free"
  (`PRICE_FREE`), from the run estimate's new `free` ids (and the tab's own
  summary for an older backend).
- The spend gate's `may_bill_nodes` reads `model_pricing.cost_class`; the
  ratchet now lists `may_bill` with no reader outside the tests. A test
  walks every registry node, each route's `_provider`, and three key sets,
  and finds the gate and `node_route.may_bill` agree on all of them, so its
  reach is unchanged.

### Settings (review 10, copy MEDIUM-1, MEDIUM-2, NIT-6, NIT-7; GM r21 items 2 to 4)

- Held rows live in `settingsDraftStore.heldRows`, so the tab badge counts
  the sections as shown (`rowHelpers.shownConnected`, r21 item 3).
- The person's own save from a held row moves it and puts focus on the
  moved row's trigger when focus was in it (`focusRowAfterMove`; M21).
- A key removed elsewhere while its manage view is open: `KeyRow` derives
  the edit view in that render and the store follows. A held row (focus in
  it) keeps its place and the field takes focus; any other row moves and
  mounts already open, taking no focus. The redundant focus guard went:
  the mutant on it was equivalent.
- One polite live region (`[data-key-changes]`) says each change made
  elsewhere once: "Replicate key saved." / "Replicate key removed.".
- A non-object `apiKeys` reads as no keys and is never overwritten: a key
  write and a key's DELETE get 409 KEYS_UNREADABLE, a save that writes no
  key keeps it as saved; a file that isn't an object refuses every write
  (SETTINGS_UNREADABLE). Builder's wording, question below.
- The signal test covers a tab whose hello had a wrong token and a socket
  that never said hello: neither hears `settingsChanged`.
- The keyLink test renders once and pins each provider's own word (M7);
  reduced motion is pinned (M20); the debug `console.log` is gone.

### The bar (review 10, copy LOW-1)

`.proposal-bar__actions` wraps, right-aligned. Live, at 700, 760, 1024 and
1440 every button is inside the bar and none is clipped; at 760 and 700
Accept takes its own line under Show and Reject.

### Base check and mutants

- On 5a237ba5 the new and changed tests fail: 27 backend, 24 frontend. The
  ones that pass there pin behaviour already right: B14's two refusals,
  B6's estimate class, the NIT-5 reach proof, the NIT-7 sockets, the plan-only
  line 1, the Accept chip and the LOW-2 hold. Mutants kill them.
- 42 mutants (19 frontend, 23 backend), with M1, M7, M20, M21, B4, B6 and
  B14. First pass: 39 killed. R20 (a route line without the quoted title)
  survived and got a test through `instance_missing_line`. F15 (the edit
  focus guard) survived because it was redundant; it's gone. F14 (`Add key`'s
  `aria-expanded={open !== null}`) is equivalent: the derived view means
  "Add key" only shows with nothing open.

### Gates

tsc, lint, check-node-contracts, contract-inventory, the model reference
and route tables checks, vite build and the budget, and the desktop tests
(temp HOME) pass. The full vitest found one stale tooltip pin
(`idolRound10.render.test.tsx`, the Accept chip before the merge); fixed,
the rerun is 702 files, 9,001 tests, 0 failed, 0 errors. The full isolated
backend: 12,818 passed, 2 failed on timing under load
(`test_acp_session` event-loop stall 0.87 s against 0.75 s,
`test_krea_mcp_server` stdio bridge deadline); both pass alone and with
their files (117 passed), and passed in the earlier full run.

### Questions for GM

- The chip rule turns r14's "~$0.13 + 1 may cost" into "~$0.13 · 1 may
  cost". OK?
- The merge for kinds other than noPrice: "“A” calls a paid provider and is
  priced from its input, which isn’t ready yet." OK, or keep those apart?
- The two settings.json refusals: "Nothing was saved because Nebula can’t
  read the keys saved in settings.json. Fix “apiKeys” in that file, then try
  again." and "Nothing was saved because Nebula can’t read settings.json.
  Fix the file, then try again."
- Person lines still say "Add your Krea API token in Settings" while the
  row says "Krea · API key". Follow the row?
- The CLI's free part names where a provider call runs: "1 free run (on
  fal.ai)", and beside other classes "2 free (1 on fal.ai)".

## Round 12 (2026-10-30): each tab knows its own key change, the 409 names the file, the provider's own nouns (GM r22, r23, review 11)

No request to any host but localhost, control runs included. Backend
tests, the frontend gates and the live backend ran inside a macOS
`sandbox-exec` profile that denies every outbound connection but localhost.
Before anything else ran, a sandboxed Python reaching api.x.ai,
api.meshy.ai, api.ideogram.ai, huggingface.co and 1.1.1.1:443 got
"Operation not permitted". The browser can't run inside the sandbox, so
CDP blocks 8000-8010, 5173, hf.space, huggingface.co and the provider check,
and sends everything else to a dead proxy; its canaries (8000, 5173,
api.x.ai, api.meshy.ai, huggingface.co) were blocked. Fake keys only;
nothing was run or accepted. One slip, early in the round: `npm run lint`
ran outside the sandbox and npm's update notifier reached
registry.npmjs.org (a version check, no package installed). From then on
every frontend command ran sandboxed with the notifier off.

### Each tab knows its own key change (review 11, copy MEDIUM-1)

- The structure: a per-tab id, not a record of this tab's writes. A record
  matched by value can't tell this tab's write from a write elsewhere of
  the same value in the same moment, and needs a rule for when to forget
  an entry. An id names the writer whatever the order and value.
- The id is the one the canvas already had: `lib/tabId.ts`, which apiFetch
  sends on every write (`X-Nebula-Tab`) and graphSync echoes as
  `edit.tab`. `main._writing_tab` reads it from the person's request (the
  same rule as `_graph_edit_origin`), and `settingsChanged` carries it as
  `origin` from PUT /api/settings, a key's DELETE and the desktop
  credential bridge. `store/settingsChangedSocket.ts` drops an event whose
  origin is this tab's, whether it lands before the write's answer or
  after.
- The first build kept a second id in `settingsSignal.ts` and set it on the
  three calls in `api.ts`. apiFetch then overwrote the header with
  `tabId.ts`'s id, so live every echo read as a change made elsewhere and
  the person's own save was said twice. The unit tests passed because they
  took both ids from the same module. The live check caught it from the
  socket frames: the PUT's header and the frame's `origin` matched, but the
  socket compared against the other id. Now there's one id, and
  `tests/idolRound12.tabEcho.test.ts` sends the save, the removal and the
  credential write through the real apiFetch and replays the header it sent
  as the echo.
- A remote change landing while this tab's write is in flight: Settings
  defers the read until the writes settle (`readAfterWrites`), and the
  Providers tab announces only on the first read after the latest signal
  (`settingsDraftStore.reads`). Tested in both orders for save and removal,
  with a change elsewhere during the write announced once.

### Settings (review 11, copy LOW-1, NIT-2; GM r22 item 3, r23)

- Re-adding a key removed elsewhere no longer leaves a focus request
  waiting: `focusRowIfItMoves` asks for focus only when the row moves, and
  `settleRowFocus` clears any request two frames after the write settles
  (LOW-1).
- The badge and "Connected · N" read one source,
  `rowHelpers.connectedRows`: key rows by `isKeySet`, Krea when its status
  isn't "disconnected" (so while it signs in too), Nous by a current check
  (NIT-2).
- The 409 lines name the settings file by its full path
  (`settings.settings_file_path()`: NEBULA_SETTINGS_PATH when set,
  `expanduser().resolve()`). Settings shows that line in the row
  (`settingsWrites.unreadableSettingsLine`) for a key save, a removal, a
  field and the run-cost confirm; any other failure keeps its own line.
  Agents can't write settings (`require_person` runs first), so only the
  person ever sees these lines; MCP and the CLI need nothing new.
- An `apiKeys` that holds nothing (null, [], "", false, 0) is replaced by a
  key write and a key's DELETE (`saved_keys_hold_nothing`,
  `saved_keys_writable`); content Nebula can't read keeps the 409 (GM r23
  item 2).
- Hugging Face says "token": "Hugging Face token saved." / "Hugging Face
  token removed." / "Hugging Face token saved. Checking it now.", and the
  row's buttons "Add token", "Replace token", "Save token", "Saved token
  ending in" (`keyNoun`, `spec.credential`; GM r23 item 3). Every other row
  keeps "key".
- The Krea sign-in row: "Uses your Krea plan instead of an API key", no
  period. The readiness detail: "This recipe uses Krea sign-in. Sign in to
  Krea in Settings; an API key doesn’t replace it." (GM r23 item 4).
- Settings.test's first render waits up to 5 s (NIT-6).

### The words (GM r22 items 1, 2, 4, 5; r23 item 1; review 11 LOW-2, copy LOW-3)

- "~$0.13 · 1 may cost" is pinned on the Run chip; the proposal wording
  stays.
- Person lines say "Krea API key" on both sides
  (`person_line.KEY_NAMES`, `directRoute.KEY_NAMES`, the readiness
  labels), and the guides follow. The grouped lines read "Black Forest
  Labs, fal.ai or Krea API key".
- MCP sends the person to "Settings > Providers > Krea", in the refusal and
  the docstring.
- The Inspector's and readiness's Krea verb is pinned (F15, F18).
- The CLI's free tag uses the provider id, as the paid part does. (Corrected
  in round 13: beside a paid run the code prints "1 paid run (google) and 1
  free (fal)", which GM r25 item 1 confirms; "1 free run (fal)" is the free
  part alone. Local runs beside a provider call read "2 free (1 fal, 1
  local)" since r24.)

### Agent surfaces and the gate (review 11, HIGH-1, LOW-1, NIT-1 to NIT-8)

- HIGH-1, option a: unreadable keys read as none for the gate and the
  run, and Idol runs keyless. Two tests name it: the gate and the handler
  see no token, and no handler or backend module reads a provider key
  from the environment. Option b would be one check before
  `agent_spend.decide`.
- `agent_words.surface(headers, query_via)`: start_here reads an older
  CLI's `?via=cli` only when X-Nebula-Surface is missing; the header wins
  (LOW-1).
- `nebula load` sends the CLI header, and `graph_file_client._words` builds
  from `agent_words.WORDS` (`size`, `delete` and `open` added); the `via`
  parameter is gone (NIT-3).
- `canvas_proposals.class_counts`: a kind Nebula doesn't name counts as
  paid, as propose_change's description says, never free. The gate reads no
  kind, only the cost class, so it already agreed. The canvas's
  `liveKeyBilling` counts free from kind "free" too (NIT-4).
- NIT-5, documented, not changed: in desktop mode every save writes `{}`
  over the file's `apiKeys`. Keys live in the Keychain there and no reader
  uses the file's, so a key left in the desktop file is removed rather
  than kept as plain text. idol.md says so beside "never overwritten".
- start_here's data notes are reworded for the CLI before the Krea and
  provider notes are added in the surface's own words (NIT-7, S7).
- A PUT that only echoes masked keys while the keys are unreadable writes
  no key and keeps them (NIT-8, T5).
- G5 (cost_class checks the plan before key billing) and G6 (the ratchet
  entry removed with the gate reverted) are killed by tests that pin the
  order and the entry. S4 (`_NAMED` without "projects") is killed through
  `cli_words` (NIT-1, NIT-2).

### The notice region beside the rail (review 11, copy LOW-2)

While the workspace rail shows, `.notice-region` keeps clear of its column
on the left (`--notice-rail-clearance`: rail left + width + the gap) and by
the same width on the right (or the docked Agent log's clearance, if
wider), so a notice that fits stays centred. No layer changes: the rail's
labels, menus and popovers stay above the bar. Live at 700, 740, 1024 and
1440 the bar never touches the rail (16 px at 700 and 740), and the rail's
"Add nodes" label still shows over it at 700. With the Agent log docked
at 700, the bar is 272 px wide.

### Base check and mutants

- On 14538996 the new tests fail: 32 backend, 22 frontend. The ones that
  pass there pin behaviour already right and asked to be pinned: the 409
  for content Nebula can't read, a masked-key echo, desktop mode, no
  environment fallback, the CLI words for the reviewer's calls, a Krea
  plan route counted by its key, an unknown kind read as paid by
  propose_change, "~$0.13 · 1 may cost", the toast's noun template, the
  bar's layers, the Inspector's Krea verb (F15), another 409's own line,
  and the tab id carried on writes and a change elsewhere being said.
  Mutants kill them.
- 46 mutants (19 backend guards and the reviewer's G5, G6, S4, S7 and T5;
  26 frontend, F15 and F18 among them), each run against focused tests that
  all passed unmutated first. 43 killed on the first pass. F3 (a read
  landing during a write taken anyway) and F10 (Nous counted on a stale
  check) survived and got tests: a read from before the person's write
  that lands during it is dropped and read again once the write settles,
  and `connectedRows` counts Nous only on a current check. Both are killed
  now, and so is the old drop with no read again.
- F7 (`focusRowIfItMoves` always asks for focus), F8 (`settleRowFocus`
  does nothing) and F23 (the save always counts as a move) each survive
  alone: the three overlap. A handoff asked for when nothing moves is
  cancelled by ProvidersTab's own-save handler while focus is in the row,
  and by `settleRowFocus` two frames after the write otherwise. F7 and F8
  together fail the LOW-1 test. Three more tests that tried to separate
  them (a tab switch as the save lands, leaving Providers before it lands,
  stepping out of a held row mid-save) passed with the mutants, so I
  didn't keep them.
- The new `_writing_tab` rule (an id only from the person, by
  `_TAB_ID_RE`) is killed when any header text is taken as an id.

### Gates

All sandboxed. tsc -b and lint (eslint, inline styles, Slava CSS scope)
pass. Focused vitest: 48 files, 1,071 tests, 0 failed, 0 errors, no
timeouts. Backend: the round 9 to 12 files, the settings API, the
credential bridge and every test file touching `settingsChanged`,
`X-Nebula-Tab` or `_graph_edit_origin`: 838 passed. Earlier in the
round, the wider related set was 3,321 passed and 10 skipped. vite build
and the budget pass (459,738 bytes raw).
check-node-contracts, contract-inventory, the model reference and route
tables checks are current. No full suite ran on the Mac.

### Questions for GM

- Idol's free tag reads "(speridlabs)", the provider id, as GM r22 item
  5's shape gives it. "(Hugging Face)" instead?
- With local free runs beside a provider call: "2 free (1 on fal)". OK?
- The Krea key row's mode label still says "API token · API balance". Leave
  it, or "API key · API balance"?
- Hugging Face's buttons follow the noun too: "Add token", "Replace token",
  "Save token", "Saved token ending in". OK?
- Four Krea handler errors still say "Krea API token" (styles, training,
  renaming, job history). They are worded on their own (error-copy
  rounds); change them to "Krea API key" in a wording pass?

## Round 13 (2026-10-31): CI's two failures, every part tagged where it runs, one rule for long lists, an unreadable file never a 500 (GM r24, r25, review 12)

Base 485fb5e0 (round 12 with main merged). No request to any host but
localhost, control runs included. Backend tests, the frontend gates and the
live backend and Vite ran inside the `sandbox-exec` profile that denies
every outbound connection but localhost; a sandboxed canary reached none of
the providers first. The browser can't run inside it, so CDP blocks
8000-8010, 5173, hf.space, huggingface.co and the provider check, and sends
everything else to a dead proxy; its canaries (8000, 5173, api.x.ai,
api.meshy.ai, huggingface.co, api.krea.ai, api.replicate.com) were
blocked, and they were the only requests off 127.0.0.1:5793/8793. Every
npm and npx ran with the update notifier off. Fake keys only; nothing was
run or accepted.

### CI on 485fb5e0

- **test_file_access::test_graph_import_content_is_checked_before_clearing_graph.**
  The test was wrong, not the code. It asserts that nothing is called on
  the client before the content check, with a `Mock` client. Round 12's
  `graph_file_client` reads the client's own identity headers
  (`_identity_headers()`, so `nebula load` says it is the CLI) before the
  check. That is a local read that sends nothing; a `Mock` answers it with
  another `Mock`, which then failed the header merge. The test's `Mock`
  now answers it with `{"X-Nebula-Surface": "cli"}`, and the assertion
  that no request goes out before the check leaves that local read out.
  It failed on 485fb5e0 ("1 failed, 38 passed") and passes now (39).
- **test_cli_apply::test_arrange_from_the_builder_and_in_the_reply**, only
  in CI part 1. From `ci_shard.assign_files` (largest files first into the
  part with the fewest tests), part 1 has 144 files and 27 run before
  test_cli_apply. Of those, four open `/ws`: test_canvas_pins,
  test_agent_questions_persist, test_canvas_proposal_updates and
  test_canvas_proposals. The leak is test_canvas_pins'
  `test_websocket_sends_pins_after_graph_sync`: its client leaves while
  the handler is still sending, the handler is cancelled rather than
  getting `WebSocketDisconnect`, and `except WebSocketDisconnect` was the
  only place a socket was unregistered. The socket stayed in
  `manager.active_connections`, so `canvas_open()` was true for every
  later test in the process, and the arrange line said the open canvas
  would lay the nodes out. The other three each passed together with the
  arrange test.
  - The structural fix: the `/ws` handler unregisters in a `finally`,
    however the socket ends.
  - An autouse conftest fixture clears the canvas and agent sockets before
    and after each test (only once a test has imported `main`).
  - test_cli_apply's `api` fixture sets its own precondition (no canvas
    open), and a new test covers the arrange line with a canvas open.
  - Proof, on 485fb5e0: test_canvas_pins then test_cli_apply, "1 failed,
    65 passed"; with the fix, "67 passed". test_canvas_pins now asserts no
    socket is left after its `with` block, which fails on 485fb5e0.
  - Each layer alone: with the `finally` removed and the conftest reset
    kept, the pair passes; with both removed and test_cli_apply's
    precondition kept, it passes; with all three removed, it fails.

### Where each part's runs go (GM r24 items 1 and 2; r25 item 1)

- The CLI's runs line tags every part the same way: by where its runs go,
  as ids, with a count per id once there's more than one, local last:
  "1 paid run (openai) and 1 free (huggingface)", "3 paid runs (2
  anthropic, 1 krea) and 2 free (1 fal, 1 local)". It is built in one
  helper (`formatter._tags`) for the paid and the free part.
- Idol's cost entry says where it runs as `runsOn` ("huggingface", from
  `node_route.key_billing_host`); its `provider` stays "speridlabs", which
  every other reader keeps reading.
- "run" goes on the first class only and carries through the rest, and a
  class that stands alone keeps it (GM r25 item 1): "1 paid run (google), 1
  on the person's Krea plan and 1 free (fal)", "1 run on the person's Krea
  plan and 1 free (fal)", "1 free run (fal)". The one visible change from
  round 12: a line whose first class isn't paid now says "run" there ("2
  runs on the person's Krea plan and 1 free", was "2 on the person's Krea
  plan and 1 free").
- A cost without an entry per run (an older backend's) keeps its providers
  as listed.
- MCP-SETUP, idol.md, the round 12 note (corrected in place) and the saved
  CLI text quote what the formatter prints. The saved text,
  `scratchpad/idol/cli-free-tags-r13.txt`, has live lines from the
  sandboxed backend ("1 paid run (openai) and 1 free (huggingface), $0.13
  at list prices", "1 paid run (openai) and 2 free (1 huggingface, 1
  local)", "1 run on the person's Krea plan and 1 free (huggingface)", "1
  free run (huggingface)") and the formatter's own lines for the fal
  examples, since no shipped node is a sourced $0 on fal.

### Krea's words (GM r24 items 3 and 5; r25 item 2)

- The connection choice reads "API key · API balance" everywhere: the
  node definitions (both copies and the catalog script), the Settings
  default, readiness, both guides and the model reference.
- The four Krea handler errors (styles, training, renaming, job history)
  say "a Krea API key". A test fails on "Krea API token" anywhere in the
  handlers, services, `main`, `mcp_server` or `person_line`.
- The HTTP and CLI sign-in line names the row, as MCP does:
  `node_readiness.KREA_SIGN_IN` is "needs the Krea account signed in
  (Settings > Providers > Krea)".

### One rule for long lists (GM r24 item 6)

`errorCopy.countsInstead` is the one rule: up to 3 names, then a count.
`nodeNameList`, `agentNameList`, `quotedNames` and the proposal bar's
not-ready lines read it. In the bar, up to 3 nodes get a line each; from
4 it is one line, "4 nodes can’t run here yet.", and every node's line is
under the details toggle (`canvasProposals.notReadyShown`; round 14 names
it "Show the list" / "Hide the list").
It counts nodes, not the lines a key lock merges. The old "and N more in
the details" line is gone.

### The 409's path and the settings file (GM r24 item 7; review 12, LOW-2, LOW-3)

- The path shows the home folder as "~" ("~/.nebula/settings.json");
  anywhere else, a sibling folder that only starts like home included, it
  stays absolute (`settings.settings_file_shown`). The save lines are the
  person's alone (every settings write runs `require_person` first); the
  read line also reaches agents, through MCP `get_settings` and `nebula
  keys` (corrected in round 14, where agents get their own words).
- One resolved path for reads, writes and the line: `settings_file()`
  expands and resolves `SETTINGS_PATH`, which is also expanded where it is
  built. A "~" in NEBULA_SETTINGS_PATH was read as a folder named "~"
  under the working folder while the 409 named the home folder's file.
- A file that isn't JSON Nebula can read (cut short, hand-edited) raises
  `settings.SettingsUnreadable`, a ValueError as json.load's own error is,
  so every reader that failed closed still does (runs included). `main`
  caught it as `settings_service.SettingsUnreadable`, read through the
  module where it is caught, because tests/test_settings_path.py reloaded
  the settings module (the wide run caught that; round 14 removed the
  reloads and put the plain import back). The settings routes answer it:
  - a save, a key's removal and `credentials/update`: 409 "Nothing was
    saved because Nebula can’t read ~/.nebula/settings.json. Fix the
    file, then try again." The file is untouched.
  - GET /api/settings: 409 "Nebula can’t read ~/.nebula/settings.json.
    Fix the file, then try again." (GM's line without "Nothing was saved
    because", since nothing was being saved). Settings shows it under
    "Couldn't load your API keys."; the panel already showed a 409's own
    line, so only the backend changed. `nebula keys` gets the same line.
  - Desktop: the panel asks `credentials/update` with `"check": true`
    before it writes or clears the Keychain. The check runs every refusal
    the write runs and changes nothing, so a refused key lands in neither
    the Keychain nor the running backend.

### Each provider's own noun (GM r25 item 3; review 12, copy LOW-1)

The noun comes from one per-provider source, the key link's word
(`providerCatalog.credentialNoun`, from `LINK_NOUNS`): "keys" a key,
"tokens" a token. The buttons ("Add", "Replace", "Save"), the notices, the
toast and the screen-reader names read it. A test fails if any provider's
notice or name ends in another word than its link's. The screen-reader
name says the noun once (`credentialName`): never "Krea · API key API
key" or "Google · Gemini API API key".

| Provider | Link | Notice |
|---|---|---|
| OpenAI | Open OpenAI keys | OpenAI key saved. |
| Anthropic | Open Anthropic keys | Anthropic key saved. |
| Google · Gemini API | Open Google AI Studio keys | Google · Gemini API key saved. |
| Google · Vertex AI | Open Google Cloud service accounts | Google · Vertex AI key saved. |
| OpenRouter | Open OpenRouter keys | OpenRouter key saved. |
| Replicate | Open Replicate tokens | Replicate token saved. |
| fal.ai | Open fal.ai keys | fal.ai key saved. |
| Meshy | Open Meshy keys | Meshy key saved. |
| Runway | Open Runway keys | Runway key saved. |
| ElevenLabs | Open ElevenLabs keys | ElevenLabs key saved. |
| MiniMax | Open MiniMax keys | MiniMax key saved. |
| xAI (Grok) | Open xAI keys | xAI (Grok) key saved. |
| Higgsfield | Open Higgsfield keys | Higgsfield key saved. |
| QuiverAI (Arrow) | Open QuiverAI keys | QuiverAI (Arrow) key saved. |
| Krea · API key | Open Krea keys | Krea · API key saved. |
| Krea · usage key | Open Krea keys | Krea · usage key saved. |
| Ideogram | Open Ideogram keys | Ideogram key saved. |
| TypeSafe | Open TypeSafe keys | TypeSafe key saved. |
| World Labs | Open World Labs keys | World Labs key saved. |
| Black Forest Labs | Open Black Forest Labs keys | Black Forest Labs key saved. |
| Hugging Face | Open Hugging Face tokens | Hugging Face token saved. |
| BytePlus · ModelArk | Open BytePlus ModelArk keys | BytePlus · ModelArk key saved. |

Vertex's link opens Google Cloud's service accounts, where the person
makes the account's key, and every Vertex line already says
"service-account key", so `LINK_NOUNS` maps that link word to "key" (its
buttons stay "Add key", "Save key"). The Replicate guide now says "Add
token" and "Save token". The run-failure line "Add your Replicate API key
in Settings." (GM, error-copy round 15) is not a key notice and is
unchanged.

### Announcements (review 12, LOW-4)

A line not said yet is kept (`unsaid`) until it is said. Another read, or
the person's own save, landing within the two frames adds to it instead of
cancelling it, and a window in the background, where no frames run, says
every change it missed once it runs frames again. Tests: three remote
changes a frame apart, a remote change with the person's own save landing
before a frame, and a background window with two changes. All three fail
on 485fb5e0.

### Smaller items (review 12)

- live_cost's count of an unknown kind is pinned: paid, never free (NIT-1).
- The user guide says the unreadable-keys rule holds in the browser, what
  desktop does, and what a file Nebula can't read at all does; it writes
  "Settings > Providers > Hugging Face" (NIT-2, copy NIT-3).
- No comment says the CLI changes keys; it only reads them (NIT-3).
- The PR body: guidance scale, the exact Refusals bullet, where the 409
  lines appear, the gate rule for unreadable keys, and the round's changes.

### The ratchet

`node_route.key_billing_host` reads `key_billing`, and
`key_billing_account` now reads it through `key_billing_host`. The round
10 ratchet (`CLASS_PARTS`) lists `key_billing_host` in place of
`key_billing_account`, so the number of readers is unchanged.

### Base check and mutants

- On 485fb5e0 the new tests fail: backend, 27 of round 13's 36 (and
  test_canvas_pins' new assertion, and the test_file_access fix);
  frontend, 37 (round 13's file and the new Settings tests). The ones that
  pass there pin shapes that were already right and that GM asked to pin
  ("1 free run (fal)", "2 runs on the person's Krea plan" alone, "1 paid
  run (google), 1 on the person's Krea plan and 1 free (fal)", "2 paid
  runs (anthropic) and 1 free", a cost without entries), live_cost's
  unknown kind (NIT-1 asked for a pin, not a fix), a Settings first-load
  409 line (the panel already showed a 409's own line; the bug was the
  backend's 500) and the Hugging Face buttons. Mutants kill them.
- 32 mutants (19 backend, 13 frontend), each against its covering tests.
  First pass: 29 killed, 3 survived, and each got a fix:
  - B1 (the `/ws` `finally` removed) survived once with the machine
    loaded: the TestClient test depends on whether the handler is
    cancelled or gets a disconnect. A timing-free test now drives the
    handler with a fake socket whose read is cancelled, or whose second
    send hits a closed socket. B1 is killed (5 tests).
  - B7 (local not last) survived: every case had ids that sort before
    "local". A case with "replicate" kills it.
  - B12 (the "~" not expanded) survived because `settings_file()` and the
    module both expanded it. It is expanded once now, where
    `SETTINGS_PATH` is built (agent_profiles' deny rules read that too),
    and the "~" test kills its removal.
- The leak's three layers, each alone (test_canvas_pins then
  test_cli_apply, the `finally` removed in all three): conftest reset
  kept and test_cli_apply's precondition removed, the arrange test
  passes; conftest reset removed and the precondition kept, it passes;
  all three removed, it fails.

### Gates

All sandboxed, every npm and npx with the update notifier off. tsc -b and
lint pass. Focused vitest (158 files: every test importing a frontend
module this round changed, plus round 12's list): 2,852 passed, 0 failed,
no errors. Backend: every test file that imports or exercises a module
this round changed (189 files, found by grepping tests/ for each module,
route and fixture name): 7,532 passed, 64 skipped. Its first pass had 8
failures: the ratchet entry and the reloaded error class above, and one
round 9 socket test that passed alone, in that order with
test_settings_path, and in the second full pass (settings.py was edited
mid-run). vite build and the budget pass (460,290 bytes raw).
check-node-contracts, the model reference and the route tables are
current. No full suite ran on the Mac.

### Questions for GM

- The GET line for a file Nebula can't read drops "Nothing was saved
  because": "Nebula can’t read ~/.nebula/settings.json. Fix the file, then
  try again." OK?
- Vertex's link word is "service accounts"; its notices and buttons keep
  "key" ("Google · Vertex AI key saved.", "Add key"), as its own lines say
  "service-account key". OK, or "service account"?
- "run" on the first class makes "2 runs on the person's Krea plan and 1
  free" (was "2 on the person's Krea plan and 1 free"). As r25 item 1
  reads, but say if the plan part should keep no "run".
- The paid part counts per provider too ("3 paid runs (2 anthropic, 1
  krea)"), the same helper as the free part. OK?
- Replicate's run-failure line still says "Add your Replicate API key in
  Settings." (error-copy round 15). Should it say "token" too?


## Round 14 (GM r26 and r27, review 13)

Base 389a7c76. GM r26 agreed with round 13's five questions (the GET line,
Vertex's "key", the Krea plan line and the per-provider paid part stay)
and asked for two changes; review 13 and GM r27 added the rest.

### Replicate's run-failure line (GM r26 item 5)

- "Add your Replicate token in Settings." Both KEY_NAMES (backend
  `person_line`, frontend `directRoute`, pinned to each other through
  route_tables.json) say `('Replicate', 'token')`, and the model picker's
  own "Replicate API key" phrase is gone, so every run-failure line takes
  the provider's noun from the one source.
- Round 13's noun test now checks each provider's run-failure lines too
  (`missingKeyLine`, `modelKeyMissingText`). Vertex is the one listed
  exception: its run lines say "credentials" (veo.py and google_vertex.py
  say "Google Cloud credentials" throughout) while its notices say "key".
  Left for GM (question below).

### The not-ready disclosure (GM r26; GM r27 item 4; review 13 copy LOW-1)

- One toggle, named by what the details hold (`canvasProposals.
  detailsDisclosure`): the list alone is "Show the list" / "Hide the
  list"; the list beside what Accept writes (or a long note) is "Show the
  details" / "Hide the details"; the other two are as before. The heading
  inside stays "Can’t run here", now with a curly apostrophe (and the list's
  aria-label too).
- The name follows `aria-expanded`, and focus stays on the toggle (tests,
  and live from the keyboard at 1440 and 700).
- "See every node that can’t run" is gone from code, tests, docs and the
  PR body; one test checks it never shows.

### Same-named nodes (GM r27 item 7; review 13 copy NIT-4)

- In the person's list, nodes with the same name and the same reason say
  one line, the count in front of the single line's own sentence with the
  plural verb: "2 “Claude” nodes need your Anthropic API key. Add it in
  Settings." (`pluralNotReadyLine`, built from the single line so the two
  can't drift; "needs" → "need", "isn’t" → "aren’t", "its" → "their"). A
  line that doesn't start with the quoted name and a verb it knows keeps
  a line per node. The count line still counts nodes.
- Agent text (CLI, MCP, HTTP) is unchanged: every node by id.

### The Accept line stays (review 13 copy NIT-3)

From 4 nodes, the visible lines are the count and, when Accept is
key-locked, the Accept line; the details still hold every line.

### A `null` settings file (review 13 HIGH-1)

`_read_settings_file` returns a `_MISSING` sentinel for no file; a file
whose JSON is `null` is like any other non-object again: `load_settings`
returns it as it is, so every run fails closed, GET and every write get the
409 and the file isn't overwritten. Both agent runs the review saw go
through on 389a7c76 (a free text node; Nano Banana with its key in the
Keychain) are tests now, and both fail on 389a7c76.

### Files Nebula may not read (review 13 LOW-3; GM r27 item 3)

Every OSError reading the file except "not found" (no permission, a folder
at the path) is `SettingsUnreadable`: the same 409 and fail-closed runs. An
AST scan of the settings readers found no handler that catches OSError
without ValueError, so no reader's outcome moves. start_here answers 200
on any file Nebula can't read: its nodes part says the read line (0 ready)
and its spend part is `{"note": <line>}`; `nebula context` prints "SPEND:
<line>". Not done: a file Nebula can read but not write (chmod 444) still
500s on save; that needs a line of its own.

### The read line by audience (GM r27 item 2)

`main.SETTINGS_UNREADABLE_ON_READ` holds both lines, keyed by audience: the
person "Nebula can’t read <path>. Fix the file, then try again.", agents
(MCP `get_settings`, `nebula keys`, start_here) "Nebula can’t read <path>.
Ask the person to fix the file." Tested through the real MCP tool and the
real `nebula keys` command against the app.

### No module reload (review 13 LOW-2)

`settings.settings_path()` reads NEBULA_SETTINGS_PATH at each call, so tests
set the variable with monkeypatch and nothing reloads; `SETTINGS_PATH` is
gone. Injected keys parse through `parse_injected_keys`, which the tests
call directly (and one child process checks the import reads the
variable). test_settings_path.py and test_credential_injection.py no
longer reload `services.settings` or `main` (a guard test fails on any
reload of either), main catches the imported `SettingsUnreadable`, and
conftest's teardown check reads the variable. agent_profiles' deny rules
read `settings_path()`.

### Smaller items

- "~" only under a real, absolute home folder other than "/" (an empty,
  relative or "/" HOME shows the absolute path; review 13 LOW-4).
- `check` on credentials/update is true or false, else 422 "check must be
  true or false" and nothing is written (NIT-2).
- Desktop both-or-neither whatever the order (LOW-1): if the backend
  refuses after the Keychain changed, the panel calls the new
  `credentials.revert`, and main puts the provider's earlier encrypted
  entry back (kept in main's memory; nothing reaches the renderer). If it
  can't, the row says so instead of "Nothing was saved" (new lines, GM
  question below). desktop/main.mjs is unchanged: the channel is
  registered in credentials.mjs.
- Krea (MEDIUM-1; GM r27 item 1): every quoted connection is read from the
  option label before " · " (`handlers.krea.connection_name`): “API key”,
  “Krea account”. The five person lines, the agents' unknown-connection
  error, the out-of-compute reason (its "Settings → Krea MCP → Show Krea
  plans" path, which doesn't exist, is gone), the Job ID placeholder and
  the bar's billing value ("API balance") changed. A test scans code and
  docs for any quoted connection that isn't a real label.
- The Agent Log's refused-run line names up to 3 nodes and counts from 4
  ("4 nodes can’t run."), with curly apostrophes (copy LOW-5). The
  backend's `person_line.NAMED_AT_MOST` is pinned to the frontend's.
- The CLI's free part (copy LOW-2; GM r27 item 5): a free run with no place
  is local, so every free run is counted once; a lone local run beside
  another class is "(local)": "1 paid run (openai) and 1 free (local)".
  Without an entry for each free run (an older backend), no place tag.
- Screen-reader names (copy LOW-3; GM r27 item 6): Add, the field, Show and
  Remove say one name per row, `credentialName` ("Add OpenAI API key",
  "Google · Vertex AI service account key").
- Curly apostrophes: "Couldn’t load your API keys." (Settings and api.ts).
- Docs: idol.md, the user guide, MCP-SETUP.md and KREA-MCP.md follow all of
  the above.
- Round 13's one-off round 9 socket failure (NIT-3): I can't tell whether
  it was the socket-leak family. That pass ran while settings.py was being
  edited, it passed alone, in that order and in the second pass, and
  review 13's reload-order run passed, so the mid-run edit is the likelier
  cause, but nothing proves it.

### Gates

All sandboxed, every npm and npx with the update notifier off. tsc -b and
lint pass. Focused vitest (100 files importing a module this round changed,
plus every changed test file): 2,294 passed, no errors, no timeouts.
Backend: 87 files that exercise the changed names (grepped for the
functions, routes and strings), isolated: 4,496 passed, 46 skipped, first
pass. Desktop credential, Paper-links and folder-picker tests: 160 passed.
vite build and the budget pass (461,610 bytes raw). check-node-contracts,
the model reference and the route tables are current. No full suite ran.

### Base check and mutants

- On 389a7c76 (a temp worktree): round 14's backend file fails 30 of 33
  (the 3 that pass are guards: no file still reads as the defaults, a lone
  local run alone, an older backend's cost); the changed backend tests fail
  16 more; the frontend files fail 53 tests; the desktop file fails 6.
- 36 mutants, each against its covering tests in a separate worktree: all
  killed. Two survived at first and were fixed: an empty HOME that the
  test didn't tell from a missing file (the test now works under the
  working folder) and a revert mutant that changed only the returned
  channel list (replaced by one that renames the handler).

### Live (8793/5793, sandboxed, fake keys)

Canaries first: 8000, 8005, 5173, api.x.ai, huggingface.co, api.krea.ai
and api.anthropic.com were blocked in the browser; inside the backend's
sandbox api.x.ai, api.meshy.ai, api.ideogram.ai, huggingface.co and
1.1.1.1:443 were refused. Those were the only requests off localhost.
Nothing was run or accepted. Shots in scratchpad/idol/shots14 (9, distinct
md5s): the list closed and open at 1440 and 700, the "details" toggle
closed and open at 1440 and 700, and two same-named Claude nodes in one
line.

### Questions for GM

- Vertex's run-failure lines say "Google Cloud credentials" while its
  notices and screen-reader names say "key". Keep, or "key" there too?
- Desktop, when the Keychain can't be put back after the backend refuses:
  "Nebula couldn’t take this key, but the Keychain kept it. Try again, or
  remove the key." and, for a removal, "Nebula still has this key, but it
  was removed from the Keychain. Try again." OK?
- The node card's provider switcher says "Add key for Replicate in
  Settings" (Replicate's noun is "token" everywhere else). Change it?
- A settings file Nebula can read but not write still 500s on save. Its
  line, e.g. "Nothing was saved because Nebula can’t write <path>. Check
  the file's permissions, then try again."?

## Round 15 (CI flake, GM r28 and r29, review 14)

Base 04c0131f.

### The CI flake (section 0)

- `test_a_token_set_from_a_second_client_reaches_an_open_socket` raced:
  the backend promotes a socket's hello only when its receive loop reads
  it, so a key change sent right after the hello could reach the socket
  before it was promoted, and `settingsChanged` (sent only to promoted
  sockets) never arrived. An injected 0.3 s delay before the read made it
  fail every time. The test now waits for the promote it can see
  (`proposalSync`, `conftest.wait_for_promote`), with no sleeps.
- The same gap was real for the person: a tab missed a key change made
  between its connect (or reconnect) and its promote, and showed the old
  state until a reload. The tab now reads the settings again when the
  backend promotes it (`wsClient` dispatches `personPromoted` after
  `proposalSync` on the current socket; `settingsChangedSocket` rereads).
- Only round 9's test had the send-hello-then-act shape. Loops: 25 of 25
  plain and 9 of 9 with the delay; rounds 9, 10 and 11: 119 passed.

### GM r28 and r29: the lines

- Not-ready reasons come from one table (`person_line.
  NOT_READY_PREDICATES`, a `NotReadyReason` with `one` and `many`).
  `cost.notReady` rows carry `reason: {one, many}`, and the bar merges
  rows by it, never by the words: "“Writer” and “Editor” need your
  Anthropic API key. Add it in Settings.", "2 “GPT Image 2” nodes and
  “OpenAI TTS” need …". A row with no reason gets a line of its own.
  `scripts/generate-not-ready-reasons.py` writes every reason the
  registry gives to `backend/tests/fixtures/not_ready_reasons.json`; the
  backend checks the file is current and every line starts with the
  quoted name, and the frontend merges every one for one node and two.
- FLUX on Auto with no key names the node in the bar: "“FLUX.2” needs
  your Black Forest Labs or fal.ai API key. Add one in Settings." The card
  keeps ", then run the node again".
- Switcher: "“N” is set to a provider that isn’t in its list. Choose one
  in its provider switcher." and its plural; the keyless route's "also"
  is "Replicate can take it. Add your Replicate token in Settings." Every
  add-key line comes from `addKeyLine` ("Add your … in Settings.").
- The Agent Log line (the in-app chat turn's): "Nebula couldn’t start the
  run." then each reason once, merged, ending ", then run the node again"
  or "the nodes". Counted from 4 nodes as before.
- Vertex: the field's name is "Google · Vertex AI service account key",
  the notice "Vertex AI service account key saved.", the run lines "your
  Vertex AI service account key"; no hyphen anywhere (docs too).
- Keychain lines (GM r28 item 2) say what Nebula is using now, beside the
  row or, from a notice's Undo, in a notice naming the key. The line stays
  until the two agree. A refusal's fix sentence (the 409's new `fix`
  field) replaces "Try again, or remove it." (GM r29 item 6).
- The details box: its own scroll box above the buttons, max
  min(240px, 34vh), a 24 px fade while there's more below
  (`hasMoreBelow`, a pixel of slack), a focusable region named "Details"
  with the shared ring.

### The settings gate (GM r28 item 4; review 14 settings-gate)

- A file or folder Nebula can't write: every write gets 409
  `settings_unwritable`, "Nothing was saved because Nebula isn’t allowed to
  change <path>. Check the file’s permissions, then try again." Checked
  before anything is written (`settings_writable`), and `save_settings`
  still refuses a file that turned read-only after the check.
- `save_settings` is atomic now: a temp file beside the old one, fsync,
  then one rename. It keeps the file's mode; a new file is 0600 (it holds
  keys). Only EACCES, EPERM and EROFS are "not allowed"; ENOSPC and the
  rest still raise.
- Every settings 409 has `code` (`settings_unreadable`,
  `keys_unreadable`, `settings_unwritable`) and `fix`, worded for the
  reader. Settings picks its line by the code.
- HIGH-1: ENOTDIR (a folder on the way that is a file) is "no file", as
  before round 14. MEDIUM-1: the object check runs first, so a desktop
  file holding `null` or `[]` gets the read line on GET, every write,
  start_here and spend, never a 500. LOW-2: GET /api/agent/spend answers
  `{note, code}` (MCP `get_spend_limits`; `nebula spend` prints
  "Spending limits: <note>"). LOW-3: a symlink loop is a file Nebula can't
  read everywhere. NITs: a broken symlink is still "no file" (pinned); a
  symlink to a folder is named by the configured path; an empty
  NEBULA_SETTINGS_PATH is unset. LOW-1: the words follow
  `refusal_copy.person_reads`, so every browser tab, with or without a
  current token, reads the person's line.
- Saving the same key again is safe: the file's bytes don't change, the
  running key is the same and `settingsChanged` names no key. The
  Keychain re-encrypts the same value (no rotation, no new token). Tested.

### The Keychain write id (review 14 keychain)

- `credentials.set` and `clear` answer a one-time `writeId`. `revert`
  takes only that id, from the page that made it, while it is the
  provider's latest write and the store still holds what it wrote
  (compare-and-swap, else `STORE_CHANGED`). `commit(writeId)`, the page
  being destroyed, crashing or navigating (main frame, new document), a
  later write of the provider, or a minute drops the entry. Seven
  channels now; the preload exposes `revert` and `commit`.
- What's left: the trusted page can undo its own write in flight for up
  to a minute, back to the entry as it was just before that write. (Round
  16, review 15 NIT-4: this used to say `set` and `clear` let it do that
  anyway, which overstated it: `set` can't put back a key the page never
  saw. Revert can, but only the one its own write replaced.) It never
  reads a key. main.mjs: only its comment changed (the brief asked not to change
  the file otherwise).
- The panel reverts only on a definite 4xx (or an offline refusal). On a
  5xx or a lost answer it reads GET /api/settings: the new value means
  commit, the old one means revert, anything else commits and says
  "Nebula didn’t respond, so this key may not be saved. Save it again to
  be sure." ("… removed. Remove it again …" for a removal). A failed
  Keychain write is never reverted.

### Smaller items

- Krea: agent and doc text says "the API key connection" (never "the API
  token"); the scan checks every quoted connection name in source and
  docs. Straight apostrophes fixed in krea.py and the Agent Log heading.
- CLI: a free part whose entries don't match `freeRuns` is untagged, not
  even "(runs locally)".
- Gemini CLI's ADC and Cloud Shell line: "Uses the Google Cloud sign-in of
  the machine it runs on."
- Out of scope but on the way: a parent path that is a file now gets the
  unwritable 409 on a write instead of a 500; `credentials/update` refuses
  on an unwritable file although it writes nothing to disk (both or
  neither). The read-only-folder case says "the file’s permissions" too.
- The notes above from rounds 3 to 13 that quote "Add key for Hugging
  Face" are history: the switcher's button reads "Add key →" with the name
  "Add your Hugging Face token in Settings."

### Gates

All sandboxed, every npm and npx with the update notifier off. tsc -b and
lint pass. Focused vitest (52 files importing a module this round changed,
plus every changed test file): 1,729 passed, no errors, no timeouts, one
run. Backend: 41 files that exercise the changed names, isolated: 2,261
passed; the round 15 file alone after its last additions: 45 passed.
Desktop credential, navigation and folder-picker tests: 137 passed. vite
build and the budget pass (463,281 bytes raw). check-node-contracts, the
model reference, the route tables and the not-ready reasons are current.
No full suite ran.

### Base check and mutants

- On 04c0131f (an exported tree): the round 15 backend file fails 34 of
  43; the 9 that pass are guards (a writable file saves, the agent gate,
  MCP and `nebula keys` on a read-only file, a broken symlink, the person,
  MCP, CLI and bare audiences, and the idempotent save). Its two later
  tests call names 04c0131f doesn't have. The frontend files fail 24 tests
  and idolRound15 fails to import; the desktop file fails 27 (with the
  missing export stubbed so it loads).
- 41 mutants, each against its covering tests in a copy: all killed.
  Three survived at first and got tests: the `reason` field dropped from
  rows, `route_unavailable_reason` returning nothing (the fallback gave the
  same line), and a 5xx that reverts (no test had a 5xx with the new key
  held).

### Live (8793/5793, sandboxed, fake keys)

Canaries first: 8000, 8005, 5173, 8790, api.x.ai, huggingface.co,
api.krea.ai, api.openai.com and 1.1.1.1 were blocked in the browser;
inside the backend's sandbox api.x.ai, api.meshy.ai, api.ideogram.ai,
huggingface.co and 1.1.1.1:443 were refused. Those were the only requests
off localhost. Nothing was accepted. The one run request was an agent's
on a subgraph whose two Claude nodes had no key: the pre-call check
refused it and nothing ran. Shots in scratchpad/idol/shots15 (10, distinct
md5s): the merged line at 1440 and 700, a same-name group and a single
name, the switcher line (a FLUX node saved on a provider it no longer
lists, set in the scratch project's saved state, since Nebula refuses to
set one now), the details box at 700 at the top (fade), at the end (no
fade) and focused, the read-only line in Settings, the Agent log, and a
Keychain line beside its row (a stand-in bridge in the browser, the real
backend refusing the write after the file turned read-only).

### Questions for GM

- The canvas Agent log, for an outside agent's (MCP or CLI) refused run,
  shows the cursor's line for the first node only: "“Editor” can’t run.
  Add your Anthropic API key in Settings, then run the node again." while
  "Writer" couldn't run either. The merged line reaches the log only in
  an in-app chat turn. Should the outside agent's entry read the merged
  line too?
- On the first refusal after the Keychain took a key, the line ends with
  the refusal's fix ("… but your Keychain has it. Check the permissions of
  ~/.nebula/settings.json, then try again.") rather than "Try again, or
  remove it." OK?
- The switcher's button shows "Add key →" but its screen-reader name is
  "Add your Replicate token in Settings.", which doesn't contain the
  visible words (WCAG 2.5.3). "Add key: Add your Replicate token in
  Settings." or keep?

## Round 16 (CI on 21241038, GM r30 and r31, review 15)

### 0. CI: the proposal row's exact shape

- `test_canvas_proposals.py::test_a_proposal_names_the_run_nodes_that_cannot_run_here`
  pinned every `cost.notReady` field but round 15's `reason`. It now pins
  the whole row again, `reason` included, word for word.
- Grepped tests/ for `notReady` and every field round 15 added to what
  agents read (`settings_unreadable`, `settings_unwritable`,
  `keys_unreadable`, `"fix"`, the spend route's note and code, the settings
  refusals, `credentials/update`, `/api/settings/api-keys`) and ran each
  match with the presence and Agent log tests: 42 files, 1,740 passed. The
  list: S/idol16/be-files.txt in the scratchpad (round 16's wider set, 123
  files, is below).
- `reason` in what agents read: MCP-SETUP.md now says it is the person's
  words for the bar to merge by, that agents read `missing` and never
  parse `reason` (its words follow the person's lines and change, as they
  did this round), and that `nebula propose` prints `missing`.
  skills/nebula/SKILL.md already said to read `missing`.

### 1. GM r30

- **One merged line for every refused run in the Agent log.**
  `_announce_validation_errors` goes through `_say_refused_run`: for an
  agent's request (MCP, the CLI, an in-app chat turn, any run route) the
  cursor still points at the first node with that node's own bubble, and
  the event's `log` is the merged line, so the log lists the run once in
  the bar's words. A refusal no cursor carried (a browser request, a
  graph-wide refusal) goes to an in-app chat turn's log once
  (`publish_action`), never twice. The log line has its own room,
  `MAX_LOG_CHARS` 600 (`clean_log`), since a bubble's 140 would cut a
  merged line of three reasons. (Corrected in round 17: 600 wasn't enough
  for three route reasons, and the cut went through a word; Nebula's own
  line is now never cut.) Agents' replies are unchanged.
- **The first Keychain refusal** keeps the backend's fix: no change.
- **The switcher's setup button** shows the provider's noun from the one
  source Settings uses (`credentialNoun`): "Add token →" for Replicate
  ("Add key →" for the rest; Hugging Face's word is "token" too, but no
  switcher row shows it: Idol's Speridlabs row is keyless, corrected in
  round 17), the arrow aria-hidden. Its
  accessible name is the visible label; the add-key line ("Add your
  Replicate token in Settings.") is its description through
  aria-describedby (a visually hidden span). Krea's plan row: "Sign in",
  described "Sign in to Krea in Settings.". No other switcher said "Add
  key". `setupButtonWords` (lib/providerSwitch.ts) is the one place.
- A WCAG 2.5.3 test renders every switcher (the fixture and every
  registry node with routes) in all three variants and checks every
  button's accessible name holds its visible text, in order, and that a
  setup button's name starts with its label.

### 2. Review 15

- **Saves that worked still work** (settings-keychain MEDIUM-1, LOW-1,
  LOW-2, NIT-1). `settings_write_block` decides before anything changes:
  a file that is there and writable saves (atomically when that's safe,
  else in place), a read-only file is refused with the file line, no file
  needs a folder that takes one, a missing folder is made (0700) when the
  nearest folder takes it, and a file where a folder must be is refused.
  "Safe" means a regular file with one name, owned by this user, with no
  ACL and no extended attribute of its own (com.apple.provenance and
  security.selinux are every new file's, so they don't count; macOS ACLs
  and attributes are read with acl_get_file and listxattr through ctypes,
  since Python's os has no listxattr there). A temp file the folder won't
  take, a group the temp file can't be given, or a rename the filesystem
  refuses falls back to the in-place write. The temp file is 0600 while
  it holds the keys, removed on any failure (a finally, so a
  KeyboardInterrupt too), and temp files older than a minute beside
  settings.json are swept at startup. The in-place write is not atomic,
  as before round 15: that is the price of not refusing a save that
  worked.
- **The lines (GM r31 items 1 and 2):** the folder case, "Nothing was
  saved because Nebula isn’t allowed to change ~/.nebula. Check the
  folder’s permissions, then try again.", code `settings_unwritable`; a
  file where the folder must be, "Nothing was saved because ~/.nebula is
  a file, and Nebula needs a folder there. Move or rename that file, then
  try again.", a new code `settings_not_a_folder` (the panel's code list
  has it). Each names the real path. The agents' forms and the two `fix`
  sentences ("Check the permissions of ~/.nebula, then try again.", "Move
  or rename ~/.nebula, then try again.") are mine, in the pattern GM set
  for the file line; no agent meets them today (every settings write is
  the person's).
- **credentials/update keeps only the read check** (MEDIUM-2): it writes
  the Keychain and the backend's memory, never the file. PUT and DELETE
  keep the write check.
- **The Keychain write id is bound to the frame** (NIT-3): the owner is
  the frame (its process and routing ids), and every credential call from
  a subframe is refused (`UNTRUSTED_SENDER`); an event without a main
  frame to check against is refused too (fails closed). A write that
  lands after its page started navigating is committed at once (NIT-2:
  each page's departures are counted when the handler starts and when
  the write lands). main.mjs is unchanged.
- **NIT-4:** the README, the notes and the PR body no longer say set and
  clear "already let it do" what revert does: revert puts back only the
  entry as it was just before the frame's own write.
- **Route lines, one shape (GM r31 item 3):** the reason, then one action
  sentence that names who can take the run, with no separate "can take
  it": "… Turn “Raw” off or switch to fal.ai." (two: "fal.ai or
  Replicate"), "…, or add your fal.ai API key in Settings and switch to
  fal.ai." for a provider whose key isn't added, the fix alone when no
  provider can. "Add it in Settings or switch to fal.ai." for a route's
  missing key. The predicates end in an `{end}` slot: "." on the card and
  the bar, ", then run the node again." in the Agent log, or ". Then run
  the node again." after the comma clause; `NotReadyReason.again` holds
  the log's forms and `merged_not_ready(again=True)` uses them. Nothing is
  appended to a last sentence any more (`run_again` is gone). A route's
  own line (Idol's token) is said as it is in the log too. The card twin
  (directRoute.ts `routeAction`) builds the same sentences;
  route_cases.json's 48 changed card lines were recomputed from the
  backend and the frontend test reads the same.
  - Choices to check: with no provider to name, a route's missing key
    says "Add it in Settings." (the old "or choose another provider" had
    nothing to name; the switcher still lists every route). Agents keep
    their own text (node_route.route_unavailable_message and its fix
    sentences, ids and env names), so "or switch provider" stays there.
    GM's "because <why>" I read as the existing why clause ("with “Raw”
    on"), unchanged. Krea's "Sign in to Krea in Settings, or choose
    another provider." (GM r21, verbatim) is unchanged.
- **Curly apostrophes:** route_block ("can’t run on", both the backend
  and the card), the size reason, the Vertex lines ("can’t be read"), the
  service account paste checks in Settings ("That isn’t a service account
  key.", "That isn’t valid JSON."). Pins updated together.
- **The generated reasons table** (LOW-2, sockets-tests LOW-1) now also
  walks every route_cases.json case (setting stops, hidden stops, too many
  inputs, keys only another route has, alternatives that need their key)
  and a node Settings can't set up: 120 reasons, every kind (key 45,
  route_block 44, route_key 28, unknown_provider, krea_plan, not_set_up),
  each with its kind and the Agent log's forms (`logOne`, `logMany`).
  (Corrected in round 17: no registry route table sets a size or retired
  rule, so the table has no row for either; round 17 pins both with a
  fixture route. The "every kind appears" test was missing until round
  17.) UTF-8 with
  "\n" on read and write (NIT-3).
- **Vertex paste error (GM r31 item 4):** "The Vertex AI service account
  key saved in Settings isn’t a valid key file. Paste the whole key file
  again."
- **The Keychain line when Nebula didn't answer, as a notice (GM r31
  item 5):** "Nebula didn’t respond, so your Replicate token may not be
  removed. Remove it again to be sure." (`keychainUnknownLine`); beside
  the row it still says "this key".
- **The unprivileged-marker scan fails closed** (LOW-2): a conditional
  mode is checked on both branches, and any mode it can't prove keeps the
  owner's read and write (a variable, a call) counts as dropping them.
  The file's own mode with bits or-ed onto it (`p.stat().st_mode |
  stat.S_IXUSR`) takes nothing away and passes. Round 16's parametrized
  parent-is-a-file test carries the marker for that reason.
- **Tests:** the window test uses fake timers (LOW-3); the read-then-lock
  test runs each write after the one before was restored (NIT-1, and its
  folder half moved to round 16, where a read-only folder saves in
  place); the rename failure tests patch `settings._replace`, not
  `os.replace` for the whole process (NIT-2).
- **PR body:** the Vertex "credentials" parenthesis is gone, "a line
  each" is "a line per reason", the backend test bullets sit under
  Backend, and the new behaviour is described.

### What agents see this round

- The presence event's `log` on a refused run is now the merged line (up
  to 600 characters; corrected in round 17: never cut); MCP-SETUP.md says so.
- `cost.notReady` rows' `person` and `reason` read the new route shape;
  agents are told to read `missing`.
- A new 409 code, `settings_not_a_folder`, and the folder line under
  `settings_unwritable` (MCP-SETUP.md); only the person writes settings,
  so no agent meets them yet. `credentials/update` no longer refuses a
  read-only settings.json.
- The switcher's labels aren't agent-visible.

### Checks (round 16)

- tsc -b --noEmit and lint pass. vite build passes; budget 461,672 bytes
  raw, 141,909 gzip. check-node-contracts (309), generate-model-reference
  --check, generate-route-tables --check and generate-not-ready-reasons
  --check are current.
- Focused vitest (76 files, --maxWorkers=2, run beside the backend set and
  the mutants): 1,818 passed, 8 failed, Errors 0. Seven were 5-second
  timeouts in Settings.test.tsx and idolRound10.test.ts, and one a focus
  check in Settings.test.tsx under the same load. Those two files and
  idolRound16.test.tsx again alone: 238 passed.
- Focused backend (123 files, 5,009 tests: every file that imports what
  changed or pins a changed line). The first run hit its time limit at
  3,814 under the load; the rest (34 files) ran again on its own: 1,201 passed, 1 skipped. Two
  failures in the first run, both timing tests that pass alone:
  test_journal_write_project.py (35 passed) and test_mcp_channel.py's pin
  check give-up (177 passed). Rounds 15 and 16 with the marker scan,
  after the last test changes: 105 passed.
  Desktop: 129 pass.
- Base check (21241038 with the new tests): round 16's backend tests fail
  but five that guard what already worked (a symlinked path writes
  through, a browser refusal logs once, a read-only file and a read-only
  file in a read-only folder are refused with the file line, a plain file
  is replaced whole); the frontend's new tests fail (37), except the
  folder line, which the panel already showed by its code; the desktop's
  four new frame and navigation tests fail, the "no navigation stays
  undoable" guard passes.
- Mutants: section 1 B1 to B7 and F1 to F7, section 2 S1 to S18, R1 to
  R8, D1 to D5, K1 and K2, all killed. Two survived their first run and
  got tests: S16 (the temp file given the file's mode before the keys are
  written; the test now reads the mode when they are flushed) and R8 (no
  test pinned the Vertex line; one now does for three bad pastes).
- Live on 8793/5793 (sandboxed backend and Vite, the browser's proxy
  dead, canaries blocked for 8000, 8005, 8010, 5173, 8790, 8760 and five
  real hosts, from the browser and the backend; fake keys only, no Space
  call, no run reached a provider): an MCP and a CLI refused run each
  logged the merged line once; Replicate's row showed "Add token →" with
  its line as the description; a FLUX 3 node set to Replicate with only a
  fal.ai key said on its card "FLUX 3 Image is set to Replicate, which
  needs your Replicate token. Add it in Settings or switch to fal.ai." and
  in the Agent log "Nebula couldn’t start the run. “FLUX 3 Image” is set
  to Replicate, which needs your Replicate token. Add it in Settings or
  switch to fal.ai, then run the node again." Shots: shots16/1440-r16-1
  to -4 in the scratchpad.

### Questions for GM (round 16)

- "Pick A, B or C or switch to fal.ai" has two "or"s when a setting's fix
  lists choices; keep it, or "Pick A, B or C, or switch to fal.ai"?
- The switcher's row notes still say "Doesn't take" with a straight
  apostrophe (not one of the lines r31 named).
- The pill's accessible name puts words between its visible parts
  ("Provider for X: Auto …"); it holds them in order, so it passes Label
  in Name, but the visible text isn't one run in it.
- Krea's "or choose another provider" (r21, verbatim) is unchanged.

## Round 17 (CI on c91de4bf, GM r32 and r33, review 16)

### 0. CI: the ratchet's stale entry

- errorCopy.namedLine.test.ts listed round 15's hand-built form of the
  direct-route line under HAND_BUILT. Round 16 builds that line from the
  shared parts (the reason template, then `action(fixPerson(...))`), so the
  scanner no longer reads it as hand-built and the entry was stale. The
  entry is deleted; the matcher and the stale check are unchanged. 7/7.
- Why round 16's focused list missed it: the list came from tests that
  import what changed. This test imports nothing from directRoute.ts; it
  reads the source files HAND_BUILT names as text. A grep for imports
  can't find it.
- Checklist step, from this round on: grep HAND_BUILT in
  frontend/tests/lib/errorCopy.namedLine.test.ts for every file a round
  touches, and run that test whenever one matches. It is in the focused
  list every round.

### 1. GM r32

- **Quoted names on the card:** "“FLUX 3 Image” is set to Replicate, which
  needs your Replicate token. Add it in Settings or switch to fal.ai."
  (backend `node_route.card_subject`, frontend `routeUnavailable`); "This
  node" when a type has no name. A run's node carries no label, so the card
  names it by its type. route_cases.json's 49 card lines were recomputed.
- **One heading over a refused run:** "Nebula couldn’t start the run."
  on the card when the pre-call check refused it. node_errors keeps the
  mark (`notStarted`) across a reload, and the graph carries
  `errorNotStarted: true`, until the node runs or fails again. It is on
  the model card, a universal model's card, the Batch card and Create
  Studio's result. A busy or network failure to start keeps "Couldn't
  start the run.", and a started run that failed keeps "Couldn't run the
  node.". The shot panel keeps its own heading. The proposal bar shows a
  proposal, not a refused run, so it keeps "Can’t run here".
  `errorNotStarted` is a runtime field: canvas undo leaves it alone.
- **The two-action comma:** a fix that lists two or more options holds
  its own "or", so the switch after it is a second clause: "Pick 1K, 2K
  or 4K, or switch to fal.ai." In the log, an action with a comma clause
  ends ". Then run the node again." (`person_line.Fix(text, options)`;
  the frontend's `FixClause`).
- **Curly apostrophes in the switcher's notes:** "Doesn’t take …",
  "Can’t make that size.", "Doesn’t take connected …", "Auto · can’t run:".
- **Accessible names start with the visible text, as one run:** the chip
  and the pill have no aria-label. Their names are their visible text, and
  "Provider for X: <chip>[. <why it can't run>]" is the description
  (aria-describedby). The WCAG test now also checks that a name starts
  with the whole visible text.
- **Krea's line names who can take the run:** "“Krea 2” runs on your Krea
  plan. Sign in to Krea in Settings, or switch to fal.ai." when a route
  with its key set can take it (`routesThatCanTake`), else "…, or choose
  another provider." Both are tested. Krea's own API-balance row is the
  same route, so it doesn't count as another provider. I added no "Switch
  to" button for this case.

### 2. Review 16

**Settings (MEDIUM-1, now LOW): no save loses settings.json.**

- (a) **Atomic whenever the metadata can be carried.** The temp file
  takes the old file's owner and group (`_carry_owner`, through
  `os.fchown`; another owner only as root), its mode, then its ACL and
  extended attributes (`_carry_metadata`). On macOS that is copyfile(3)
  through ctypes with COPYFILE_ACL | COPYFILE_XATTR; on Linux each xattr
  is copied, which carries system.posix_acl_access. Then one rename. The
  file is written in place only when:
  - it has a second name (nlink > 1);
  - another user owns it and Nebula isn't root;
  - its folder takes no temp file;
  - the owner, group or metadata can't be carried;
  - or the rename is refused (an ACL that denies delete).
  A copied ACL is taken off the temp file again before it is removed, so
  one that denies delete can't keep a copy of the keys beside the file.
- (b) **The in-place write parses at every step** (`_overwrite`):
  1. grow the file with spaces to the new length, then fsync (a full disk
     fails here, and old JSON plus spaces still parses);
  2. write the new JSON at 0, padded with spaces to the old length when
     it is shorter, then fsync;
  3. cut the file to the new length, then fsync.
  On a failure the old bytes are written back. Seams for tests:
  `settings._pwrite`, `_truncate`, `_chown`, `_replace`.
- (c) **One save at a time:** an exclusive `fcntl.flock` for the whole
  save, on the file (opened with O_NOFOLLOW), or on its folder while there
  is no file. A save that waited while another replaced the file locks
  again until its lock is on the file at the path now. Polling with
  LOCK_NB, it gives up after 10 s (OSError, a 500, nothing written).
  There is no lock where the system has none or the file and folder can't
  be opened to read; no save is refused for that.
- (d) **A verified copy before any in-place write**, in Nebula's own
  folder (NEBULA_STATE_DIR, else ~/.nebula): `settings-backup-<sha256 of
  the path, 16 hex>.json`, holding `{path, text}`. It is 0600 (mkstemp),
  fsync'd, renamed into place, read back, and removed once the write is
  done or the old bytes are back. At start, before the temp sweep, a
  settings.json that reads but doesn't parse while its copy does is put
  back from it (`restore_settings_from_backup`, through the same
  locked write). That is journaled as `settings.restored` (data `{file}`,
  the shown path, actor `system`) and logged as a warning on
  nebula.settings. A file that parses drops its copy. A file that is gone,
  can't be read, or another path's copy is left as it is. Until that
  start, every reader gets the unreadable answer, as today.
  - **My call:** a copy Nebula isn't allowed to make refuses the save
    before the file changes, with the folder line naming Nebula's folder
    ("Nothing was saved because Nebula isn’t allowed to change
    ~/.nebula."). A copy that fails for another reason (a full disk, or a
    read-back that doesn't match) raises, with nothing written.
- (e) The PR body says the in-place write isn't atomic and how (b) to (d)
  bound it.
- **LOW-1:** temp names are `.settings-nebula-<pid>-<mkstemp's 8>.tmp`
  (`_TEMP_NAME`). The sweep removes only those: a regular file with one
  name, owned by this user, older than a minute. It sweeps the settings
  folder and Nebula's own folder (the copy's temp files).
- **LOW-2:** S15 (the temp file's group) and S16 (an in-place EACCES or
  EPERM is the 409's file line) have tests. D8 (frameKey) has one too:
  two frame objects with the same process and routing ids can undo the
  write, and another routing id can't.
- **NIT-1:** the main frame's `did-navigate` (the new document's commit)
  drops the old document's writes too.
- **NIT-2:** every missing folder level is made 0700. A folder that can't
  be made names the existing folder that refuses it (GM r33 item 5):
  "Nothing was saved because Nebula isn’t allowed to change ~/ro."
  (tested with two missing levels).
- **NIT-3:** the in-place write opens with O_NOFOLLOW and checks the
  file's dev and inode against the decision. A symlink or another file
  swapped in makes the save decide again from the path, as a new save
  would. On a symlinked path a save writes through to the target, as it
  always has.
- **NIT-4:** `sameOwner` compares the webContents too.

**Copy (GM r33):**

- **M1:** an input with no wire merges as a reason does, from one table
  (`person_line.INPUT_NEED_PREDICATES`, `input_need`), through the shared
  name list.
  - One node: "“GPT Image 2” needs a prompt. Connect one, then run the
    node again."
  - Several: "2 “GPT Image 2” nodes need a prompt. Connect a prompt to
    each, then run the nodes again."
  - Different names merge, and the subject counts from 4 ("4 nodes need
    a prompt…").
  - Each check marks its kind where it is made, never sent
    (`ValidationErrorDetail.marked`: "reason" for the key, route and Krea
    stops; "input" for a required input with no wire). The log reads the
    mark, not the words.
  - Other input kinds take the same pattern. The singular's word is
    "one" for "a prompt", "it" for "audio" or "text", "them" for
    "images". A numbered or lettered input, or a pass-through, is named
    by its label: "needs an output connected to “Item 1”. Connect one…".
- **L1:** a node with a reason and another stop keeps both, the reason
  first. Any other stop (a World Labs batch line, the Gemini check) still
  says its card line after the node's name.
- **M2:** Nebula's own Agent log line is never cut (`clean_log(...,
  whole=True)`, `agent_presence.point(log_whole=True)`, from
  `_say_refused_run` only). A `log` built from what an agent sent (raw
  field keys) is still cut at 600. A named line longer than 600 takes the
  count form early ("Nebula couldn’t start the run. 3 nodes can’t run here
  yet."). One node's line has no shorter form and is said whole. The
  frontend never cut it.
- **N1:** the size and retired clauses are pinned on both sides with a
  fixture route.
- **N2:** corrected the round 16 notes above (600, the table walking
  sizes, "Add token" for Hugging Face) and the generator's docstring (no
  "every kind" test existed; a route_key line names another route only
  when its key is set). The PR body and MCP-SETUP are corrected too.
- **N3:** route_clients.refuse_unwired is left for the wording batch (GM
  r33 item 3).
- **GM r33 item 4:** the missing-key line is unchanged. A test pins that
  it names another provider only when that provider's key is set, on
  both sides.

**Tests-ci:**

- **LOW-1:** test_idol_round15 asserts the generated table's kinds equal
  `NOT_READY_PREDICATES` (mutant G2 is killed).
- **LOW-2:** the reopened-expiry test runs on the proposals' clock and on
  events. The clock stands still until the undo is inside p2's slow
  Update, so p1 reopens whatever the load; then p1 and p3 fall due, and
  the undo waits there until p1's own timer has expired them. A 15 s
  deadline is only a hang guard. With a 0.6 s stall injected before the
  undo, the old form fails and the new one passes.
- **LOW-3:** the pin give-up test checks the shipped timeout as a number
  (3 to 5 s) and runs on 0.3 s, with 30 s hang guards, asserting
  took >= 0.3. With a 5.5 s stall where the check falls due, the old form
  fails (9.6 s against its 9 s budget) and the new one passes.
- **LOW-4 and NIT-2:** the scan's cases now include a `|` whose right
  side brings the owner's bit back, a bare `chmod`, a starred and a `**`
  mode (unproven), and a chmod command in a list (an octal string is
  read; anything else is unproven). A chmod in a shell string isn't read
  (the docstring says so). The scan's new reach found three ACL tests
  (`chmod +a`) whose behaviour root ignores; they carry the marker now.
- **NIT-1:** the not-a-folder test writes literal modes (`0o755 if
  executable else 0o644`) and lost its marker, so it runs as root too.
- **NIT-3:** the temp-file mode test reads through the module's own
  seams (`_carry_owner`, after the keys are flushed, and `_replace`). It
  no longer patches os.fsync or tempfile.mkstemp.

### What agents see this round

- `errorNotStarted: true` on a node whose run the pre-call check refused
  (graph data, the canvas's only). `error` is unchanged.
- The card's route lines quote the node's name, and a listed fix takes a
  comma before the switch (`person`, `reason`).
- The Agent log's refused-run line merges inputs with no wire, keeps a
  reason and another stop, and is never cut. `error` and `errors` are
  unchanged.
- A new journal kind, `settings.restored` (MCP-SETUP table,
  wait_for_canvas_change's description, the nebula skill).
- A folder that can't be made names the existing folder in the 409's
  line and `fix`.
- MCP-SETUP.md and skills/nebula/SKILL.md say all of this.

### Checks (round 17)

- tsc -b --noEmit and lint pass. vite build passes; budget 462,281 bytes
  raw, 142,058 gzip. check-node-contracts (309), generate-model-reference
  --check, generate-route-tables --check and generate-not-ready-reasons
  --check are current.
- Focused vitest (52 files, --maxWorkers=2, run beside the backend set and
  the mutants): 1,742 passed, Errors 0, no timeouts, so no rerun.
- Focused backend (59 files: every file that names a function, route,
  string or payload field this round touched): 2,344 passed, 1 skipped,
  2 failed. One was real: MCP-SETUP.md's new paragraph said "with no
  wire", which the docs ratchet refuses; it now says "with nothing
  connected". The other was test_project_save_event_loop's 0.3 s stall
  check, at 1.78 s while the mutants, a vite build and the live check ran
  beside it (a project save doesn't write settings). Both files again
  alone, three times: 77 passed each. test_canvas_proposals and the
  round 17 log tests after the doc change: 112 passed.
- Desktop (node --test, every file, in the local-only sandbox): 396 pass,
  9 skipped, 1 fail: sidecar.test.mjs's stdin-token test, at `spawnSync
  ps EPERM`, because the sandbox refuses `ps`. That file is unchanged
  since c91de4bf. credential-service.test.mjs: 132 pass.
- person_gate.py is byte-identical to c91de4bf. No private question ids
  in the diff.
- Base check (c91de4bf with the new tests), corrected in round 18 (review
  17, tests NIT-2): backend 85 failed, 5 passed, 1 skipped (Linux only).
  "The fixture's card lines already quoted" fails on base; the 5 that pass
  guard what already worked: a run error after a refusal (no mark
  existed), the count form from 4 on MCP, the CLI and chat, and a file
  that turns read-only before the in-place write gets the file line. About
  35 of the 85 failures are only AttributeErrors on names round 17 added.
  Frontend 30 of 33 fail; the 3 that pass are "or choose another provider"
  with no key, the Krea API key as the same route, and the started run's
  heading. Desktop: the 3
  new did-navigate, other-page and watched-events tests fail; "same
  frame, another object or routingId" passes as a guard.
- Mutants: section 0 and 1 C1 to C19, copy L1 to L16, settings S1 to
  S27, tests T1 to T4, desktop D8 to D10: 72, all killed. One, C12 (a
  later refused start keeps the mark), was killed only by a 5-second
  timeout under load; alone it survived. A test now covers it (a busy
  start after a refusal drops the mark, and the card keeps its own
  heading). Alone again it is killed, and the test fails on c91de4bf.
  idolRound17.cards.test.tsx with that test: 8 passed.
- Live on 8793/5793 (sandboxed backend and Vite, the browser's proxy
  dead, canaries blocked for 8000, 8005, 8010, 5173, 8790, 8760 and six
  real hosts from the browser, and the backend's own canary; fake keys
  only, no Space call, every run request refused by the pre-call check):
  1. A FLUX 3 node set to Replicate with only a fal.ai key, an MCP run
     refused: the card's heading "Nebula couldn’t start the run." over
     "“FLUX 3 Image” is set to Replicate, which needs your Replicate token.
     Add it in Settings or switch to fal.ai."; the log said the same with
     ", then run the node again."
  2. FLUX 3 on fal.ai at 1.5K with a Replicate token: the switcher's line
     "“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K.
     Pick 768 x 768, 1K, 2K or 4K, or switch to Replicate."
  3. Krea 3 on the Krea plan, signed out, with a fal.ai key: "“Krea 3”
     runs on your Krea plan. Sign in to Krea in Settings, or switch to
     fal.ai."
  4. FLUX Kontext with neither input connected, an MCP run refused: two
     sentences, each with its own run-again ending (a question for GM
     below).
  Shots in scratchpad/idol/shots17, four distinct md5s, each opened. No
  page errors; the 7 console errors are the canaries' own blocked loads.

### Questions for GM (round 17)

- From 4 nodes the log keeps the whole run's count line ("4 nodes can’t
  run here yet.", r24), so "4 nodes need a prompt…" shows only where the
  shared name list counts a group. Should a run whose 4 or more nodes all
  share one stop say "4 nodes need a prompt. Connect a prompt to each,
  then run the nodes again." instead?
- The input kinds GM didn't name: "“OpenAI TTS” needs text. Connect it,
  then run the node again.", "needs images. Connect them…", and for a
  numbered input "“Batch” needs an output connected to “Item 1”. Connect
  one, then run the node again." (plural "…Connect one to “Item 1” on
  each…").
- A node with a reason and an input need says two sentences, each ending
  "then run the node again.". Keep it, or one ending for both? The same
  holds for one node with two inputs with nothing connected (live, FLUX
  Kontext): "“FLUX Kontext” needs a prompt. Connect one, then run the
  node again. “FLUX Kontext” needs an image. Connect one, then run the
  node again." Or "“FLUX Kontext” needs a prompt and an image. Connect
  them, then run the node again."?
- Past 600 characters, 2 or 3 nodes take "2 nodes can’t run here yet.",
  which drops the actions. Is that right?
- A save that can't keep its copy in ~/.nebula (the folder refuses it)
  is refused with the folder line naming ~/.nebula.

## Round 18 (CI on 204ad52f, GM r34 and r35)

### 0. CI: a settings test that passed only on macOS

- test_metadata_that_cant_be_carried_writes_in_place_and_leaves_no_temp
  failed on the Linux runner (the inode changed). It forced "can't be
  carried" by patching `_darwin_copy_metadata` and, off macOS,
  `os.setxattr`. On Linux the file had no xattrs, so setxattr was never
  called, the copy "worked" and the save stayed atomic.
- Fix: the copy is one seam on every system, `settings._copy_metadata(path,
  temp)` (copyfile(3) on macOS, each xattr on Linux, ENOTSUP elsewhere).
  `_carry_metadata` asks whether the file has its own metadata, then calls
  the seam and turns a refusal into the in-place write. The test patches
  the seam and asserts it was called, so the same branch runs on macOS and
  Linux.
- Linux fails closed: a real user xattr whose copy the temp file refuses
  (os.setxattr raising EPERM) keeps the file and its xattr, written in
  place. That test runs where the filesystem takes user xattrs and skips
  elsewhere (macOS has no os.setxattr). A second test runs the Linux branch
  on any system: sys.platform "linux" and Linux's three xattr calls over a
  dict. A refused copy writes in place; a copy that works carries the
  person's xattr, never the system's own label (security.selinux), then
  renames.
- The other round 17 settings tests: CI ran the whole file on Linux and
  only this one failed. From the code, the rest patch platform-neutral
  seams (`_pwrite`, `_replace`, `_chown`, `_lock_waiting`), use real
  files, or skip off macOS (the chmod +a ACL tests). No Linux container
  ran here: Docker's daemon isn't running on this Mac, and starting it is
  a shared-machine change.

### 1. GM r34

- **One node with several needs** (shot 4 of round 17 said the ending
  twice). Each node's inputs with nothing connected are one need, built
  from the same table (`INPUT_NEED_PREDICATES["inputs"]`,
  `person_line.input_needs`), in the node's input order (`_input_order`,
  the definition's ports), so the same node always reads the same:
  "“FLUX Kontext” needs a prompt and an image. Connect both, then run the
  node again."; "“FLUX Fill (Inpaint)” needs a prompt, a base image and a
  mask. Connect them, then run the node again." Every input kind works in
  a set, a labelled one too ("a prompt and an output connected to “Item
  1”").
- Nodes with the same set merge, whatever order their own inputs are in
  (keyed by the set; the first such node's order is said): "2 “FLUX
  Kontext” nodes need a prompt and an image. Connect both to each, then
  run the nodes again."; "“FLUX Kontext” and “GPT Image 1 Edit” need …".
  Different sets are separate sentences. One need is the round 17 line,
  and an input listed twice is said once.
- From 4 nodes (GM r35 item 1, section 1b): nodes that share a reason or
  a set of needs count inside its own sentence in the Agent log, as the
  bar's list already did: "4 nodes need a prompt and an image. Connect
  both to each, then run the nodes again."; each other reason or set is
  its own sentence ("4 nodes need … . “GPT Image 2” needs a prompt. …").
  The log's early "N nodes can’t run here yet." from 4 is gone; it says
  that only when the named line is longer than the log's room (600), so
  the line stays whole (9 nodes with nine different sets take "9 nodes
  can’t run here yet."). The bar's summary line above "Show the list"
  stays r24's "N nodes can’t run here yet." (unchanged, now pinned beside
  the list's per-reason count). Unwired inputs never reach the bar: a
  proposal's notReady rows are readiness reasons (keys, routes, the Krea
  plan), so its list counts reasons.
- **The Auto row loses the colon:** "Auto · fal.ai doesn’t take
  “Resolution” set to 1.5K". provider-switcher.css's comment and
  PROVIDER-ROUTES.md quote the new form.
- **Every Auto row is subject-first** (GM r35 item 2): the provider leads.
  "fal.ai doesn’t take …" (rejects, blockedBy, hidden), "fal.ai needs
  “…”", "fal.ai can’t make that size", "fal.ai no longer runs this model"
  (was "retired by the maker on fal.ai"), "fal.ai doesn’t take this many
  images" (was "too many images for fal.ai"). "Auto · needs a key" takes
  the providers' noun from providerCatalog.credentialNoun, the source
  Settings' buttons use (`autoNeedsCredential`): "Auto · needs a token"
  when every key that would let it run is a token (Replicate, Hugging
  Face), "a key" for keys or a mix. A route with no key and no other stop
  says "fal.ai needs a key" the same way; no shipped node reaches that
  case, nor "no route can take it", which has no provider to lead with.

### 2. Review 17 (section 2) and GM r36

**Settings durability.**

- **The copy and the temp files are out of agents' reach (MEDIUM-1).** The
  copy an in-place save keeps, the file a restore replaces and the copy's
  temp file live in `<state>/settings-copy` (0700; `settings_copy_folder`).
  That folder is in `protected_agent_dirs()`, so the Codex deny paths,
  `require_allowed_path`, the agent workspace check and Claude's
  `deny_read_dirs` rules all cover it. The save's temp file beside
  settings.json has one fixed name, `.settings.json.nebula-tmp`
  (`temp_path_for`), opened O_EXCL | O_NOFOLLOW, 0600, and listed in
  `default_secret_paths()` (`secret_temp_paths`, the configured and the
  resolved path). The start sweep holds the save's lock, so any temp file
  found then is a cut-short save's: the fixed name, the copy's, and round
  17's `.settings-nebula-<pid>-…` names go with no age check. Where the
  lock can't be held (no flock), the 60-second age check still applies. A
  round 17 copy in the state folder itself moves into the copy folder as
  `legacy-…` and is never restored (it has no marker or hash).
  **This is the coordinator's call, and Justin can veto it**: the
  alternative was to keep no copy at all when the file holds keys.
- **The restore holds the lock throughout (LOW-1, mutant N22).** Read,
  judge, keep aside, write and drop all run inside `_save_lock`, so a
  Nebula starting during another's in-place save waits, and then finds
  that save finished: it never drops the other's copy or puts an older
  copy over a newer save. Tested with two processes (the second's wait is
  seen, never timed).
- **Only Nebula's own copy, and the replaced file kept (LOW-2).** The copy
  is `{"nebula": "settings-copy", "version": 1, "path", "sha256", "text",
  "next"}`: the hash covers the path, the old text and the text being
  written. It is read with O_NOFOLLOW and must be a regular file with one
  name, this user's, with no group or other access. A copy that is ours
  but fails the marker, version, hash or parse is dropped; one that isn't
  provably ours (a symlink, a second name, another owner, group-readable)
  or is for another path is left and never restored. Before the restore,
  the file it replaces is kept as
  `settings-copy/settings-replaced-<UTC time>.json` (0600, O_EXCL, synced,
  the folder synced); a restore that can't keep it changes nothing.
- **The restored line (GM r36 B6b).** `settings.restored` is journaled and
  logged with "Nebula restored your settings from its saved copy because
  the last save didn’t finish. The file it replaced is kept at <path>."
  The copy is only ever left by an in-place save that didn't finish, but
  the file may have been changed since (its drop failed after a finished
  save, then the person edited the file). So the reason is given only when
  the file is what that save leaves part way: every byte the old file's or
  the new text's at that place, its length from the old file's to the
  longer one's (`_cut_short`, which is why the copy keeps the new text).
  Otherwise the line drops the "because" clause: "Nebula restored your
  settings from its saved copy. The file it replaced is kept at <path>."
  The event's data is `{file, keptAt}`. The journal cuts summaries at 200
  characters, and on desktop this line with the state path runs past
  that, so `settings.restored`'s summary has its own limit (1,200,
  `SUMMARY_CHARS_BY_KIND`). Through MCP, the CLI (`nebula watch`'s line)
  and an in-app chat turn, both cases verbatim.
- **The copy folder can't be changed (GM r36 B6a).** A new cause,
  `copy_folder`, answers the save with "Nothing was saved because Nebula
  isn’t allowed to change ~/.nebula, where it keeps a copy while it saves.
  Check the folder’s permissions, then try again." (the agents' form asks
  the person; `code` stays `settings_unwritable`, the fix is the folder
  fix). It names the folder that refuses, as the person sees it, so on
  desktop it is the desktop app's state folder.
- **PUT and DELETE hold the lock from the read to the save (LOW-3).**
  `settings_transaction()` takes the save's lock for the read, the change
  and the save; `_save_lock` is reentrant for the thread that holds it
  (`_HELD`), so the save inside takes no second lock. Neither route awaits
  inside it. Tested with another Nebula holding a transaction while this
  backend's PUT (or DELETE) starts: the route waits at its read, and both
  keys survive.
- **The lock on a folder at the settings path.** Taking the lock before
  the read exposed a loop main already had: with a folder where
  settings.json should be, `_lock_target` opens that folder,
  `_lock_holds` judged it as the parent folder and said no, and `_locked`
  tried again forever with no deadline (round 14's folder test hung
  PUT). `_lock_holds` now holds a lock on whatever is at the path (same
  device and inode), and `_locked` stops at its deadline with EAGAIN when
  the target keeps changing. The PUT answers the 409 not-a-file line at
  once. Two tests (each fails on 204ad52f by spinning, caught by a
  10-second thread guard) and mutants L1 and L2.
- **NIT-1:** the PR body now says "where the filesystem supports flock",
  "except when Nebula's own folder takes no copy", and no longer says no
  failure loses the old settings: a failure leaves the old or the new
  settings, and where it leaves neither the restore puts the old back.
- **NIT-2:** every missing level of the copy folder is 0700 (and a loose
  existing one is made 0700 again); a state path through a file is the
  409 not_a_folder line naming that file, never a 500.
- **NIT-3:** N9 (a pwrite of 0 accepted) is killed by a seam test: EIO,
  the file unchanged, the copy left. N22 is killed by the restore test
  above. N2 (the grow's sync) and N12 (the copy's sync) are now killed
  too, by the sync recorder below. N33 stays benign: it makes each level
  with mode 0755, but the `chmod 0700` right after still runs, so an
  empty folder is open for microseconds with nothing in it yet.
- **NIT-4:** every sync meant to survive a power cut goes through `_sync`:
  F_FULLFSYNC where fcntl has it (macOS; fsync there reaches only the
  drive's cache), else fsync, and fsync again if the filesystem refuses
  F_FULLFSYNC. The folder is synced after each rename (the atomic save's
  and the copy's). A test records every sync through the module's own
  seams (`_fcntl`, `_FULLFSYNC`, `_fsync`), never os's.

**Copy and UI (GM r36 B1 to B5).**

- B1: the port row's plural names what to connect: "2 “Combine Text” nodes
  need an output connected to “Text 1”. Connect an output to “Text 1” on
  each, then run the nodes again." The singular keeps "Connect one".
- B2: "“Claude” needs messages. Connect them, then run the node again."
  The pronoun follows the noun's number: `_PLURAL_MASS_NOUNS` ("messages")
  takes "them"; audio, text, context, lighting, media and guidance keep
  "it" (media is used as a mass noun here, and GM named only messages).
- B3: the bar's "Can’t run here" stays. The busy-start toast ("Couldn't
  start the run.", graphStore) and the Cinema shot panel's "Couldn't
  generate the shot." (GENERATE_SHOT_HEADING) are main's lines, not
  Idol's, so they are left for the wording batch. The
  RUN_NOT_STARTED_HEADING comment no longer claims a busy start: a start
  refused another way keeps RUN_NODE_HEADING on the card.
- B4: two actions take a comma when either holds its own "or": the fix
  lists options, or the switch names two or more providers ("Pick 1K, or
  switch to fal.ai or Replicate."), backend `route_action` and frontend
  `routeAction` alike. This reaches every route line with two providers to
  switch to, not only a single option: "Add it in Settings, or switch to
  Black Forest Labs or fal.ai.", "Clear “Seed”, or switch to …", "Change
  that setting, or switch to …". With the comma, the log's ending is its
  own sentence (". Then run the node again."), as r32 set for the listed
  fix. route_cases.json and the generated not_ready_reasons.json follow.
- B5: the cursor bubble is the node's line alone when that line already
  opens with the quoted name ("“FLUX 3 Image” can’t run on fal.ai with …");
  a line that doesn't (an input to connect, or several lines joined) keeps
  "“X” can’t run." before it.
- Krea's named switch is pinned for a provider whose key is set but which
  can't take the run (Krea 3, the plan, a fal.ai key, high reasoning with
  no image: "…, or choose another provider."; F17). "Can’t make that
  size." is pinned on a fixture route's row (F12). Both already worked;
  the tests kill the mutants.
- MCP-SETUP's settings paragraph lists every in-place case (metadata that
  can't be carried, a refused rename), the fixed temp name, the copy
  folder and its deny lists, the lock and the transaction, and the copy
  folder's refusal; its `settings.restored` row has the line and `keptAt`.
- The switcher's description and menu label quote the node's name:
  "Provider for “FLUX 3 Image”: …".
- runway-gen4-turbo (the one definition only in the engine's NODE_DEFS)
  labels its ports "Image" and "Prompt", so its line says "Connect an
  image to this node, then run it again."

**Tests and CI.**

- The seam (MEDIUM-1): every stub takes `*args, **kwargs`; the xattr calls
  and the platform are module seams (`_listxattr`, `_getxattr`,
  `_setxattr`, `_PLATFORM`), so no test patches `os.setxattr`,
  `os.listxattr`, `os.getxattr` or `sys.platform` (they were process-wide).
  The Linux in-place test patches `_setxattr` and reads real user xattrs,
  so on Linux it runs the real branch, and it skips on macOS. M1 (a
  refused copy swallowed) is still killed. No Linux container ran here
  (Docker isn't running on this Mac); from the code, every settings path
  the tests take on Linux is the one they take here except `_PLATFORM`'s
  branch, which the simulated test runs here.
- test_project_save_event_loop is driven by events (LOW-1): the stand-in
  check records its thread, sets `in_check` and waits for `loop_ran`
  (10 s hang guard); a loop task sets `loop_ran`. It asserts the check ran
  off the loop and the wait returned. T4 (the check moved onto the loop)
  is killed. Main's other real-time budgets go to a separate follow-up
  PR: test_mcp_channel.py:1067, test_agent_questions.py:484,
  test_agent_questions_waits.py:211 and test_acp_session.py's 0.75 s
  check.
- The marker scan (NIT-1) reads `args=`, matches the command by its base
  name (`/bin/chmod`), and counts a digit string that isn't octal as
  unproven instead of crashing.
- The round 17 base-check counts are corrected (NIT-2, above).

### What agents see this round

- The refused-run log line (the presence event's `log`) says a node's
  several needs once, and merges nodes with the same set. `error` and
  `errors` are unchanged. MCP-SETUP.md and skills/nebula/SKILL.md say so.
- From 4 nodes the log line counts inside each reason's or set's
  sentence, and says "N nodes can’t run here yet." only past 600
  characters. MCP-SETUP.md says so.
- The Auto row is the person's switcher only; agents see no change there.
- Section 2: the log line's numbered-input plural ("Connect an output to
  “Text 1” on each"), "messages … Connect them", and the comma before a
  switch to two providers reach agents in the refused-run log line and in
  every route line Nebula already gives them; `error` and `errors` are
  unchanged. An agent's cursor
  bubble no longer repeats the node's name. `settings.restored` carries
  `keptAt` and GM's line as its summary; agents can't read the copy
  folder or the temp file (deny lists). A copy folder Nebula can't change
  answers a save with B6a's line, `settings_unwritable`. MCP-SETUP.md,
  `wait_for_canvas_change`'s docstring and SKILL.md say so.

### Checks (round 18)

- tsc -b --noEmit and lint pass. vite build passes; budget 462,527 bytes
  raw, 142,116 gzip (after section 1b). check-node-contracts (309), generate-model-reference
  --check, generate-route-tables --check and generate-not-ready-reasons
  --check are current.
- Focused vitest (83 files: everything that imports providerSwitch or
  ProviderSwitcher, the copy ratchets, failureLines, focusRingCss, the CSS
  sweeps and the presence ratchets): 1,348 passed, Errors 0, no timeouts.
  After section 1b, with every file that imports canvasProposals (128
  files): 2,231 passed, Errors 0, no timeouts.
- Focused backend (63 files that name the log line, person_line, the input
  needs or read MCP-SETUP.md or SKILL.md): 2,421 passed, 9 skipped. The
  settings files after the seam change (round 16, round 17 settings,
  settings_api, settings_path, the marker scan): 180 passed, 2 skipped
  (the Linux xattr tests, here on macOS). After section 1b, the 39 files
  that name the refused-run line, its heading, the count or read
  MCP-SETUP.md: 1,284 passed, 9 skipped. Four older tests that pinned the
  log's "4 nodes can’t run here yet." now pin the per-reason sentence
  (rounds 14, 16, 17 and 18).
- person_gate.py is unchanged.
- Base check (204ad52f with the new tests): round 18's log tests fail but
  the three "4 nodes can’t run here yet." cases, which guard the count
  line; the seam test fails (no seam); the simulated Linux tests pass on
  base (Linux already failed closed) and stay as guards. idolRound18.test.ts
  fails 9 of 10; "Auto · needs a key" passes as a guard. After section
  1b: all 39 round 18 log tests fail on base; idolRound18.test.ts fails 11
  of 15, and the 4 that pass guard what didn't change ("needs a key" for a
  key and for a mix, and the bar's summary and list).
- Mutants, all 19 killed (section 1 rerun after 1b; N8 the log counting
  from 4 again, N9 no fallback when too long, F3 retired in the old
  words, F4 too many in the old words, F5 the token noun ignored, F6 a key
  and a token said "token"): M1 a refused copy ignored, M2 the save bypasses
  the seam, M3 Linux skips an xattr it can't set, M4 Linux copies the
  system's own labels, N1 always "Connect them", N2 the plural without "to
  each", N3 a repeated input said twice, N4 the checks' order, not the
  input order, N5 the same set in another order not merged, N6 a need per
  input again, N7 one need as a set of one, F1 the colon back, F2 the
  rowBlock kinds without the provider.
- Live on 8793/5793 (sandboxed backend and Vite, the browser's proxy dead,
  canaries blocked for 8000, 8005, 8010, 5173, 8790, 8760 and six real
  hosts from the browser, and the backend's own canary; fake keys only;
  every run refused by the pre-call check):
  1. One FLUX Kontext node, an MCP run: "Nebula couldn’t start the run.
     “FLUX Kontext” needs a prompt and an image. Connect both, then run
     the node again."
  2. Two FLUX Kontext nodes feeding an Image Compare, an MCP run of the
     Compare: "Nebula couldn’t start the run. 2 “FLUX Kontext” nodes need
     a prompt and an image. Connect both to each, then run the nodes
     again."
  3. FLUX 3 at 1.5K on Auto with a fal.ai key: "Auto · fal.ai doesn’t take
     “Resolution” set to 1.5K".
  Shots in scratchpad/idol/shots18, three distinct md5s, each opened. No
  page errors; the 7 console errors are the canaries' own blocked loads.
  The live check ran before section 1b, which changes none of these
  three lines.

**Section 2 (review 17 and GM r36).**

- tsc and lint pass; vite build passes, budget 462,539 bytes raw, 142,122
  gzip; check-node-contracts (309), generate-model-reference,
  generate-route-tables and generate-not-ready-reasons (regenerated for
  B4) --check are current.
- Focused vitest (194 files: everything that imports directRoute,
  providerSwitch, ProviderSwitcher or nodeErrorCopy, the copy and CSS
  ratchets, the presence ratchets): 3,741 passed, Errors 0.
- Focused backend (162 files: every file that imports services.settings,
  agent_profiles, file_access, person_line, canvas_events, the engine's
  validate_graph or the run route, or reads MCP-SETUP.md or SKILL.md;
  the ratchets test_unprivileged_marker and test_ci_shard), in 4 isolated
  shards: 6,779 passed, 13 skipped, 3 failed. One was a pin of the old
  "Add it in Settings or switch to Black Forest Labs or fal.ai." in
  test_error_copy_round3e (B4 reaches it; updated, the file passes). Two
  were main's real-time budgets under a machine load of about 40:
  test_iterator_execution's 1-second wait for the handler to start, and
  test_agent_presence_agents' 5-second run_nodes wait. Both pass alone, on
  head and on 204ad52f, and the three files pass together (70). Both go on
  the follow-up list of main's real-time budgets.
- The first focused run hung: round 14's folder-at-the-settings-path test
  spun in the lock loop (above). Fixed; that file, round 17 settings and
  round 18 settings pass (126, 2 skipped on macOS).
- person_gate.py and the spend guard are unchanged; desktop/main.mjs is
  untouched; no private question ids in the diff.
- Base check (204ad52f with the new tests): round 18 settings fails 47 of
  48 (the N9 seam test passes as a guard; both lock tests fail by
  spinning, caught by their thread guard); round 18 copy fails 13 of 22
  (the six mass nouns that keep "it" and the three bubble-prefix cases
  guard what didn't change); the marker scan fails 3 of its 4 new cases
  (the 0644 case is a guard); idolRound18.test.ts fails 13 of 22 (Krea's
  named switch, the size note and two single-provider comma cases pin
  code that was already right).
- Mutants: all 57 killed, rerun together on the final code (the 19 from
  sections 0 to 1b, M3 and M4 pointed at the new `_setxattr` seam, and 38
  for section 2): S1 the copy folder not protected, S2 the temp file not a
  secret path, S3 the restore without the lock, S4 no keep-aside, S5/S5b/
  S5c no marker, hash or file checks, S6/S6b PUT or DELETE without the
  transaction, S7 no F_FULLFSYNC, S8/S8b no folder sync after either
  rename, S9 (N9) a pwrite of 0 accepted, S10 the sweep without the lock,
  S11 every file counted as a cut save, S12 the copy line as the folder
  line, S13 a file at the copy folder a 500, S14 the levels 0755, S15 the
  restored line always "because", S16 its summary cut at 200, S17 the lock
  not reentrant, S18 a stale fixed temp file kept, S19 the cut check from
  the shorter length, C1 the port plural "Connect one", C2 messages "it",
  C3 the bubble prefix always, C4/C5 no comma before two providers
  (backend, frontend), C6 (F17) and C7 (F12), C8 the description
  unquoted, C9 runway's image unlabelled, T1 to T3 the marker scan, T4
  the snapshot check on the loop, L1 the lock never holding a folder at
  the path, L2 a changing lock target spinning past the deadline. A
  mutant whose covering run hangs past 300 s would count as killed; none
  did.
- The review's three comparisons, 204ad52f against this round: the gate
  table is byte-identical (157,905 rows, md5 8ff8a96c…, the review's), the
  HTTP matrix's sorted rows too (330, md5 858c49c0…, the review's), and the
  fs cases' sorted rows too (574 cases, 12,710 rows, md5 b7fd63c0…): no
  difference to list. The table and the matrix ran before the lock fix,
  which none of their cases reach (no folder at the settings path); the fs
  cases ran after it. The copy folder changes no row: each row records
  the answer's status and line and the settings file's own state (hash,
  mode, inode, links), not the state folder.
- Live on 8793/5793 (the same sandbox and canaries; fake keys only; every
  run refused before a provider):
  4. FLUX 3 Image on fal.ai at 1.5K, wired to a prompt: the cursor bubble
     is "“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K.
     Pick 768 x 768, 1K, 2K or 4K, or switch to Black Forest Labs or
     Replicate." (the name once).
  5. Two Combine Text nodes, an MCP run: the log's "2 “Combine Text” nodes
     need an output connected to “Text 1”. Connect an output to “Text 1”
     on each, then run the nodes again."
  6. A route with no key and two providers: the card's "…Add it in
     Settings, or switch to Black Forest Labs or fal.ai." and the log's
     ". Then run the node again.".
  Shots 4 to 6 in scratchpad/idol/shots18, six distinct md5s in the
  folder, each opened; no page errors.

### Questions for GM (round 18)

- GM r35 answered both earlier questions (the per-set count from 4 in the
  log; subject-first Auto rows).
- B4 reaches more than "Pick 1K": every route line with two providers to
  switch to takes the comma ("Add it in Settings, or switch to Black
  Forest Labs or fal.ai.", "Clear “Seed”, or switch to …"), and with the
  comma the log ends ". Then run the node again." as its own sentence, as
  r32 set for a listed fix. Keep both, or only the single-option case?
- B2: only "messages" takes "them"; "media" keeps "it" (used as a mass
  noun here). Confirm.
- B3: the busy-start toast and the Cinema line are main's, not Idol's, so
  they are left for the wording batch.
