---
name: typesafe
description: TypeSafe Jev in Nebula — a decision model that answers typed questions (yes/no, pick one, score, where-is-it) with calibrated probabilities and never writes text. Use it to judge, classify, gate or rank generated media. Activate when the user wires `jev-decide` (or `jev-pick-best` / `jev-box` once they ship), asks to "judge", "check", "classify", "score", "pick the best" or "find the box" for an image or text, or mentions TypeSafe, Jev or System One. BYOK only (TYPESAFE_API_KEY). Written 2026-10-14 from docs.typesafe.ai and the Nebula guide docs/api-guides/typesafe.md.
---

# TypeSafe Jev Skill

Jev returns probabilities, not prose. Treat it as a cheap, fast judge between generators. Full contract and output formats: `docs/api-guides/typesafe.md`. Vendor docs: https://docs.typesafe.ai.

## Which node

| Need | Node | Notes |
|---|---|---|
| One yes/no check, a classification, or a 2-10 level rating of text and/or images | `jev-decide` | `answer_type`: `yes_no`, `choice`, `score` |
| Keep the best of N candidate images | `jev-pick-best` | Not shipped yet. Until then, run `jev-decide` per image (iterator) and compare `probability` |
| Where something is in an image (crop, mask for inpainting) | `jev-box` | Not shipped yet. Experimental; always paired with a presence check |

Use `claude-chat` or another LLM node when you need words back (captions, critiques, rewrites). Use Jev when you need a decision a graph or agent can act on.

## Writing questions

- **Keep each question atomic.** "Is the background plain white?" and "Is the logo fully visible?" as two Decide nodes beat one "Is it on brief?". Compound questions blur the probability.
- **Gate on the must-pass checks, not an average.** Several high scores can hide one failed requirement. Take the minimum across required checks, or require every `pass` to be `true`.
- **Neutral option keys.** Nebula sends Choice options as `a`, `b`, `c` with your wording as the description, because a loaded option name steers the answer. Write options as plain, parallel descriptions.
- **Jev reads literally.** It is weak at counting and numbers, and can lean toward the first option when options are close. If a Choice comes back `unsure`, reorder the options and ask again.
- **Use `yes_means` / `no_means`** to define borderline cases instead of stuffing them into the question.
- **Score levels describe situations**, low to high, one per line ("Off brief", "Right product, wrong setting", "On brief"), not degrees ("bad", "ok", "good").

## Reading results

- `pass` is `true`, `false` or `unsure`. `unsure` means confidence fell below `min_confidence` (default 0.5). Escalate or ask a person on `unsure`; don't treat it as a pass.
- `probability`: yes-probability, winner probability, or normalized score (0..1).
- `confidence`: for yes/no it is `|2p - 1|`; for choice and score it is Jev's own.
- `report` names the model that actually answered and the input tokens. Quote it when you explain a decision.
- To act on `pass` inside the graph, use the gate ports below. Outside the graph, read it from the run results.

## Branching a graph (gate)

`jev-decide` is also a gate. Wire the thing to pass along (usually the image being judged) into **`through`**, then wire **`on_pass`** to the next step and, if you want one, **`on_fail`** to a fallback.

- After deciding, `through`'s value comes out of exactly one of `on_pass` / `on_fail`, unchanged (or the `pass` text when `through` isn't wired). The other port is withheld.
- Every node wired to a withheld port is **skipped**, and so is everything below it. Skipped nodes never call their provider and cost nothing. Run results list them under `skipped` with the reason ("Jev Decide failed (answered no, 0.12)"); `nebula run` prints `<id>: skipped — <reason>`.
- `when_unsure` picks the branch for an `unsure` verdict: `fail` (default), `pass`, or `neither` (both withheld, so nothing below runs).
- A node wired to both `on_pass` and `on_fail` is always skipped. Don't join the branches into one node.
- The other outputs (`answer`, `pass`, `report`, ...) always flow, so a report or log node still runs on either branch.
- Inside an iterator each item is gated on its own: the next step runs only for the items that passed.
- A cached decision replays the same branch.
- The run's cost estimate still counts the nodes a gate may skip (it's an upper bound).

## Models

- Default and recommended: **`jev-1.14.0`** (pinned). `jev-1.13.0` is also pinned.
- `jev-latest` and `jev-preview` are aliases that move to new versions; thresholds tuned on one version can shift. Pin a version for anything repeatable.
- Box questions need Jev 1.14 (`jev-1.14.0` or `jev-preview`).

## Images are experimental

TypeSafe says image input and Box aren't production-ready: format, limits and accuracy can change. Say so when you rely on an image judgment, and prefer text checks where a text check is enough. Nebula prepares images itself (EXIF rotation, PNG/JPEG, 256-1568 px, padding, size caps), up to 16 images per Decide node.

## Box (when it ships)

A Box answer always contains a box, even when the target isn't there. Always read `found` first; `box` is `null` when it is `false`, and `crop` / `mask` only exist when it is `true`. One target per node. Small targets in big images can be missed: crop to the region first.

## Keys and cost

- BYOK only: `TYPESAFE_API_KEY` in Settings → TypeSafe. Never suggest a shared or hosted key.
- Priced per request at the context ceiling: up to $0.0027 (64k tokens) by default, $0.011 with `long_context`. Real runs usually cost far less. Agents under a USD limit can run it without asking.
- `long_context` raises the limit to 262k tokens but is slower and less accurate. Turn it on only after a `max_tokens_exceeded` error you can't fix by sending fewer or smaller images.

## Recipes

1. **Only upscale what's on brief.** Text Input (brief) → image generator → `jev-decide` (`state` = brief, `images` and `through` = the generated image, question "Does `image` show a red mug on a plain white background?") → `on_pass` → upscaler. Off-brief images stop at the gate and the upscaler is skipped.
2. **Classify inputs.** `jev-decide` with `answer_type: choice`, options one per line, `pass_when` listing the acceptable ones.
3. **Rate on a rubric.** `answer_type: score`, levels low to high, `threshold` 0.6 to pass the top part of the scale.

## Ground truth

- Node: `backend/data/node_definitions.json` (`jev-decide`, provider `typesafe`).
- Handler: `backend/handlers/jev_decide.py`; client: `backend/services/typesafe_client.py`; formats: `backend/services/jev_outputs.py`.
- Guide: `docs/api-guides/typesafe.md`.
