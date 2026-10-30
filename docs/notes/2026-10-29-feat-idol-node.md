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
