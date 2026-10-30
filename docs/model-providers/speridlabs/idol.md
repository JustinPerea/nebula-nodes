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
3. The image: a public `http(s)` URL goes as itself; a data URI or a local
   file is uploaded with `POST /gradio_api/upload` (multipart `files`).
4. `POST /gradio_api/call/run` with `{"data": [...]}`, then the event stream
   `GET /gradio_api/call/run/{event_id}` until `complete` or `error`.
   Heartbeats (every 15 s) move the progress bar slowly; it never claims done.
5. The `.ply` from `/gradio_api/file=...` on the Space's own host, streamed
   into the run folder with a 128 MiB cap, checked by
   `services/splat_ply.validate_splat_ply`, then renamed into place.

The node's values are its own (`synthetic`, `real`, `262144`), mapped to the
Space's labels by the route's `valueMap`. `randomize` is always sent false and
is not a setting: Nebula's run cache keys on the params, so a random seed would
replay one result. A new seed gives a new object.

## Output: World v2

```json
{
  "schemaVersion": 2, "kind": "world", "id": "idol-<12 hex>", "displayName": "Idol object",
  "coordinateSystem": {"id": "idol-object", "handedness": "right", "upAxis": "-y", "forwardAxis": "z",
                       "unit": "custom", "metersPerUnit": 1, "originMeters": [0, 0, 0]},
  "session": {"source": "generated", "provider": "speridlabs", "model": "idol", "label": "Idol object",
              "tags": ["seed:42", "gaussians:262144", "mode:Synthetic", "steps:50"]},
  "assets": {"splats": [{"id": "splat", "format": "ply", "pointCount": 262144,
                         "asset": {"id": "splat-ply", "uri": "/api/outputs/...", "mediaType": "application/octet-stream",
                                   "byteLength": 17826208}}]}
}
```

Axes: Idol's model works z-up, and `save_ply` writes (x, -z, y). Its comment
says "y-up", but up in the file is **-Y**: the example
`default-obj-backpack.ply` projected on to the XY plane is upright with +Y
pointing down. The side the input camera saw faces +Z. That is the same
right-handed, -Y-up, +Z-forward frame as World Labs' OpenCV splats. The object
fits in [-0.5, 0.5] on each axis in model units, so the unit is `custom`.

The file is the plain 3DGS layout with degree-0 spherical harmonics: 17
float32 properties (x y z, nx ny nz, f_dc_0..2, opacity, scale_0..2,
rot_0..3), 68 bytes a Gaussian. 262,144 Gaussians is 17.8 MB; 1,048,576 is
71.3 MB.

## Price

`model_pricing.json` prices the route at $0 a run, sourced from the ZeroGPU
docs: ZeroGPU Spaces are free to all users. Each run uses the caller's daily
ZeroGPU time: 2 minutes a day without an account, 5 on a free account, 40 on
PRO and Team, 60 on Enterprise. **PRO, Team and Enterprise accounts can go past
the daily quota on prepaid Hugging Face credits, at $1 per 10 GPU-minutes.**
That charge is on the person's own Hugging Face account; Nebula can't see it
and doesn't count it. The Space asks for up to 120 s of GPU per call
(`spaces.GPU(duration=120)`); the real time per run isn't published or
measured. Agents' spend gate admits the run at $0, like other free nodes.

## Errors

| Situation | The card's line |
|---|---|
| No image | "Idol needs an image. Connect one, then run it again." |
| Anonymous quota used up | "The free GPU time Idol shares without an account is used up for now. Add a Hugging Face token in Settings to use your own daily time, or try again later." |
| The person's quota used up | "Your Hugging Face GPU time for today is used up. Run Idol again once it resets, or add time to your Hugging Face account." |
| Space sleeping or building past 180 s | "The Idol Space is still starting up on Hugging Face. Try again in a few minutes." |
| Space paused, stopped or failed | "The Idol Space on Hugging Face isn't running right now. Try again later." |
| Space deleted | "The Idol Space is gone from Hugging Face, so Idol can't run." |
| Signature changed | "The Idol Space changed how it's called, so this version of Nebula can't run it. Update Nebula, or check the Space." |
| Token refused | "Hugging Face didn't accept your access token. Check it in Settings." |
| No answer in time | "The Idol Space took too long to answer. Try again in a few minutes." |
| Not a readable splat | "Idol sent back a file that isn't a splat Nebula can read. Try again." |
| Splat over 128 MiB | "Idol made a splat too large for Nebula to keep. Pick fewer Gaussians." |

Quota errors are matched on the `spaces` package's own texts ("exceeded your
... quota", "reached its GPU limit", "runs limit", "No GPU was available").

## Token handling

The token goes only to `huggingface.co` and `*.hf.space` over HTTPS
(`token_allowed`), as a Bearer header, never in a URL. Provider text is
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
