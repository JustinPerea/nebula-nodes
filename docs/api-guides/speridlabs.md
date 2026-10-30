# Speridlabs (Idol) in Nebula Nodes

> **Structural integration verified 2026-10-29.** Nebula implements the Idol
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
| Seed | any whole number | 42 |

Nebula reuses a result for the same image, settings and seed, so change the
seed for a different object.

## Keys and cost

Idol needs no key. It runs on Hugging Face ZeroGPU, which
[Hugging Face offers free](https://huggingface.co/docs/hub/spaces-zerogpu),
so Nebula shows $0 a run.

Without a key, runs share Hugging Face's small allowance for people without an
account (2 GPU-minutes a day). Add a Hugging Face **read** token in
**Settings → Providers → Hugging Face** to use your own daily time instead: 5
minutes on a free account, 40 on PRO or Team, 60 on Enterprise. Create one at
[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).

**On a PRO, Team or Enterprise account, Hugging Face can bill you** for GPU
time past your daily quota, from your prepaid credits at $1 per 10 minutes.
That bill is between you and Hugging Face; Nebula can't see it.

## The result

The `world` output is a World v2 value with one PLY splat. On the card,
**Explore in 3D** opens it in the World viewer (Orbit or Fly), turned upright
and framed as an object, with a download of the `.ply`. The file opens in any
3DGS viewer (SuperSplat, Spark, Blender add-ons). 262,144 Gaussians is about
18 MB; 1,048,576 is about 71 MB.

Agents can't look at 3D, so `view_output` gives them the splat as numbers:
Gaussian count, bounding box, file size, seed and axes.

World Labs Export only exports worlds made by World Labs Environment, so it
doesn't take an Idol splat.

## When it doesn't run

The Space is Speridlabs' demo on Hugging Face. It may be asleep (Nebula wakes
it and waits up to 3 minutes), paused, or busy. If the shared allowance is
used up, add your token or try later. If Speridlabs change the Space's API,
the node stops with a line saying so until Nebula is updated.

Details: [model-providers/speridlabs/idol.md](../model-providers/speridlabs/idol.md).
