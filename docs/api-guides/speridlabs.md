# Speridlabs (Idol) in Nebula Nodes

> **Structural integration verified 2026-10-30**, with mocked tests and one
> live run without a token. No run with a token has been made yet.

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

Idol runs without a token on Hugging Face’s shared GPUs, which can be busy or out of free time. Add a fine-grained token with no repository access to use your own ZeroGPU allowance. With Hugging Face PRO, time past that allowance uses your prepaid credits.

Add the token in **Settings → Providers → Hugging Face**; create it at
[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
Nebula shows Idol at $0 a run, since
[Hugging Face offers ZeroGPU free](https://huggingface.co/docs/hub/spaces-zerogpu).
Any bill for time past your allowance is between you and Hugging Face;
Nebula can't see it.

With a token set, an agent can't run Idol on its own, or anything that
runs after it: it proposes the run, and you accept it on the canvas. The
proposal says "may use your Hugging Face credits", its card reads "may cost ·
Hugging Face", and the Run chip counts Idol as "may cost" ("~$0.13 + 1 may
cost" beside priced models), never as paid. Running an agent's unfinished
Idol node yourself asks first, as a paid one does. Without a token nothing
can bill: the card reads "free · Hugging Face", agents run it as they run
any free node, and it asks nothing. Adding or removing the token changes
all of this at once, open proposals included.

Whether a fine-grained token with no repository access applies your own
allowance isn't confirmed yet; Hugging Face's docs don't say.

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
it and waits up to 3 minutes), paused, or busy. If the free GPU time, or your
own allowance, is used up, try later. The card says which of these it is. If Speridlabs change the Space's API,
the node stops with a line saying so until Nebula is updated.

Details: [model-providers/speridlabs/idol.md](../model-providers/speridlabs/idol.md).
