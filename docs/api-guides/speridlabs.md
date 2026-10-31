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

Add the token in **Settings > Providers > Hugging Face**; create it at
[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
Settings says "Hugging Face token saved. Checking it now." Once it's
saved, the row's **…** menu has **Replace token** and **Remove**, with
**Open Hugging Face tokens ↗** on the line under "Saved token ending in
…". A token of only spaces or invisible characters isn't saved, and Nebula
treats one saved that way as no token. A token added or removed in
another window, by a script or by the desktop app is said once in an open
Settings panel ("Hugging Face token saved."); your own save isn't said
twice.

In the browser, if Nebula can't read the keys in its settings file, it
reads them as no keys, so Idol runs without a token, and Settings refuses
to save a key over them: "Nothing was saved because Nebula can’t read the
keys saved in <the file's path, with your home folder as "~">. Fix
“apiKeys” in that file, then try again." In the desktop app, keys live in
the macOS Keychain, not in that file, so this doesn't apply there; saving
any setting clears keys found in the file.

If Nebula can't read the settings file at all (cut short, not JSON, not
an object, or a file Nebula isn't allowed to read), nothing runs until
it's fixed. Settings says "Nebula can’t read <the
path>. Fix the file, then try again.", and any save, in the browser or
the desktop app, is refused with "Nothing was saved because Nebula can’t
read <the path>. Fix the file, then try again." On the desktop app the
key isn't written to the Keychain either. An agent that reads your
settings is told "Nebula can’t read <the path>. Ask the person to fix the
file."
Nebula shows Idol at $0 a run, since
[Hugging Face offers ZeroGPU free](https://huggingface.co/docs/hub/spaces-zerogpu).
Any bill for time past your allowance is between you and Hugging Face;
Nebula can't see it.

With a token set, an agent can't run Idol on its own, or anything that
runs after it: it proposes the run, and you accept it on the canvas. The
proposal says "may use your Hugging Face credits", its card reads "may cost ·
Hugging Face", and the Run chip counts Idol as "may cost" ("~$0.13 · 1 may
cost" beside priced models), never as paid. Hover the Run chip or the Accept chip for the
whole picture: the paid nodes first, then the estimate, a line for each node
with no listed price or on your Krea plan, and Idol's sentence last. When
the paid nodes all share one reason, it's one sentence: "“Writer” and
“Editor” call paid providers that have no listed price." The Run
button's own tooltip, and what a screen reader hears for Run and Accept, is
the same text. Neither adds anything for
Idol to the estimate. Running an agent's unfinished
Idol node yourself asks first, as a paid one does. Without a token nothing
can bill: the card reads "free · Hugging Face", agents run it as they run
any free node, and it asks nothing. Adding or removing the token changes
all of this at once, open proposals included, and in every open window,
whichever window, script or app changed it.

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
