# Speridlabs (Idol) in Nebula Nodes

> **Structural integration verified 2026-10-30.** Nebula implements the Idol
> Space's Gradio API with mocked tests. No Idol run was started for this
> pass, so this isn't a live result.

[Idol](https://huggingface.co/spaces/speridlabs/idol) by Speridlabs turns one
image of an object into a 3D Gaussian splat. Nebula runs it on Speridlabs' own
Hugging Face Space and gives back a `World` value you can explore on the card
and download as a `.ply`.

## The node

| Node | ID | Inputs | Outputs |
|---|---|---|---|
| Idol | `speridlabs-idol` | `image` (Image, required) | `world` (World) |

Settings, as the Space names them:

| Setting | Values | Default |
|---|---|---|
| Input type | Synthetic or Real photo (the Space doesn't describe them further) | Synthetic |
| Gaussians | 65,536, 131,072, 262,144, 524,288 or 1,048,576 | 262,144 |
| Steps | 10-100 | 50 |
| Guidance scale | 0-10 | 3 |
| Time shift | 1-6 | 3 |
| Seed | 0 to 2,147,483,647 | 42 |

Nebula reuses a result for the same image, settings and seed, so change the
seed for a different object.

## Keys and cost

Idol needs your Hugging Face token. Add it in **Settings → Providers →
Hugging Face**; create one at
[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
Until it's set, nothing on the canvas runs Idol: Run on the node says "You
can run Idol after you add your Hugging Face token in Settings.", the
toolbar's Run says "You can run this canvas after you add your Hugging Face
token in Settings.", and an agent's proposal that would run it can't be
accepted yet.

It runs on Hugging Face ZeroGPU, which
[Hugging Face offers free](https://huggingface.co/docs/hub/spaces-zerogpu),
so Nebula shows $0 a run. Each run uses your own daily GPU time: 5 minutes on
a free account, 40 on PRO or Team, 60 on Enterprise. Visitors without an
account get a small free daily allowance (2 minutes, by Hugging Face's
table, which may not apply to calls from a server like Nebula's).

Why the token: the Space asks for 120 seconds of GPU a run, and on
ZeroGPU's Blackwell cards Hugging Face's `spaces` package counts that as
180 seconds (`duration_factor` 1.5), more than the 2 minutes without an
account. A run needs that much left in your day to start, but is charged the
time it uses, so a free account gets a few runs a day: at least 1, and more
when runs are short (PRO at least 13). The first live run will confirm the
numbers: the quota error names the seconds asked for and left.

**On a PRO, Team or Enterprise account, Hugging Face can bill you** for GPU
time past your daily quota, from your prepaid credits at $1 per 10 minutes.
That bill is between you and Hugging Face; Nebula can't see it.

## The result

The `world` output is a World v2 value with one PLY splat. On the card,
**Explore in 3D** opens it in the World viewer, turned upright and seen from a
three-quarter view in front of the object, to orbit, pan and zoom, with a
download of the `.ply`. The file opens in any
3DGS viewer (SuperSplat, Spark, Blender add-ons). 262,144 Gaussians is about
18 MB; 1,048,576 is about 71 MB.

Agents can't look at 3D, so `view_output` (or `nebula splat <node>` from the
CLI) gives them the splat as numbers: Gaussian count, bounding box, file size,
seed and axes.

World Labs Export only exports worlds made by World Labs Environment, so it
doesn't take an Idol splat.

## When it doesn't run

The Space is Speridlabs' demo on Hugging Face. It may be asleep (Nebula wakes
it and waits up to 3 minutes), paused, or busy. If your daily allowance is
used up, try later. The card says which of these it is. If Speridlabs change the Space's API,
the node stops with a line saying so until Nebula is updated.

Details: [model-providers/speridlabs/idol.md](../model-providers/speridlabs/idol.md).
