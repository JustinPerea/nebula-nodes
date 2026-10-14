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
| Typed QC of a video (loop seam, identity drift, compositing, camera angle) | `qc-*` nodes with `mode: jev` | One question per check over the sampled frames; read `jev.verdict` and `jev.checks` in the `text` report |

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
- Graphs can't branch on `pass` yet. Read it via the run results and decide the next step yourself, or propose the change.

## QC nodes in Jev mode

- Set `mode` to `jev` on `qc-loop-safety`, `qc-frame-review`, `qc-composited-look` or `qc-camera-geometry`. It needs `TYPESAFE_API_KEY`; the default `heuristic` mode stays free.
- The `text` report keeps its usual keys and adds `jev`: `verdict` (`true` / `false` / `unsure`, or `null` when no must-pass check applied), `min_pass_probability`, and `checks.<id>` with the question, answer, probabilities, confidence and verdict.
- Act on `jev.verdict`, not on one score. `unsure` means a check fell below `min_confidence`; look at `jev.unsure` and check by eye or rerun with another sample density.
- Camera geometry only gates when you set `expected_angle` or wire a `reference` frame.
- At most 8 frames go to Jev; `jev.frames.sent` lists which samples.

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

1. **Gate a generation on the brief.** Text Input (brief) → image generator → `jev-decide` (`state` = brief, `images` = generated image, question "Does `image` show a red mug on a plain white background?"). Act on `pass`.
2. **Classify inputs.** `jev-decide` with `answer_type: choice`, options one per line, `pass_when` listing the acceptable ones.
3. **Rate on a rubric.** `answer_type: score`, levels low to high, `threshold` 0.6 to pass the top part of the scale.

## Ground truth

- Node: `backend/data/node_definitions.json` (`jev-decide`, provider `typesafe`).
- Handler: `backend/handlers/jev_decide.py`; client: `backend/services/typesafe_client.py`; formats: `backend/services/jev_outputs.py`.
- Guide: `docs/api-guides/typesafe.md`.
