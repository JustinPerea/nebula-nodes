# 2026-10-23 — Error copy round 3g: GM's answers to 3f

Branch `fix/error-copy-3g`, from main `54bf7cd6` (the merge of #173, round 3f). Backend and frontend. No package installed, no paid provider call (the live check ran with fake key strings behind a network guard).

## What changed and why

GM - Design answered 3f's five questions and made two fixes: "Answers to 3f's five questions, plus two fixes to calls it made. Everything else 3f decided is approved." "The fixes and 2-5 can go in a small 3g. a) is its own PR." This branch is that small 3g plus item 1's interim option c). Option a), undo that restores everything, is the parallel lane `fix/undo-restores-deletes`.

1. **The Delete key, for now (GM option c).** GM: "While a) builds, ship c) so the Delete key doesn't start asking on every delete. It asks only when a node has pins or open proposals; the toolbar, menu and Inspector paths keep the confirm until a) lands."
   - Delete and Backspace (`Canvas` `onBeforeDelete`) now ask "Delete this node?" / "Delete {n} nodes?" only when `lib/deleteConfirm.ts` `deleteLosesAttachments` says the delete would take something undo doesn't put back. Otherwise the key deletes with no confirm.
   - It reads the canvas's own stores: the pins store, the canvas proposals store, the asset proposals store, the open project (`currentProject()`) and the graph's nodes. It applies the backend's own rules for a delete:
     - a pin anchored to a doomed node, open or answered (`canvas_pins.detach_node` detaches both);
     - an open proposal whose `references` include a doomed node (`canvas_proposals.invalidate_referencing`: the nodes it wires from, changes or runs);
     - an open cover proposal for the open project whose image (`to`), or for "back to automatic" the pinned cover it is against (`from`), only the doomed nodes show. The sweep after a delete closes it (`main._cover_proposal_misfit`). The image rules mirror `project_cover.project_images`: a reference node's first picture, never a mask, and URLs compared as `portable_url` compares them.
   - The graph store's `allowCanvasDelete` already took `{ confirm }`, so it is unchanged. The toolbar, context menu and Inspector keep `confirmNodeDelete` as they were.
   - One fixture, `backend/tests/fixtures/delete_confirm_cases.json` (17 cases), pins the rule on both sides. Pytest runs each case through the real backend: it creates the nodes, the pins, the proposals and the cover proposals through the API, `DELETE`s the nodes, runs the sweep, and asserts "something was detached or closed" equals the case's `asks`. Vitest asserts `deleteLosesAttachments` gives the same answer for each case. If the backend's delete rules change, the backend test fails first.
2. **Ports in quotes.** GM: "the rule is now that anything a person reads as a label on the node goes in quotes, field or port. "The wire into “Prompt” brings something it can't take." "Connect an image to “Character Refs”.""
   - The wiring lines (`services/port_contracts.py`, every input of every node) quote the port's label exactly as the node shows it, parentheses and all ("Mask (white = edit)", "Images (1-4)"): "The wire into “{Label}” brings something it can't take. Remove that wire, then connect a matching output." and "“{Label}” takes {one wire}. Remove {the extra one}, then run the node again."
   - The Krea 2 moodboard hint now starts with "“Moodboard” takes a Nebula moodboard now."
   - Identity Edit's two lines name their ports in GM's second example's form: "Connect a base image to “Image”, then run the node again." The mask line says "Disconnect “Mask (unavailable)”", which is the label the node shows on that endpoint (3f's line said “Mask”).
   - Rule 6's "Connect {a/an X in words} to this node, then run it again." names no label, so it stays, as the spec says. The numbered-port form of `connect_line` now quotes the label exactly. No current label changes by this (no numbered label has parentheses); it keeps the rule exact for future ones.
   - The lines from earlier rounds that already quoted a port (Ideogram Character's “Character Refs”, Ideogram Edit's “Image”/“Images”, Runway's “Audio”, Veo's “Extend Video”, Meshy's “Rig Task ID”/“Task ID”, Hailuo's “End image”) are pinned against the node's real labels.
   - The guard: 3f's `rule_breaks` now fails a bare port label too ("a port label not in quotes"). It takes every input label in `node_definitions.json`, and looks for it after "Connect … to/into", after "Disconnect", or before "input"/"output"/"port", once quoted spans and URLs are removed. A `{}` before "input" fails too. On `54bf7cd6` it found the Identity Edit line, both wiring templates and the moodboard hint.
3. **World Labs:** GM: "keep the quotes. 3c's form doesn't come back. One rule for every round." 3f's `test_review_rule_5_the_lines_the_label_guard_found_quote_their_fields` already pins `PERSON_LINES["both_recovery_ids"]` in its quoted form, so no new test was added.
4. **The Cinema shot panel's own wording.** GM: ""Generate the shot again. If it keeps failing, Details shows what {Provider} said." With no provider: "Generate the shot again. If it keeps failing, open Details." With nothing behind Details: "Generate the shot again.""
   - `nodeErrorCopy` takes a `surface` (`'node' | 'shot'`). The shot surface gets GM's heading "Couldn't generate the shot." and "Generate the shot again." in `cardGeneralLine`.
   - The provider is 3f's `errorProvider` on the shot output. It is set only when that provider answered.
   - `CinemaShotPanel` passes `surface="shot"`, and the node card keeps "Run the node again…".
5. **The provider chip.** GM: ""Auto · Black Forest Labs". If the chip can't fit it at its narrowest, keep "BFL" in the chip only, with the full name in its title and aria-label. Send me a screenshot if you pick that fallback."
   - I measured it in headless Chrome with the app's JetBrains Mono woff2 at 10px (6px a character). The chip's text has 84px of room, which is 14 characters, and 75px beside the ⚠ glyph, which is 12. The chip's own max-width (96px) sets that room at every viewport and card width, so its narrowest is the same at both desktop sizes. "Auto · Black Forest Labs" needs 144px, so it doesn't fit.
   - So `providerSwitch` now carries `chipName`, the full name ("Auto · Black Forest Labs", "fal.ai", "Replicate", "OpenRouter"). `chip` is the full name when it fits the room of its state, else the short one. The title and aria-label always use `chipName`.
   - In practice: "Auto · BFL" falls back, and so does a chosen Black Forest Labs (17 characters), to "BFL". "Auto · fal.ai" shows in full unless blocked, where it reads "Auto · fal". "fal.ai", "Replicate", "OpenRouter" and "Krea" show in full, blocked or not.
   - Create Studio's pill wraps, so it always shows the full name.
   - Rule 9 is applied to every name the chip and switcher show: the chip used "fal", "Rep" and "OR" where the full name fits, and now shows it. The switcher's rows already used full names.
6. **Readiness, an answered failure.** GM: ""Nebula didn't respond" is wrong when something did answer. → "Couldn't check the connections. Try again, or reload if it keeps happening.""
   - `providerReadinessStore` now uses that line for any answer: a 5xx, a 429, a 404, a malformed body.
   - Only no answer at all (`isConnectionFailure`) keeps "Couldn't check the connections. Nebula's server isn't answering. Make sure it's running, then try again."
7. **Gemini Omni.** GM: "the period inside the quote followed by a comma reads badly." The card line is now GM's: "Gemini Omni can edit a video but can't make it longer. Describe the change as an edit, like “Change the lighting and keep everything else the same”, or use Veo 3.1 to extend the video." `GEMINI_OMNI_EXTENSION_ERROR`, the agents' text, is unchanged.

8. **Coordinator, after the review: Cinema Color's palette line** (a reviewer's note, outside the port scope). The line said "Add hex swatches in the Palette field … or set a Source Image", a field named bare and by the wrong name: the node shows "Palette Source". 3f's guard let "the {Label} field" through. It now flags it ("in the Palette field" added to its self-test, red first), and across every card line it found only this one. The card line is now "Cinema Color needs a target palette. Add hex swatches to “Palette”, click “Extract from reference”, or set “Palette Source” to pull a palette from an image. With no palette the image passes through unchanged.", with both labels read from node_definitions.json; agents' text is unchanged. Pinned in `backend/tests/test_cinema_color.py` (red on the base handler, green after). check2: 5 files, 0 differences.

## Decisions

- **The Delete key's rule is read from the stores, not asked of the backend.** The key's confirm has to answer synchronously from what the canvas already holds; a round trip on every key press would add latency and a failure mode. The shared fixture keeps the two from drifting.
- **Asset (cover) proposals count.** The spec names three backend effects (pins, canvas proposals, asset proposals that need the node). The backend closes a cover proposal on the sweep after the delete, not in `delete_graph_node` itself, so the pytest cases run the sweep explicitly.
- **The port guard lives in 3f's `rule_breaks`**, so every card line in every round goes through it, not just 3g's.
- **An unlabeled port reads “Input”** in the wiring lines (3f said "this"; a quoted “this” would be wrong).
- **Labels are quoted whole, parentheses and all**, since GM's rule is the label "a person reads" on the node. 3f's rule 3 (no parentheses) already exempted a quoted label.
- **The chip rule is "the full name when it fits this chip's room"**, not "BFL always": GM asked for the full name, and "fal.ai" / "Replicate" / "OpenRouter" fit.

## Tradeoffs

- The Delete key mirrors three backend rules in the frontend (about 60 lines). The fixture test makes drift fail loudly, but a new kind of attachment (a future backend effect of delete) needs adding to both sides. The undo lane (a)) will remove this file's rule entirely.
- The chip's room is a constant (14 / 12 characters) from a measurement, not a live measurement per render. It's exact for the monospace font at 10px; a font or size change in `provider-switcher.css` needs the constants updated (the comment says so).

## Surprises

- 3f's Identity Edit mask line quoted “Mask”, but on that endpoint the node shows the port as "Mask (unavailable)". The new guard's label list caught it.
- The canvas proposals and pins stores were already in the first load (through `useFitCanvasView` and the selection toolbar), and so was the asset proposals store, so reading them in `Canvas` costs 223 bytes, not a deferred chunk.
- The Delete key and the toolbar both ran through `allowCanvasDelete`, which already took `{ confirm }`, so the change in `Canvas.tsx` is only what it passes.
- In the live check, a FLUX node that can't run (no prompt, or a blocked provider) holds the whole graph's Run. The chip nodes were added after the run.
- A provider 500 never reaches the shot panel's general line: the backend gives it GM's status line ("fal.ai is having trouble right now…"). The live check's "Details shows what fal.ai said" case uses a job failure (fal.ai answered, no table line).

## Tests (red first on 54bf7cd6)

- **Backend** (`tests/test_error_copy_round3g.py` new, `tests/test_error_copy_round3f.py` guard extended): on `54bf7cd6`, 9 failed and 72 passed.
  - 6 failures in 3g: the card-line port guard (the Identity Edit line at `maker_routes_google.py:115`), every wiring line for every port, the wiring lines in GM's form, the AST check that `_input_name` sits in quotes (`port_contracts.py:100` and `:107`), Identity Edit's lines, and Gemini Omni.
  - 3 failures in 3f: the guard's self-test, every card line, and every wiring line.
  - The 17 delete-fixture cases pass on base by design: they pin the backend's behaviour.
  - After the build: 81 passed. 3e's two wiring pins moved to the quoted form.
- **Frontend** (`tests/errorCopy.round3g.test.tsx`, `tests/errorCopy.round3g.deleteKey.test.tsx` new): on `54bf7cd6`, 30 failed and 8 passed (38).
  - The failures covered the fixture agreement, the Delete key's plain and attached cases, the shot panel's lines (unit and rendered), the chip and `chipName`, the chip button's title and aria-label, and readiness.
  - The Create Studio pill test, added later, failed 1 of 1 on base before its fix.
  - After the build: 39 passed.
  - Pins moved to GM's new words: `providerSwitch.test.ts` ('Rep' → 'Replicate'), `ProviderSwitcher.test.tsx` (full names in aria and the pill), `errorCopy.round3f.test.tsx` and `errorCopy.round3c2.test.tsx` (the shot panel's line), `errorCopy.round3f.projects.test.ts` (readiness), and the shared `backend/tests/fixtures/switch_cases.json` chips ("fal" → "fal.ai", "OR" → "OpenRouter", "Rep" → "Replicate", an unblocked "Auto · fal" → "Auto · fal.ai"; "BFL", "Auto · BFL" and a blocked "Auto · fal" stay). The whole-suite run found the last two; `test_route_clients.py`, the fixture's backend reader, passes after the move (134).
  - `tests/Canvas.continuity.test.tsx` now mocks the pins store the way it already mocks the selection toolbar. `Canvas` imports the pins store for the Delete key, and the test's graph replacements made its socket handler fetch pins. In the app the toolbar already loads that store with the canvas, so the entry grows by 223 bytes (363,692 against 363,469 with base's `Canvas.tsx`).
- **Agents' texts:** `scratchpad/textcheck/check2.py <worktree> 54bf7cd6` reported 4 files and 0 differences.

## Live check

The isolated stack: backend 8791 (`iso.sh`, temp HOME, every NEBULA_* root in the scratch dir, every key/token var dropped) and Vite 5791 with `VITE_NEBULA_BACKEND_PORT=8791`.
- The backend ran with a network guard: every non-loopback httpx request is refused, and it refused 0.
- It used fake key strings, so nothing paid could run.
- Two handlers were stubbed: flux-kontext as a fal.ai job failure, and nano-banana as a plain failure before any provider.
- A flag file made the connection check answer 503.
- Puppeteer blocked 8000-8010 and 5173 (CDP `Network.setBlockedURLs` plus a dead proxy). Blocked attempts: 0. A canary request to 8799 was unreachable.
- Checked at 1440x900 and 1280x800, then after a reload: **61 passed, 0 failed.**

What it checked:
- **Cards naming a port, in quotes** (both sizes, and after the reload):
  - "Ideogram Character needs reference images. Connect “Character Refs” or a Character node, then run the node again."
  - "Ideogram needs an image to edit. Connect one to “Image” or “Images”, then run the node again."
  - "Identity Edit can't take a mask on the Nano Banana 2 endpoint. Disconnect “Mask (unavailable)”, then run the node again."
- **The provider chip at its narrowest:**
  - Auto on Black Forest Labs shows "Auto · BFL". With the full name put in, the text needs 144px against 84px of room. The title is "Runs on Auto · Black Forest Labs. Change provider" and the aria-label is "Provider for FLUX 3 Image: Auto · Black Forest Labs".
  - "fal.ai" shows in full. "Replicate" and "OpenRouter" show in full even when blocked, beside the ⚠.
  - The switcher's rows name every provider in full, none cut off.
- **The Cinema shot panel**, with GM's heading "Couldn't generate the shot." and the raw text behind a closed Details:
  - When fal.ai answered: "Generate the shot again. If it keeps failing, Details shows what fal.ai said."
  - With no provider: "Generate the shot again. If it keeps failing, open Details."
  - "Generate the shot again." alone can't happen live, because a shot's failure always stores its raw text. Unit tests cover it.
- **Delete:**
  - The Delete key on a node with a pin, and on a node an open agent proposal reads, asks "Delete this node?". When dismissed, the node stays.
  - The toolbar's delete on a plain node asks.
  - The Delete key on a plain node deletes it with no confirm, and the backend deletes it too. The pin stays attached.
- **Readiness**, an answered 503: "Couldn't check the connections. Try again, or reload if it keeps happening.", before and after the reload.
- **MCP stdio `look_at_canvas`** reads the exception texts word for word: "Ideogram Character needs reference images — connect Character Refs or attach a Character node", "Image input is required (connect Image or Images)", and "Identity Edit does not support masks on the Nano Banana 2 endpoint; disconnect Mask before running this node". It carries none of the card lines.
- **The shots' stored `error`** (what agents read) is the raw text, with `errorProvider` "fal.ai" only on the one fal.ai answered.

Screenshots are in `scratchpad/error-copy-3g/live/shots/`. The servers were stopped by port and the state dir was deleted.

## Gates

- **Backend** whole suite (`iso.sh .venv/bin/python -m pytest -q -p no:cacheprovider`): 10212 passed, 71 skipped (16 min). It ran before the `switch_cases.json` chip move; that fixture's backend reader, `test_route_clients.py`, passes after it (134).
- **Frontend** `npx vitest run` whole suite, after every fix: 371 files and 4929 tests passed, 11 files and 29 tests failed. Of those, 18 were timeouts on the loaded machine. Rerun alone, the 11 files pass: 194 tests. (The first whole run found the real failures: `switchToClient` against the old chip pins, 3c-2's shot pin, and `Canvas.continuity`'s unmocked pins fetch. They are fixed above.)
- `npx tsc -b`: clean. `npm run -s lint`: clean.
- `npx vite build && node scripts/check-build-budget.mjs`: passed, 363,692 bytes raw (budget 512,000) and 108,925 gzip.
- check2 against `54bf7cd6`: 4 files, 0 differences.

## Agent support

Agents' texts don't change. The exception texts, validation `message`s, `PORT_TYPE_HINTS` and `GEMINI_OMNI_EXTENSION_ERROR` are word for word as before (check2: 0 differences), and MCP `look_at_canvas` reads them unchanged live. The Delete key's confirm is a person-only interaction in the canvas. Agents delete through `remove_from_canvas` / `nebula` as before, so no MCP tool, CLI command or doc changes.

## Open items

- **Undo that restores everything (GM option a))** is `fix/undo-restores-deletes`. When it lands it removes every confirm, `deleteLosesAttachments` included, and the fixture can move to its restore tests.
- Two labels that aren't error card lines name a port bare, and GM may want them quoted:
  - the moodboard adapter's card line "Board images: on · up to N to {label}" (agents also read it through `describe_node`);
  - JevCardField's "Used when the {label} input is empty".
- The node library's "BFL · fal" provider summary isn't the chip or the switcher. It still uses the short names.

## Round 3g lines for GM

### Judgment calls for GM

1. **The chip keeps "Auto · BFL".** "Auto · Black Forest Labs" needs 144px and the chip has 84px at both desktop sizes (its max-width caps it, whatever the card's width). The full name is in the chip's title and aria-label. Screenshots:
   - `scratchpad/error-copy-3g/live/shots/chip-bfl-1440.png` and `chip-bfl-1280.png` show the chip as shipped;
   - `chip-bfl-full-name-1440.png` and `chip-bfl-full-name-1280.png` show the full name forced in, cut to "Auto · Black …";
   - `switcher-rows-1280.png` shows the switcher's rows in full.
2. **Other names show in full where they fit.** "fal.ai", "Replicate" and "OpenRouter" now show in full (they read "fal", "Rep" and "OR" before). A chosen Black Forest Labs also falls back to "BFL". Auto on fal.ai reads "Auto · fal.ai", or "Auto · fal" when blocked, beside the ⚠.
3. **Labels with a note are quoted whole:** “Mask (white = edit)”, “Images (1-4)”, “Mask (unavailable)”, because that is what the node shows.
4. **An unlabeled port reads “Input”.**

### Old -> new

Cinema Color (coordinator, after the review):
- "Cinema Color needs a target palette. Add hex swatches in the Palette field, or click “Extract from reference”, or set a Source Image to pull a palette from. With no palette the image passes through unchanged." -> "Cinema Color needs a target palette. Add hex swatches to “Palette”, click “Extract from reference”, or set “Palette Source” to pull a palette from an image. With no palette the image passes through unchanged."

Wiring lines, for every input (shown with Prompt):
- "The wire into the node's Prompt input brings something it can't take. Remove that wire, then connect a matching output." -> "The wire into “Prompt” brings something it can't take. Remove that wire, then connect a matching output."
- "The node's Prompt input takes one wire. Remove the extra one, then run the node again." -> "“Prompt” takes one wire. Remove the extra one, then run the node again."
- (a port whose label has a note) "The wire into the node's Mask input brings…" -> "The wire into “Mask (white = edit)” brings…"

Krea 2:
- "Krea 2's Moodboard input takes a Nebula moodboard now. To use a Krea moodboard, put its ID in “Moodboard ID” and remove the wire." -> "“Moodboard” takes a Nebula moodboard now. To use a Krea moodboard, put its ID in “Moodboard ID” and remove the wire."

Identity Edit:
- "Connect a base image to this node's Image input, then run it again." -> "Connect a base image to “Image”, then run the node again."
- "Identity Edit can't take a mask on the Nano Banana 2 endpoint. Disconnect “Mask”, then run the node again." -> "Identity Edit can't take a mask on the Nano Banana 2 endpoint. Disconnect “Mask (unavailable)”, then run the node again."

Cinema shot panel (the node card keeps "Run the node again…"):
- "Run the node again. If it keeps failing, Details shows what {Provider} said." -> "Generate the shot again. If it keeps failing, Details shows what {Provider} said."
- "Run the node again. If it keeps failing, open Details." -> "Generate the shot again. If it keeps failing, open Details."
- "Run the node again." -> "Generate the shot again."

Provider chip:
- "Auto · BFL" -> "Auto · BFL" (title and aria-label: "Auto · Black Forest Labs")
- "fal" -> "fal.ai"; "Rep" -> "Replicate"; "OR" -> "OpenRouter"; "Auto · fal" -> "Auto · fal.ai" (unblocked)
- The Create Studio pill: "BFL" -> "Black Forest Labs" (it wraps)

Readiness, an answered failure:
- "Couldn't check the connections. Nebula didn't respond. Try again." (and the other status lines under that heading) -> "Couldn't check the connections. Try again, or reload if it keeps happening."

Gemini Omni:
- "…like “Change the lighting and keep everything else the same.”, or use Veo 3.1 to extend the video." -> "…like “Change the lighting and keep everything else the same”, or use Veo 3.1 to extend the video."
