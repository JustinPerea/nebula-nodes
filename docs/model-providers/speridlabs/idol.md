---
id: nebula-speridlabs-idol
kind: project-model-integration
project: nebula_nodes
provider: speridlabs
status: active
verified: 2026-10-29
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
- [ZeroGPU docs](https://huggingface.co/docs/hub/spaces-zerogpu): quotas and
  overage billing
- `spaces` 0.51.3 `spaces/zero/client.py`: the quota error texts

## Node

| Node ID | Category | Inputs | Outputs | Route | Key |
|---|---|---|---|---|---|
| `speridlabs-idol` | `3d-gen` | `image` (Image, required) | `world` (World v2) | `hf-space`, maker, Space `speridlabs/idol` | none; `HF_TOKEN` optional |

Handler: `backend/handlers/speridlabs_idol.py`, through the `hf-space` route
client (`backend/execution/route_clients.py` `run_hf_space`).

The route is keyless (`keys: []`, `optionalKeys: ["HF_TOKEN"]`, see
[PROVIDER-ROUTES.md](../../PROVIDER-ROUTES.md#keyless-routes)): Auto runs it
with no key, and the token, when set, only changes whose ZeroGPU time a run
uses. `HF_TOKEN` is not in `envKeyName`, so the node reads as free
(`node_readiness.instance_access` returns `free` without the token and `key`
with it).

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
   before any call; a 404 says the Space is gone.
2. `GET /gradio_api/info`: the signature. Inputs, outputs and the two enums
   must match the pinned fixture exactly, or the run stops with "The Idol Space
   changed how it's called".
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
   URL-quoted; an `http://` result URL falls back to HTTPS), streamed into
   the run folder as a `.part` with a 128 MiB cap, checked by
   `services/splat_ply.validate_splat_ply`, then renamed into place as
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
docs: ZeroGPU Spaces are free to all users. Each run uses the caller's daily
ZeroGPU time: without a token, Hugging Face's small anonymous allowance; with
one, the account's own (5 minutes on a free account, 40 on PRO and Team, 60 on
Enterprise). Each Idol call reserves 120 s of GPU (`spaces.GPU(duration=120)`
in `app.py`), and ZeroGPU checks the reserved duration against the quota, so
the anonymous allowance may fit about one run a day. The first live run
should confirm it; if anonymous runs can never fit 120 s, readiness must say a
token is needed (GM, waiting on Justin's live test). **PRO, Team and Enterprise accounts can go past
the daily quota on prepaid Hugging Face credits, at $1 per 10 GPU-minutes.**
That charge is on the person's own Hugging Face account; Nebula can't see it
and doesn't count it. The real GPU time per run isn't published or measured.
Agents' spend gate admits the run at $0, like other free nodes; whether an
agent may run it on a PRO token that can bill past the quota is open
(TODO(Justin)).

## Errors

The card's lines are GM's (PR #203 r1), with curly apostrophes.

| Situation | The card's line |
|---|---|
| No image | "Idol needs an image. Connect one, then run it again." |
| Anonymous quota used up | "Idol’s free allowance is used up for now. Try again later, or add your Hugging Face token in Settings to use your own." |
| The person's quota used up | "Your Hugging Face GPU allowance is used up for now. Try again later, or raise it on your Hugging Face account." |
| No GPU free in the queue | "Hugging Face had no free GPU for Idol. Try again in a few minutes." |
| The Space's own GPU limit | "Idol has reached its own limit on Hugging Face for now. Try again later." |
| A token was sent but didn't reach the Space | "Idol ran without your Hugging Face token and hit the free allowance. Check your token in Settings, then try again." |
| 120 s is more than the allowance per run, no token | "Idol needs more GPU time per run than the free allowance gives. Add your Hugging Face token in Settings, then try again." |
| The same with a token | "Idol needs more GPU time per run than your Hugging Face account allows. Raise your allowance on Hugging Face, then try again." |
| Space sleeping or building past 180 s | "Idol is still starting on Hugging Face. Try again in a few minutes." |
| Space paused, stopped or failed | "Idol isn’t running on Hugging Face right now. Try again later." |
| Space deleted | "Idol is no longer on Hugging Face, so it can’t run. Use another 3D node instead." |
| Signature changed | "Idol changed on Hugging Face, and this version of Nebula can’t run it. Update Nebula, then try again." |
| Token refused (401 or 403 from the Hub or the Space) | "Hugging Face didn’t accept your token. Check it in Settings." |
| Token with a character a header can't carry | "Your Hugging Face token has a character a token can’t have. Paste it again in Settings." |
| No answer in time | "Idol took too long to answer. Try again in a few minutes." |
| Not a readable splat | "Idol sent back a file Nebula can’t read as a splat. Try again." |
| Splat over 128 MiB | "This splat is too large for Nebula to keep. Lower Gaussians in the node’s settings, then run it again." |
| A setting out of range | "Steps must be between 10 and 100. Change it in the node’s settings, then run it again." (each field with its own label and limits) |

How the ZeroGPU texts are told apart (`zerogpu_kind`, from `spaces` 0.51.3
`zero/client.py`):

- **Duration**: "The requested GPU duration (Ns) is larger than the maximum
  allowed". The text is the same with and without a token, so which line
  shows depends on whether Nebula sent `HF_TOKEN`. This is built against the
  mock; the first live run should confirm the texts.
- **The person's own quota**: "exceeded your … quota", "runs limit" or "too
  many ZeroGPU credits". Without a token this is the free allowance line.
- **No IP token reached the Space**: `spaces` adds "Try re-running outside of
  examples" only on the branch where no `X-IP-Token` arrived. With that
  marker, "reached its GPU limit" or "No GPU was available" is the token-not-
  applied line when Nebula sent a token, and the Space's own limit when it
  didn't.
- **Busy**: "No GPU was available" without that marker: the queue timed out.
- **The Space's own limit**: "reached its GPU limit" without the marker.

## Token handling

The token goes only to `huggingface.co` and `speridlabs-idol.hf.space` over
HTTPS (`token_allowed`, `TOKEN_HOSTS`), as a Bearer header, never in a URL.
Not any `*.hf.space`: anyone can make a Space, so a result URL on another
Space never gets it. A token with a character outside printable ASCII is
refused before any request. Which token scope Settings asks for, and whether
it says the token goes to Speridlabs' Space, are open (TODO(Justin)). Provider text is
scrubbed of it before it reaches an error, connection errors keep only their
type name, and the log line says `signed_in=True/False`, nothing more. Agents
see it masked like every key; only a person can set it.

## Cancellation

Stopping a run closes the stream and ends Nebula's wait. Gradio's `/call` API
has no documented cancel, so a job the Space has already started can still
finish there and use that person's GPU time.

## What isn't covered

- No live run. The first real run should be a person's, on their own token,
  at 65,536 Gaussians.
- The Space is the maker's demo, not a service with an uptime promise; a
  change to its signature stops the node until Nebula is updated.
- World Labs Export takes only Marble's World v1, so it can't export an Idol
  splat; download the `.ply` from the preview instead.
