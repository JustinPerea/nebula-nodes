---
id: nebula-speridlabs-idol
kind: project-model-integration
project: nebula_nodes
provider: speridlabs
status: active
verified: 2026-10-30
stale_after_days: 14
---

# Speridlabs Idol structural audit

Idol turns one image of an object into a 3D Gaussian splat. Nebula runs it on
Speridlabs' own Hugging Face Space, the maker's only public way to run it.
This is a structural audit with mocked HTTP: no Idol run was started, no
Space queue was joined, and nobody's GPU time was used on 2026-10-29.

## Canonical sources

Read 2026-10-29 (GET requests that run nothing):

- [Space page](https://huggingface.co/spaces/speridlabs/idol) and its repo
  files `app.py`, `idol/model.py`, `idol/gaussian.py`, `idol/camera.py`
- [Gradio API info](https://speridlabs-idol.hf.space/gradio_api/info), pinned
  byte for byte in `backend/tests/fixtures/provider_schemas/speridlabs_idol_gradio_info.json`
  (13,741 bytes)
- [Space config](https://speridlabs-idol.hf.space/config): Gradio 5.49.1,
  `api_prefix` `/gradio_api`, protocol `sse_v3`
- [Hub Space API](https://huggingface.co/api/spaces/speridlabs/idol):
  `runtime.stage` RUNNING on `zero-a10g`
- [Querying Gradio apps with curl](https://www.gradio.app/guides/querying-gradio-apps-with-curl)
- [ZeroGPU docs](https://huggingface.co/docs/hub/spaces-zerogpu): quotas,
  GPU sizes and overage billing
- `spaces` 0.51.3, the package ZeroGPU Spaces run
  ([wheel](https://files.pythonhosted.org/packages/f5/b3/f6c0dfa766e0fc5ae66466235c13be580e543d8d2d9023f678ba5859adca/spaces-0.51.3-py3-none-any.whl),
  released 2026-08-31 and still the current PyPI release on 2026-10-30):
  `spaces/zero/client.py` (the quota error texts, `get_duration_seconds`, the
  admission check) and `spaces/zero/configs.json` (each GPU's
  `duration_factor`). The Space doesn't pin it (its `requirements.txt` has no
  `spaces` line; Hugging Face installs it at build), so it runs whatever
  release is current when it was last built.
- [`huggingface_hub` 2.4.0 `utils/_http.py`](https://github.com/huggingface/huggingface_hub/blob/v2.4.0/src/huggingface_hub/utils/_http.py)
  `hf_raise_for_status`: how the Hub says a repo is missing, gated or disabled
- [hub-docs `spaces-zerogpu.md` line 116 at d035e18f](https://github.com/huggingface/hub-docs/blob/d035e18fdd808e4dced8c51b61c19287fe5c5323/docs/hub/spaces-zerogpu.md?plain=1#L116)
  (2026-09-07): the `xlarge` note counts an "effective" task duration
- [gradio-app/gradio PR #11700](https://github.com/gradio-app/gradio/pull/11700),
  `gradio_client` 1.11.1+ and Hugging Face's MCP server: the
  `X-HF-Authorization` header

## Node

| Node ID | Category | Inputs | Outputs | Route | Key |
|---|---|---|---|---|---|
| `speridlabs-idol` | `3d-gen` | `image` (Image, required) | `world` (World v2) | `hf-space`, maker, Space `speridlabs/idol` | `HF_TOKEN` (required) |

Handler: `backend/handlers/speridlabs_idol.py`, through the `hf-space` route
client (`backend/execution/route_clients.py` `run_hf_space`).

The route needs the person's Hugging Face token (`keys: ["HF_TOKEN"]`, GM
PR #203 r4; see [Why a token is required](#why-a-token-is-required)).
Readiness, Auto, `describe_node`, `nebula info` and `nebula keys` treat Idol as
keyed. Without the token the route carries its own line
(`missingKeyLine`, [PROVIDER-ROUTES.md](../../PROVIDER-ROUTES.md#a-routes-own-missing-key-line)):
"You can run Idol after you add your Hugging Face token in Settings."

Nothing runs until the token is added (GM PR #203 r6, `lib/runKeyLock.ts`):

- Run on the node, or on a node fed by it, is locked with that line on every
  surface (the selection toolbar, the Inspector, the context menu). It is
  `aria-disabled` rather than natively disabled, like the toolbar's Run while
  the tab follows an agent: it keeps its focus and tooltip, its accessible
  description is the line, and it has the canvas lock's not-allowed cursor.
- The toolbar's Run is locked the same way for the whole canvas: "You can run
  this canvas after you add your Hugging Face token in Settings." The card
  keeps its own line, so the person sees which node needs it.
- Cmd+Enter, the palette's "Run graph" and any other run path that would run
  Idol send nothing and show the line as a neutral one-line notice.
- A proposal whose run needs Idol has Accept locked: "You can accept this
  after you add your Hugging Face token in Settings." The backend refusal stays
  behind it.
- Agent and CLI runs are refused with the node's line before any request
  (`node_route.route_unavailable_line` in the engine's preflight); `nebula
  quick` / `/api/quick` answers 400 "Nothing ran, so nothing was spent. You can
  run Idol after you add your Hugging Face token in Settings." before the spend
  check.

The handler's anonymous branch still works, as a backstop and for a switch
back.

### Switching back to keyless

If the first live run shows the Space asks for 120 s, a keyless route could
run on the anonymous allowance. That is not a one-line change:

1. **The route**: `keys: []` and `optionalKeys: ["HF_TOKEN"]`, drop
   `missingKeyLine`, and empty `envKeyName` and `directKeyName`, in
   `nodeDefinitions.ts` and the JSON mirror.
2. **The copy**: every string written for the token-required state needs new
   keyless copy, ruled by the design reviewer first (r4 replaced r1's keyless
   lines): the route note, the Settings row ("Needed to run Idol."), its
   caveat, the node description, the user guide in
   `docs/api-guides/speridlabs.md`, and the keyless readiness lines in
   `providerReadiness.ts` (kept in code, never shown today, with a TODO to
   re-rule them from the first live run's numbers).
3. **The tests that pin the keyed state flip**: round 3's review applied
   step 1 in a scratch worktree and counted 18 backend tests
   (`test_route_agent_surfaces.py` ×5, `test_speridlabs_idol.py` ×11 and two
   route-case tests) and 11 frontend ones (`idolNode`, `idolRunLock`,
   `ProviderSwitcher`, `ProviderReadinessBadge`). Round 4 added more that pin
   it (`idolCanvasLock`, the Accept lock in `ProposalBar`, the quick refusal),
   so count again at that point. The keyless rules keep their own tests,
   each built only on `keyless_idol` or `_keyless_idol` (which build the
   keyless route from the current one either way), so they pass before and
   after step 1. Round 5's review split the three tests that mixed a keyed
   half in; with step 1 applied in a scratch copy (round 6), every keyless
   test passed and 15 keyed backend tests failed, as step 3 expects.
4. **The generated tables**: the route tables
   (`generate-route-tables.py`) and `docs/MODEL_REFERENCE.md`, then
   `scripts/check-node-contracts.mjs`, which CI runs.

## Request contract

`/run` takes, in order: `image` (ImageData), `mode` ("Synthetic" or "Real
photo"), `steps` (10-100, default 50), `cfg_scale` (0-10, default 3),
`rescale_t` (1-6, default 3), `seed` (default 42), `randomize` (bool) and
`gaussians` ("65,536" to "1,048,576", default "262,144"). It returns a Model3D
file (the `.ply`), the seed used, and an HTML block.

A run is:

1. `GET https://huggingface.co/api/spaces/speridlabs/idol`: the stage. A
   sleeping or building Space is woken with one `GET /gradio_api/info` and
   polled for up to 180 s; a paused, stopped or failed one stops the run
   before any call. The Space reads as missing by `huggingface_hub`'s rule
   (2.4.0 `hf_raise_for_status`, in its order on an error answer:
   `RevisionNotFound` and `EntryNotFound` come first and aren't missing; the
   bucket and job branches don't apply to `/api/spaces/{id}`):
   `X-Error-Code: GatedRepo`, then `X-Error-Message: Access to this resource
   is disabled.`, then `X-Error-Code: RepoNotFound` (Hugging Face answers that
   for a deleted Space and for a private one the caller can't see) or a 401
   whose `X-Error-Message` isn't "Invalid credentials in Authorization
   header". Gated and disabled come first, so with a token they read as
   missing too, not as a refused token. A 404 without the RepoNotFound code
   isn't missing to `huggingface_hub`, so the stage check skips it and goes on
   to the Space. With a token, the bad-credentials 401, or another 403, is the
   token refused.
2. `GET /gradio_api/info`: the signature. Inputs, outputs and the two enums
   must match the pinned fixture exactly, or the run stops with "Idol changed
   on Hugging Face, and this version of Nebula can’t run it. Update Nebula,
   then try again." (the agent text: "The Idol Space's API changed (…)").
3. The image: Nebula reads it itself (`load_media`, which fetches a public
   HTTPS URL through `fetch_public_media` and refuses loopback and private
   hosts), then uploads the bytes with `POST /gradio_api/upload` (multipart
   `files`) under a neutral name such as `input.png`, so neither the source
   URL nor its query string nor a local file name reaches the Space.
   Settings are range-checked against the pinned bounds first.
4. `POST /gradio_api/call/run` with `{"data": [...]}`, then the event stream
   `GET /gradio_api/call/run/{event_id}` until `complete` or `error`.
   Heartbeats (every 15 s) move the progress bar slowly; it never claims done.
5. The `.ply` from `/gradio_api/file=...` on the Space's own host (the path
   URL-quoted; an `http://` result URL falls back to HTTPS), asked for as it
   is (`Accept-Encoding: identity`) and streamed into the run folder as a
   `.part`. A server that compresses it anyway is still read: httpx hands
   over the decoded bytes, and Content-Length (the compressed size then) is
   compared only when the body isn't encoded. The PLY header is checked as soon as
   `end_header` arrives (or after 64 KiB): a file that isn't a splat PLY, more
   than 2,000,000 Gaussians or a declared size over 128 MiB stops the
   download there. A Content-Length that disagrees with the header's size, or
   a body that runs past it, stops it too. The whole file is then checked by
   `services/splat_ply.validate_splat_ply` and renamed into place as
   `idol-seed{seed}-{gaussians}-{8 hex}.ply`, so two nodes with the same
   settings never share a file.

The node's values are its own (`synthetic`, `real`, `262144`), mapped to the
Space's labels by the route's `valueMap`. `randomize` is always sent false and
is not a setting: Nebula's run cache keys on the params, so a random seed would
replay one result. A new seed gives a new object.

## Output: World v2

```json
{
  "schemaVersion": 2, "kind": "world", "id": "idol-<12 hex>", "displayName": "Idol object",
  "coordinateSystem": {"id": "idol-object", "handedness": "right", "upAxis": "-y", "forwardAxis": "x",
                       "unit": "custom", "metersPerUnit": 1, "originMeters": [0, 0, 0]},
  "session": {"source": "generated", "provider": "speridlabs", "model": "idol", "label": "Idol object",
              "tags": ["seed:42", "gaussians:262144", "mode:synthetic", "steps:50"]},
  "assets": {"splats": [{"id": "splat", "format": "ply", "pointCount": 262144,
                         "asset": {"id": "splat-ply", "uri": "/api/outputs/...", "mediaType": "application/octet-stream",
                                   "byteLength": 17826208}}]}
}
```

Axes: Idol's model works z-up, and `save_ply` writes (x, -z, y). Its comment
says "y-up", but up in the file is **-Y**: the example
`default-obj-backpack.ply` projected on to the XY plane is upright with +Y
pointing down. The front faces **+X**: renders of the backpack from each axis
show its front at +X, its back at -X and its sides at ±Z (PR #203 review). The
input camera's yaw is predicted per image, so this is the usual front, not a
promise. The value says right-handed, `upAxis` `-y`, `forwardAxis` `x`; the
viewer turns it upright and opens on a three-quarter view of that side
(about 30° off the front and 15° above, the object's bounding sphere filling
about 60% of the view). The object fits in [-0.5, 0.5] on each axis in model
units, so the unit is `custom`. `pointCount` is the count in the file's own
validated header, not the requested setting.

The file is the plain 3DGS layout with degree-0 spherical harmonics: 17
float32 properties (x y z, nx ny nz, f_dc_0..2, opacity, scale_0..2,
rot_0..3), 68 bytes a Gaussian. 262,144 Gaussians is 17.8 MB; 1,048,576 is
71.3 MB.

## Price

`model_pricing.json` prices the route at $0 a run, sourced from the ZeroGPU
docs: "ZeroGPU Spaces are available to use for free to all users." Each run
uses the person's own daily ZeroGPU time through their token. The docs' tiers
(read 2026-10-30):

| Account | Daily GPU quota | Queue priority |
|---|---|---|
| Unauthenticated | 2 minutes | Low |
| Free account | 5 minutes | Medium |
| PRO account | 40 minutes (extensible) | Highest |
| Team organization member | 40 minutes (extensible) | Highest |
| Enterprise organization member | 60 minutes (extensible) | Highest |

The unauthenticated row is the docs' figure for visitors; Nebula's backend
calls from a server, and whether that row applies to server-side calls isn't
documented.

**PRO, Team and Enterprise accounts can go past the daily quota on prepaid
Hugging Face credits** ("at the rate of $1 per 10 minutes of GPU time. Once
your daily quota is exhausted, any additional GPU usage is automatically
billed against your credit balance"). That charge is on the person's own
Hugging Face account; Nebula can't see it and doesn't count it. `describe_node`
tells agents so (`billing` on the route, `main.HF_SPACE_BILLING_NOTE`), and so
do `find_nodes` (a `billing` field next to "free"), `nebula nodes` (a
`BILLING:` line under the table), `start_here` (a note), `nebula info` (a
`BILLING:` line) and `skills/nebula/SKILL.md`. Agents' spend
gate admits the run at $0, like other free nodes, pending a product decision
on whether agents ask before runs that can bill a PRO account.

## Why a token is required

The Space asks for 120 s a call (`app.py` `gpu = spaces.GPU(duration=120)` on
its one `/run` function), and
`spaces` 0.51.3 scales that by the GPU it runs on before asking ZeroGPU:

```python
# spaces/zero/client.py
def get_duration_seconds(duration, gpu_size):
    zerogpu_config = config.get_config()
    gpu_size = gpu_size if gpu_size is not None else default_gpu_size()
    duration_seconds = duration.seconds if duration is not None else DEFAULT_SCHEDULE_DURATION
    if gpu_size != 'xlarge':
        duration_seconds *= zerogpu_config['duration_factor']
    return duration_seconds
```

```json
// spaces/zero/configs.json
{"model": "NVIDIA H200", ..., "duration_factor": 1.0},
{"model": "NVIDIA RTX PRO 6000 Blackwell Server Edition", ..., "duration_factor": 1.5}
```

`get_config()` picks the entry whose `model` matches the GPU the driver
reports. The ZeroGPU docs now say the default size is "Half NVIDIA RTX Pro
6000 Blackwell", so a call most likely asks for 120 × 1.5 = **180 s**, more
than the unauthenticated 2 minutes. ZeroGPU refuses an ask larger than the
tier's maximum ("The requested GPU duration (180s) is larger than the maximum
allowed"), so without a token Idol likely can't run at all.

Three things keep 180 s from being settled:

- The Space doesn't pin `spaces`, so the rule above is the current PyPI
  release (0.51.3, 2026-08-31), not a version the Space fixes.
- The Hub reports the Space's hardware as `zero-a10g`, and `get_config()`
  falls back to the H200 entry (factor 1.0, so 120 s) when the driver's model
  string matches neither entry.
- On Blackwell, a model packed over `xlarge_threshold` (45,097,156,608 bytes)
  makes the default size `xlarge`. Then the factor isn't applied, but the
  quota counts twice (`requested *= 2 if gpu_size == 'xlarge'`).

Starting a run and paying for it are two different checks:

- **Admission**: a run starts only if the account has the whole ask left.
  The refusal names both numbers, "({requested}s requested vs. {left}s
  left)" (`spaces/zero/client.py` 0.51.3, the quota branch of the schedule
  call).
- **Charge**: the quota is likely charged only the seconds the run uses. The
  docs say so only for `xlarge` (line 116): "`xlarge` consumes **2×** more
  daily quota than `large` (e.g. a 45s **effective** task duration consumes
  90s of quota)". The first live run will show it.

Daily quotas, from the docs' table: free 300 s, PRO and Team 2,400 s,
Enterprise 3,600 s, unauthenticated 120 s.

### Open: can a free account run Idol at all?

Nebula says no run count until the first live run (GM, PR #203 r8). Two
limits apply, and only the daily quota is published:

- **The per-task cap.** ZeroGPU refuses a task whose ask is over the
  account's maximum for one task: "The requested GPU duration ({requested}s)
  is larger than the maximum allowed" (`spaces/zero/client.py` 0.51.3, when
  the schedule answer's `wait` is negative). On an API call, for no account
  or a free ("regular") one, it adds "Subscribe to Hugging Face PRO to allow
  GPU tasks up to 40 min". The cap for a free account isn't published, so a
  free account may be refused the 180 s ask even with its whole day's quota
  left.
- **The daily quota.** A run starts only with the whole ask left (above).

If a free account fits, the count comes back with the real number. If it
doesn't, Idol needs a PRO account, and the copy (including the node
description's "free within your Hugging Face allowance") is ruled again.

**To be confirmed on the first live run**: ZeroGPU's quota and duration
errors name the seconds requested. If the live run shows 120 s, see
[Switching back to keyless](#switching-back-to-keyless) for what that takes.

## Errors

The card's lines are GM's (PR #203 r1 to r4), with curly apostrophes.

| Situation | The card's line |
|---|---|
| No token in Settings (refused before any request) | "You can run Idol after you add your Hugging Face token in Settings." |
| No image | "Idol needs an image. Connect one, then run it again." |
| Anonymous quota used up (a run that slips through without a token) | "Idol’s free allowance is used up for now. Try again later, or add your Hugging Face token in Settings to use your own." |
| The person's quota used up | "Your Hugging Face GPU allowance is used up for now. Try again later, or raise it on your Hugging Face account." |
| No GPU free in the queue | "Hugging Face had no free GPU for Idol. Try again in a few minutes." |
| The Space's own GPU limit | "Idol has reached its own limit on Hugging Face for now. Try again later." |
| A token was sent but didn't apply (no IP token reached the Space, or the quota text is the IP-only one) | "Idol ran without your Hugging Face token and hit the free allowance. Check your token in Settings, then try again." |
| The run's ask (120 s, or 180 s on Blackwell) is more than the allowance per run, no token | "Idol needs more GPU time per run than the free allowance gives. Add your Hugging Face token in Settings, then try again." |
| The same with a token (either the token didn't apply, or a free account's per-task cap is under the ask; the text is the same for both, so the first live run settles it; until then GM r6 #7 shows the token line) | "Idol ran without your Hugging Face token and hit the free allowance. Check your token in Settings, then try again." The signed-in duration line ("Idol needs more GPU time per run than your Hugging Face account allows. Raise your allowance on Hugging Face, then try again.") stays in code, unused, for the first live run to confirm or replace. |
| Space sleeping or building past 180 s | "Idol is still starting on Hugging Face. Try again in a few minutes." |
| Space paused, stopped or failed | "Idol isn’t running on Hugging Face right now. Try again later." |
| Space missing (deleted, private, gated or disabled; with or without a token) | "Nebula can’t find Idol on Hugging Face, so it can’t run. Use another 3D node instead." |
| Signature changed | "Idol changed on Hugging Face, and this version of Nebula can’t run it. Update Nebula, then try again." |
| Token refused (with a token, a 401 or 403 from the Hub, `/gradio_api/info`, the upload, `/call/run` or its stream) | "Hugging Face didn’t accept your token. Check it in Settings." |
| Token with a character tokens can't have (leading and trailing spaces and line breaks are trimmed first) | "This token has a character Hugging Face tokens can’t have. Copy it again from Hugging Face, then paste it in Settings." (the Settings field, and the settings check, which then sends nothing: "…then paste it here.") |
| The image was empty | "The image Idol got is empty. Check the node that makes it, then run Idol again." |
| The model couldn't make an object | "Idol couldn’t make a 3D object from this image. Try another image, or open Details to see why." |
| The Space stopped with no message | "Idol stopped without saying why. Try again in a minute." |
| The upload was refused | "Idol couldn’t use this image. Try another one, or open Details to see why." |
| `/call/run` was refused | "Idol turned down this run. Open Details to see why, then try again." |
| The stream ended or failed before a result | "Idol stopped before sending a result. Try again in a minute." |
| The `.ply` download failed | "Nebula couldn’t download the object from Idol. Try again in a minute." |
| No connection | "Nebula couldn’t reach Idol. Check your internet connection, then try again." |
| A Gaussians or input type value the Space doesn't list | "Idol doesn’t take this Gaussians value. Pick one from the list." / "Idol doesn’t take this input type. Pick one from the list." |
| No answer in time | "Idol took too long to answer. Try again in a few minutes." |
| Not a readable splat | "Idol sent back a file Nebula can’t read as a splat. Try again." |
| Splat over 128 MiB | "This splat is too large for Nebula to keep. Lower Gaussians in the node’s settings, then run it again." |
| A setting out of range | "Steps must be between 10 and 100. Change it in the node’s settings, then run it again." (each field with its own label and limits) |

How the ZeroGPU texts are told apart (`zerogpu_kind`, from `spaces` 0.51.3
`zero/client.py`):

- **Duration**: "The requested GPU duration (Ns) is larger than the maximum
  allowed". The text is the same with and without a token, so which line
  shows depends on whether Nebula sent `HF_TOKEN`: without one, the free
  allowance's duration line; with one, the token-not-applied line. This is
  built against the mock; the first live run should confirm the texts.
- **The person's own quota**: "exceeded your … quota", "runs limit" or "too
  many ZeroGPU credits". Without a token this is the free allowance line.
- **A token that didn't apply**: with a token sent, the IP-only quota texts
  ("authenticate with a Hugging Face token", or the bare "exceeded your
  ZeroGPU quota" with no free or Pro label) mean ZeroGPU fell back to
  IP-based quotas: the token-not-applied line.
- **No IP token reached the Space**: `spaces` adds "Try re-running outside of
  examples" only on the branch where no `X-IP-Token` arrived. With that
  marker, "No GPU was available" is the token-not-applied line when Nebula
  sent a token, and the Space's own limit when it didn't.
- **Busy**: "No GPU was available" without that marker: the queue timed out.
- **"reached its GPU limit"** (with or without the marker): the Space's own
  limit without a token, token-not-applied with one.

## Token handling

The token goes only to `huggingface.co` and `speridlabs-idol.hf.space` over
HTTPS (`token_allowed`, `TOKEN_HOSTS`), never in a URL: `Authorization:
Bearer` to the Hub, and `X-HF-Authorization: Bearer` to every Space request
(info, upload, call, stream and the file download), as `gradio_client`
1.11.1+ and Hugging Face's MCP server send it. Gradio PR #11700 says Hugging
Face's Space proxy reads that header for the caller's ZeroGPU quota and
strips it, so the token shouldn't reach Speridlabs' container; plain
`Authorization` would. To be confirmed on the first live run (a
token-not-applied error would say it didn't arrive). Not any `*.hf.space`:
anyone can make a Space, so a result URL on another Space never gets it.
Settings, `/api/credentials/update`, the settings check and the handler trim
leading and trailing spaces and line breaks, and a token of spaces alone
counts as no token; a token with any other character outside printable ASCII
is refused before any request, the settings check included. Which token scope
Settings asks for, and whether it says the token goes to Speridlabs' Space,
are pending a product decision. Provider text is
scrubbed of it before it reaches an error, connection errors keep only their
type name, and the log line says `signed_in=True/False`, nothing more. Agents
see it masked like every key; only a person can set it.

## Cancellation

Stopping a run closes the stream and ends Nebula's wait. Gradio's `/call` API
has no documented cancel, so a job the Space has already started can still
finish there and use that person's GPU time.

## What isn't covered

- No live run. The first real run should be a person's, on their own token,
  at 65,536 Gaussians. It should confirm the seconds the Space asks for (120
  or 180), that `X-HF-Authorization` carries the token's quota, and the
  ZeroGPU error texts.
- The Space is the maker's demo, not a service with an uptime promise; a
  change to its signature stops the node until Nebula is updated.
- World Labs Export takes only Marble's World v1, so it can't export an Idol
  splat; download the `.ply` from the preview instead.
