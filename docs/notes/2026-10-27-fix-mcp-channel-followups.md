# 2026-10-27 — #114 follow-ups: GM's r18 rulings and review 17's lows

Branch `fix/mcp-channel-followups`, from `origin/main` at c1e7338c (#114 merged).

- **What changed and why.** GM's rulings after the #114 r17 visual check (gm-channel-r18.md, built verbatim) and review 17's L1-L4. The corrupt-catalog repair (keep a last good copy, restore it) is with Justin and not in this PR.
  - *Cursor bubble.* Codex's bubble read "Set value", the raw param key. The key came from the backend's `PUT /api/graph/node/{id}` (main.py `update_graph_node`), not from #195's presence code: it joined the changed keys. Now `_set_params_bubble` names each field by its card label in quotes ("Set “Text”"), in the agent's order, and says nothing when no changed field has a label (a universal node's provider params). The other bubble paths (`edit_canvas`'s summary, proposals, connect, rename, move, remove, run) never used keys.
  - *Video editor offline.* The banner has a third place, `editor`, right under the editor's header: 69px (the header ends at 61px at 1280 and 1440, plus the usual 8px). It clears the preview's timecode at 110px. Trim, Speed, Cut and Vol, a selected clip's speed and volume sliders, presets and mute, Render Preview, Export… and the export popover's Export are disabled offline with the offline mark. Play, the edit points, zoom, scrubbing and the timecode stay usable. A disabled tool or preset is at the disabled opacity with no hover. A disabled Render Preview or Export is neutral (`--sr-edge` border, `--sr-surface-control` fill), with no accent outline.
  - *Home.* A card's cover, rename and delete icons were already disabled offline (busy covers offline) but drew as enabled. They now carry the offline mark and `.project-home__rename:disabled` is at the disabled opacity.
  - *Price chip.* `runChipTitle`: "~$X" has the title "Estimated cost"; "$X+" has "At least $X. Some costs aren't known yet.", with X the estimate's low end (so "$0.0047–0.43+" says "At least $0.0047."). A plain range and "N paid" have none. Both Run chips (bottom bar, selection toolbar) carry it.
  - *Project-store 507.* A run start refused with `code: "project_store"` now reads "Couldn't run “<node>”. Nebula can't read its project list, so nothing was started. Check that the drive Nebula saves to is connected and has space, then try again." or "Couldn't start the run. …" (`PROJECT_LIST_REASON`), on the card and as a notice, like the run-safeguards line. A 507 naming no store keeps the general line.
  - *Never count 1.* `acceptUndoLine` names a single item ("Undid the proposal except “Text” for “Brief”. It was changed after you accepted."). Items are the settings (a rename is "Name") and the kept nodes. They're counted from 2 when kept nodes and settings are mixed ("<N> changes <who> made") and from 4 otherwise ("<N> settings <who> changed"), following G2. Fewer are named, each node's settings "for" it. Nothing-undone forms are unchanged.
  - *Commons.* The accents line is "You changed this reference's accents in another window while Nebula was offline, so your changes here weren't saved."
  - *G4.* Stop's icon slot is 16px like Run's. The 14px dots sit centred in it (left and top 1px). Live, the label is 36px into the button for both Run and Stop at 1280 and 1440 (it was 34px for Stop).
  - *L1.* When the held save into the project the tab left is refused and that project can't be read (an agent deleted it while Nebula was offline), the tab judges loss against what it last saved or loaded for that project (`lastSaved`, captured as the follow starts). A pan alone makes no recovered copy, while a moved node still does. The switch toast's way back goes through `wayBackIn` with the listing `loadWorkspace` just read, so it never names a deleted project. "Back to" a project that disappeared after the toast came up closes the toast instead of sending an open that can't work.
  - *L2.* The Cinema shot task's merge sync, and the World Labs recovery-checkpoint and start-ambiguity syncs, pass `run_params=<run id>`, as `_sync_params_to_cli_graph`'s sync already did. Undo of an Accept rebases over them instead of noting unknown touches.
  - *L3.* A Commons label draft is carried over a reconnect only if the batch's `manifest_hash` and the reference's `image_sha256` are unchanged too, not just its saved labels and accents.
  - *L4.* A start refused because a Stop was recorded for its run id says what this process knows (`_stopped_id_refusal`): "run '<id>' was already stopped, so this id can't start again. Start a new run with a new id." for a run that registered here and was stopped; "run '<id>' already ran, …" for one that ended before its Stop; "run '<id>' was cancelled before it started" only when the Stop reached the id while this process was admitting its start (`ExecutionRunRegistry.stopped_before_start`, noted at the Stop); otherwise "run '<id>' was stopped, so this id can't start again. Start a new run with a new id." The 409 is unchanged. MCP and the CLI never pick a run id, so they only pass a re-sent request's `detail` through. MCP-SETUP.md and SKILL.md say so.
- **Decisions not in the spec.**
  - Bubble: several labeled fields are all named ("Set “Prompt” and “Seed”"). The old code silently cut at 4 keys.
  - Never count 1: across nodes, named items are grouped per node, and a group holding its own "and" is set apart with ", and" ("“A” and “B” for “Hero”, and “C” for “Logo”"). For unknown sources the count drops the actor and follows G2 too: "<N> settings changed after you accepted." Four or more kept nodes with no settings say "<N> nodes <who> changed after you accepted." None of these has GM's wording yet.
  - L3 reuses the labels/accents line when the image or batch changed. It says "You changed this reference's …", which is close but not exact for a batch replaced in another window.
  - The editor banner's 69px is measured, not derived. If the editor header changes height, so must this.
  - Promote-variation (`/api/cinema/promote-shot-variation`) and Forget ID syncs stay unmarked: they are the person's own choices, not a run's write-back, and attribute as unknown.
- **Tradeoffs.** `_stopped_id_refusal` reads the in-memory registry, so after a restart every reused stopped id gets the neutral line. That is true but less specific than before the restart.
- **Surprises.** The shared scratchpad `iso.sh` was rewritten mid-session by another lane (it now `cd`s into nebula_nodes-catalog-backup). This lane used its own copy (scratchpad mcp-channel/fu/iso_fu.sh) and left the shared file alone. `test_agent_presence.py` also pinned "Set quality". The headless browser paints no native tooltips, so the price screenshots carry a dashed caption the script drew from each chip's `title`.
- **Tests (failed first on c1e7338c).**
  - Backend `tests/test_mcp_channel_followups.py`: 9 of 10 failed first. The bubble tests got "Set value", "Set guidance_scale" and "Set endpoint_id, guidance_scale". The three L2 syncs had no `runParams`. The three L4 reuses read "… was cancelled before it started". The pre-start control passed.
  - Updated backend tests: test_connected_copy ("Set “Text”"), test_agent_presence ("Set “Quality”"), test_provider_start_admission (the neutral L4 line for a never-seen id), and test_cinema_generate_shot (its fake broadcast takes kwargs).
  - Frontend: 25 failed first. `tests/channelFollowupsUi.test.tsx` (G4, editor placement, transport offline, disabled CSS, home icons, tooltips, the Commons line, L3) and `tests/store/graphStore.followups.test.ts` (507 lines, never count 1). `tests/projectSwitch.followups.store.test.ts` (H1, H2, the dead "Back to") had 3 fail; its control, a live way back, passed. The Z2 store test passed from the start, because the frontend already rebased marked syncs; its backend half failed.
  - Updated frontend tests: round16/round17 undo-line expectations (2 settings across nodes are now named), round17Ui (16px slot, the editor placement in App, the accents line), and the readOnlyCues banner ratchet (allows the editor placement).
- **Live check.** Isolated backend on 8797, Vite on 5797 (`VITE_NEBULA_BACKEND_PORT=8797`), 8000-8010 and 5173 blocked by CDP and a dead proxy (a canary to 8001 refused), 1440x900 and 1280x800, 25/25 checks:
  - the bubble read "Set “Text”" after an agent PUT;
  - chips "~$0.0059" (title "Estimated cost") and "$0.0059+" (title "At least $0.0059. Some costs aren't known yet.");
  - Stop's slot was 16px, with the label 36px in for both Run and Stop;
  - offline in the editor (a clip in the tab), the four tools, Render Preview and Export were disabled, marked and at opacity 0.48, the last two with identical neutral borders; Play was enabled; the banner sat at 69-102px, 8px under the header and clear of the timecode at 110px;
  - home card icons were disabled, marked and at 0.48.
  - 0 requests to 8000-8010/5173. Screenshots: scratchpad mcp-channel/fu/fu-*.png.
- **Open items.**
  - The corrupt-catalog repair (with Justin).
  - GM wording for the decisions above: named items across nodes, "<N> nodes", the unknown-source count, and the L3 line for a replaced batch.
  - Other studios (Cinema, Character, Moodboard, Create, Remotion) still put the banner at the canvas's 150px. GM to say if they get the editor's place.
  - Review 17's nits N1-N3 are unchanged.
  - The r15 X1 probe still fails as written (it counts the Stop only after reconnect).

## Fix round 1 (PR #198 review 1, GM's pr198 r1 rulings)

Justin: "I want to do complete fixes as soon as we run into them"; "implement the correct and better choice - not the easy now choice".

- **M1, Undo of an Accept dropped a paid shot.** The cause was whole-key thinking: an accepted step remembered `scene` as one value, a run's merge into one shot rewrote the step's `set.scene` to the merged scene, and Undo then put back `before.scene` whole, s2's image included.
  - *The choice.* Both of the review's options, together, because each covers a case the other can't. (a) Undo puts a compound param back path by path, `before ⊕ (now − set)` (lib/canvasUndo.ts `merge3`): records by key, lists of records with their own string `id` (a scene's shots, an editor's clips) by id, anything else as one value. A part the Accept didn't touch keeps what it is now, whoever changed it (a run, an agent, another window). A part both the Accept and someone else changed stays as it is now and its key is named in the line, as before. (b) A Cinema shot's media (`output`, `variations`, `selectedVariation`) is the run's: the same split `authoredParams` and the backend's `_author_cinema_scene` already make. A run's write-back is taken path by path too (`rebasePart`): media the Accept changed and a run wrote since is never put back; a value derived from what the Accept set (a color the run parsed, clips snapped to frames) still goes back with it, as round 17 intended for flat keys; a part that can't be split (a shot the Accept added and a run rendered since) is kept as the run left it and named in the line ("Undid the proposal except “Scene” for “Scene”. It was changed after you accepted."). (b) alone would leave an agent's edit to another shot reverted; (a) alone would put back a shot image the Accept had cleared and a run made since.
  - *Every compound param written by both proposals and runs* (handlers and `_sync_params_to_cli_graph`): `cinema-scene.scene` (shot media, rule b); `video-edit.clips` (an id list, snapped by the run: derived, path by path); Recraft's `colors` and `background_color` (a string the run parses into an object: one value, derived, still put back); `video_urls` (a list of strings: one value); `_paperSource` and every other `_` param (agents can't propose them, so the Accept never touches them). World Labs' recovery ids and other flat keys behave as before.
  - *Reachability.* An agent's proposal can't change a Cinema scene today: the backend refuses it ("Cinema scenes can't be changed by a proposal; edit them in Cinema", main.py `_apply_spec`, since 53e976c1). So the review's exact steps can't be made through the API, and the live check stages them (below). The canvas fix still matters: the same undo path serves `video-edit.clips` and any compound param a proposal may set, and it would be the only guard if the scene refusal is ever lifted.
  - *A node Accept added* takes a run's write path by path too, so an agent's edit to it before a render still keeps it (whole-key absorption had hidden that edit and removed the node).
  - *The backend.* POST /api/graph/restore already kept a live shot's media (`_author_cinema_scene`), so s2's image was never lost there; the canvas was wrong, and now sends the same scene. One backend gap found on the way: undoing a delete of a rendered shot (the person's own shot delete) brought the shot back idle on the backend while the canvas showed its image. A person's restore (or the server's own kept inverse) now brings a returning shot back with its media and its `shot_<id>` port; anyone else's still starts idle (`returning_media`).
- **L1.** `paramLabel` reads `allParamDefinitions`, as the Inspector does: "Aspect Ratio" for FLUX 1.1 [pro] Ultra, never "aspect_ratio".
- **L2 / GM item 7.** A Replicate model's settings are labeled by their key in sentence case, on the backend (`universal_ports.setting_label`, used by the picker and by `_set_params_bubble`) and in the Inspector (`lib/universalSettingLabel.ts`, derived from the key so a node saved with the old Title Case label matches). "Set “Guidance scale”". `_title` was the shared helper: it also labels Replicate's file-input ports, and those keep Title Case like every other port ("Input Image"). The other universal nodes (FAL, OpenRouter, Nous) show no Inspector control for an extra param, so it has no label: the bubble says nothing and the Agent log says "Changed a setting on “<node>”" / "Changed <N> settings on “<node>”" (GM's words; "Updated" is gone). The presence event carries `log` when the log's line isn't the bubble's; `agentActionEntry` reads it. `_show_agent` also logs any action that names what it did (`did`) and says nothing, in the Agents panel's words ("Changed “Hero”"), so no action is left out, as MCP-SETUP.md promises. A bare cursor move still logs nothing. The backend parity test applies the label rule to the old picker fixture (`_with_setting_labels`), and the fixture's note says so.
- **N1.** `_start_refusal` takes the run id; a Stop that lands at the World Labs claim answers `_stopped_id_refusal(run_id)`.
- **N2.** `_show_agent` takes `words`, computed inside its guard; a failure there falls back to the panel's words. A saved PUT never 500s on its bubble.
- **GM (1)-(3).** Settings are named only when every one is on one node; across nodes they are counted from 2 ("…except 2 settings Codex changed after you accepted."). The ", and" grouping is gone. 1-3 kept nodes are named, from 4 "<N> nodes"; the unknown-source count as built.
- **GM (4).** Commons: a reference's image replaced, or the whole batch (a new manifest), gets its own line, verbatim. The batch line wins when both changed.
- **GM (5).** One banner rule. The canvas keeps 150px and home its 81px; every other screen is a `studio` placement, `top: calc(var(--workspace-header-bottom, 61px) + 8px)`. Each screen's topmost header is a WorkspaceHeader, which publishes where it ends (`lib/publishedHeaderBottom.ts`, a ResizeObserver, so a header that wraps taller moves the banner too) and takes it back when it unmounts. The brand showcase's own bar publishes the same way. The video editor's fixed 69px is gone (it was this rule measured once).
- **GM (6), the price chip.** Built verbatim: "$0+" is "Some costs aren't known yet."; a range from $0 is "Between $0 and $0.43, plus costs that aren't known yet." / "Between $0 and $0.43."; a non-zero amount under a cent is "<$0.01" on a chip ("<$0.01+", "<$0.01–0.43+"), never "$0" or "$0.0047". One shared formatter (`lib/pricing formatChipEstimate`) writes both the Run chips and the proposal card's chip; detail lines and the cost confirm keep formatUsd's figures. The floor and its words are one constant each (`CHIP_FLOOR_USD`, `CHIP_UNDER_FLOOR`, `CHIP_UNDER_FLOOR_WORDS`). "$0" only ever meaning free also reached spend: Settings and `nebula spend` showed "$0.00" for a few tenths of a cent; they show "<$0.01" now (`formatSpentUsd`, cli spend `_usd`).
- **Decisions not in the spec.**
  - The sub-cent tooltips GM didn't word, built from GM's words and marked in runScope.ts: "Estimated cost: less than $0.01." (exact), "Less than $0.01, plus costs that aren't known yet." (with +), "Between less than $0.01 and $0.43[, plus costs that aren't known yet.]" (a range).
  - A range whose low end is above $0 keeps r18's forms ("At least $0.05. …" with +, no tooltip without). GM's "Between" was given for the $0 case only.
  - The guard's log words for an action with nothing said ("Changed “Hero”") are the Agents panel's.
- **Tradeoffs.** `merge3` merges a small object like a color channel by channel when the Accept and someone else changed different channels. That's what the formula says; colors are written whole in practice.
- **Agent support.** MCP-SETUP.md (the Agent log paragraph, the World Labs claim's refusal, Replicate labels on /api/universal/ports, spend's "<$0.01"), SKILL.md (labels, never keys), mcp_server.py's `model_schema` (a param's `label`). The CLI's `nebula spend` changed; nothing else in the CLI formats these.
- **Tests, failed first on 102b90b3.** Written before the fixes and run against the base code:
  - frontend/tests/store/graphStore.fix1.test.ts: 14 of 18 failed (M1 two-shot marked and unmarked, same shot, variations, cleared output, added shot, conflict, merge units, L1 FLUX, GM 1-3 lines); the Guidance-scale store test, added with GM item 7, failed too. 19 tests now.
  - frontend/tests/pr198Fix1Ui.test.tsx: 12 of 16 failed (Commons lines, banner placement and publishing, chips and tooltips, proposal chip, the log field); the spend test, added later, failed too. 17 tests now.
  - backend/tests/test_pr198_fix1.py: 8 of 10 failed (bubble and log words, picker labels, the did fallback, N1, N2, CLI spend); the returning-shot tests, added later, failed too. 12 tests now.
- **Live check** (scratch fix1_live.mjs; backend 8797 with temp HOME and every NEBULA_* root in scratch, no keys; Vite 5797 with VITE_NEBULA_BACKEND_PORT=8797; 8000-8010 and 5173 blocked by CDP and a dead proxy, a canary to 8001 refused; 0 blocked attempts after the canary). 30/30 at 1280x800 and 1440x900:
  - Two-shot undo, nothing paid: an agent's scene proposal is refused (above), so the proposal is opened on the canvas and its Accept answered by the person's own PUT of the same scene. s2's write-back ran through a test-only route that calls the shot task's own merge (`_merge_shot_variations`) and its runParams sync, with a local image. Undo put s1's prompt back and kept s2's image on the canvas, in the restore body and on the backend.
  - Agent log for universal params: FAL "Changed a setting on “Hero still”" with no bubble; Replicate bubble and log "Set “Guidance scale”".
  - Banner, offline, on every screen: the canvas at 150px; Cinema, Character, Moodboard, Create and Commons 8px under a 49px header (57px); Remotion under its 89px header and toolbar (97px); the video editor under its 61px header (69px). No control under it on any screen.
  - Found on the way: a Cinema scene without `base` (an agent's `create_node` with a bare `{shots}` scene) crashes the Cinema editor (CinemaSharedControls reads `scene.base.model`). Pre-existing, not touched here.
- **Gates.**
  - Backend (iso_fu.sh): 11257 passed, 71 skipped.
  - Vitest full run, under a load average of 55-62: 435 files, 5512 tests; 398 tests in 152 files failed, nearly all timeouts. The 152 files rerun with 4 workers: 1624 passed, 10 failed in 8 files, 9 of them timeouts. Those 8 files alone: 94 passed.
  - errorCopy ratchets alone: 15 files, 192 passed.
  - tsc -b clean; lint clean.
  - vite build passes; check-build-budget: 395,139 bytes raw (limit 512,000).
- **Open items.**
  - GM: confirm the sub-cent tooltip sentences, and whether "Between" also covers a range whose low end is above $0.
  - GM: words for the undo line or save-failed line naming an extra param that has no label (FAL); it still falls back to the key.
  - GM: the did-fallback log words ("Changed “Hero”").
  - A Cinema scene without `base` crashes the Cinema editor (above).
  - Carried from earlier rounds: the corrupt-catalog repair (with Justin), and the r15 X1 probe.

## Fix round 2 (PR #198 review 2, GM's pr198 r2 rulings and follow-up)

- **M1, a shot brought back by Undo.**
  - Nothing Nebula stores is ever rendering: a stored `running` (or `queued`) is settled to `done` when the shot has an image, else `idle`, on every backend write and on a project's load (`services/cinema_scene_spec.py settled_output`). A reload never shows "Generating…" for good.
  - No undo step holds it either: the canvas's snapshots (`createSnapshot`) and every slice step (`canvasUndo keep`) settle shots and node run state. An undo or redo that lands while a shot still renders keeps its live spinner (`keepRenderingShots`, in `applySlice` and `restoreWithOutputs`).
  - A returning shot (`_author_cinema_scene`, `returning_media`) keeps its output only when it was `done` or `error`. When a run put a newer image on `shot_<id>` after the shot left, the shot adopts that image and the port is never overwritten. The restore's own coercion settles a returning `running` shot that has an image to `done` first, so it comes back with that image and its port: it is a finished, real image (this changed the review's expectation for that one case).
  - GM: block × while a shot renders. The rail's × is disabled with "Stop the run first." while Cinema shows a Stop for the run (Stop shot for that shot's run, Stop scene for a run of the scene), else "Wait for “Shot 2” to finish." (its optimistic "running" before the run registers). `removeShot` refuses the same. The backend refuses a PUT or restore that would remove a shot a live run renders, 409 with the run id, `cancel_run` / `nebula cancel <id>`, and "Nothing changed." (`_refuse_removing_rendering_shots`; shot runs and runs that include the scene are noted as they start).
  - Builder's call: GM's "Stop the run first." also covers a whole-scene run, because Cinema shows Stop scene for it. A known gap: the backend notes a run when it registers, so a removal during a run's spend-approval admission isn't refused.
- **M2, a scene without `base`.**
  - One normalizer on every write path (create, edit_canvas and `nebula apply`, a proposal and its Accept, import, PUT, restore) through `_coerce_params`; lenient (fill what it can, keep the rest) for a project's load and `CLIGraph`'s own adds and loads. It fills `version` 1, `base` `seedream-4-5`, `aspectRatio` 16:9 and a shot's empty `prompt`, and refuses only what can't be filled (not an object, `shots` not a list, a shot without an id, a duplicate id, a wrong type) with 400 naming the field and showing the shape.
  - The frontend reads through the same defaults (`lib/cinemaScene normalizeCinemaScene`, in CinemaStudioView, CinemaSharedControls and graphStore's `sceneFromNode`).
  - Every studio sits inside `StudioBoundary` (App.tsx): a studio that throws shows GM's line, "Couldn't open “<node>”. Some of its data is missing or damaged, so Nebula can't show it.", with Back to canvas (the studio's own exit), and the Agent log gets "Couldn't open “<node>”, node n4. <field> is missing.". Neither names the agent.
  - Builder's: the unlabeled nouns GM didn't give (this character, this moodboard, Creator Studio, the Commons, the showcase); "this clip" for the video editor and "this shot list" for Remotion are my reading of GM's three nouns; the log's "Its data couldn't be read." when no field is found.
- **Banner (GM).** On every screen but the canvas the banner is a row of the layout right under the top header (`StudioOfflineRow`, rendered by WorkspaceHeader as the header's next sibling; each studio's grid names it `offline`; the video editor's flex column and the brand showcase just stack it). Centred, 8px above and below, pushing the content down; in Cinema it sits above the scene-settings strip. It opens and closes on `--workspace-dock-spring` (`grid-template-rows` 0fr → 1fr), and with reduced motion at once. The canvas keeps its floating banner (`offlineRow={false}`); the floating studio placement, `--workspace-header-bottom` and `lib/publishedHeaderBottom.ts` are gone. A blocked edit's pulse is shared (`hooks/useOfflinePulse`).
  - There was no existing offline delay: the canvas's banner shows on the first failed probe. The row waits `STUDIO_BANNER_DELAY_MS` = 1000 ms, because opening it moves the whole studio. Builder's value, for GM.
- **Gating (GM).** One helper, `offlineAction(offline, disabled)` (lib/useBackendOffline): disabled, the offline mark (a press pulses the banner) and `data-offline-neutral`, one App.css rule that drops the accent for the control look. Cinema's Generate shot, Generate N, Generate all and Add shot; Create's Generate; Remotion's six adds, REC (only turning it on), Export and Render MP4.
  - Finding: Remotion's adds, layer order, Delete and keyframes all save (the store's edit gates, then the project autosave), so they're gated; layer order and Delete got the helper too.
  - Run has no offline tooltip of its own (its title stays its normal one), so each button keeps its own title, as Run does. Flag for GM if a line was meant.
- **Load notices offline (GM).** `useOfflineHiddenNotice` hides Character's and Moodboard's load failure ("… not found …") and the Commons' load failures (collections, worker status, a search; now kept apart from an action's failure) while offline. On reconnect the screen checks again: a failed load is retried, and a not-found one is reloaded unless the person started a new one there since. The notice comes back only if it still applies.
- **Agent log time (GM).** `white-space: nowrap` and a `max-content` column (the time is zero-padded and tabular, so every row lines up).
- **GM asks 1-4, built verbatim.** "<$0.01" → "Estimated cost under $0.01"; "<$0.01+" → "Under $0.01 so far. Some costs aren't known yet."; every range chip → "Between $X and $Y." / "…, plus costs that aren't known yet."; "At least $X. Some costs aren't known yet." only for a single "$X+". An unlabeled setting is "a setting on “<node>”" in the undo line and the save-failed toast, and the Agent log keeps the raw key. "Changed “Hero”" stays the last fallback.
  - Builder's forms: "Between less than $0.01 and $Y." for a sub-cent low end; the nothing-undone forms with an unnamed setting ("Nothing was undone. Codex changed a setting on “Flux” after you accepted.", "A setting on “Flux” was changed after you accepted."); two or more settings with one unnamed are counted ("2 settings").
- **L2.** Inside an id-keyed item the Accept changed (a clip it sped up), everything a run wrote there since is derived and goes back with it (`rebasePart`); a Cinema shot's media stays the run's.
- **L3 (GM's follow-up).** When both the Accept and someone since reordered the same list, `merge3` keeps the order now and notes it; the line names it as one kept item: "Undid the proposal except the shot order in “<scene>”. Codex reordered the shots after you accepted.", the clip form, and "Nothing was undone. You reordered the shots in another window after you accepted." when that was all. Builder's: the unknown actor ("The shots were reordered after you accepted."), and an order kept with other changes is counted ("N changes … made").
- **L4.** One money formatter on each side, `services/money.py` and `lib/pricing.ts`, tested against one table (`contracts/fixtures/money/cases.json`) plus property tests: spent to the cent with "<$0.01", amounts with two significant figures under $0.10, cents under $10 and whole dollars from $10, picked after rounding, half up on the binary value. Grouping commas. Chip ranges under $0.10 share their decimals ("$0.010–0.015"), and ends that read the same collapse ("<$0.01–0.01" is "~$0.01"). Negative and non-finite amounts clamp to nothing: costs and spend are sums of prices, so below zero is only float noise from a subtraction, where "nothing left" is true; a refund would need its own words, not "$-0.00".
- **Nits.** N1: the picker parity test reads fixed expected labels from the fixture. N2: MCP-SETUP says the event "carries `log`, the Agent log's line". N3: a run's write-back rebases every undo and redo step that held what it replaced (`rebaseStepOnRunOutput`), so Redo keeps a shot rendered between Undo and Redo, and a flat key a run wrote. N4: an empty PUT says and logs nothing (no bubble, no "Updated" chat line). N5: a part kept because a run rendered it drops the actor.
- **G3: open.** It is reachable only once proposals can change scenes (the backend refuses a proposal that changes a Cinema scene), so GM's lines wait for that work.
- **Agent support.** MCP-SETUP.md (a new "Cinema scenes over MCP": the fill, the refusals, settled statuses, the shot-removal 409; money formats; N2), SKILL.md (a bare scene, the 409), mcp_server.py (`edit_canvas` and `cancel_run` docstrings). The CLI needed no change: `nebula set` prints the 409's detail as every refusal.
- **Late fixes from the live check.** The Agent log named `scene.base` for a scene whose first shot was null: `cinemaSceneProblem` now checks the shots first, because a missing base is filled in and isn't what breaks the studio. The video editor's row sat 10px under its header (the editor is a flex column with a 10px gap, 16px when empty); the row now cancels the gap above it, and while open the one below it, on the same spring.
- **Tests that failed first (on the base, before the fix).** Backend: proposals and universal ports, 7 failed and 31 passed; `test_pr198_fix2.py`, 39 failed, 2 errors and 23 passed. Frontend: the money and store files, 38 failed and 38 passed; the UI file failed to import the modules it tests. Added after the fix, not first: the store test "an Undo while a shot still renders keeps its spinner" and the field-order test for `cinemaSceneProblem`.
- **Gates.** Backend, full suite: 11,323 passed, 71 skipped, 0 failed (22:46). `tsc -b` clean; lint clean (inline-style guard, Slava CSS scope guard, eslint); vite build OK, budget 398,584 bytes raw / 120,495 gzip (limit 512,000). Vitest, full run at a machine load around 40: 99 failed and 5,991 passed (6,090) in 34 files, 89 of them timeouts; those 34 files rerun alone with 4 workers: 744 passed, 0 failed.
- **Live check** (8797/5797, 1280 and 1440, isolated state, nothing paid): 57/57 on the last run, 0 blocked attempts after the canary (the canary to 8001 was refused). Earlier runs: 54/57 (the two late fixes above), then two runs lost to page loads timing out under the machine's load (the script now reloads until the project list shows). The harness had no person link, so every screenshot shows "This tab isn't connected as you." That's the harness, not the build. Screenshots: `fix2-*.png` in the scratchpad (M2 bare scene and boundary, M1 blocked ×, the two-shot undo on the canvas and in Cinema, the Agent log, and the offline row on every screen).
- **Two-shot undo, for GM.** A full undo says nothing by design, so the reshoot has no undo toast to show. The state is undo 1, redo 1, with no notice; the screenshot shows the board after the undo.

## Fix round 3 (PR #198 review 3, GM's r3 rulings and answers)

- **H1: only agents' scene writes are refused.** `normalize_scene(scene, strict=…)` (services/cinema_scene_spec.py). Lenient never raises. It converts:
  - a base string → `{"model": …}`;
  - a bad version → 1;
  - a bad aspect → 16:9;
  - a non-text prompt → text (`""` for a non-scalar);
  - missing or duplicate shot ids → new unique ids (`s1`, `s2`, … past every id in the scene; the first shot with an id keeps it);
  - a non-dict shot is dropped, and so are a broken `output`, a non-list `variations` and a non-int `selectedVariation`;
  - anything else → defaults.

  JSON text is read as the object in both modes (N4: `--param scene='<json>'`). Who is strict comes from `_scene_writes_strict()` = not `refusal_copy.person_reads()`, never the token, so a stale token never refuses the person.
  - **Strict (400 naming the field):**
    - `POST /api/graph/node`, create-and-connect, `PUT /api/graph/node/{id}` and `POST /api/graph/cluster`, each when an agent sends it;
    - `_stage_proposal`: `edit_canvas` / `nebula apply` (`apply_graph_edit`), `propose_change` (`create_canvas_proposal`), Accept and the reopen check.
  - **Lenient:**
    - `_stage_project_snapshot`: project open, every save and autosave (`_save_project`), the handoff save (`_save_handoff`), `recover_project_copy`;
    - import (for everyone: it is saved data);
    - the restore (undo/redo, the person's and an agent's);
    - `_validate_restore_graph`;
    - `CLIGraph.load` and `CLIGraph.add_node`'s backstop;
    - the person's create, PUT and cluster.
  - **Canvas:** a refused scene PUT keeps the entry, so the typing stays, and says "Couldn't save “Scene” for “<node>”." (`paramSaveFailedLine`). The next sync that brings back the scene the backend still had keeps the typing. A sync with any other scene (an agent's or another window's newer edit) wins and releases it. The person was already told, and that keeps `graphStore.cinemaPersistence`'s "releases failed persistence to external updates" true. `backendScenes` remembers the backend's scene per node, from every sync and every save it took.
- **M1.** `_cinema_renders: OrderedDict[run_id, set[(node, shot|None)]]`; `_note_scene_renders` notes every scene in a run. A test covers two scenes in one run.
- **L1.** `@_admits_cinema_renders` on `/api/execute`, `/api/execute-node`, `/api/cinema/generate-shot` and `/api/graph/run`. A ContextVar plus `_cinema_admitting` (a 600 s deadline) protect a run's scenes from the start of admission (spend approval included). `_render_state` returns "running", "admitting" or None. A removal while a run is still admitting reads "…Wait for it to finish."
- **L2.** Each scene is released when its own node is done (`_scene_event_done` in `_emit_and_sync`: Executed, Error, Skipped), not when the run ends. A fan-out scene (several executions of one node) is held until the run ends. On the canvas, `shotRemovalBlock` counts a graph run only while the scene's node is undefined, queued or executing. The rail, `removeShot`, the undo check and the delete check all pass the node's state.
- **M2 / GM 3.** `stepHistory` refuses, before sending, an undo or redo that would remove a rendering shot or its scene (`renderingRemoval`), with GM's line: "Couldn't undo. It would remove “Shot 2”, which is still running. Stop the run first." ("Couldn't redo. …"; "…Wait for it to finish." with no Stop). It never includes the run id.
  - The backend's 409 has the same person form (`_removal_person_line`); the agent detail is unchanged.
  - A restore the backend refuses anyway shows its person line as is and keeps every rendering shot's spinner (`withLiveRenders`: running in the canvas before or now, or a shot run of this tab, including one that started while the undo was on its way).
  - Builder's: several shots, "“Shot 2” and “Shot 3”, which are still running", and from four "4 shots that are still running".
- **L3.** A batch that lands on a shot that is gone is stashed (`_late_shot_results`, in memory, bounded at 256). A shot an undo brings back adopts the image together with its variations and a matching `selectedVariation`. After a restart, the adopted shot keeps the image alone.
- **L4.** CinemaSceneNode reads through `sceneCardView`; RemotionNode and EditNode guard their timeline and clip reads. Every card in `CANVAS_NODE_TYPES` sits in its own `NodeCardBoundary` (`withNodeCardBoundary`, memoized; `CANVAS_CARDS` is the raw map).
  - A card that throws shows GM's boundary line at card size: "Couldn't open “X”. Some of its data is missing or damaged, so Nebula can't show it." ("this node" with no label).
  - It keeps its handles (from the definition, the dynamic ports and the shot ports), so wires stay drawn. It logs to the Agent log and tries again when its data changes.
  - canvasRenderScope's counter now wraps the raw card inside the boundary.
- **L5.** `usd_amount` / `formatUsd`: under $0.000001 reads "<$0.000001" (5e-324 used to raise). A non-finite high end gives the low end with "+" (never "~$0"). The table and property tests are extended.
- **L6.** The Commons boundary's way back sets `viewMode: 'canvas'`.
- **GM r3 (a).** Composition's toolbar is its own grid row (`.remotion-editor-view__toolbar`) under the offline row.
- **GM r3 (b).** StudioBoundary renders the studio's WorkspaceHeader (project bar, back to Canvas, Updates, and the offline row under it) and replaces only the body.
- **GM r3 items 2, 5, 6, 7.**
  - Item 2: "You reordered them in another window after you accepted." ("the shots" in the Nothing-was-undone form, which has nothing to point back to).
  - Item 5: the unknown-actor reorder lines.
  - Item 6: "Up to $Y." / "Up to $Y, plus costs that aren't known yet."
  - Item 7: unnamed settings, also on a whole node an Accept added.
- **G1 / GM 1: deleting a scene while a shot renders.**
  - Backend: `_refuse_deleting_rendering_scene` (in `_ensure_node_deletable`, so DELETE, `edit_canvas` / `nebula apply` remove, an undo or redo that deletes it).
    - Agents get 409 "Couldn't delete “Scene”, node n4. “Shot 2” is still running, run <id>.", and the Agent log shows the same line under the agent's name (`_log_agent_refusal` → `_say_agent_action`).
    - The person reads "Couldn't delete “Scene”. “Shot 2” is still running. Stop the run first."
  - Canvas: the context menu, the Inspector and the selection toolbar (only when every selected node is such a scene) disable Delete with "Stop the run first." or "Wait for “Scene” to finish." (`sceneDeleteDisabledTitle`).
    - The Delete key and `deleteSelected` delete the rest and keep the scene and its wires (`withoutRenderingScenes`; Canvas `onBeforeDelete` drops the scene's edges): "Deleted 3 nodes. “Scene” wasn't deleted because “Shot 2” is still running." The scene alone gets the single toast.
    - The strings live in `lib/cinemaScene.ts`.
  - Builder's: two or more kept scenes ("“A” and “B” weren't deleted because their shots are still running."); the multi-scene tooltip ("Wait for them to finish."); the PUT 409 person line ("Couldn't remove “Shot 2”. It's still running. Stop the run first.").
- **Nits.**
  - N1: `useOfflineHiddenNotice` runs the check from the connection's own change, so what it clears lands in the same update as "online" and nothing flashes.
  - N2: "At least" says the low end ("$0.0099").
  - N3: two significant figures per end ("$0.0099–0.010"). This mixes decimals only across a power of ten, as "$9.50–12" does at $10; the property test allows only that.
  - N4: as above.
- **Agent support.**
  - MCP-SETUP.md "Cinema scenes over MCP": the strict and lenient paths, the conversions, the timing, the person lines, G1 and the canvas blocking.
  - SKILL.md: the 400 examples, `--param scene='<json>'`, and the 409s.
  - mcp_server.py: the `edit_canvas`, `cancel_run` and `remove_from_canvas` docstrings.
  - The CLI prints the 409 detail as it does every refusal.
- **Tests that failed first, on 537af979.**
  - Backend, `test_pr198_fix3.py`: 122 failed and 11 errored (the mechanisms the M1/L1/L2/G1/M2 tests call didn't exist); the run kept only the failure list, not the pass count.
  - Frontend, the new store and money files plus the changed fix2 money file: 32 failed and 63 passed. The new UI file failed to import (no `withNodeCardBoundary` on the base). Run with a stub in its place, 14 of its 26 failed.
  - What passed on the base:
    - some malformed scene shapes, the Remotion and editor cards with damaged params, and the L2 "still on the scene" rows;
    - the H1 test "a newer edit from someone else still wins" (added after the fix, a guard).
- **Gates.**
  - Backend, full suite: 11,480 passed, 71 skipped, 0 failed (6:01).
  - Vitest, full: the first run had 2 real failures (the persistence test above; a kept whole node's unnamed setting), both fixed. The rerun had 464 files and 6,159 passed, 0 failed, with no timeouts to rerun.
  - The errorCopy ratchets: 15 files, 192 passed.
  - `tsc -b` clean.
  - Lint clean: the inline-style guard, the Slava CSS scope guard and eslint.
  - Vite build OK; budget 401,668 bytes raw / 121,496 gzip (limit 512,000).
- **Live check** (8797/5797, 1280 and 1440, isolated state, nothing paid; the rendering shot was a client-side stub): 19/20, 0 blocked attempts after the canary.
  - **What passed:**
    - The project with all 12 malformed scene shapes opens (200) and autosaves (PUT 200). Every scene is converted, and every card draws.
    - Damaged cards on the live canvas never blank it. A card that throws shows the boundary line at card size and keeps its handle. A text node with `params: null` also hit the boundary: ModelNode can't draw it, and only a client-side write can make one.
    - The Cinema boundary keeps the header (project bar, Canvas, Cinema, Updates). The vehicle was a shot whose `variations` isn't a list, which only a client-side write can make; the backend drops one. Back to canvas lands on a drawn canvas.
    - Composition: the header, then the offline row, then the toolbar.
    - Undo is refused for a rendering shot, with GM's line and nothing sent.
    - G1: the toast, and the context menu's disabled Delete.
  - **The one failure:** the multi-select delete removed the other node and kept the scene, but no line showed. In this harness a plain delete shows no "Deleted …" line either (the control check). The tab has no person link, so the delete's sync takes the step off the top before the answer. The kept line is covered by the store test.
  - Screenshots: `fix3-*.png` in the scratchpad.

## Fix round 4 (PR #198 review 4, GM's r4 and r5 rulings)

- **HIGH: a refused shot removal.** Any refusal of a scene write (a 409 from another window's run, or any other non-ok answer) now ends that write's authoring entry and puts the scene back as the backend has it (`refusedSceneWrite` in graphStore). Nothing stays queued to be re-sent.
  - The restore uses `backendScenes`, with the live runtime of the shots the canvas has. It cancels the write's undo step and reads `/api/graph/export` again when no newer sync has landed.
  - The toast is the backend's person line alone when it has one ("Couldn't remove “Shot 2”. It's still running. Stop the run first."). Otherwise it is GM's save line with "It's back to its last saved value."
  - The wires of a removed shot are no longer sent as separate DELETEs. The backend's scene PUT prunes them in the same write (`_author_cinema_scene`), so a refused PUT leaves them, and the image, where they were. `removeShot` and `updateScene` hand their wire holds and undo step to the entry, which settles them when the write is answered.
  - This reverses round 3's "the typing stays": the kept typing is what re-sent the refused removal with the next edit. A person's write is lenient now, so a refusal is rare (a 413, a run's 409).
- **M1: the run lock is never silent.**
  - The Delete key (Canvas `onKeyDown`, since React Flow's delete key is off while a run is going), the menu's Delete, `deleteSelected`, `deleteNode`, `deleteGeneration` and Undo/Redo now say why (`refuseRunLockedDelete`, `stepHistory`).
  - A selection of only rendering scenes reads GM's scene line. An undo that would remove a rendering shot reads its GM line. Everything else reads the lock (GM r5): "Couldn't delete “X”. Wait for the active run to finish." / "Couldn't delete 3 nodes. …" / "Couldn't undo. …" / "Couldn't redo. …". The strings are in `lib/cinemaScene.ts` (`RUN_LOCK_REASON`, `runLockedLine`).
  - The doubled toast (GM r5 item 3) is fixed as a rule. `headedLine` in `lib/errorCopy.ts`: a reason that is a line of its own ("Couldn't …") shows alone, unless the heading names something the reason doesn't. `oneLine`, `deleteRefusalText` and `reportNodeDeletionFailure` go through it. `tests/lib/errorCopy.namedLine.test.ts` ratchets new hand-built "heading reason" templates.
  - The person's 409 for a rendering scene carries `rendering: {shots, stoppable}` (`_RenderingSceneRefusal`). A multi-select delete in another window's run reads "Deleted 2 nodes. “Scene” wasn't deleted because “Shot 2” is still running." with Undo, as one line.
  - GM r4: 4+ kept scenes are counted. The several-scene tooltips read "Wait for the running shots to finish." / "Stop the runs first."
- **M2.** `_scene_render_done` returns early for a run that noted any shot entry, so a shot run holds its upstream scenes through every variation pass until it ends, stops or fails. `shotRemovalBlock` does the same on the canvas (a shot run holds the scenes in its `nodeIds`).
- **L1.**
  - `normalize_scene(..., reserved=)`: a new id never takes one a `shot_<id>` port names (`shot_port_ids`). The ids come from the PUT, the restore, ingress, `CLIGraph.add_node` and `CLIGraph.load`.
  - A lenient open or import drops an output port no shot owns, and a saved wire from it (`_orphaned_shot_wire`), instead of refusing the file. `test_cli_api`'s fabricated-port import case moved from 400 to "dropped": the value never lands, the file opens.
- **L2 (GM r4 money).**
  - Chips never show sub-cent figures: cents under $10, whole dollars from $10.
  - A low end under a cent is "Up to $Y" / "Up to $Y+", and the tooltip says the same figure.
  - Both ends of a range have the same decimals ("$9.50–12.00").
  - Ends that round to the same cents are one figure.
  - `formatUsdRange` with a NaN, infinite or lower high end writes the low end alone.
  - The parity fuzz is `contracts/fixtures/money/fuzz.json` (2,607 amounts, seed 198), checked by `test_money_fuzz_parity.py` and `pr198Fix4Money.test.ts`. No Python chip formatter exists, so parity covers `formatUsd` / `formatSpentUsd`.
- **L3.** `nodeDataProblem` checks a known `definitionId`, a text label, `params` and `outputs` objects, a scene, an edit's `clips` and a composition's `manifest.timeline`. "Missing or damaged" shows only when that check names a field.
  - Otherwise the card reads GM r5's neutral line and the studio its own neutral line, and the Agent log reads "Couldn't draw “X”, node n4. <error>".
  - Cards keep their header (icon in its own quiet boundary, then the label), and only the body is replaced (GM r4). A check that throws counts as damaged.
  - The studio's header sits in `SafeHeader`, which falls back to a plain header with the title and "Back to Canvas".
  - App's `problem()` covers the editor and the composition editor too.
- **N1, N2, MCP-SETUP.** Agents' restore and import are documented as lenient. The import-during-run 409 reads "A run is still going. Wait for it to finish or stop it first." for the person. MCP-SETUP's run-protection list (upstream scenes) and its "canvas blocks" paragraph (the own-run lock vs. another window's run) are rewritten to match.
- **Tests that failed first, on d67a2410.**
  - Backend `test_pr198_fix4.py`: 14 failed, 1 passed (the canvas-run case, a guard). Two tests were added after that run and weren't run on the base: the reserved-id unit test, and the leftover-port open, a guard for the L1 regression the fix itself caused.
  - Frontend, the five new files on a base extract: 55 failed, 16 passed. Money: 19 of 33. UI: 15 of 15. Store: 15 of 16. namedLine: 5 of 5. The Delete key: 1 of 2.
- **Gates.**
  - Backend full suite: 11,495 passed, 71 skipped, 2 failed (36:49 under load).
    - The import case above was updated.
    - `test_every_tool_is_async_or_offloaded` failed because `mcp_server.py` was edited while the suite ran (`inspect.getsource` read shifted lines). It passes alone.
    - Both files, the fix1–4 files, money parity, run-stop scope and the follow-ups rerun: 431 passed.
  - Vitest full: 6,107 passed, 112 failed. 94 were 5 s timeouts at load ~40; the rest were the timeouts' knock-ons, plus one real one, below. The 31 failed files rerun alone: 605 passed, 1 failed.
    - The real one was `graphStore.test.ts`'s CLI-node delete. `response.clone()` sat outside the `try`, and a test double has no `clone`. Fixed; it passes.
  - Focused files (94) after the fixes: all pass. The errorCopy ratchets: 17 files, 363 passed.
  - `tsc -b` clean. Lint clean.
  - Vite build OK; budget 404,167 bytes raw / 122,160 gzip (limit 512,000).
- **Live check** (8797/5797, 1280 and 1440, isolated state; a fake cinema-scene handler that holds per call, nothing paid): 24/24, 0 blocked attempts after the canary.
  - The own run: Delete on one node, a multi-select, the scene alone, and Cmd+Z each show their line. No DELETE was sent.
  - Another window's run: removing its shot gives the backend's line alone. Scene, paid image and wire stay in the tab and the backend, and the next edit's PUT keeps s2.
  - Multi-select: "Deleted 2 nodes. “Ref scene” wasn't deleted because “Shot 1” is still running." with Undo.
  - Variation pass 2: the agent's DELETE gets 409 with the run id and `rendering`, the person's Delete shows GM's line, and the scene is free after the run.
  - The Run chip reads "Up to $0.43" for a GPT Image 2.5 node, and its tooltip says "Up to $0.43.".
  - Screenshots: `fix4-*.png` in the scratchpad.

## Fix round 5 (PR #198 review 5, GM's r6 and r7 rulings, GM's offline verbs from #200 r2)

- **H1: Undo after a refused removal.** Every undo and redo step is numbered as it lands on either stack (`stepSeq`, set in the store's one `set` wrapper, so every writer is covered).
  - A scene's authoring entry keeps the step number before its first edit (`since`), its removals' steps (`removalSteps`, appended, never overwritten by later typing), and every wire its edits took off (`takenWires`).
  - When the backend keeps shots this canvas removed (`restoreShots`), every step since `since`, on either stack, takes those shots back into its copy of the node: the scene in a snapshot or in both slices of a slice step, the ports and their values, and in a snapshot the wires. The removals' own steps leave both stacks.
  - So no Undo or Redo can send the scene without the shot. Review 5's P1 and P7 repros, a debounced-typing variant, and the live repro all keep Shot 2 and its image.
- **M1 / GM r6 item 1: the partial revert.** A 409 that names its rendering shots (`rendering.shotIds`, new from the backend; a backend from before this round is read by rail number) puts back only those shots, and the backend's line is the only line. The rest of the save (the same-scene typing and anything queued) goes again at once, without the removal. A resend that already has every named shot and is refused the same way stays on screen unsaved, so it never loops.
- **GM r7 item 1: whole-save refusals.** The edits stay on screen, marked unsaved (`unsavedScenes`, shown on the scene card), with the line for what clears it (`lib/sceneSaveCopy.ts`):
  - 413: GM's line. The next save that fits takes the edits.
  - A paid start or an approved run's inputs (`code` `paid_start` / `approved_run`): "…Your changes are kept and will save when the run finishes." Sent again with a backoff (2, 4, 8, then every 15 s), and at once on a sync (at most once a second), so it saves when the run ends.
  - 5xx, 408, 429: "…Your changes are kept. Nebula will try again." The canvas really retries, on the same backoff.
  - 404: "…It was deleted in another window." Nothing more is sent.
  - The workspace moved (`code` `workspace_moved`, with `project` and `switchedBy`): "…Codex switched to “Y” first." / "Nebula switched to “Y” first." Nothing more is sent.
  - 400: "…Nebula ran into a problem saving them, so they're kept on screen but not saved." The detail goes to the Agent log ("Couldn't save “X”, node n4. <detail>").
  - `params_outdated`: **stopped for GM.** Unsaved edits do survive the reload, but as a recovered project (projectStore saves the canvas as a copy, then the tab reloads by itself), not into the same project. So "Reload Nebula and they'll save." would be untrue. The scene adds no line of its own and sends nothing more, and the edits stay on screen for the recovered copy to capture.
  - Anything else: the backend's line (alone when it is a line of its own), marked unsaved. A retry refused the same way says nothing new.
  - A newer edit from somewhere else to a scene with kept edits (the backend's authoring changed and it isn't one of this tab's own writes) shows that version, and the person is told (`CHANGED_ELSEWHERE`, a placeholder). Kept edits are never sent over it later. This replaces round 3's "a newer edit from someone else still wins", which dropped them silently.
  - A kept removal never takes a newer image: on each sync, a removed shot that the backend still has, and whose runtime changed since the removal, comes back.
- **L1: no answer.** The entry is marked `unanswered` and sends nothing more until a sync shows what the backend has; the canvas reads the backend again on reconnect. A removed shot the backend still has comes back, with its port, image and wire; one the backend no longer has stays removed. Then whatever is left (typing) goes. Until then the removed shot's wires stay held off, so no wire is drawn from a missing port.
- **L2.** A shot put back gets its wires from the canvas's own record (`takenWires`), and its port's value from the backend's last outputs or the removal's step, whether or not `/api/graph/export` answers.
- **Naming (GM r6, both multi-delete lines).** `nodeNameList` in errorCopy (same name and rule as fix/agent-presence-followups' helper): up to 3 named, the same title grouped with a count, a count from 4 nodes, no ids. It is used by:
  - `runLockedLine`: "Couldn't delete “Brief” and “Note”. Wait for the active run to finish.";
  - `deletedNotice`: "Deleted “Temp 2” and “Temp 3”. “Ref scene” wasn't deleted because “Shot 1” is still running.";
  - `scenesKeptLine` (2-3 kept scenes; 4+ stay "4 scenes").
  - A single delete keeps "Deleted the node." (signed off). Titles come from the card label, else the model's name, never the id.
- **N1.** Delete with only wires selected during the tab's run: "Couldn't delete the connection. Wait for the active run to finish." / "Couldn't delete 2 connections. …" (`runLockedWiresLine`). The Canvas key handler now passes wire-only selections to `deleteSelected`.
- **Found by the live check: a kept scene lost its wire.** A multi-select Delete of a scene that another window's run was rendering, plus two Text nodes, kept the scene but deleted the wire into it, on the backend too. React Flow sent the selected nodes' wires as their own DELETEs before the scene's 409 came back. Canvas's `onBeforeDelete` now hands React Flow only wires between nodes that stay (`wiresDeletedWith`). A deleted node's wires go with its own DELETE (the backend removes them) and the canvas prunes them when the node goes, so a node the backend keeps keeps its wires.
- **Money.**
  - The "+ unpriced" chip and its tooltip follow GM r6/r7 (`lib/unpricedCopy.ts`). There are no colons, one sentence per reason, "The priced part of this run costs up to $X." first, and the reasons grouped with the name helper, ordered by where each reason's first node sits on the canvas (left to right, then top to bottom).
  - The missing-key line names the key as the node's own route line does ("its fal.ai API key").
  - Found live: a node whose only listed price is on one provider (Seedream, BytePlus only) read "has no listed price" when no key was set, because it fell back to fal.ai. With no key for any of its providers it now reads the missing key ("can't be priced until their BytePlus or fal.ai API key is added."). With a fal.ai key alone it still has no listed price.
  - A $0 low end reads "Up to $0.43". Detail lines write each end in full. A high end below the low end shows only the low end. Amounts above $10,000,000,000,000 read as more than that on both sides (N4, `CEILING_USD`), up to the float max.
- **M2 (backend lane).** `test_money_fuzz_parity.py` reads each amount from the fixture, so Linux and macOS check the same floats. The only libm call left in the formatter is `log10`, and a ±1-ulp perturbation over every fixture amount and each power of ten changes nothing. The carry check's `pow` was replaced by an integer check.
- **L3 (backend lane): stray ports.** A stray `shot_<id>` port moves to a renumbered shot whose image matches, and its wires follow (import, project open and save, `CLIGraph.load`). A port or wire still dropped is reported in the load's `warnings`, as `droppedPorts` on `canvas.replaced`, and in the Agent log for agents. Project open still drops a port nothing can take back (a switch clears the undo stack), but now says so.
- **L4 / nits (copy lane).**
  - `headedLine` is by role. A quoted heading with a different verb keeps both, and the ratchet is wider.
  - L5: each distinct error is logged once.
  - The rest: the wire-only Delete line, the tooltip's period, `isNamedLine`'s verbs, the studio's Agent log line, missing vs. damaged (`problem()` returns `state: 'missing'` for a missing node).
- **GM r7 item 2.** The Cinema scene card and the card boundary use the selected style every card has, in their category colour. The breathing animation is untouched. `.remotion-node--selected` is still orange; that predates this PR and is left for GM.
- **Offline (GM, #198 round 5 and #200 r2 item 4).**
  - `lib/useBackendOffline.ts`: `offlineReason(verb)` ("You can <verb> when Nebula reconnects."), `OFFLINE_RECONNECT_FALLBACK` ("This works again when Nebula reconnects."), `offlineTitle`, and GM's verbs as named constants (`OFFLINE_VERBS`) for #200 to use.
  - The Cinema studio is locked offline, each control with its verb:
    - Generate shot, Generate N and Generate all: "generate";
    - Send to motion: "send it to motion";
    - + Add shot: "add shots";
    - the arrows (and Alt + arrow keys, and a drag): "reorder shots";
    - ×: "remove shots".
  - The prompt is read-only with no tooltip. A variation pick, a reference's ×, an upload's Retry, the scene settings and the shot's references and art direction (one `fieldset.cinema-offline-lock` each) read the generic line.
  - Every locked control looks locked (GM's merge check): the label at 55% of the ink, the outline at 12%, no fill or accent, and no extra dimming on top. Checkboxes, swatches and sliders keep the fieldset's dimming.
  - Run history stays live, since it shows the runs already loaded and opening it needs no server.
  - Create's and Remotion's offline actions don't use the tooltip yet (deferred by GM: "offline tooltips elsewhere through #198's helper").
- **Tests that failed first, on 4cc05ab2.**
  - Store (`graphStore.fix5.test.ts`): 22 of 24.
  - Money: 32 of 38, plus the Seedream missing-key case (1 of 1, on this round's code before its fix).
  - Copy: 46.
  - Offline: 9 of 9 (the helper's import fails on the base; 8 of 9 with the helper alone). GM's verbs and the locked look were added after his ruling.
  - The kept wire: 3 of 3.
  - Backend `test_pr198_fix5.py` and the extended fix2/fix3 cases: 36 failed, 54 passed. The new fuzz form, the ±ulp test, the table-rows check and `params_outdated` passed from the start.
- **Gates.**
  - Backend, full suite (backend lane): 11,539 passed, 71 skipped, 0 failed (32:28). Its first full run had 7 failures from this round, all fixed: "wires" in new MCP docstrings, the import guard's exact sync call, and its own journal cursor.
  - Vitest, full run: 476 files, 6,392 passed, 0 failed, no timeouts.
  - Focused files and the errorCopy ratchets: 26 files, 898 passed.
  - `tsc -b` clean. Lint clean (inline-style guard, Slava CSS scope guard, eslint).
  - Vite build OK; budget 407,410 bytes raw / 123,207 gzip (limit 512,000).
- **Live check** (8797/5797 with `VITE_NEBULA_BACKEND_PORT=8797`, isolated state, 1280 and 1440, a fake cinema-scene handler that holds per call, nothing paid): 29/29, 0 blocked attempts after the canary.
  - Own run: "Couldn't delete “Brief” and “Note”. Wait for the active run to finish."
  - Another window's run: "Deleted “Temp 2” and “Temp 3”. “Ref scene” wasn't deleted because “Shot 1” is still running." with Undo. The scene keeps its wire (the bug above). The selected scene card is no longer #FF5A1F.
  - The chip: "Up to $0.43 + unpriced", tooltip "The priced part of this run costs up to $0.43. 7 nodes can't be priced until their BytePlus or fal.ai API key is added."
  - The partial revert: the backend's line alone, Shot 2 back with its image and wire, the typing saved, no later PUT drops Shot 2; the same after a refresh.
  - H1: after the refusal and the run, Cmd+Z undoes the Brief edit, and Shot 2, its image and its wire stay on the tab and the backend.
  - Offline: every Cinema control above locked with its verb and the locked look (computed: label alpha 0.51, no fill, opacity 1).
  - Harness notes: a node's next fake call isn't always 1 (Ref scene's run runs Agent scene upstream), and a same-input shot run is a cache hit that never reaches the handler, so H1's repro has an agent edit Shot 2's prompt first, as review 5's did. A refresh right after an edit gets "Leave site?" while the autosave is pending; it saves within 20 s.
  - Screenshots: `fix5-*.png` in the scratchpad.
- **Awaiting GM (placeholders).**
  - `sceneSaveCopy.ts`: `UNSAVED_MARK` ("Not saved"), `CHANGED_ELSEWHERE`, `SWITCHED_UNNAMED`.
  - `unpricedCopy.ts`: `PRICED_PART.free` and `.over`, `OVER_TITLE`, `MISSING_KEY`'s plural, `MISSING_KEY_UNNAMED`, `ROUTE_CANT_RUN`, `AWAITING_INPUT`'s plural, `SIZE_UNREADABLE`, and the left-out lines (one neutral line for "input images", "thinking tokens" and "input media and thinking tokens").
  - Backend (`main.py`): `STRAY_SHOT_PORT_DROPPED`, `STRAY_SHOT_PORT_AND_WIRES_DROPPED`, `STRAY_SHOT_WIRES_DROPPED`, and the Agent log's "…and N more" line.
  - `params_outdated` (above): no line until GM decides.
  - The provider is "fal.ai" (Settings' own name), not GM's "fal". The Run button is never disabled for a missing key, so the tooltip's missing-key line agrees with the node's route line instead.
  - The Cinema scene card's header reads "Cinema Scene", never its label, so “Ref scene” in a toast names a card the person can't find by that name.

## Merge with main (#195)

origin/main at cd593dea (PR #195, agent presence) merged into e43d6bd2 (fix round 5). 25 files conflicted. Rule throughout: both PRs' behaviour stays; where both gate the same control, both apply.

- **Backend fence and coded refusals (main.py).** `_check_workspace_revision` keeps #195's canvas-revision check (`X-Nebula-Canvas-Revision`, the filed-canvas epoch) and both of its 409s now go through #198's `_workspace_moved_refusal`, so a tab refused for a cleared or replaced canvas gets `code: workspace_moved` with `project` and `switchedBy` (the docstring already listed "cleared or replaced"). The fence middleware keeps #195's `FENCE_BEFORE_ROUTE` gate and #198's body with the CodedRefusal's fields. #195's no-project 409 (a tab write with no workspace revision) stays code-less: the scene save reads it as "anything else". `_note_canvas_change()` (#198) runs after #195's canvas moves in a clear (after `_forget_canvas_undo` and `cli_graph.clear()`), an import (after `advance_epoch` and the commit), and the open project's delete (after `restore_epoch`'s guarded commit), so `switchedBy` names the canvas the change made.
- **Run routes.** `/api/execute`, `/api/execute-node`, `/api/cinema/generate-shot` and `/api/graph/run` carry both `@graph_write` (#195's marker, read through `functools.wraps`) and `@_admits_cinema_renders` (#198). `_note_scene_renders` moved after #195's `_skip_placeholders`, so a run protects the scenes it renders, never an agent's placeholder it skips; a shot run whose scene is itself skipped returns before anything is noted. #198 added no routes, so #195's fence walk covers all of them.
- **Cursor bubble (`update_graph_node`).** Both PRs rewrote it. Kept #195's `_set_words` rule (GM r16-r18: card labels in card order, "Changed N settings" from 3, the Agent log naming an unlabelled field by its key, only the keys that changed) and #198's: the Replicate fallback (`_card_label` reads `universal_ports.setting_label`, "Set “Guidance scale”"), the words computed inside `_show_agent`'s guard (N2), the did-fallback log line, and an empty PUT that says nothing (N4, so `test_connected_copy` keeps #198's form). **A choice:** a universal node's extra provider param that no definition or `dynamicParams` names (FAL, OpenRouter, Nous) is never logged by its key; a change that is only those reads #198's "Changed a setting on “<node>”" / "Changed N settings on “<node>”" (GM pr198 r1 item 7, the later ruling for that exact case). A field the card does name but hides keeps #195's raw-key log. Mixed FAL changes log the labelled part only ("Set “Endpoint”"). `log` rides on the event only when it differs from `say` (#195). MCP-SETUP.md says all of it.
- **Name lists.** #198's `errorCopy.nodeNameList` is the one helper (up to 3, same titles grouped, a count from 4, canvas order, no ids). #195's own hand-built lists now call it: `deleteCopy` (no-answer and server-error delete lines), and `placeholderRunConfirm` (the moved-rows line and the replay line). Same output except same-titled nodes now group. #195's failed-save setting counts (`savingCutOff.settingsOnOneNode`) are settings, not nodes, and stay; `paramSaveFailedLine` takes them and keeps #198's unnamed-setting form (a null name counts). The old `runScope.nameList` (unquoted, "and N more") is from before both PRs and is left.
- **Undo (graphStore).** #195's held-press machinery (`stepHistory` → `holdsHistory` / `applyHistory`, `stepsInFlight`, `removedBy`, `stepAdds`, landings) is the base. #198's rules sit inside it:
  - the run lock: an undo or redo while this tab runs anything shows GM's line (`refuseRunLockedStep`, which previews the step without `captureOwnAdd`), from `stepHistory` and from a held press that comes due mid-run (`applyHistory`), never silently;
  - a step that would take away a rendering shot is refused in `applyHistory` after `withoutRemovedAbove`, before anything is sent;
  - a refused restore (`sendRestore`'s `refused`) reads `headedLine` and keeps live shot spinners (`withLiveRenders`) in both of #195's branches (on top, and W5's newer-step revert).
  - #198's numbered steps (`stepSeq` in the store's `set` wrapper) and `restoreShots` patch steps in place, so #195's identity-keyed maps (`stepAdds`, `removedBy`, `arrivedSince`) still hold; a removal step `restoreShots` drops from both stacks is one a held press then treats as "taken off" (skipped, never misapplied). The backend's epochs are untouched by a scene refusal: a refused PUT changes nothing there.
- **Graph sync.** #195 moved the node merge into `mergeSyncedNode`. #198's `backendScenes` / `scenesChangedHere` bookkeeping runs before #195's held-node early return, so a held node still records what Nebula has; `reconcileSceneEntries` runs after the merged `setState`.
- **Deletes.** #195's optimistic delete (`changeCanvasNodes`, the node leaves at once and comes back on failure) takes #198's rules: the run lock says why (`refuseRunLockedDelete`, also in `deleteCanvasElements`, with the wires-only line); rendering scenes are held out (`withoutRenderingScenes`; a step taken only for them is cancelled); a scene the backend keeps (`renderingRefusals`) is named in the kept line after "Deleted …", and its reason isn't reported twice; the deleted notice names nodes through `nodeNameList` in the order they were removed (#198's own order, which its Create Studio test pins: the result first, then its upstream node; sorting by canvas position flipped that). A kept scene's wires come back through #195's `putBackFailedDeletes` (from the step's edges), and `deleteCanvasElements` never sends a deleted node's wires separately, so #198's kept-wire fix holds on the Delete key path too. The Canvas Delete key is #195's handler; during a run it calls `deleteSelected` (#198's line) instead of returning silently, before it reads React Flow's selection, and #198's second Delete branch went (unreachable). #198's test that "with no run, the key is React Flow's" no longer holds (React Flow's `deleteKeyCode` is off since #195): it now checks that the key deletes the selection with no run-lock line, and its React Flow mock gained `getNodes`, `getEdges` and `setState`. `onBeforeDelete` keeps #195's modal check and #198's `wiresDeletedWith`. #198's local `nodeTitle(nodes, id)` collided with directRoute's `nodeTitle`; it is `listedNodeTitle` now and reads the card's canvas title.
- **Lock plus offline (components).** `lib/canvasLock.lockedAction(lock, own, { verb, neutral, offlineTooltip })`: #195's `lock.act` (following and offline, GM's wait line) plus, offline and not following, #198's `offlineReason(verb)` tooltip and, with `neutral`, `data-offline-neutral`. Cinema uses it with GM's verbs (Generate shot / N / all, add, reorder, remove shots, send to motion, the generic line for the rest); the fieldsets lock on `lock.locked` with `lock.mark`, so following locks them too. Create's Generate and Remotion's adds, order and Delete use it with `offlineTooltip: false` (GM deferred those tooltips) and keep their neutral look; REC, Export and Render MP4 keep #198's `offlineAction` (#195 leaves them enabled while following). The context menu, the selection toolbar and the Inspector compose #195's lock with #198's rendering-scene hold and `RUN_LOCK_REASON`. The video editor's tools take #195's lock (Trim, Speed and Vol keep #198's offline-only gate, as #195 left them unlocked). `EditorTransport` and `RemotionEditorToolbar` read offline as `lock.offline`, not `useBackendOffline()`, for #195's one-source ratchet (round22Surfaces); #198's `useOfflineHiddenNotice` is offline-only (no canvas edit) and joins that ratchet's allowlist. #195 had no offline tooltip of its own, so nothing else needed routing through `OFFLINE_VERBS`.
- **Smaller ones.** The scene card carries both #198's category colour and #195's `data-pending`; CSS took the one time-column rule; `agentLogStore` and `wsClient` read `log ?? say` (both had it); `runScope` keeps #198's unpriced reasons and #195's `ids`, `repeatRun` and placeholder notes; `projectStore` keeps #198's `lastSavedThere` / `wayBackIn` and #195's cut-off handoff and `latest()` actor; MCP `open_project`'s docstring has both paragraphs.
- **Ratchets after the merge.** #198's `pr198Fix2Ui` "one helper" check accepts `lockedAction(` as well as `offlineAction(` (it applies the same offline title and neutral mark). `errorCopy.namedLine`'s reviewed list gains #195's three hand-built lines: `canvasFollow`'s run and Create following lines (the tail is GM's fixed "<agent> is opening “<project>”.") and `deleteCopy`'s no-answer line (a fixed tail). The `onBeforeDelete` comment got shorter so `pr198Fix5KeptWire`'s 600-character check still finds `wiresDeletedWith(`. The backend docs sweep forbids "wire" in prose: #195's new MCP-SETUP.md and SKILL.md paragraphs say "connection" instead (eight words).
- **#195's tests on #198's forms.** #198 writes both ends of a price range in full (GM r6 item 3, "$0.0047–$0.43"); #195's placeholder-dialog tests (round 5, round 6) expected "$0.0047–0.43" and now read the full form. #195's round-23 save test with three keys expected the raw keys "prompt" and "seed"; #198 never shows a raw key (an unlabelled setting counts), so it reads "Couldn't save 3 settings for “Banana”.", as #198's own test of that case did.
- **Gates.** Backend: 11,983 passed, 71 skipped, 2 failed (the docs "wire" sweep, fixed after; that file then 72 passed). tsc -b and lint clean. Vitest, one full run under load 20-27: 7,238 passed, 279 failed (176 of them 5 s timeouts); the 55 files rerun alone with 4 workers: 868 passed, 10 failed; the 3 real ones fixed (above) and those 9 files rerun: 147 passed. heldUndo.property.round17 passes alone (9 tests, 760 s). Build: 417,142 bytes raw entry, under 512,000.
- **Not changed.** #198's banner row and its studio placement (main didn't touch it); #195's disabled styles; both sides' tests, with `test_connected_copy`'s empty-PUT line on #198's form as above.

## Fix round 6 (GM's pr198 r8 rulings, the merge regression shots)

- **Toasts never cut a sentence (GM bug).** On the merged build the canvas's undo toast already wraps: #195's round 22 made `.canvas-undo-notice__text` `white-space: pre-line` with `overflow-wrap: anywhere`. The live check shows the other-window multi-delete line on two lines at 1280 and 1440, not clipped. Round 5's cut shot was from before the merge. Four other toasts still cut their text to one line with "…", and they now wrap:
  - Projects' toast (`.project-home__toast-text`);
  - the asset trash's (`.asset-trash__toast-text`);
  - the moodboard board's lines (`.moodboard-board-toast__line`);
  - the "Agent log hidden" notice (`white-space: nowrap` dropped).
  - A ratchet in `tests/pr198Fix6Copy.test.ts` reads every stylesheet and fails on any toast or notice rule with `text-overflow: ellipsis` or `white-space: nowrap`. A toast's own buttons (action, ×, "Back to …") are exempt.
- **Offline arrows (GM check).** Nothing changed. Measured live, offline, the shot ← → and × have the same label colour as Generate shot: ink at 55% (alpha 0.507, `color-mix(--sr-ink 55%)`), opacity 1, no fill. They look brighter because they sit on the rail's lighter surface (rgb 33,33,37), and Generate sits on black. Measured from the pixels:
  - the arrows' glyphs are rgb 146 with contrast 5.1–5.2 : 1;
  - Generate's label is rgb 129 with contrast 5.4 : 1.
  - The tooltips are "You can reorder shots when Nebula reconnects." and "You can remove shots when Nebula reconnects.".
- **params_outdated: not built.** Checked live, with the backend switched to params version 2 while the tab was open and back to 1 after the copy was made, as a real update's reload would find it. The result:
  - The recovered copy is named as #199 names it: "<project> (recovered)".
  - It doesn't hold the person's edits. Cinema saves each keystroke at once (`updateScene`, no debounce). So the first keystroke after the update is refused, and the tab captures the canvas at that moment. That is one character of the typed text (the copy's prompt read "a"). The tab then leaves for Projects, and the rest of the typing is lost.
  - The tab reloads by itself, so no one would see a "Reload Nebula" button. After the reload it lands on Projects, listing "<project>" and "<project> (recovered)". Neither is opened, and nothing says which one holds the edits.
  - So GM's line ("Reload Nebula and they'll open in a recovered copy of “Alpha”.") would be untrue. Nothing was built for it, and there is no fallback line. The scene still adds no line of its own for `params_outdated`.
- **GM's words for round 5's placeholders.**
  - `sceneSaveCopy.ts`: `SWITCHED_UNNAMED` and `CHANGED_ELSEWHERE` are verbatim. "Not saved" (`UNSAVED_MARK`) is now a small label in the scene card's header, after its name, with the cause's toast sentence as its tooltip.
  - **CHANGED_ELSEWHERE changes behaviour.** Before, a newer edit from elsewhere replaced the kept edits on screen. GM's sentence says the opposite ("your changes are kept on screen but not saved"), so now the person's edits stay on screen, marked "Not saved", and the line shows once. Nothing sends them by itself: no retry, and no resend on a sync. The builder's choice, for GM: the person's next edit to that scene saves it as they see it, which overwrites the other window's change. The words say "another window" even when an agent made the change.
  - `unpricedCopy.ts`, all verbatim:
    - the plurals;
    - `MISSING_KEY_UNNAMED` ("…until its API key is added.");
    - `ROUTE_CANT_RUN`;
    - `SIZE_UNREADABLE`;
    - the three left-out lines, grouped by cost with the name helper.
    - Builder's wording, for GM: the plurals of GM's singular lines ("as they're set up now, so they have no price", "priced by their input sizes", "their input images", "the models' thinking"), and an unknown `plus` read as "may cost more for its <plus>, …".
  - A free priced part has no line, so the tooltip starts with its reasons. A summary with no reasons recorded names its unpriced nodes as "has no listed price", so the chip always has a tooltip.
  - **"Ceiling" isn't a price cap.** `CEILING_USD` ($10,000,000,000,000) is Nebula's display limit for amounts. So `PRICED_PART.over` and `OVER_TITLE` stay placeholders, and GM's "“X” may cost more than $Y." isn't used.
  - The studio's Agent log line for damaged data names the studio: "Couldn't open “X” in Cinema, node n4. scene.base is missing." A canvas card's line doesn't.
- **STRAY_SHOT (backend).** One line per node, in GM's words:
  - "Removed the connection to shot port s2 on “Scene”, node n4. That shot no longer exists."
  - "Removed 3 connections to shot ports on “Scene”, node n4. Those shots no longer exist."
  - Opening a project (the load case) adds "while loading the project" before the first period, with no comma, as GM wrote it. A graph-file import doesn't.
  - Builder's choices, for GM:
    - <port> is the shot's id ("s2").
    - Several connections from one port read "Removed 2 connections to shot port s2 … That shot no longer exists."
    - A port dropped with nothing connected has no line. It is still in `droppedPorts`.
  - The Agent log says up to 5 node lines, then one line for the rest: "Removed 7 connections to shot ports on “F”, “G”, “H” and 4 more while loading the project. Those shots no longer exist." (`quoted_overflow`, no serial comma).
  - MCP-SETUP.md and SKILL.md say this.
- **Canvas order (GM, #200 r2 item 3).** Both multi-delete lines name nodes in the order the canvas holds them, as #200's `inCanvasOrder` does (the node's index in the store). This covers:
  - "Deleted …";
  - the kept scenes after it, including scenes the backend kept;
  - "Couldn't delete … Wait for the active run to finish.".
  - #198's Create Studio test now reads "Deleted “Text Input” and “Nano Banana”.".
- **Rerun offline.** Run history's Rerun and "Rerun with latest source" read "You can rerun it when Nebula reconnects." (`OFFLINE_VERBS.rerun`). Retry failed and Recover read the generic line.
- **Both locks in one toolbar (merge check).** The selection toolbar's Run, Duplicate, Arrange and Delete read the run lock's reason ("Wait for the active run to finish.") while the tab's own run goes, even while following. Ask and Note read the follow lock's. Before, `lock.act` let following's title win. Run and Arrange had kept their idle titles while locked by the run.
  - Found live: the backend refuses an agent's project switch while the person's own run goes (409). So the tab only reaches both locks at once in a race. The shot sets the follow lock the way the tab does when it sees a switch.

Gates, fix round 6: full backend 11,997 passed, 71 skipped, 0 failed. Full vitest under load: 57 failed / 7,481 passed across 28 files, 45 of them 5 s timeouts. Rerun of those 28 files alone, serially: 416 passed, 1 failed. That one was real: `graphStore.cinemaPersistence.test.ts` still expected an outside edit to replace the edits kept unsaved, which is the old behaviour. It now expects them kept on screen (GM r8 CHANGED_ELSEWHERE) and was renamed to match; it passes with fix3 and fix6.

## Fix round 7 (PR #198 review 6, GM's pr198 r9 decisions)

- **H1, a replaced canvas.** An agent's clear or an import of the same project now hands every kept scene entry to #195's cut-off report (`sceneSavesNow`, one save per scene, setting "Scene"), then clears the entries. No old scene is ever PUT onto a new canvas's node: the scene flush refuses to send while an entry reads `replaced`, and a `canvas_replaced` refusal settles the entry as kept and reads Nebula's graph again (3 s fallback) so the report takes it. With an agent, #195's typing line names the scene; with none, the edits go into the recovered copy as #195 does.
  - A reconnect cuts nothing off (coordinator's change to H1). Editing is paused while offline; on reconnect the stopped retries are kicked and the kept edits re-send. A cut-off line shows only if that re-send is refused, and then it is that refusal's own line. A reconnect that brings a different canvas (project or canvas revision) never PUTs the old scene: the backend's fence refuses it with `canvas_replaced` or `workspace_moved`, and the edits are named or kept.
- **H2 (GM r9 decision 2, option b).** Each scene entry keeps a `base` (what the backend had when the edits started, moved on each saved write) and a change from elsewhere is rebased three-way, per field and per shot (`lib/cinemaSceneMerge.ts`).
  - Nothing overlaps: merged and saved without asking. Shots added elsewhere stay; a shot the person removed that the other side changed comes back.
  - A clash keeps "Unsaved" and shows GM's line with [Keep mine] and [Use Codex's] (no agent: [Use theirs]). It has no dismiss: it stays until the person chooses. The Unsaved mark's tooltip is the same line.
  - Until the choice, saves go on top of the backend's scene, with the clashing field as the backend has it. The next edit never overwrites the other change silently.
  - Own echoes: a graphSync built before a save committed can arrive after its HTTP answer. The entry waits up to 2 s (`SCENE_ECHO_WAIT_MS`) for its own echo before treating a different scene as a change from elsewhere, then reads Nebula's graph again (`rebaseFromBackend`).
  - Builder's choices, for GM: an ORDER clash (both reordered differently) and a PRESENCE clash (the other side removed a shot the person changed) are clashes like any field; Keep mine keeps the person's order or shot, Use theirs takes the other side's. Use theirs on a removed shot drops the shot with its wires.
  - Known edges: a rebase adds no undo step, so a Cmd+Z right after can put back the scene from before the merge. The card's shot count and scene follow the merged scene.
- **Outdated settings, complete.** The copy holds the latest state: what was on screen when the canvas left. The snapshot and the move to Projects are one step (`preserveWorkspaceConflict`), so no keystroke is accepted and then dropped; checked live at 120 ms a key against a trace of the prompt on screen (review 6 L1 had the 5 ms harness keys outrunning the first round trip). With edits in a recovered copy, Nebula no longer reloads by itself: `handleParamsVersionChange` sets the line and [Reload Nebula] (`errorRetry: reloadForUpdate`) on Projects, where #199's stop already puts the tab, and waits. The copy's id is remembered in sessionStorage (`nebula:recoveredForUpdate`) before the line shows, so a reload that comes anyway still opens it. After the reload, `initialize` opens the copy directly and shows GM's notice "These are the changes Nebula couldn't save before it updated. They're in “X (recovered)”."; a copy that is gone shows the notice on Projects. About 90 non-test lines (projectStore.ts and ProjectHome.tsx), under the 300 line stop.
  - Builder's line, for GM: "Couldn't save your changes because Nebula was updated. Reload Nebula and they'll open in a recovered copy of “X”." (GM r8's line without the scene name: the copy holds the whole canvas).
- **M1.** A clear or import of the same project refuses with its own 409 code, `canvas_replaced` (`_canvas_replaced_refusal` in main.py, with the same `project` and `switchedBy` as `workspace_moved`). Another project opened stays `workspace_moved`. MCP-SETUP.md's table and `mcp_server.py`'s docstring say both. The scene save shows no line of its own for it; #195's line covers it.
- **M2, N1, N2: one run lock.** `lib/canvasLock`'s `act(own, { run, runTitle })` orders the reasons: run, then follow, then offline, then idle. Where the run's line wins there is no following mark (`data-following-disabled`), so the control never looks follow-locked. Callers say whether the run holds them (`isExecuting`, or `runStarting` too for Run), so cards that draw no run lock don't re-render when a run starts. Wired into:
  - the selection toolbar, and Next step on the card and in the toolbar;
  - the Canvas actions panel (Load, Import and Clear keep the panel's own blocked reason as their run title; Arrange);
  - the context menu (Run This Node, Duplicate, Delete) and the Inspector (Run, Duplicate, Delete) really use it;
  - run history's Rerun and "Rerun with latest source" (L6), the shot rail's × and Generate all;
  - the store gate: during this tab's run, the Delete key and Cmd+Z/redo say the run's line before following or offline (`RUN_LOCK_FIRST`).
  - Run history's run line is now RUN_LOCK_REASON ("Wait for the active run to finish."), not "Wait for the run to finish first.".
  - The clash prompt's buttons read the lock too (a choice saves).
- **LOWs.** L2: a server error is retried 8 times on a timer, then stays "Unsaved" with GM's line; a sync, a reconnect or the next edit sends it again. L3: Undo during a rendering refusal settles cleanly (no late line, no stale mark). L4: a repeated refusal line isn't toasted twice. L5: "You switched to “B” in another window first." when the person switched. L7: the Agent log sets `--agent-log-clearance` while docked at the right edge and low enough; the notice region's right edge keeps clear of it. L8: "Unsaved" on its own row under the header; the header (always "⛭ Cinema Scene") stays on one line with an ellipsis.
- **GM r9 bugs and wording.** The "Delete:" prefix came from round 6's live harness, which wrote it into the tooltip capture box, not from the app; a ratchet (pr198Fix7Ui) checks every selection-toolbar title in each lock state and the toolbar sources. Unpriced reasons go one per line under the priced part's line. The ceiling has no line (no tooltip on a closed chip past it). "They're kept and Nebula will try again." and "They're kept and will save when the run finishes." are verbatim.
- **N5.** The pin-check listener test's bound is 30 s on the fake clock; the fake clock ends it, so the bound only catches a hang.

Gates, fix round 7: tsc -b and lint clean. Focused vitest (230 files: every test file changed since 4cc05ab2, the lock and errorCopy suites, round21Store/Lines, the new ones): 3,812 passed. Backend: fix5/6/7, round19/20/21/22 fences, mcp_channel, the copy sweep and MCP-SETUP readers: 455 passed. vite build plus the budget: 418,989 bytes raw.

Live, fix round 7 (isolated backend 8797 with the free fake cinema handler, Vite 5797, 8000-8010 and 5173 blocked; no attempts reached them): every check passed across the runs.
- An agent's clash and another window's clash each showed GM's line and the two buttons. Before the choice the backend held the other side's value. Keep mine saved mine; Use theirs showed and kept theirs. In each case the prompt and the mark went.
- Edits with no overlap merged and saved without a prompt.
- "Unsaved" sat on its own row with the header on one line.
- With both locks and "Next step" selected, its native title read "Wait for the active run to finish.", with no following mark. No toolbar title had a "Word:" prefix.
- A 3-line toast at 1180 sat clear of the docked Agent log (`--agent-log-clearance: 364px`).
- Outdated settings: there was no reload until [Reload Nebula] was clicked. The copy opened with GM's notice, its id unchanged, and it held exactly what was on screen when the canvas left ("a quiet", at 120 ms a key, with the first refused PUT held 0.8 s).
- Builder's harness bug: round 6's "Delete:" tooltip prefix came from the harness. This round's capture box shows the attribute as it is.

## Fix round 8 (PR #198 review 7, GM's pr198 r10 and r11 answers)

- **H1, order clashes.** `withFields`'s ORDER branch took a shot by index from a list it was rewriting, so a clash could duplicate one shot and drop another. It now takes each id once per slot (`lib/cinemaSceneMerge.ts`). Use Codex's and Keep mine both work on an order clash. A 20,000-seed fuzz with reorders (`tests/lib/cinemaSceneMerge.fuzz.test.ts`, 145 order clashes) holds every invariant. A merge that throws no longer drops the sync it came in: `guardedSceneMerge` keeps the card's scene, and `mergeInto` turns a throw into a whole-scene clash (`WHOLE`) so the person chooses.
- **H2, conditional scene writes.** Every scene has a `sceneKey` (`backend/services/scene_keys.py`): a hash of its authoring, without the shots' runtime. Export, snapshot, `GET /api/graph`, each graphSync and each save's answer carry the keys (`sceneKeys` is left out when the canvas has no scene, so those answers are unchanged without one). A `PUT /api/graph/node/{id}` with a scene is checked against its `ifSceneKey`. If the scene changed since, it is refused with 409 `scene_changed`, carrying the scene Nebula has now, its key and `changedBy`.
  - The canvas sends the key of the scene its edits started from on every save. On `scene_changed` it merges three-way and sends again silently, or shows the field clash line. It never shows "Couldn't save", and the refusal doesn't count toward the 8 retries (GM r11). A loop guard (20 refusals in a row) settles it as kept.
  - Its own echo clears its echo wait by key. A per-node sync sequence stops a save's answer from overwriting `backendScenes` with an older scene when a sync stored a newer one while the save was out. A foreign scene that arrives while a save is out (`deferred`) is merged when the answer lands.
  - The agent rule is symmetric (builder's decision, for GM). An agent's write is checked against its `ifSceneKey`, or else against the scene that agent last read: the export, the snapshot, `GET /api/graph`, or its own last write. An agent that never read the scene is the last writer, as before. Reads and writers are kept per canvas (the graph object plus project and canvas epoch), and a clear, import or switch forgets them. MCP-SETUP.md (a new subsection and a row in the code table), SKILL.md and `mcp_server.py`'s docstring say so.
- **M1 (GM r10).** While a clash waits, no retry runs: the timer is cleared, and the retry toast whose text is the kept line is removed. The "Unsaved" tooltip is the clash line. After Keep mine the save goes; if it fails, the normal retry line shows once.
- **M2 (GM r11 answer 4).** When the other side removes a shot the person is editing, its wires are held on the card while the choice waits (`notePresenceWires`). `applyGraphSync` now reads the wire holds after the nodes merge, so a merge's hold counts in the same sync. Keep mine keeps them held until the save lands, then sends them (`restorePresenceWires`). If every wire comes back, nothing is said. A wire whose other end is gone, or whose single-connection input now holds another connection, stays off, and the line says "“Shot 2” is back without its connection to “Edit A”.". A restored wire never replaces one Codex made. Use theirs drops the shot and its wires.
- **Lines (GM r10 answer 3).** The reorder and removal lines are verbatim, and their another-window forms follow the same pattern (`sceneReorderedLine`, `shotsRemovedLine`). Builder's plural: "“Shot 2” and “Shot 3” were removed…". L1: a clash keeps its author unless the new change also clashes, and two different authors read as "another window".
- **L2 (GM r11 answer 3).** After 8 timed retries saving stops, with "Couldn't save your changes to “Opening”. They're kept and Nebula will try again with your next change." and [Try again] on the toast (`RetrySceneButton`, `retrySceneSave`; there is no popover on the mark). A sync sends nothing; the next change, a reconnect or [Try again] does. The offline suffix still wins. The toast leaves after its usual hold (about 8 s), as every notice does; after that the mark's tooltip keeps the line.
- **L3.** A reconnect sends a kept save at once and cancels its timer (`resendKeptScenes`, called only from the reconnect subscriber).
- **L4 (GM r11 answer 2).** If the recovered copy was deleted before the reload opened it, Projects says so. In Recently deleted, the line has [Restore], which restores and opens the copy with the usual notice. If it was deleted for good, the line has [Dismiss] only. That is the dismissable-notice case: after the reload the tab holds none of the edits (sessionStorage keeps only the copy's id and name), so there is nothing to apply. If the copy fails to open, the notice still shows, ahead of the open's own error.
- **L5.** "Rerun with latest source", run history's Forget and the deferred Run read canvasLock's order. They are in pr198Fix7Ui's ratchet. **L6.** `canvas_replaced` and `scene_changed` are in SKILL.md.
- **N1.** "Use Codex's" keeps the straight apostrophe this PR's lines use; #195's "Undid Codex’s edit" is curly. GM to say which one wins. **N2.** Cmd+Z after a merge undoes Codex's edit through #195's own step ("Undid Codex’s edit"), the same as with no refusal: a merge adds no undo step of its own.
- **Found while gating.** The first full backend run had 89 failures from two causes. (1) `sceneKeys: {}` on an empty canvas broke a test that compares the export exactly. That test failed before its World Labs cleanup ran, so the leftover paid state failed about 60 later tests. Fix: `sceneKeys` is left out when there is no scene. (2) Agent reads were keyed by node id alone, so a read in one test held a later test's `n1`. Fix: reads and writers are now keyed per canvas. SKILL.md's example also used `nebula set n4 --param …`, which isn't the CLI's syntax; it is now `nebula set n4 scene=…`.
- **For GM.** The [Try again] toast leaves after the usual hold (about 8 s) and an agent's "Codex changed the canvas" toast replaces it, since both use the one undo slot. After that, only the mark's tooltip, the next change or a reconnect remain. A popover on the mark would make the action last, if GM wants that.

Gates, fix round 8: tsc -b and lint clean. Focused vitest: 291 files, 4,684 passed. These are round 7's 230 files plus every test that touches the changed modules, and the new graphStore.fix8 (21), cinemaSceneMerge.fuzz (5) and L4/L5 tests. Full backend: 12,010 passed, 71 skipped. vite build plus the budget: 419,802 bytes raw.

Live, fix round 8: isolated backend on 8797 (fix8_server.py, the free fake cinema handler; the slow-put switch spares agents' PUTs), Vite on 5797, 8000-8010 and 5173 blocked, no attempts reached them. Every check passed on the final code. The full run passed 30 of 31; the one failure was the harness, whose own agent rename pushed out the stopped toast. The rerun passed 6 of 6.
- Order clash: GM's reorder line. Use Codex's saved s1, s3, s2 and Keep mine saved s2, s1, s3, on the card and on the backend, and the mark went each time.
- Remove clash: GM's removal line. The backend dropped the wire while the card still drew it. Keep mine brought back the shot and the `shot_s2 → Edit A` wire on both, with no toast.
- Clash prompt: the retry toast left. The "Unsaved" tooltip read the clash line. No PUT was sent and no line shown for 9 s.
- R7-A live: Codex wrote shot 2 while the tab's first save was held in the backend. One 409 `scene_changed` came back, the scenes merged silently, and both changes were saved. With the same field, the field line showed with no "Couldn't save", and Keep mine saved mine.
- Stopped after 8: exactly 9 PUTs, then GM's line with [Try again] and no more PUTs. [Try again] saved, and the mark and toast went.
- The recovered copy: deleted for good showed GM's line with [Dismiss] only; in Recently deleted, GM's line with [Restore], which restored and opened the copy with the usual notice.

## Fix round 9 (PR #198 review 8, GM's pr198 r12 review and r13 answers)

- **H-1, scene revisions.** `services/scene_keys.revision()` gives each scene a number. It stays the same while Nebula holds the same authoring and takes the next value as soon as Nebula holds another. The counter starts from microseconds since the epoch, so it keeps growing across restarts. The export, the snapshot, `GET /api/graph` and every graphSync carry `sceneRevs`; each save's answer and each 409 carry `sceneRev`. The tab keeps the highest revision it has seen per node (`staleSceneRev`):
  - A sync below it never touches the card or `backendScenes`.
  - A 409 below it rebases onto the newer scene the tab already holds.
  - A deferred sync whose revision is at or below the save's answer is dropped.
  - Revisions are noted for nodes the card doesn't show yet. Without that, the fuzz caught a late sync from before a node's first sync being applied.
- **M-3 (GM r13 answer 1).** `mergeInto` keeps a copy of each shot as it was before the other side removed it while the person edited it (`removedShots`). When the shot comes back, it is merged against that copy:
  - Back as it was: the person's edit stands, silently, and is saved.
  - Back with other text: the field line naming the shot, "Codex changed “Shot 2” while you were editing it." It stays one prompt, with its line replaced (`readded`, `clashLineFor`).
  - Keep mine keeps the person's text. Use Codex’s takes the re-added text.
  - This needed `baseRev`. A scene the tab knows by key (here, the scene from before the removal) used to be dropped as "known". It now counts as a new change when its revision is above the base's (`knownScene`).
- **M-1.** Project open, create and delete no longer call `scene_keys.forget()`. The scope (graph token, project, canvas epoch) already separates canvases; a clear or import moves the epoch. `forget()` stays for tests only. The MCP-SETUP line saying a switch forgets reads is gone.
- **M-2.** `_reader_agent()` returns a reader key, in this order:
  - `chat:<session>` for a verified token with a session;
  - `token:<hash>` for any other verified token;
  - `name:<name>:<X-Nebula-Agent-Session>`;
  - `name:<name>`.

  The MCP server sends its own `X-Nebula-Agent-Session` (random per process, or `NEBULA_AGENT_SESSION`), and the CLI sends `NEBULA_AGENT_SESSION` when set. Reads are bounded (4,096) and writers too (1,024).
- **L-1, builder's decision: a refusal is not a read.** The CLI prints only the detail, so its agent never sees the answer's scene. Counting the refusal as a read would let a blind resend of the old copy go over the person's typing. The CLI can't usefully send `ifSceneKey`: it is stateless, and the last-read already plays that part. GM's new detail ("Read it again and redo your change.") gives the CLI a path that works: `nebula look`, then `set`. Test: refused twice, a read, then 200.
- **L-2.** A PUT whose scene key equals Nebula's skips the check.
- **L-3.** `POST /api/graph/connect` takes `onlyIfFree`. When the input already holds a connection, it answers 409 `input_taken` before validation, and nothing changes. Keep mine's put-back (`sendRestoredWire`) uses it for single inputs, and a refused wire comes off the card. All the misses go into one `shotBackWithoutLine`. Without `onlyIfFree`, the real backend already refused a second connection into a single input (400); the reviewer's case was found on a fake backend.
- **L-4 (GM r13 answer 2).** Deleting a held wire (`applyCanvasEdgeChanges`, or a replace in `onConnect`) releases it locally (`releaseHeldPresenceWire`). There is no request and no line, and Keep mine doesn't send it.
- **GM r12 item 1 / r13 answer 3.** `stoppedScenes` follows `entry.stopped` (`setSceneStopped`). In that state the mark is a button (`SceneUnsavedMark`). A click opens a popover with the line and [Try again] (`RetrySceneButton`), in the toast's surface, anchored with `useAnchoredPopover`. Escape or a press outside closes it. The `title` tooltip is unchanged.
- **GM r12 items 2–4.**
  - "Use Codex’s" is curly.
  - Clash lines are one sentence.
  - `errorCopy.quotedNames` takes up to three quoted names, then a count ("4 shots"). It feeds `shotsRemovedLine` and `shotBackWithoutLine`; the targets go through `nodeNameList`.
  - The agent's refusal detail is GM's, verbatim.
  - An agent's refusal broadcasts nothing (tested: `api.sent` is empty).
- **GM r12 item 5.** The recovered copy's notices moved out of the red error box into their own state, `projectStore.copyNotice`. `ProjectHome` draws it as a toast in the notice region (`CopyNoticeToast`, `project-home__toast`, the same look as the restored copy's notice), with ×. The Recently deleted version adds [Restore] (`restoreCopyNotice`). The `restoreCopy`/`dismiss` retry actions are gone. A copy that fails to open still says the open's own error in the error box.
- **N-2, N-3.** MCP-SETUP says MCP has no scene write (`edit_canvas` answers 400) and that polling the export as an agent refreshes that session's read. It also covers the new `input_taken` row, `sceneRev(s)`, sessions, and that a write on Nebula's own scene is never refused. SKILL.md and the MCP docstring say the same in short.
- **N-4.** The 20,000-seed merge fuzz has a 60 s timeout.
- **Tests.**
  - Backend: `test_pr198_fix9.py`, 10 tests (H-1, M-1, M-2 twice, L-1, L-2, L-3, GM's detail with no broadcast, the docs, MCP's session).
  - Frontend:
    - `graphStore.fix9` (15): D1, D1b, a stale 409, stale syncs, the first-seen revision, M-3 four ways, L-3, L-4, plurals, the stopped state.
    - `graphStore.fix9.fuzz`: the reviewer's three-actor fuzz with a lagging FIFO socket and revisions, 12 seeds disjoint and 12 flaky (15% of saves fail), with invariants asserted.
    - `pr198Fix9Ui` (9).
  - Two MCP header assertions now include the session.

Gates, fix round 9:
- tsc -b and lint: clean.
- Focused vitest: 295 files, 4,715 passed. That is round 8's list, ArtDirectionNodes, and the three new files.
- Full backend: 12,020 passed, 71 skipped, with 2 failures. The 2 were MCP tests that pin the exact headers; they now include `X-Nebula-Agent-Session` and pass.
- vite build plus the budget: 422,959 bytes raw.

Live, fix round 9: 24 of 24 checks passed. The setup was an isolated backend on 8797 (`fix9_server.py`: the free fake cinema handler, plus the reviewer's lag-sync), Vite on 5797, and 8000–8010 and 5173 blocked (0 attempts after the canary).
- **H-1, lag-sync.** Syncs went out 0.7 s apart in order. Over 4 trials, Codex and Gemini each edited another shot while the person typed 24 keys. The card never jumped back, and there was no clash and no "Unsaved". All 24 keys and both agents' edits reached Nebula and the card. Review 8 had 2 regressions in 8 trials.
- **M-3.** Codex removed Shot 2 while I edited it, then put it back with other text. One prompt showed, its line replaced by "Codex changed “Shot 2” while you were editing it.", with [Keep mine] [Use Codex’s]. Keep mine saved my text.
- **L-4.** Deleting the held wire sent no request and showed no line. Keep mine brought the shot back without it, with no connect.
- **Plurals.** "Codex removed “Shot 2” and “Shot 3” while you were editing them.", then "“Shot 2” and “Shot 3” are back without their connections to “Edit P”."
- **Popover.** Saving stopped after 8 failures, then Codex's toast took the slot. The mark is a button, and its popover showed the line and [Try again]. [Try again] saved, and the mark went.
- **Agent refusal.** A 409 with GM's detail. No Agent log row, no toast, and the typing stayed. After a read, the redo was taken and its row showed.
- **Recovered copy.** Both notices are neutral toasts. The one for a copy deleted for good has × only; the one for a copy in Recently deleted has [Restore] and ×. Restore opened the copy with the usual notice.

## Fix round 10 (PR #198 review 9, GM's pr198 r14 review and r15 answers)

- **M-1: an MCP read guards a CLI or HTTP write again.** Round 9 split reads per session, so a write with no session found no read and went through unchecked. Now (`services/scene_keys.py`, `main._reader_agent`):
  - a read under `name:<name>:<session>` is also recorded under `name:<name>`;
  - a write is checked against its own session's read, and if it has none, against the name's, which is the newest read by any session of that name;
  - so a CLI write (no session) on top of an MCP read is refused when the scene changed since that read, and taken on a fresh one;
  - lanes that each send their own `NEBULA_AGENT_SESSION` stay apart, and a verified token (`chat:`, `token:`) is never the name's reader.

  MCP-SETUP, SKILL.md and the MCP docstring say when MCP and the CLI share a read: when both send the same `NEBULA_AGENT_SESSION`, or when the write sends none.
- **M-2: a save another writer refuses 20 times in a row stops, never silently.** It enters the stopped state (`stopSceneSave`): "Unsaved" with GM's stopped line, the toast and the mark's popover with [Try again]. The next change, a reconnect or [Try again] sends it again. A refusal with no key (a backend before round 8) is merged and sent once unconditionally, as the comment always said. Found live in this round: a sync that brings another writer's change no longer sends a stopped save (`settleRebasedScene`); the change shows on the card and the edits stay "Unsaved". Before, a busy agent paced a resend per sync.
- **M-3 (GM r14: the bar follows the card).** `ProjectWorkspaceControls` says "Unsaved changes" while any scene is in `unsavedScenes`, over the project's own "Saving…" and "Saved"; "Save failed" still comes first. `beforeunload` also asks while `hasUnsavedSceneEdits()` (kept, stopped, unanswered, pending, in flight or in a clash).
- **L-1.** `backendSceneRevs` is cleared when a sync comes from another backend process (`restarted`), on a graph replace, and when the socket's hello carries a new `bootId` (`subscribeBackendRestart`). Revisions start from the wall clock at boot, so they only go back across a restart, and a restart always brings a new `bootId` before the next save.
- **L-2 (GM r15: approved).** ’ in every person-facing string this PR adds or touches (`fu10/curly.py` over the PR's added lines in `frontend/src`, string literals only), GM's r12 recovered-copy wording and the stopped line included. Two families that must read as one with those lines went whole: `lib/savingCutOff.ts` (its test says "one wording" with `paramSaveFailedLine`) and the other branch of `paramSaveFailedLine`. The rest of the app still uses straight apostrophes, so a line that joins a curly heading to an older reason mixes them (for example "Couldn’t connect the video node. Nebula didn't respond."). That is a question for GM, not fixed here.
- **N-1.** `onlyIfFree` applies only to a single-connection input (`port_contracts.input_takes_one`); an input that takes several keeps its own `maxConnections`. MCP-SETUP says so.
- **N-3.** The two round 9 store tests that passed on ff1f5968 now fail there and pass here: the stale 409 test asserts one refusal (`[409, 200]`, the second with the newest key) and that the card never shows the 409's older copy; the re-added shot test asserts the clash is really asked and the card's wires match Nebula's afterwards.
- **GM r15 answer 3.** `SceneUnsavedMark` stops pointerdown, mousedown, click and double-click on the mark and on its popover (a portal, still inside the card in React's tree), and Enter/Space keydown, so React Flow neither selects nor starts a drag. `nodrag nopan` stays.
- **GM r14 FOCUS.** The popover's [Try again] rings from `:focus-visible` only (`canvasProposals.css`). Live: a real mouse click on the mark gives focus with no ring; Escape gives focus back to the mark, and Enter opens it with the ring.
- **GM r14 item 1, r15 answer 2: the notice stack.** The recovered copy's notice is no longer a toast. `CopyNotice` is the inline neutral notice at the top of Projects home, first in `.project-home__notices`, then the held edits or the line that says where they went, then the error. `useNoticeStackFocus` replaces `useFocusAfterHeldEdits`: when a notice goes and takes focus with it, focus moves to the notice now in its place, else the one before, onto its first control; a notice with no control (the saved line, an error with no Try again) takes focus itself. With the stack empty, focus goes to the "Recent projects" heading (`tabindex -1`, never ringed). React focus events bubble through portals, so the held edits' confirm counts as inside its notice. The h1 is no longer a focus target.
- **Not this PR (GM r14):** the "Set scene" Agent log row goes to the wording batch.
- **Tests.**
  - Backend: `test_pr198_fix10.py`, 7 tests (M-1 four ways, verified tokens, N-1, the docs). On 17f57bad, 5 fail; the 2 that pass are the lanes and verified-token guards.
  - Frontend: `graphStore.fix10` (9: M-2 five ways, L-1 three ways, M-3's unload prompt) and `pr198Fix10Ui` (20: the stack, the focus rules, the mark's presses, the CSS, the bar). On 17f57bad, 24 of the 29 fail; the 5 that pass are guards (no stack with no notice, focus never taken from elsewhere, "Save failed" first, fewer than 20 refusals, H-1 holds). The strengthened N-3 tests fail on ff1f5968.
  - 40 earlier test files changed, almost all for the curly expectations (lines from untouched sources kept their straight apostrophes); the rest are the N-3 tests, the Recent projects focus target and a mock that lacked `unsavedScenes`.

Gates, fix round 10:
- tsc -b and lint: clean.
- Focused vitest: 297 files, 4,744 passed (round 9's list plus the two new files).
- Full backend: 12,029 passed, 71 skipped.
- vite build plus the budget: 424,108 bytes raw.

Live, fix round 10: the first run passed 15 of 17 checks. The 2 failures were the M-2 resend per sync and an error with no Try again taking no focus; both are fixed, and a rerun of those two sections passed 9 of 9, so all 17 checks pass. Isolated backend on 8797 (`fix9_server.py`, the free fake cinema handler), Vite on 5797, 8000–8010 and 5173 blocked (0 attempts after the canary).
- The bar said "Unsaved changes" while the card was stopped, and "Saved" after [Try again] saved.
- A real mouse click on the mark opened the popover with the curly line, selected nothing, and [Try again] had focus with no ring. From the keyboard the ring showed.
- Codex wrote during each of the tab's slow saves: 21 refusals, then "Unsaved" with GM's line and the bar saying so, and no more PUTs while Codex kept writing. [Try again] once Codex stopped saved both changes.
- An MCP read (session header) then a CLI write with no session: 409 `scene_changed`, the typing kept. A fresh MCP read, then the write: 200.
- Projects home: the copy's notice inline above the error; × from the keyboard moved focus to the error box; with the stack empty, to "Recent projects" with no ring. [Restore] by mouse opened the copy. The error line in these shots was set from the page, since a real list failure can't be held while the copy's notice shows.
- Not live: the backward clock across a restart (it needs a second backend process with a lower clock); the store tests cover it.

## Fix round 11 (CI on f3e28e91, GM's pr198 r16)

- **CI: CreateView (23 tests across draft, lifecycle, reuse and bottomBar; review 10 M-1a).** Round 10's bar selector reads `state.unsavedScenes`, and those four files mock the graph store with a state that has no `unsavedScenes`, so the bar threw "Cannot convert undefined or null to object". The mocks now carry `unsavedScenes: {}` like the real store (and CreateView.save's already did). A first try guarded the selector with `?? {}`; the store's type guarantees the map, so the guard only hid the mocks' gap, and it is gone.
- **CI: focusRingCss.** Round 10 added `:focus:not(:focus-visible){outline:none}` on the popover's [Try again], which the test forbids, and it was unneeded: the browser only rings `:focus-visible` there. The rule is gone. Round 10's `#recent-projects-title:focus { outline: none; }` broke the same rule.
- **GM r17: rings follow the input (corrects r15's wording).** Focus moved by a keyboard action rings; focus moved by a click, or by nothing (page load, a scripted move), doesn't. That is `:focus-visible` with the browser's own heuristic, never forced either way. The app has no input-modality helper: its programmatic moves are plain `focus()` calls left to that heuristic, and `useNoticeStackFocus` is one of them. So the saved line, the error box and now the "Recent projects" heading ring from `:focus-visible` with the token ring (`project-home.css`), and no rule touches their plain `:focus`. A first attempt this round turned those rings off with `outline: none` and two NO_OUTLINE entries; GM r17 called that a regression, and both are gone. Closing a notice from the keyboard rings whatever takes focus next; closing it with a click rings nothing.
- **CI: chatCancellation, graphStore.fix2, graphStore.followups (6 tests).** They pinned the straight-apostrophe wording that round 10's ’ sweep changed (GM r15 approved it): "Couldn’t stop the reply.", "Couldn’t save a setting on “Flux”. It’s back…", "Nebula can’t read its project list…". Expectations updated, sources untouched.
- **CI stderr `key.split is not a function` (AgentNodeMarkLayer.tsx:60).** Not from round 10: the passing 17f57bad run logs it 72 times. `tests/Canvas.fileDrop.test.tsx` mocks React Flow's `useStore` as `() => 1`, so `useBoxes` gets a number where it expects its key string. It doesn't fail a test; left for a test cleanup.
- **GM r16: a stopped save tries once by itself.** A change from another writer arriving in the scene counts as evidence that saving works again. About 2 s after the last one (`SCENE_QUIET_RETRY_MS`, `scheduleQuietRetry`), the stopped save sends once.
  - Success: the "Unsaved" mark, the bar and the toast clear as on any save.
  - Failure (Nebula refuses it, or a run holds the scene): it stays stopped with the same line, no new toast, and the popover keeps [Try again].
  - Refused because the scene changed: that refusal is itself another writer's change, so the try merges it and waits for the next quiet stretch.
  - Each new change restarts the 2 s wait, so a busy writer gets at most one try per quiet stretch, never a loop. An agent event with no scene change isn't evidence. [Try again] or the person's own edit sends at once and cancels the wait.
  - MCP-SETUP says an agent that stops writing for a moment lets the person's stopped edits land.
  - GM r17's condition on the refused try: "nothing new shown" holds only when the merge is silent. If Codex's change overlaps a field the person changed, the clash prompt asks as usual and the stopped state waits behind it. While the clash waits, the mark carries the clash line and no [Try again] (`markSceneStopped` reads the clash), the stopped toast leaves (as any clash does), and no quiet try is scheduled. The person's answer sends the save, as any clash answer does. If the clash clears without an answer and the save is still stopped, its line and [Try again] come back.
- **Tests.**
  - `graphStore.fix11` (15): GM r16's quiet try (success, quiet failure, one try per stretch, no change no try, Try again first, M-2 stop then save), GM r17's refused try (silent merge, overlap), L-2 (P3, a reconnect while Codex still writes), GM r18's four lines (named agent, unnamed agent, another window, server failure) and N-4 (the reviewer's P1). On f3e28e91, 12 fail; the 3 that pass are guards (no try without a change, no double save after Try again, the server-failure line). The overlap test also fails on this round's code without the r17 change.
  - `test_pr198_fix11.py` (9): review 10's probes B1, C1 (with the `nebula look` recovery), C1b, C2, C3, C4, C5, and L-3's lines. On f3e28e91, 3 fail (C1 and both L-3 tests); the others are guards that held in round 10 too. Round 10's B8 test is now the refusal test.
  - `pr198Fix10Ui`: keyboard and click closes move focus with a plain `focus()`, every target rings from `:focus-visible` only (no plain `:focus` rule), and N-1's press released off the mark. jsdom has no `:focus-visible` heuristic, so the ring itself is checked live.
  - Tests changed because they pinned behaviour GM or the coordinator changed: the wording tests above (’ sweep), round 10's three M-2 store tests (GM r18's named line), round 10's B8 backend test (L-1), round 10's ring CSS assertions (GM r17), and the backend tests that pin this PR's refusal lines (fix1, fix2, fix3, fix4, fix5, mcp_channel_followups; GM r18 answer 1).

Gates, fix round 11 (after review 10 and GM r18):
- tsc -b and lint: clean.
- Full vitest (not a focused list): 588 files, 7,673 passed, also after the last fixture edits.
- Full backend: 12,038 passed, 71 skipped. The first full run had one real failure, `test_provider_start_admission`, which pins the run-id line L-3 changed; it failed alone too, and passes now.
- vite build plus the budget: 424,636 bytes raw.

Live, GM r16 quiet try: 6 of 6 checks, same isolation as round 10 (backend 8797, Vite 5797, 8000–8010 and 5173 blocked, 0 attempts). A save stopped by server errors made no try of its own; Codex's change brought one try about 2 s later, which the still-failing backend refused quietly (still "Unsaved", no save toast); once saves went through, Codex's next change brought one try that saved both changes, cleared the mark, and the bar said "Saved".

Live, review 10 and GM r18: 10 of 10 checks, same isolation.
- Codex writing during each of the tab's slow saves stopped it with "Codex kept changing “Opening”, so your changes aren’t saved yet. Nebula will try again when Codex stops." in the toast (with [Try again]), the mark's tooltip and its popover; no PUT while Codex kept writing.
- Once Codex stopped, one try about 2 s later saved both changes with no [Try again], the mark cleared and the bar said "Saved" (L-2 with GM r16).
- A press on the mark dragged off and released on the card selected nothing, opened nothing and moved nothing; the next plain click on the card selected it (N-1).
- L-1, probe C1 over HTTP: a `nebula look` with no session, the person's typing, a fresh MCP read, then the CLI's stale write: 409 `scene_changed`, the typing kept; `nebula look` and the redo: 200.
- In the shot after the save, the project bar reads "Unsaved changes": each shot's prep re-centres the canvas, and the camera is part of the project, so the project's own autosave is due. The check before the shot read "Saved".

Live, GM r17 rings: 12 of 12 checks, same isolation. For each target that takes focus when the recovered copy's notice closes (the error box with no Try again, the saved line, and the "Recent projects" heading once the stack is empty):
- after page load nothing had a ring;
- Tab to × and Enter: focus moved to it, `:focus-visible`, with the solid token ring;
- a real mouse click on ×: focus moved to it with no ring.

Four of this round's ring shots are byte-identical to round 10 shots of the same states (keyboard close onto the error box, ringed both rounds; the heading with no ring, from the keyboard in round 10 and from a click now). They come from separate runs on different code, with the state checked each time, so they are identical renders, not reused frames.

## Fix round 12 (PR #198 review 11, GM's pr198 r19 and r20)

- **M-1 (GM r19 answer 2, r20 answer 1): a clash answered while the save was stopped.** `resolveSceneClash` now notes whether the save was stopped, and who stopped it (`clashAnswerStop`), before it clears the stop. The answer sends the save once.
  - It lands: the stopped state is gone for good, and a later failure says its own line and retries as any save does.
  - It fails, whatever refused it (a server error, a run lock, 400, 413): `backToStopped` puts the card back as it was. Same line (the named writer kept), the mark's popover with [Try again], no toast and no timed retries. Its comment says GM r19 overrides GM r10 for a stopped save.
  - Refused as changed: merged as usual. If the 20-in-a-row guard stops it again, it stops quietly too (`stopSceneSave` reads the flag).
  - The quiet try comes back: the next change another writer brings starts a quiet stretch, as in any stopped state (GM r20 answer 1).
  - [Use Codex’s] that leaves the card as Nebula has it sends nothing and settles as saved, so it never goes back to stopped.
  - The flag clears on a save that lands, on the person's next change and on [Try again].
- **L-1 (GM r19 answer 3, r20 answer 2): "another window" only for the person's own tab.**
  - `lib/sceneSaveCopy.ts` has one writer type for every line: `SceneWriter` is agent (a name or none), window or unknown. `sceneWriterOf` maps a backend `changedBy` or `deletedBy`: `person` is window, `agent` is agent, and anything else (anonymous, system, null) is unknown.
  - The clash, reorder, removed and stop lines each have GM's neutral form for unknown. The 404 line is new (below), and `DELETED_ELSEWHERE` is gone.
  - The refusal's `by` is the only writer the 409 carries (the separate `agent` field is gone). Item 7: the clash's author comes from it.
  - `sceneSyncOrigin` carries the writer from `foreignSource`: agent, window (`origin.tab`, sent only with this launch's person token) or unknown.
  - A clash with two different authors is unknown, unless both are the same writer.
  - `rebaseAfterEchoWait` merges as unknown, since nobody named that change.
  - The clash prompt's button reads from the writer: [Use Codex’s] for a named agent, [Use theirs] for anyone else.
  - Backend: `_restore_graph` calls `note_write` with the restoring actor for each scene whose authoring it changed (`_note_restored_scenes`), so a refusal after an undo names the restorer.
  - `switchedFirst` and the canvas undo copy are left as they were (items 9 and 10).
- **L-2 (GM r16, r20 answer 3): what the quiet try says when it is refused.**
  - 400 and 413 now follow GM r16, like a server error: back to stopped, same line, no toast. Before, only `server` and `run-lock` did.
  - 404: the save can never land, so it speaks once and stops for good.
    - The backend answers a node write to a missing node with `code: "node_gone"` and `deletedBy`. `scene_keys.note_delete` records who deleted a scene (the delete endpoint, an agent's `edit_canvas`, a restore that removes it) under the same scope as reads and writers.
    - The line is "Codex deleted “Opening”, so your changes to it can’t be saved.", "“Opening” was deleted in another window, …" or "“Opening” was deleted, …".
    - A delete's sync usually lands first and takes the card off, aborting any PUT in flight. So `noteSceneRemovals` says the same line from the sync's writer when a scene card with unsaved edits leaves by another writer's sync. It is said once per scene per canvas, whichever comes first. It is said after the sync's own update, in the plain line beside the sync's toast ("Codex changed the canvas" with [Undo]). Said before it, the toast took the slot and the line was lost; the first live run caught that.
    - The edits are kept aside (`deletedSceneEdits`, with the base they started from). When a sync shows the node back on the same canvas, with no undo of this tab still holding it, they are merged onto the restored scene (`mergeScenes`, the person's value kept where both changed) and saved, with no new line. Tested for an agent's undo (the Agent log's path, a sync that brings the node back). The canvas's own Undo of a foreign delete was not checked this round: its restore is held until it lands, and only a sync after that would merge the edits.
  - Workspace moved: a new refusal kind, `moved`, that says nothing, sends nothing more (flush skips it, as it skips `replaced`), and still counts as unsaved. The switch's own handling says it once: an agent's switch hands the edits over, and anything else stops on the outdated-workspace banner. It does not read the graph again (unlike `replaced`), since that would read another project's canvas.
  - A server failure stays quiet, as before.
- **L-3: Escape on the "Unsaved" mark.** `keepActivationKeys` keeps Escape too, so React Flow's node never sees it. With the popover open, Escape on the mark closes it and focus stays on the mark. Escape inside the popover already closed it and gave focus back to the mark.
- **L-4: two quick restarts.** The backend sends `bootStartedAt` (`BACKEND_BOOT_STARTED_AT`, microseconds since the epoch) with the health answer and the socket's hello. `noteBackendBootId(id, startedAt)` orders processes by it.
  - An id that started before the current one is retired on arrival and never becomes current. That covers the late health answer from the middle process (probe B1).
  - An id with no start, from a backend before this round, counts as older than one that has a start.
  - With no start known for the current process at all, the newest id wins, as before.
  - A hello from a retired process is dropped before `socketBoot` takes it.
  - H-1/P1 holds: its test is unchanged and passes.
- **GM r19 answer 1: ids take no quotes.** Every backend refusal detail, store error and CLI line that put an id in straight quotes now prints it bare: `run run_ab12 already ran…`, `Node n4 not found`, `Moodboard mb_x not found`, `Edge e1 references missing … node n3`, `sora-2 was retired … Use veo-3 instead (or grok-imagine-video or runway-video)`, and the provider-start holds.
  - `scripts/count_agent_turns.py` reads both forms, since old transcripts quote them.
  - Left alone:
    - repr of a bad value (`invalid id: 'x y'`), which shows what was sent;
    - the engine's two run-error lines (`Required input port 'prompt' is not connected`, `No handler registered for 'x'`; in the scan test's allow list);
    - call syntax shown as code (`get_run('run_x')`);
    - refs that may be names (`no Style 'X'`, `no board 'X'`, `unknown node definition 'moodboard'`).

    The last group is GM's call on names (“…”): see the questions in the report.
- **GM pr200 r16 #2 (from the coordinator, added to this round): where focus goes after ×.** GM reversed the r15 rule for safety: in #200, × moved focus onto the next notice's Run and a second Enter ran it. `useNoticeStackFocus` now moves focus to the next notice's × (`button.project-home__notice-close`), else the one before's. It never lands on a primary or destructive action (Restore, Download your edits, Continue without them, Try again).
  - A notice with no × takes focus itself, by its `tabindex -1`. The held edits' notice (`UnsavedEditsNotice`) gets `tabIndex={-1}`, since it had none and would otherwise have fallen through to the heading. The saved line and the error box had one already.
  - An empty stack still goes to the "Recent projects" heading. The r17 ring rule is unchanged: a plain `focus()`, ringed from `:focus-visible` only. The held notice rings from `.project-home__error:focus-visible`, the rule it already shared.
  - The doc comment and the project-home.css comment now cite GM pr200 r16 #2.
- **Docs.** MCP-SETUP (the `changedBy` kinds, a restore counts as a write, the neutral person lines, `node_gone` and `deletedBy` in the codes table, the deleted line and its resume, the workspace hand-off, `bootStartedAt`, bare ids), SKILL.md and `mcp_server.py`'s docstring (`node_gone`, bare ids), and `CodedRefusal`'s list of codes.
- **Tests.**
  - `graphStore.fix12` (24): M-1 (Keep mine fails, back to stopped; the quiet try comes back; a named stop keeps its line; Keep mine lands; Use Codex’s with nothing to send), L-1 (an unknown sync's clash and removed lines, the other tab, two authors, the neutral stop for anonymous, system and null), L-2 (400 and 413 quiet; a server failure quiet; 404 said once by name, then the restore resumes the save; the delete's sync first for Codex, the other tab and an unknown writer, each resuming after the restore; nothing unsaved says nothing; workspace moved says nothing) and L-4 (probe B1 with start times, a start-less middle answer, a real restart still taking over). On dee9cd75, 19 fail. The 5 that pass are guards: Keep mine lands, the other tab's line, a quiet server failure, a delete with nothing unsaved, a real restart.
  - `pr198Fix12Ui` (6): L-3's three Escape cases (all fail on dee9cd75), and review 11 N-5: the keyboard-versus-click ring, pinned with a simulated input-modality heuristic (a key press makes the next focus keyboard focus, a pointer press makes it not) over project-home.css with `:focus-visible` read as that attribute. That covers the heading and the error box. They pass on dee9cd75 too: they pin round 11's behaviour, which N-5 asked for.
  - `pr198Fix12Ui`, GM pr200 r16 #2 (5): two Enters on × never act. Enter is modelled as the browser activates a button (keydown, then a click unless it was prevented), against a real stack whose × closes the copy's notice. With the error next, the held edits next, the saved line next and an empty stack, the first Enter closes it and the second does nothing. Every handler (Restore, Try again, Download, Continue, create, open, rename, delete) stays uncalled. After the held edits go by their confirm, focus lands on the copy's ×, never [Restore]; Enter there closes it, and the next Enter does nothing. Against the old rule, 3 of the 5 fail; the saved line and the empty stack are guards.
  - `projectStore.switch`: a scene save refused as another window switched project shows only the banner (no toast, no line, no mark). It fails on dee9cd75.
  - `test_pr198_fix12.py` (9): `node_gone` with `deletedBy` for Codex's delete, the person's other window, an agent's `edit_canvas` removal, and a delete never seen (null, bare id); a restore names the restorer; a restore that leaves the scene as it was records no writer; health's `bootStartedAt`; bare ids; a scan of backend f-strings for a quoted id. On dee9cd75, 8 fail; the no-writer restore is a guard. The hello's `bootStartedAt` is checked in `test_graph_recovery_bootstrap_retry`.
  - Tests changed because they pinned behaviour GM or the coordinator changed:
    - the scene copy tests (`pr198Fix6Copy`, `pr198Fix9Ui`; the copy functions take a writer now);
    - `errorCopy.namedLine`'s two allow-list entries for the 404 and moved lines, which no longer exist;
    - `graphStore.fix5`'s 404 line and its workspace-moved test, and `graphStore.fix6`'s and `graphStore.fix7`'s moved lines (GM r20 answer 3: no line of the scene's own);
    - `graphStore.fix6`'s other-window clash, whose sync now carries the other tab's origin (L-1);
    - `graphStore.cinemaPersistence`'s external update, whose sync names no writer and now gets the neutral line (L-1);
    - `pr198Fix10Ui`'s focus tests (GM pr200 r16 #2 replaced "first control"): closing the copy's notice with the error next now lands on the error box, not [Try again]; the last notice closing lands on the copy's ×, not [Restore]. A new case: the held edits next land on the notice itself, not [Download your edits]. All three fail against the old rule;
    - the health pin in `test_params_version_gate` (`bootStartedAt`);
    - the backend tests that pinned quoted ids (GM r19 answer 1): error_copy_round3, 3b and 3e, node_delete_person_copy, character_node, asset_move, node_lookup_by_name, cli_apply, moodboard_adapters, moodboard_reader_routes, retired_nodes, provider_start_admission, project_context, moodboard_cli, pr198_fix1 and mcp_channel_followups.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 590 files, 7,710 tests passed. A second full run that overlapped the backend suite by mistake had 68 failures in 23 files, 50 of them 5 s timeouts. Rerun on an idle machine, those 23 files pass (418 tests).
  - Full backend: 12,046 passed and 71 skipped, with 1 failure. `test_journal_write_project::test_a_reopened_proposals_expiry_never_carries_the_undos_edit_link` is a timing test (0.4 s expiries against a 1.5 s slow write), and it ran while vitest, a build and a live run shared the machine. It passes alone (5 of 5) and with its file (35 passed).
  - vite build plus `check-build-budget.mjs`: 424,760 bytes raw (budget 512,000), 128,465 gzip; `dist` deleted.
- **Live** (isolated backend 8797 and Vite 5797; 8000–8010 and 5173 blocked, 0 attempts after the canary; the cinema handler a free fake).
  - M-1, 5 of 5: stopped, then Codex changes the same shot and the clash asks. Keep mine with saves still failing sends once and goes back to stopped with the same line and no toast, and the popover has [Try again]. Codex's next change brings one quiet try about 2 s later. Once saving works, the quiet try saves both.
  - Unknown writer, 3 of 3: a script's change clashes with the neutral line and [Use theirs]. A script that keeps writing stops the save with the neutral stop line (mark, toast and popover).
  - Deleted, 3 of 3: Codex deletes the scene with an edit unsaved, and the line is said once, by name, beside Codex's [Undo] toast. Nothing more is sent. Codex's undo brings it back, and the edit is saved onto it with no new line.
  - Escape, 2 of 2.
  - Stack, 3 of 3. With the error next, the held edits next and an empty stack, × then a second Enter leaves focus on the error box, the held notice and the heading, and nothing acts (Restore, Try again, Download, Continue, create, open and delete were counted, not run). Keyboard focus rings each time.
  - The combined run of all five sections reached the stack section and then lost its page to a reload behind a `beforeunload` dialog (unsaved state left by the earlier sections), a harness fault. The stack ran alone, 6 of 6 with the canary and page-error checks. The unknown section was rerun so that its stop shot shows the stopped state while the script still writes (6 of 6).
  - Shots: `fix12-*` at 1280 and 1440. The stack's error-box and heading shots match round 10 and 11's pixel for pixel; they are fresh files of the same state. `deleted-by-codex-line-1440` was taken after the toasts timed out, so the 1280 one shows the line beside the toast. The bar says "Unsaved changes" in the canvas shots because of the harness's project save, as in round 11.


## Fix round 13 (PR #198 review 12, GM's pr198 r21 and r12/r10 answers)

- **M-1: the person's other window switches project while a scene edit is unsaved.** The handler's `unsaved` now also counts `hasUnsavedSceneEdits()`, as the agent-switch path does through `beginAgentSwitch`. So the banner offers "Try again to save your unsaved edits as a recovered project." even when the autosave already sent the typed text with the project (the snapshot matched `lastSaved`). `preserveWorkspaceConflict` also sets `dirty` from it, so Try again sends the recovered copy.
  - Live: Street's edit stopped, the other window opens "Second canvas", the banner offers to keep the edits, and Try again makes "Recovered canvas (recovered)" holding the typed text.
  - After Try again, Projects lists the copy, but no notice says where the edits went. That is the existing `retry` load path, unchanged here; a question for GM.
- **L-1: a second clash during the answer's save.** `resolveSceneClash` keeps the earlier stop (`entry.clashAnswerStop = stopped ?? entry.clashAnswerStop`), so the second answer, failing, goes back to stopped with no timed retries and no new line.
- **GM r12 answer 1 (review 12 N-1): a stopped save's own try refused 400 or 413.** `stopSceneForGood` says it once and stops: "Nebula can’t save your changes to “Opening”." for 400, and "“Opening” is too big to save. Remove something from it, then try again." for 413 (`sceneCantSaveLine` and `sceneTooBigToSaveLine` in `lib/sceneSaveCopy.ts`). Each line has [Try again], in the toast and in the "Unsaved" mark's popover.
  - The Agent log gets the status and code: `Couldn’t save “Opening”, node n1: HTTP 413. <detail>`. The person-facing text never does.
  - `scheduleQuietRetry` skips a save stopped for good (`stoppedForGood`), and `resendKeptScenes` already skipped 400 and 413. Nothing goes until the person edits or presses Try again.
  - This also covers a clash answer sent while stopped that is refused 400 or 413. It replaces round 12's "back to stopped, same line" for those two codes.
  - The ordinary 400 and 413 lines, where the save was not stopped, are unchanged. A question for GM.
- **GM r21 answer 3: a delete's sync is ONE toast.** `noteSceneRemovals` returns the deleted lines, and `sayDeletedSceneLines` puts them into the sync's own toast:
  - If Codex's write only deleted the scene (every node it removed has a line, and every wire it removed touches one), the toast is the deleted line with Codex's [Undo].
  - If it did more, the toast is "Codex changed the canvas. Codex deleted “Opening”, …", still with its [Undo].
  - A 404 that said the line first: the sync's toast carries it, and no second toast appears.
  - When no agent toast appears (a window or an unknown writer), the line goes out as before.
- **GM r12 answer 2 (review 12 L-2): a clash waiting when the scene was deleted.** `deletedSceneEdits` keeps the clash's fields and writer, and the clash prompt goes away with the card.
  - When the scene comes back, `restoreDeletedScenes` compares against the restored scene (`stillClashing`). If Codex's restored value is the person's, there is no clash and the save goes.
  - Otherwise the existing clash line asks again, with Keep mine and Use Codex’s. It clears the deleted line from whichever slot shows it, so the two are never shown together, and there is no "came back" sentence.
- **N-5: ids and handles are bare, through `!r` too.** Changed:
  - `moodboard_layout.py` (card ids);
  - `main.py`: `_preview_port`, the imported handle check, and the port line at 15065;
  - `node_lookup.py`: unknown node definition;
  - `engine.py`: Required input port and No handler registered;
  - `cinema_scene.py`, `gating.py`, `cinema/look.py` and `typesafe_client.py`.

  A value that was refused (invalid, received, unexpected) keeps its repr, as sent. `count_agent_turns.py` reads both forms.
- **GM r21 answers 1 and 2.** Names an agent wrote are in “…”: no Style, no Character, no board, no project, no look, frame, Board and Moodboard, and "N Styles are named …". Calls an agent can make next are code in backticks with straight quotes (`get_run('run_x')`, `open_project('…')`).
- **N-6.** "Couldn’t save your edits." `CONFIRM_LINE` ("can't") and `EDITS_NOT_WRITTEN` ("didn't") in the same file still use straight apostrophes. They are out of N-6's scope; flagged.
- **Docs.** MCP-SETUP (the bare examples, the one toast, asked again, the hand-off keeping scene edits, 400 and 413, and ids, names and calls), SKILL.md, and `mcp_server.py`'s docstring.
- **Tests.**
  - `graphStore.fix13` (12):
    - L-1's double clash;
    - N-1: 400 and 413 said once with [Try again] and nothing more until the person acts; the person's next change; a clash answer refused 400;
    - r21-3: only a delete, did more, the 404 first, nothing unsaved;
    - L-2: asked again with the deleted toast cleared, the same value meaning no clash, Use Codex’s after the restore.

    On 4acdfe27, 11 fail; "nothing unsaved" is the guard.
  - `projectStore.switch`: M-1, failing on 4acdfe27.
  - `test_pr198_fix13.py` (7): bare card id, port and handle; a `!r` scan; a names scan; a style by name nothing has or two share; a backticked-calls scan; the engine's bare run errors. `test_pr198_fix12`'s id scan no longer has exclusions.
  - Tests changed because GM or the coordinator changed behaviour:
    - `graphStore.fix12`: the 400/413 back-to-stopped test is removed (GM r12 answer 1), and the delete-sync test now expects the one toast (GM r21 answer 3);
    - `errorCopy.namedLine`: the log line's reviewed template;
    - `ProjectHome.unsavedEdits` and `pr198Fix5CopyHeadedLine` (N-6);
    - the backend copy pins (N-5, r21 answers 1 and 2): asset_move, cli_api, cli_project_reads, error_copy_round3e, graph_cluster, krea_board_strengths, universal_ports, node_lookup_by_name, pending_nodes, and the fixtures `moodboard_golden/expected.json` (`test_moodboard_golden` maps “…” back before hashing) and `universal_ports_saved_before.json`.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 591 files, 7,721 tests passed.
  - Full backend: 12,053 passed and 71 skipped, with 1 failure. It was `universal_ports_saved_before.json` pinning the old quoted run error; that fixture is now fixed, and the file passes with `test_pending_nodes` (62 passed).
  - vite build plus `check-build-budget.mjs`: 424,788 bytes raw (budget 512,000), 128,492 gzip; `dist` deleted.
- **Live** (`fix13_live.mjs`: backend 8797 with `fix13_server.py`, which adds a `big-put-<id>` 413 flag, and Vite 5797; 8000–8010 and 5173 blocked, 0 attempts after the canary; no paid runs).
  - Canvas run, 18 of 18:
    - m1double: two clashes, the second answer failing, sends once, then stopped, with no new lines and [Try again] in the popover;
    - toobig: the line is said once with [Try again] in the toast and the popover, the Agent log has HTTP 413, Codex writing again sends nothing, and Try again saves;
    - deleted13: one toast in both cases, still showing in both shots, and its [Undo] resumes the save;
    - clashback: asked again with the deleted toast gone, Keep mine saves, and the same value means no clash.
  - Person switch: 5 of 5.
  - Round 12 regression (m1, unknown, escape, stack): 16 of 16.
  - Shots `fix13-*` at 1280 and 1440, all distinct: m1double-back-to-stopped, toobig-line, toobig-popover, deleted-by-codex-line, deleted-did-more-one-toast, clashback-clash-replaces-deleted-toast, moved-banner-keeps-edits, moved-recovered-listed.

## Fix round 14 (GM's pr198 r22, PR #198 review 13, GM's pr198 r23)

- **GM r22 Q1: the popover takes the toast's place.** `noteScenePopover` (graphStore) runs when the "Unsaved" mark's popover mounts and unmounts. Opening it clears whichever slot holds that scene's line and [Try again] (`retryScene.nodeId`). Agent toasts and other scenes' toasts stay. While it is open, a new line for that scene goes only to the popover (`stopSceneSave` and `stopSceneForGood` skip the toast). Closing it brings nothing back.
- **GM r22 Q2: the saved-as notice.** In `projectStore.retry`, when Try again finished a pending recovery and a new recovered copy is listed, `copyNotice` becomes "Your latest edits were saved as their own project, “<name>”." with `open: {id, name}`. `ProjectHome`'s `CopyNotice` renders [Open] before ×, in the banner's slot. Focus goes to its × when it was on the body, lost, in the notice stack, or on the Recent heading; otherwise it stays where the person put it. `openCopyNotice` clears the notice and opens the project.
- **GM r22 Q3: one line per status.** `sceneRefusal` gives 400 "Nebula can’t save your changes to “Opening”." and 413 "“Opening” is too big to save. Remove something from it, then try again." on every save, not only a stopped one. The kept-edits branch of `settleSceneAnswer` stops it for good (`stopSceneForGood`), so nothing goes until the person edits or presses [Try again]. `BAD_SAVE`, `SCENE_TOO_BIG` and `sceneTooBigLine` are gone. The Agent log still has the status and code.
- **GM r22 notes.**
  - 1: `editArrivedText` ends with a period ("Codex changed the canvas.", "Codex undid its edit.").
  - 2: `CONFIRM_LINE`, `EDITS_NOT_WRITTEN` and `EDITS_DOWNLOAD_HEADING` use ’. The stopped popover's "Couldn’t" was already U+2019: the live check reads its code points.
  - 3: a write that deleted a scene and did more is `sceneChangedAndDeletedLine`, "Codex changed the canvas and deleted “Opening”, so your changes to it can’t be saved." An undo that deleted a scene (`entry.undoes`) keeps "Codex undid its edit. <line>"; flagged.
  - 4: the banner colour is skipped, as GM said.
- **Review 13 LOW-1 and GM r23 answer 2: [Undo] asks the clash again.**
  - `restoreHeldScenes` (called from `sendRestore`) puts back the scene as Nebula had it (`backendScenes`) for a cinema scene that has a same-canvas deleted record, not the person's unsaved text.
  - Once the restore lands, `restoreDeletedScenes` asks the waiting clash again. It clears the toast showing the delete (its line, or the redo toast for that node) and passes `focus` when that toast had focus or focus was lost.
  - `SceneClashNotice` gives the prompt `tabIndex={-1}` and focuses the prompt itself, never [Keep mine], unless the person has moved focus elsewhere.
- **Review 13 LOW-2: refused again stays stopped.** A [Try again] or an edit refused 400/413 goes back to stopped for good with the same line and [Try again] in the toast and the popover, and Codex writes send nothing. `retrySceneSave` clears `refusedLine`, so a refused retry says the line again; an edit keeps it, so a refused edit says nothing new.
- **NITs and GM r23 answer 3.**
  - `mcp_server._example` puts the call in backticks.
  - The Avoid item and "has no model “…”" use curly quotes.
  - `node_lookup.shown_definition` leaves an id-shaped definition bare and puts anything else in “…”.
  - No value (missing, null, empty or blank) reads "No node definition was given." for the person (`refusal_copy.refusal`, route canvas). The agent's detail stays `unknown node definition ""`. Both carry `code: "unknown_definition"` and `definitionId` (raw).
  - `count_agent_turns.py` reads the new forms.
- **The property-test flake (seeds 10 and 24).** It came from the harness, not a product race. When a block in `heldUndo.property.round17` timed out, its seed loop kept running and typed into the next block's fresh canvas ("pre-clear typing landed on the new canvas"). I reproduced it by forcing the refuse block's timeout to 1000 ms: the clear blocks then failed on seeds 24 and 84. Each block now runs under its own `generation`, and an abandoned loop throws `Abandoned` at its next step. With the same forced timeout, the probe then passed.
- **Docs.** MCP-SETUP has:
  - the `unknown_definition` code row;
  - the saved-as notice;
  - the 400/413 lines on every save, the popover rule, and that refused again keeps the line;
  - the did-more sentence;
  - Undo restoring Nebula's scene and the prompt taking focus;
  - toast periods.

  SKILL.md has the `unknown_definition` sentence.
- **Tests.**
  - New `graphStore.fix14` (16): Q3 400/413, the next change, no retry promise; Q1 (4); notes 1 and 3; LOW-1 (3); LOW-2 (3). The first 10 and the LOW-2 tests fail on beaf935d, and LOW-1 fails without `restoreHeldScenes`.
  - New `pr198Fix14Ui` (6): the Q2 notice and focus, focus left alone, the update copy notice unchanged, the Q1 popover, and the clash prompt's focus (2).
  - `projectStore.switch`: 2 Q2 tests.
  - New `test_pr198_fix14.py`: definitions (bare, quoted, empty in 3 forms), backticks, curly quotes.
  - Tests changed because GM or the coordinator changed behaviour:
    - `graphStore.fix3`, `fix4` and `fix5`: the 400/413 lines;
    - `graphStore.fix13`: did-more is one sentence;
    - the toast period pins in arrangeUndo, agentUndo, noticeMessageBesideUndo.round8, round23Surfaces, placeholderRuns round8/round9 and CanvasUndoNotice;
    - `errorCopy.namedLine`: drops the SCENE_TOO_BIG and BAD_SAVE entries;
    - `ProjectHome.unsavedEdits` and `downloadTooBig`: ’;
    - `test_first_turn_fixes`: backticks;
    - `test_node_lookup_by_name`: a shown name.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 593 files, 7,745 tests passed.
  - Full backend: 12,061 passed, 71 skipped.
  - vite build plus `check-build-budget.mjs`: 425,658 bytes raw (budget 512,000), 128,722 gzip; `dist` deleted.
- **Live** (`fix14_live.mjs`: backend 8797 with `fix14_server.py`, which adds a `bad-put-<id>` 400 flag; Vite 5797; 8000–8010 and 5173 blocked, 0 attempts after the canary; no paid runs).
  - bad400 8/8: the unstopped line with [Try again], and a refused Try again from the popover staying stopped.
  - toobig: the period, and the popover clearing the toast.
  - deleted13: one sentence.
  - clashback (undoclash) 6/6.
  - moved 6/6: the saved-as notice, × focused, [Open] opens it.
  - Round 12 regression 16/16.
  - Shots `fix14-*` at 1280 and 1440, all distinct: popover-open-toast-gone, moved-saved-as-notice, moved-banner-keeps-edits, bad400-unstopped-line, bad400-try-again-refused, deleted-did-more-one-toast, toobig-line, undoclash-asked-again.

## Fix round 15 (GM's pr198 r24)

- **Answer 1: an agent's undo that deleted a scene is one sentence.** `sayDeletedSceneLines` gives `sceneUndidAndDeletedLine` ("Codex undid its edit and deleted “Opening”, so your changes to it can’t be saved.") whenever the toast's edit `undoes` one and has an agent's name. That holds whether the undo only deleted the scene or did more. It replaces round 14's two sentences, "Codex undid its edit. <line>". Both lines share `agentDeletedLine` in `lib/sceneSaveCopy.ts`; several scenes read “A” and “B”, "to them".
- **Answer 2: "Undid Codex’s edit." with its period.** `undoNoticeText` ends all three forms with a period (agent, another window, outside Nebula; Undo and Redo). The count added after it ("1 proposal couldn't be reopened.") now joins with one period: the join strips the line's own period first.
- **The saved-as notice's ×: the ring follows the input.** Checked live with a real mouse click on Try again, then Enter, then Space (each round makes a new recovered copy). The mouse leaves × focused with no ring (`:focus-visible` false, outline none). Enter and Space ring it (`:focus-visible` true, the solid token ring).
  - This needed no change: the effect is a plain `focus()` and the CSS rings from `:focus-visible` only, the mechanism GM r17 set for every notice.
  - Round 14's shot showed a ring because its harness pressed Try again with a scripted `click()` after keyboard actions, which Chrome treats as keyboard input.
  - `pr198Fix15Ui` pins the mechanism (one plain `focus()` with no options on ×, for mouse, Enter and Space; the CSS rings from `:focus-visible` only), since jsdom has no `:focus-visible` heuristic.
- GM withdrew r22 note 2 (the popover was already ’).
- **Docs.** MCP-SETUP (the agent-undo sentence, "Undid Codex’s edit.") and the `mcp_server.py` docstring.
- **Tests.**
  - New `graphStore.fix15` (6): the undo that only deleted the scene, and the one that did more, both fail on 0d66cdef; two scenes; nothing unsaved; every Undo/Redo form; Undo pressed on Codex's toast.
  - New `pr198Fix15Ui` (4).
  - Tests changed because GM changed behaviour (answer 2's period): CanvasUndoNotice, graphStore.agentUndo, noticeFollowsStacks, noticeRegion.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 595 files, 7,755 tests passed.
  - Full backend: 12,061 passed, 71 skipped.
  - vite build plus `check-build-budget.mjs`: 425,658 bytes raw (budget 512,000), 128,731 gzip; `dist` deleted.
- **Live** (`fix15_live.mjs` on round 14's harness: backend 8797 with `fix15_server.py`, Vite 5797, 8000–8010 and 5173 blocked with 0 attempts after the canary, no paid runs).
  - moved across mouse, Enter and Space: 15/15.
  - undodel, ownundo, and the round 14 deleted13 and undoclash regression: 13/13.
  - Shots `fix15-*` at 1280 and 1440, all distinct: undo-delete-one-sentence, undo-toast-period, saved-as-x-after-mouse, saved-as-x-after-enter.

## Fix round 16 (PR #198 review 14, GM's pr198 r25)

- **LOW-1 and GM r25 answer 1: every way back asks again.** The person's own Redo took the scene off as this tab's own echo, so `noteSceneRemovals` kept nothing, and the next Undo restored the card as shown, which settled the clash as theirs.
  - Now the node-removal subscriber (the one that clears a scene's save entry) first calls `keepOwnRemovedScene`. When the card held unsaved edits or a waiting clash, it keeps them aside with the scene Nebula had, silently, through the same `keepDeletedScene` record a deleting sync uses. That covers the person's delete, an undo and a redo.
  - Every way back then goes through the same path: `restoreHeldScenes` for the canvas's own Undo or Redo, and `restoreDeletedScenes` on the sync for any return (another window's restore, the Agent log's undo). The clash is asked again while the values still differ. No way back counts as an answer.
  - A silent record has an empty line, so it never clears a slot (`said &&`) and never counts as said in `noteSceneRemovals`.
  - Canvas replacements clear every save entry before they swap nodes, so nothing is kept across canvases.
- **LOW-2 and GM r25 answer 2: a 400 or 413 behind a clash.**
  - In `settleSceneAnswer`, a `bad-save`/`too-big` answer while a clash waits goes to `stopSceneForGood`. With a clash waiting, that sets `entry.clashRefusal` and says nothing.
  - `flushCinemaScenePersistence` sends nothing for the scene while `clash && clashRefusal` hold, whether triggered by another writer's sync, the person's edit (which no longer unstops it) or a reconnect. Other scenes are untouched.
  - `resolveSceneClash` then decides:
    - if the answer left the card as Nebula has it (GM's edge case), the stop and the mark go and nothing is said;
    - otherwise `stopSceneForGood` says the line once with [Try again], and nothing is sent.
  - A landed save clears `clashRefusal`.
- **NIT-2: the property test's window.**
  - `runSeedInner` shadows `tick` and `settle` with `guardedTimers(mine)`. The shared fake timers advance in slices of at most a second, with the generation checked before and after each slice.
  - The seed's steps, presses, `Promise.allSettled` and its final delivery all stop at their next await once a newer block took over.
  - The block's own 20 s wait is sliced too.
  - `Abandoned` counts as a stop only when the generation moved; otherwise it rethrows, so a misfire can't hide a failure.
  - Probe: a copy where the refuse block gives up after 1 s of real time and leaves its run going, as vitest's timeout does. The clear 1–30 block and seeds 84 and 1123 pass after it.
  - Seed timings match round 15's file (plain 1–30: 2.1 s both; clear 1–30: 0.26 s both), so the slicing changes nothing for a live run.
- **NIT-3 (harness).** The pointer rests on Codex's toast during the toobig-line shots (its hold waits while the pointer is on it). The click on the mark that follows starts its full hold again before the check. Live, it passes.
- **Docs.** MCP-SETUP (every way back, each time; a refusal behind a clash, with the edge case) and the `mcp_server.py` docstring.
- **Tests.**
  - New `graphStore.fix16` (9):
    - Undo, Redo, Undo again;
    - the person's own delete, then Undo;
    - another window's restore;
    - the same value meaning no question;
    - nothing unsaved;
    - 400 and 413 behind a clash: nothing sent on Codex's writes, the person's edits or a reconnect; Keep mine leaves it stopped for good; [Try again] saves;
    - Use Codex’s with another edit left: stopped for good;
    - the edge case: nothing unsaved, so no stop, no mark, nothing said.

    On 172f5673, 6 fail; the same-value, nothing-unsaved and edge-case tests are guards.
  - `heldUndo.property.round17` (NIT-2).
  - No test changed because behaviour changed.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 596 files, 7,764 tests passed.
  - Full backend: 12,061 passed, 71 skipped.
  - vite build plus `check-build-budget.mjs`: 425,658 bytes raw (budget 512,000), 128,730 gzip; `dist` deleted.
- **Live** (`fix16_live.mjs`, isolation as before, 0 blocked attempts, no paid runs).
  - redoclash, mouse and keyboard (Undo by the toast's [Undo] or Cmd+Z; Redo by Cmd+Shift+Z, since no toast offers it then; Undo again by the "Redid Codex’s edit." toast's [Undo] or Cmd+Z): asked again each time, Codex's value on Nebula, no deleted line for the Redo, and Keep mine saves. 7/7.
  - The first run's two failures were my check counting the Undo and Redo toasts as said lines.
  - clash400b: refused 400 with s3 unsaved, the prompt the only line, and Codex's two writes send 0. Keep mine then shows the line once with [Try again] and sends nothing, and [Try again] saves. Run together with toobig (NIT-3): 14/16, the two failures being the redo check above.
  - Shots `fix16-*` at 1280 and 1440, all distinct: redoclash-asked-again-mouse, redoclash-asked-again-keyboard, clash400-only-prompt, clash400-after-keep-mine.

## Fix round 17 (PR #198 review 15, GM's pr198 r26)

- **LOW-1 and GM r26 answer 1: Codex ending a clash counts as the person's answer.** When a sync writes the person's own value into the clashing field, `settleRebasedScene` used to drop the clash. A 400 or 413 waiting behind it (`clashRefusal`) then stayed stopped with nothing said.
  - The refusal branch of `resolveSceneClash` is now `endClashRefusal(nodeId, entry)`, and both paths call it. `settleRebasedScene` calls it when the clash has gone and `clashRefusal` is still set.
  - If the card now matches Nebula's scene with nothing in flight, the stop and the mark go and nothing is said. Otherwise the stop line is said once with [Try again] and nothing is sent.
- **GM r26 answer 2: while a clash is asked again, the prompt is the only line for that scene.**
  - `restoreDeletedScenes` clears both slots where `aboutScene(notice, nodeId, said)` holds:
    - a stop line for the scene;
    - its said line;
    - an undo entry that touches the node (a ForeignEdit's before or after, an own-add, or an UndoSnapshot whose presence of the node differs from the canvas now).
  - So "Codex undid its edit." [Undo] and "Restored the node." [Redo] give way. They are not put back after the answer. Lines about other nodes stay.
  - The undo and redo stacks are untouched, so the keyboard and the Agent log still undo and redo. No stale toast button is left to delete the scene behind the question.
- **GM r26 answer 3: a stop line keeps its slot.**
  - In `foreignEditStep`, a Codex edit that touches only stopped scenes and deletes none (its changed edges touch only stopped nodes) goes on the undo stack with no toast. The Agent log has it as before.
  - A Codex edit about anything else takes the undo slot as usual. A stop line that was there moves to `messageNotice`, keeping its `retryScene`, so [Try again] stays beside the toast.
  - The two branches where the situation changes:
    - Codex deletes the scene: the delete line replaces the stop line, as before.
    - Codex starts a new clash: `setSceneClash` clears that scene's stop line when the clash is first set.
- **NIT-2: the property test's clock window.** Each slice of `guardedTimers` is recorded in `sliceInFlight`. Before its 20 s settle, `afterEach` bumps the generation and waits, up to 10 s of real time, for the slice in flight. So an abandoned slice can't advance the next block's clock.
- **The round 16 edge-case test now pins its code.** While the clash waits it checks:
  - nothing is sent after s3 is typed back;
  - the scene isn't stopped;
  - the clash is still there.

  It fails on 0d66cdef's graphStore and when the equality branch is disabled.
- **Docs.**
  - MCP-SETUP: asked again, the prompt is the only line; Codex's write ending the clash counts as an answer; the stop line keeps its slot, with its two boundary cases.
  - The `mcp_server.py` docstring.
- **Tests.**
  - New `graphStore.fix17` (11 tests):
    - LOW-1: 400 and 413 with another edit left (the line once, nothing sent, [Try again] saves); nothing left unsaved (no stop, no mark, nothing said).
    - Answer 2: the Agent log's undo (no slots; the stack's top still undoes Codex's edit; nothing after the answer); the person's delete and Undo, then Redo by keyboard; a line about another node stays.
    - Answer 3: Codex's edit about the stopped scene; Codex deletes it alone; deletes it and more; a new clash; an edit about another node.

    On 732ca471, 6 fail. These 5 pass there and are guards:
    - nothing unsaved (it fails with the equality branch disabled);
    - the other-node line under the prompt;
    - the two delete tests;
    - the new clash.
  - `graphStore.fix16`: the edge-case test (above). `heldUndo.property.round17` (NIT-2).
  - Changed because GM r26 changed behaviour: only the live harness's toobig section. A Codex edit about the stopped scene no longer toasts, so the 413 line is in the undo slot, the pointer rests on that toast for NIT-3, and the popover check expects no Codex toast. No vitest or backend test changed for that reason.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 597 files, 7,775 tests passed.
  - Full backend: 12,061 passed, 71 skipped.
  - vite build plus `check-build-budget.mjs`: 425,658 bytes raw (budget 512,000), 128,726 gzip; `dist` deleted.
- **Live** (`fix17_live.mjs`, isolation as before, 0 blocked attempts, no paid runs).
  - dissolve (LOW-1): Codex ends the clash with the person's value while a 400 waits. The stop line shows once with [Try again] on the toast and the mark, 0 PUTs, and [Try again] saves.
  - onlyprompt (answer 2), by Codex's apply/undo and by the person's delete then Cmd+Z: the prompt is the only line, with no [Undo] or [Redo] toast. Keep mine saves and nothing comes back.
  - stopline (answer 3): four branches (the same scene, another node, a new clash, deleted), each as specified.
  - All three together: 13/13. The first runs failed the new-clash branch because the harness started it from a scene still stopped by the previous branch, so its edit had been saved. Each branch now starts from a saved scene.
  - Regressions:
    - m1, unknown, deleted, escape and stack all pass.
    - m1double, toobig and bad400: 17/17 rerun alone. The first run had them after stack, which leaves the page on Projects, and all 13 of their checks failed there.
    - deleted13, clashback, undoclash, moved, undodel, ownundo, redoclash and clash400b: 35/35.
  - Shots `fix17-*` at 1280 and 1440, all distinct: dissolve-stop-line, onlyprompt-agentundo, onlyprompt-ownundo, stopline-codex-same-scene, stopline-codex-other-node, stopline-new-clash, stopline-deleted.

## Fix round 18 (PR #198 review 16, GM's pr198 r27)

- **LOW-1 and GM r27 answer 1: one rule for a scene with a line of its own.**
  - `scenesWithOwnLine()` returns the scenes whose save entry is `stopped` or holds a `clash`, whether a first clash or one asked again. It replaces round 17's `stoppedSceneIds()`.
  - In `foreignEditStep`, a Codex edit that touches only those scenes, deletes none of them and changes only wires going into them goes on the undo stack with no toast. The Agent log has it as before.
  - `applyGraphSync` notes the set before its merge rebases any scene (`sceneLinesBeforeSync`), and `foreignEditStep` reads it once.
    - Without it, an edit that ends a clash (the field now the person's value) while changing another field would still toast, since the clash is gone by the time the toast is decided.
  - An edit to the clashed field alone doesn't change the card, so it makes no undo step and no toast. The prompt takes the latest state (path 5), and a value that matches the person's ends the clash.
  - A delete or a new clash still replaces the line, as before.
- **LOW-2 and GM r27 answer 2: the person's own toasts.**
  - `stopLineBeside(state, gone)` is the helper Codex's toasts already used, extracted. A stop line in the undo slot moves to `messageNotice` with its `retryScene`, unless the step took that scene off the canvas.
  - It now runs with every own-step notice:
    - "Deleted the node." (`deletedNotice`);
    - the undo/redo notice in `applyHistory` ("Undid Codex’s edit.", kept lines, "Restored the node." / "Deleted the node.");
    - the late "Restored the node." that waits for the backend's answer.
  - After an undo or redo, a stopped scene whose node the step changed goes through `settleIfNothingUnsaved`. That is `endClashRefusal`'s equality branch, extracted and shared: if the card is Nebula's scene and nothing is in flight, the stop, its line and the mark go, and nothing is said.
- **GM r27 answer 3: a wire out.** A wire counts as about the scene only when it goes into it. So a Codex wire from the stopped scene into another node shows its toast, with the stop line beside it.
- **NIT-1 and GM r27 answer 4.** MCP-SETUP and the code comments say Undo and Redo work from the keyboard. Mentions of an undo "from the Agent log" now name the agent's undo or the person's Cmd+Z. In-app copy is unchanged.
- **Harness.**
  - Each round 18 section starts with `fresh18`: it unflags the fake failures, ends any clash or stop, resets the scene and clears the slots.
  - The older `stack` section still leaves the page on Projects. Getting back to the canvas from it didn't work: neither the card click nor `projectStore.open` after a fresh load left the home screen. So m1double, toobig and bad400, which come after it in file order, run in their own run.
- **Docs.** MCP-SETUP: a scene with a line of its own, the person's own toasts, the wire out, and keyboard only. The `mcp_server.py` docstring.
- **Tests.**
  - New `graphStore.fix18` (8 tests). All 8 fail on befffdca.
    - LOW-1:
      - a first clash: no toast for Codex's edit to another field, Cmd+Z can undo it, an edit about another node still toasts;
      - asked again: no toast;
      - the clashed field and another field together: the prompt is rewritten with no toast, and Use Codex’s takes the latest;
      - the clashed field now the person's value, with another field: the clash ends, no toast, nothing unsaved.
    - LOW-2:
      - "Deleted the node." then "Restored the node." with the stop line beside both;
      - "Undid Codex’s edit." with the stop line beside it;
      - the person's own Undo leaves nothing unsaved: stop and mark clear.
    - Answer 3: the wire out.
  - Mutation check: with the before-merge set disabled, the "ends the clash" test fails.
  - No existing test changed because behaviour changed. The full `tests/store` directory passes unchanged.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 598 files, 7,783 tests passed.
  - Full backend: 12,061 passed, 71 skipped.
    - The first run failed 2 tests in `test_connected_copy_sweep.py`: the new MCP-SETUP and docstring prose said "wire". It now says "connection", and that file passes 72/72.
  - vite build plus `check-build-budget.mjs`: 425,658 bytes raw (budget 512,000), 128,741 gzip; `dist` deleted.
- **Live** (`fix18_live.mjs`, isolation as before, 0 blocked attempts, no paid runs).
  - Round 18 sections, 12/12:
    - clashquiet: a first clash, Codex's edit to s3 quiet, its edit to another node toasting beside the prompt, then an edit that ends the clash quietly;
    - askedquiet;
    - owntoasts: Deleted, then Restored, each with the stop line beside it;
    - undidcodex;
    - ownundoclear;
    - wireout.
  - The first owntoasts run failed its last check. The stop line in the message slot had reached the end of its reading-time hold, which every canvas notice has, before the Cmd+Z. That check is now its own section (`undidcodex`) with a fresh stop line, and it passes.
  - Regressions:
    - m1, unknown, deleted, escape and stack: 16/16.
    - m1double, toobig and bad400 in their own run: 17/17.
    - deleted13, clashback, undoclash, moved, undodel, ownundo, redoclash and clash400b: 35/35.
    - Round 17's dissolve, onlyprompt and stopline: 13/13.
  - Shots `fix18-*` at 1280 and 1440, all distinct:
    - clash-codex-same-scene, clash-other-node, clash-dissolve, askedagain-codex-same-scene;
    - stopped-own-delete, stopped-own-restore, stopped-undid-codex;
    - ownundo-clears-stop, stopped-wire-out.

## Fix round 19 (PR #198 review 17, GM's pr198 r28)

- **GM r28 item 2: a stop line is a state, never lost.**
  - The stop lines have their own slot in the notice region, `scene-stop`, between `scene-clash` and `message`: above both event slots. `SceneStopLines` renders it from `sceneStopLines(state)`, which reads `stoppedScenes` and a new `sceneStops` map (the cause per stopped scene, kept by `setSceneStopped` through `noteSceneStop`).
  - One line per cause, in the order 400, server, 413. Scenes of the same cause share one line through `sceneStopStateLine`, naming them with the shared `quotedNames` (up to 3, then "4 scenes"), in reading order on the canvas (top to bottom, then left to right). The first live run showed why: a scene put back by Undo comes back last in the node list, which turned "“Opening” and “Ref scene”" around.
  - "…kept changing…" (another writer outpaced the save) stays one line per scene: GM gave no merged wording for it.
  - [Try again] retries every scene its line names. `retrySceneSave` now sets `clashAnswerStop` when the scene was stopped, so it is one try: a failure goes straight back to stopped (`backToStopped`), and the scene stays in the line. A scene whose stop clears leaves it.
  - No × and no reading-time hold: the line goes when the stop does.
  - The toasts no longer carry `retryScene`; `stopLineBeside` and its four call sites are gone, and so are the popover's toast clearing and `sceneInPopover`. The popover now sets `scenePopover`, which leaves that scene out of the lines while it is open. Closing it brings the line back.
  - The transient line takes GM's subject-and-comma fix in the singular too: "Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change." The mark and popover say it the same way.
- **A clash that ends marks the stop once.** `withClashSettling` wraps `resolveSceneClash` and `settleRebasedScene`. While a clash ends, `setSceneClash(null)` doesn't mark the scene stopped again; the stop is marked once, after the end has decided. Without it the stop line showed for one store update before the answer's try, or before a clash that left nothing unsaved cleared it (graphStore.fix13 and fix17 caught both).
- **LOW-1.** The person's own delete of a stopped scene takes its stop line with it (the line is drawn from the scenes on the canvas; `clearCinemaScenePersistence` also drops `sceneStops`). Event lines about its save (the retry line, the kept line) go through `dropSceneLines`, now shared by `keepOwnRemovedScene` and `noteSceneDeleted`, in either slot. "Deleted the node." [Undo] is the only line.
- **LOW-2.** `settleRebasedScene` runs `settleIfNothingUnsaved` for a stopped scene with no clash before its "nothing to send" branch, so another writer's change that matches the person's values clears the stop, its line and the mark together.
- **LOW-3 (GM r28 answer 1, c).** `keepDeletedScene` records the stop (`refused` and `by`) for a stopped scene with no clash. When the scene comes back and still differs, `restoreSceneStopped` sets the entry up held (no send, no timed retries; `retries` at the limit for a server stop) and stops it with its own line.
  - After a server stop it schedules the quiet try: the restore's sync is a sign that saving works (GM r16's rule for a change by a sync). After 400 or 413 nothing goes until the person acts.
  - A scene that comes back matching the person's values has no stop.
  - This replaces the brief's "Undo with the server back saves": it now comes back stopped, and then the quiet try saves it.
- **Harness** (`fix19_live.mjs`, from fix18's).
  - `notices()` reads the state slot (`stop`, `stops`, `retry` from `sceneStopLines`); `watchLines` and `slotTexts` count its lines; toast selectors leave `.scene-stop-line` out. Checks that read the stop line from the toast slots now read it from the state slot.
  - `stack` ends with a fresh load and the card (the reviewer's `stackback`), so m1double, toobig and bad400 run after it in the same run. Its counter install retries if the page drops the evaluate.
  - The reviewer's `owndel` (fu15 `my_sections.mjs` and fu17 `live_r17.mjs`) seeds the watched lines with what shows before the delete, so a line said before it no longer matches. The section is ported into fix19 with that fix.
  - `toobig`'s popover check now expects the line back after the popover closes (GM r28). `m1double`'s "nothing said" leaves out the stop line coming back in its slot (the state, not a new line), and its U+2019 check reads "Nebula couldn’t".
- **Docs.** MCP-SETUP: the stop lines as a state with GM's merged wording, one try per [Try again], the person's delete and Undo of a stopped scene, LOW-2, and the popover rule.
- **Tests.**
  - New `graphStore.fix19` (23 tests) and `pr198Fix19Ui` (2). All 25 fail on 5042895b; most fail there because the state slot doesn't exist yet.
    - To see which test real behaviour, I ran fix19 against 5042895b with a reader of the old toasts in place of `sceneStopLines`: 15 of the 21 then still fail (merging, the event under the slot, a partial [Try again], a shrinking line, LOW-1 for a server stop and beside another toast, LOW-3 for every cause, the late "Restored the node.", and LOW-2 for a server stop). Six pass on the old behaviour: LOW-1 for 400 and 413, "a merged line loses only the deleted scene", LOW-2 for 400 and 413, and the scene that comes back matching Nebula. These pin GM's edge cases.
    - Mutation checks: without the reading-order sort, the reading-order test fails; without `dropSceneLines` in the person's delete, the retry-line test fails.
  - Tests changed because behaviour changed (GM r28): every store and UI test that read the stop line from `undoNotice`/`messageNotice` and `retryScene` now reads it from `sceneStopLines` (fix3, 4, 5, 7, 10, 11, 12, 13, 14, 16, 17, 18; pr198Fix14Ui). The GM r22 Q1 popover tests now expect the line back after the popover closes. A 413 said while the popover is open shows in the state slot once it closes. "Beside" checks now expect the message slot empty and the line above. The transient line's new wording is in 12 test files. The slot order in `lateRestoreCount` adds `scene-stop`, and the copy ratchet lists the new line.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 600 files, 7,808 tests passed.
  - Full backend: 12,061 passed, 71 skipped.
  - vite build plus `check-build-budget.mjs`: 425,651 bytes raw (budget 512,000), 128,724 gzip; `dist` deleted.
- **Live** (`fix19_live.mjs`, ports 8797/5797, 0 blocked attempts in every run, no paid runs).
  - Round 19 and owndel, 23/23: merged (a merged line, a partial [Try again], the line going), twocauses and eventunder, owndelstop for server, 400 and 413 (the delete's toast alone; Undo back stopped with its line, the mark and "Restored the node."; no new retries; [Try again] saves), codexmatch, and the reviewer's owndel.
  - m1, unknown, deleted, escape, stack, m1double, toobig and bad400 in one run: 34/34. Two earlier tries broke in `stack`'s third reload ("Promise was collected", a harness evaluate, before the round 19 code ran there). One more failed m1double's two checks, which still expected the old toast and wording, and those are updated.
  - deleted13, clashback, undoclash, moved, undodel, ownundo, redoclash and clash400b: 35/35.
  - dissolve, onlyprompt, stopline, clashquiet, askedquiet, owntoasts, undidcodex, ownundoclear and wireout: 22/22.
  - Shots `fix19-*` at 1280 and 1440, 24 files, all distinct: merged-line, merged-partial, two-causes, event-under-state-slot, own-delete-stopped-{server,400,413}, undo-back-stopped-{server,400,413}, codex-match-shrinks, owndel-nothing-left.

## Fix round 20 (GM's pr198 r29, PR #198 review 18)

- **GM r29 call 3: Undo saves first.** `restoreSceneStopped` is gone. `restoreDeletedScenes` calls `restoreSceneSavingFirst` for a scene deleted while stopped that comes back still different from Nebula's. It puts the scene back with its "Unsaved" mark (the line it had, from `DeletedSceneStop.line`) and sends one save at once through the one-try path (`clashAnswerStop`).
  - If it saves, the mark goes and no stop line shows at any store update.
  - If it fails (a server error, 400 or 413), `settleSceneAnswer` puts it straight back to stopped, with its line and [Try again]. Nothing more goes by itself: no timed retries and no quiet try.
  - This replaces round 19's "back stopped, then a quiet try saves it", which showed the stop line for about 2.2 s before clearing it (review 18's GM note 2).
- **GM r29 call 2: [Try again] while its try runs.** `retrySceneSave` puts the scene in a new store map, `sceneTries` (scene → the stop it is trying out of), before it un-stops it, so no store update lacks the line. `noteSceneTry` takes it out when the try ends: it saved, it stopped again, a clash came, the scene was edited (`persistSceneParam`), or the scene left.
  - `sceneStopLines` keeps a trying scene in its line (`trying: true`), and the mark stays a button with its popover.
  - Both [Try again] buttons, in the state slot and in the popover, are `aria-disabled` while the try runs, with the label unchanged. A press does nothing, and `retrySceneSave` also returns early for a scene in `sceneTries`.
  - Why `aria-disabled` and not `disabled`: a focused button that turns disabled drops focus to the page, which is review 18 LOW-1 (a). The canvas toolbar uses `aria-disabled` for the same reason.
  - It also ends round 19's flicker, where the line left and came back during a try.
- **GM r29 call 7: reading order with a row tolerance.** `readingOrder` sorts by top, then x. A node joins the current row when its top is within `READING_ROW_SHARE` (0.25) of the row's first node's height below that node's top; each row then reads left to right.
  - For an unmeasured card that is 55 px (`UNMEASURED_NODE_SIZE.height` 220). Live, the scene cards measure 278 and 314 px, so about 70 to 79 px.
  - Why a quarter: two cards a few pixels apart read as one row, while a card a third of its height lower already reads as the next row. Review 18 suggested half, which would merge cards that look stacked.
- **Review 18 LOW-1: focus on a stop line never drops to the page** (`useStopLineFocus` in `SceneStopLines.tsx`). It acts only when focus went with the line (on the body, or gone), never when the person moved elsewhere.
  - (a) A try that fails the same way keeps the same element, so focus never moves (the line stays mounted, and the button is `aria-disabled`). A try that comes back under another cause (400 then 413) lands in a new line, and focus goes to that line's [Try again].
  - (b) A focused line that goes for good (the stop cleared by itself, or every scene saved) follows the notice stack's × rule (ProjectHome `useNoticeStackFocus`, GM pr200 r16 #2):
    - first, the stop line now in its place, else the one before, as the notice itself (stop lines now have `tabindex -1`), never its [Try again], so a second Enter can't act;
    - with no stop line left, the next notice below in the region, else the one above, onto its ×, or onto the notice itself when it takes focus (the clash prompt);
    - otherwise the canvas (`.canvas-wrapper`).
    - Focus moves by a plain `focus()`, so the ring follows the input (GM r17).
- **Review 18 NIT-1.** Two fix20 tests pin `dropRetryingLine` in `stopSceneSave` (the timed retries run out) and in `stopSceneForGood` (a retry refused 400). Removing either call fails its test.
- **Review 18 NIT-2 / GM r29 Q1.** The retrying event line is now "Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula is trying again." It is in the present tense because Nebula is retrying now, while the stopped line keeps "…will try again with your next change."
  - It is built in one place, `sceneRetryingLine(scenes)`, with the shared `quotedNames`, and is used by the refusal, `dropSceneLines` and `dropRetryingLine`.
  - `KEPT_AND_RETRYING` became `KEPT_AND_TRYING`. The named-line ratchet lists the new template in place of `${heading} ${KEPT_AND_RETRYING}`.
- **Review 18 NIT-3.** The harness `owndel` seed now includes `sceneStopLines`.
- **Docs.** MCP-SETUP covers save-first Undo, the disabled [Try again] while it runs, the reading order with its row tolerance, and the retrying line.
- **Tests.**
  - New: `graphStore.fix20` (13) and `pr198Fix20Ui` (9).
  - 21 of the 22 fail on 8c970400. The one that passes is the guard "focus the person moved elsewhere stays there".
  - The NIT-1 pair fails there only because the wording changed; the two mutations above pin them.
  - Tests changed because behaviour changed:
    - fix19's LOW-3 describe now expects save first: one save at once, and back stopped only while saving still fails.
    - The retrying line's new wording is in fix5 (and its constant check), fix6, fix7, fix8, fix12, fix19 and pr198Fix6Ui.
    - The named-line ratchet has the new template.
- **Gates.**
  - tsc -b and `npm run lint` are clean.
  - Full vitest: 602 files, 7,830 tests passed.
  - Full backend: 12,061 passed, 71 skipped.
  - vite build plus `check-build-budget.mjs`: 425,736 bytes raw (budget 512,000), 128,774 gzip; `dist` deleted.
- **Live** (`fix20_live.mjs`, from fix19's).
  - Setup: ports 8797/5797, 0 blocked attempts after the canary in every run, no paid runs. `fix20_server.py` adds `hold-put-X`, which holds the tab's save to X until the flag goes.
  - Round 20 sections, 28/28:
    - `undoback` for server, 400 and 413 (one save at once; no stop line at any store update or in the page);
    - `owndelstop` for each cause (still failing: one save, back stopped, the line never leaves);
    - `trydisabled` (the state slot and the popover, a held try, two more presses send nothing). Its line check reads the lines with the open popover set aside; the popover's own opens and closes are logged apart (GM r28 leaves its scene out of the line while it is open);
    - `focus20` (LOW-1 a and b, rings by keyboard and none by mouse);
    - `nearlevel`.
  - Regressions:
    - merged, twocauses, codexmatch and owndel: 11/11;
    - m1, unknown, deleted, escape and stack: 20/20;
    - m1double, toobig and bad400: 17/17;
    - deleted13 through clash400b: 35/35;
    - dissolve through wireout: 22/22.
  - Two runs before the split broke in `stack` with the known "Promise was collected" harness flake. That is why m1double, toobig and bad400 now run as a batch of their own.
  - Shots: 128 `fix20-*`/`fix20r-*` files.
    - One md5 pair matches: `focus-try-again-held-keyboard` and `-back-keyboard` at 1280. That is expected, since nothing visible changes between the held try and its return (same line, same focused button). Their 1440 versions differ.
- **For GM.** The notice actions have no disabled look, so [Try again] while its try runs looks like a live button. The clash prompt's buttons share this. The label stays as GM asked; whether it should dim is GM's call.

## Fix round 21 (GM's pr198 r30)

- **GM r30 item 1: the shared disabled look on every notice button.** One rule in `canvasProposals.css` covers every button inside a `.canvas-undo-notice`: the toasts, the message and late notices, the stop lines, the clash prompt, the "Unsaved" popover and the save-paused notice. It uses the app's own token (`opacity: var(--sr-disabled-opacity)`, 0.48) and `cursor: default`, with no new grey.
  - It keys on `[aria-disabled='true'][data-held-look]` for a button held while its action is on its way, and on `:disabled` for one the canvas lock disables (following, offline), which until now looked live. Hover leaves a disabled button as it is.
  - `useHeldLook(held)` (`hooks/useHeldLook.ts`) sets `aria-disabled` at once and adds `data-held-look` only after `HELD_LOOK_DELAY_MS` (150), so a try answered in under 150 ms never greys.
    - Each hold gets its own token (`useMemo` on `held`), so a grey from one hold never carries into the next. Releasing the hold drops both attributes at once.
    - There is no setState in the effect body (the react-hooks lint rule).
  - Users: the stop line's [Try again] (now its own `StopLine`), the popover's `RetrySceneButton`, and the clash prompt's two buttons (now `ClashPrompt`).
- **A clash answer being sent.** Before this round the prompt went the moment the person answered, so there was no "being sent" moment to show. Following GM r29 call 2 (a [Try again]'s line stays while its try runs), the prompt now stays while the answer's save is on its way.
  - In the store, `SceneClashNotice` gets `sending: 'mine' | 'theirs'`, set by `markClashSending` on the answer (the same prompt id, so nothing remounts and focus stays).
  - The entry's `answering` is `'queued'` until a save carries it; then it holds that save's `sendSeq`.
  - When that save settles, `endClashAnswer` takes the prompt off. If the save stopped (`setSceneStopped`), the prompt goes in the same store update that shows the stop, since a showing prompt holds the stop back (`markSceneStopped`). So no update shows neither.
  - A new clash replaces the sending prompt with a fresh one that isn't sending (`setSceneClash` clears `answering`).
  - An answer that sends nothing takes the prompt off at once: Use Codex’s on the only changed field, a refusal that waited behind the clash, or a scene that is gone. So does an answer no save will carry (nothing in flight, nothing scheduled).
  - A second press, from either button, sends nothing: the component ignores presses while sending, and `answerSceneClash` returns early.
- **GM r30 item 2.** The stop line, the popover (while its scene's try runs) and the sending prompt are `aria-busy`. A held button has no title: no reason tooltip, since it's a moment, not a lock.
- **Docs.** MCP-SETUP: the prompt staying (held) while the answer is sent, and the try's busy line and delayed grey.
- **Focus when an answered prompt goes (the coordinator's ruling on the drop flagged above).** `useAnsweredFocus` in `SceneClashNotice.tsx` hands focus on when an answered prompt leaves with focus in it, never from where the person moved. A failed save goes to the [Try again] of the stop line that took the prompt's place (stop lines now carry `data-scene-ids`). A prompt asked again goes to the new prompt. Otherwise the × rule applies: the next stop line itself, else the next notice's ×, else the canvas (`nextNoticeTarget`, now shared with the stop lines in `lib/noticeFocus.ts`). The ring shows only for a keyboard answer (a click with `detail` 0): `focus({ focusVisible })`, which live Chromium honours.
- **Review 19 LOW-1 (GM r31): a delete keeps the stop in every state.** `stopToKeep` gives the stop a delete records (`keepDeletedScene`):
  - Stopped with a known refusal: that stop.
  - Stopped with a clash waiting: the clash clears `entry.refused`, so the cause comes from `sceneStops` (still kept behind the prompt) and the line from that cause, never the mark (it carries the clash line).
  - One try out of a stop (`clashAnswerStop`): a [Try again] from `retrying`'s cause, Undo's save-first try from `restoredStop` (set by `restoreSceneSavingFirst`, cleared once the try settles).
  - So Undo, Redo, Undo while the restore's save is out, a delete during a held [Try again], and a delete with a clash waiting all come back to GM's one save, for every cause (they ran the full timed retries before).
- **GM r31 answer 1: after Undo, the clash answer is the one try.** `restoreDeletedScenes`, when it asks the clash again over a kept stop, sends nothing: `persistSceneParam` with a long debounce and its push timer cleared, then the entry is set stopped with the kept refusal, line and writer, `retries` at the limit, and `noteSceneStop` (the prompt holds the stop back). The answer's save then goes as any answer out of a stop does.
- **GM r31 LOW-2: 15 s with no answer counts as failed.** A one try (`clashAnswerStop` set when the save goes) starts a timer (`SCENE_TRY_TIMEOUT_MS`, 15 000; `setSceneTryTimeoutForTests`). If it fires while the save is still out, the save is let go (`inFlight` null, `lateTry` its `sendSeq`) and settles as a kept refusal with the stop it came from (`sceneTryTimedOut`): back to stopped, the same line, [Try again] live, so `useStopLineFocus` keeps focus on it. An answer with no response at all keeps the timer and ends the same way.
  - The late answer (`settleLateTry`): a success while nothing else is out, no clash waits and the card's `cinemaAuthoringKey` is the sent scene's clears the stop and the mark at once. After the person's edit the stop stays. A failure changes nothing (no store update).
  - A late success still records the backend's new key and base (the ok branch runs before `finally`), so the person's next change isn't refused as a clash with their own save. A late save that reaches the backend after a newer one is refused by its `ifSceneKey` when it carried one (a late failure).
- **GM r31 answer 2: a run lock refusing the one try.** In `settleSceneAnswerNow`'s kept branch, `run-lock` on a one try (or a quiet try from a stop) clears `clashAnswerStop`, `retrying`, `stoppedBy` and the stop, and goes the ordinary run-lock way: the run's line, the mark, `scheduleSceneRetry`. `backToStopped` no longer takes it.
- **GM r31 answer 3: the row tolerance is a quarter of the smaller card** (`readingOrder`: the row's first card or this one), so a mirrored pair reads the same either way round.
- **GM r31 answer 5: the run-lock and "other" lines.** `sceneSaveHeading` is "Nebula couldn’t save your changes to “X”." and `KEPT_UNTIL_RUN_ENDS` is "They’re kept, and Nebula will save them when the run finishes."
  - Run lock, before: "Couldn’t save your changes to “Opening”. They’re kept and will save when the run finishes." After: "Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will save them when the run finishes."
  - "Other" (here a 422 with no detail), before: "Couldn’t save your changes to “Opening”. Try again, or reload if it keeps happening." After: "Nebula couldn’t save your changes to “Opening”. Try again, or reload if it keeps happening."
  - The heading also leads the rendering 409's line when the backend's detail isn't a named line.
- **Review 19 NIT-1.** A clash now ends a try in the same store update that shows the prompt (`setSceneClash`), so no update shows both. Tests pin the card's mark staying a button during a try, the person's edit ending a try, and a clash ending one; each fails with its one-line mutation.
- **Tests changed because behaviour changed:** `graphStore.fix13` (review 12 L-1) waits for a prompt that isn't sending; `graphStore.fix5` and `pr198Fix6Copy` take the new heading and run-lock suffix.
- **Gates.** `tsc -b` and `npm run lint` pass. Full vitest: 605 files, 7,855 tests. Full backend: 12,061 passed, 71 skipped. The build budget passes at 426,069 bytes raw (128,887 gzip).
- **Live (8797/5797).** All 152 checks passed across 7 runs: the six round-21 batches, and a run of the new GM r31 sections (`lines21`, `timeout21`, `runlock21`).
  - Batch e first stopped in its `stack` section with a puppeteer "Promise was collected" error, which happens when the page reloads mid-evaluate. `stack` passed 7/7 when rerun alone.
  - The "before" lines were shot with the page served from 4cb3d7c1 against this round's backend (`FRONT_WT`).
- **Focus fix, checked.** The five new focus tests in `pr198Fix21Ui` fail on 4cb3d7c1, where focus drops to the page. Full vitest: 7,860 tests. Live, the clash-answer sections and `focus20` passed 68 of 68, including the new `clashfocus21`: a keyboard answer that lands goes to the canvas, ringed; one that fails goes to [Try again], ringed; a mouse answer goes to the canvas, no ring.

## Fix round 22 (GM's pr198 r32)

- **Were the run-lock and "other" lines state-slot lines? No, events.** `settleSceneAnswerNow` said both through `state.notify`: a toast in the event slot, with × and the usual reading-time hold, and only the "Unsaved" mark's tooltip kept the line after that. Nobody chose this. Both lines predate GM r28 (they come from GM r7 and r9). GM r28 moved only the stops into the state slot: 400, 413, a server error past its retries, and "kept changing". Those are the causes that end only when the person acts. The run lock clears by itself (timed retries until the run ends). "Other" had no recovery of its own: it waited for the next change and never retried. Neither was a stop (`stoppedScenes`), so both kept their old event form.
- **GM r32 answer 1: the run-lock line is not a failure.** `sceneRunLockLine(scenes)` uses the shared `quotedNames`: "Your changes to “Opening” are kept. Nebula will save them when the run finishes.", or "…to “Opening” and “Ref scene” are kept. …", and from 4 scenes "…to 4 scenes are kept. …". `KEPT_UNTIL_RUN_ENDS` is gone; `SAVES_WHEN_RUN_ENDS` is the second sentence.
- **GM r32 answer 3: both are state lines with no ×.**
  - The run lock is a `SceneStop` with cause `run-lock` in `sceneStops`, but not in `stoppedScenes`. So it isn't a stop: no [Try again] on the line, the card's mark stays a label, and the timed retries go on. `sceneStopLines` shows it unless a clash waits for that scene (the prompt asks).
  - Any other answer drops the run-lock line (`dropRunLockStop`); a save that lands drops it through `setSceneStopped(false)`. So it clears when the run ends.
  - Nothing is said as a toast any more; the line and the mark carry it.
- **GM r32 answer 2: the "other" line gets [Try again].** `stopSceneOther` stops the save the way `stopSceneForGood` does, with the line it had (wording unchanged). Its stop is `{ cause: 'other', reason, line }`.
  - `reason` is the text after GM's heading, so scenes refused for the same reason merge: `sceneOtherStopLine`, "Nebula couldn’t save your changes to “Opening” and “Ref scene”. Try again, or reload if it keeps happening.". A line the backend wrote itself (`reason` null) stays one per scene.
  - [Try again] is one try. Refused the same way, the scene is stopped again with the same line (`stopSceneOther` comes before `backToStopped`, which would make it a server stop). It clears on a try that saves, or on the person's next change, which sends again.
  - A delete keeps it (`stopToKeep`, `DeletedSceneStop.refused` takes `other`), so Undo sends one save.
- **Merge by cause.** The order is 400, server, 413, "other" by reason, then the run lock, then the one-per-scene lines ("kept changing", an "other" line of the backend's own). `SceneStopLine.retry` is false only for the run lock. With no button on that line, the stop lines' focus hand-off and the clash prompt's both focus the line itself.
- **The disabled look (GM r33 answer 2, replacing the first version of this round's single opacity).** Review 20 NIT-2's correction: before this round, notice buttons the lock disables did not look live. `[data-offline-disabled]` and `[data-following-disabled]` in App.css already gave them opacity 0.6 and a not-allowed cursor; round 21 then made them 0.48 inside notices. The ones that really looked live were the run-lock-disabled buttons and the busy `OpenCopyButton`.
  - GM r33: the disabled look is not one whole-control opacity. One token set sits in the shared stylesheet (`slava-restraint.css`, under `body.app-slava-restraint`):
    - `--disabled-label: var(--sr-ink-light)`, the neutral grey at 0.55, for text-button labels;
    - `--disabled-fill: rgb(255 255 255 / 0.42)` and `--disabled-fill-label: rgb(17 17 17 / 0.62)`: the grey fill of round 21's held [Try again] (0.9 white at 0.48 over the notice's surface came to about the same grey), with a dark label;
    - `--disabled-opacity: 0.45` and `--disabled-filter: grayscale(1)`, for image-only buttons. No notice has one, so nothing reads them yet; they're for the sweep.
  - Every notice button that is held (`[aria-disabled='true'][data-held-look]`) or locked (`:disabled`) reads them, in `canvasProposals.css`:
    - filled (`__action`: [Try again] on the stop line and in the popover, Keep mine, Undo/Redo, Open copy while busy): the grey fill, its edge the fill itself, so never brighter than the enabled edge (0.85 white);
    - ghost (`__action--quiet`: Use Codex’s): no fill, its enabled edge (0.28), the grey label;
    - × (`__close`): the grey label, no fill.
  - In every case `opacity: 1` (App.css's lock dim of 0.6 gives way inside notices), hover changes nothing, and the cursor is never a pointer (default; the lock's `not-allowed !important` still applies).
  - `--sr-disabled-opacity` itself is still a whole-control opacity on text buttons across the app (asset-move, asset-proposals, asset-trash, character-studio, cinema-studio, commons, project-home, settings, slava-restraint, workspace-header). Moving those to the label token is the pressed-state sweep's, as GM said; this PR doesn't widen.
  - Ratchet (`pr198Fix22Ui`): in the 15 style files this PR touches, any literal opacity (or a literal var() fallback) in a disabled, held or locked rule fails unless it is in `KNOWN`, the 10 already there. A removed one must leave `KNOWN` too, so the list only shrinks. The notice rules have no 0.6 or 0.48.
  - The sweep's list, the other style files with literal disabled opacities, 52 rules in all, these 10 included: run-history (5), panels (5), cinema-studio (5), character-studio (4), create-gallery (3), project-home (2), moodboard-studio (2), canvas (2), canvas-toolbar (2), App (2); one each in world-preview, remotion-editor, provider-readiness, prompt-dialog, personal-agents, paper-source-node, nodes, mask-painter, create-studio, commons-evaluation, command-palette, chat-model-picker, canvasProposals (`.proposal-bar__button:disabled`), canvas-next-steps, batch-node, asset-proposals, asset-move, components/projects/ProjectSwitchToast.css, components/CanvasTabs.css and components/agent-notes/agentNotes.css. Separately, `moodboard-studio.css`'s `.moodboard-tile--set-aside { opacity: 0.48 }` is a set-aside tile, not a disabled look.
- **Review 20 LOW-1: every timed-out try is tracked.** `lateTry` held one `sendSeq`, so a second try past the bound overwrote it. The first try's late answer then took the normal path: a late 500 started the timed retries ("…is trying again." beside the stop line), and a late 200 cleared the stop while the person's edit was still out. `lateTries` is now a set: each let-go save's answer goes to `settleLateTry` (a late success with that try's values unchanged, nothing else out and no clash, clears the stop; a late failure changes nothing), and none of them touches `inFlight`.
- **GM r33 answer 1 (review 20 LOW-2): a held clash prompt waits 15 s at most.** Pressing an answer starts `answerTimer` (`SCENE_TRY_TIMEOUT_MS`). When it passes, `clashAnswerTimedOut` ends the answer: the prompt goes, the answer stands (the card keeps it), and the save carries on as an ordinary save (saved later, nothing shows; failed, its own stop line). For a stopped scene's answer (`clashAnswerStop`) that is out, the one try's own bound governs: `setSceneStopped` puts the stop back in the same update as the prompt goes. No new copy.
- **GM r33 answer 3: a run-locked one try that still fails after the run is one try.** The branch where a run lock meets the one try now keeps `runLockTry` (who stopped it). The save after the run counts it as the one try (`answeredStop`): 500 → `backToStopped`, 400/413 → `stopSceneForGood`, other → `stopSceneOther`, each with its line and [Try again] and no timed retries. A save that lands, any other refusal, the person's edit or [Try again] clears it.
- **Review 20 NIT-1: the untested branches.**
  - Nothing is sent before the answer to a clash that Undo asks again.
  - The one try's bound on a stopped scene's clash answer (the prompt gives way to the stop line in one update).
  - A run lock on the stopped scene's own quiet try.
  - Focus on a re-asked prompt (ahead of a toast's ×), focus the person moved staying where it is, and the × rule's same-slot search.
  - The reviewer's mutations, rerun against them:
    - caught: `runLockClear`, `answeredFocusAgain`, `answeredFocusSteal` and `noticeSameSlot`; so are my own `lateOneOnly`, `answerNoTimer` and `runLockNotOneTry`;
    - still equivalent:
      - `askAgainSends`: the 60 s timer is cleared at once, and even with that clear removed too, the stopped flag set right after holds the save back (`askAgainNotStopped` is caught);
      - `endOnTimeout`: `setSceneStopped` also ends a sending prompt, and the new answer timer does too. Removing both the timer and `endOnTimeout` is caught.
  - Not testable: `answerTimerNoYield`, the guard that leaves an out one-try's prompt to its own bound. It matters only if the press timer fires before the send's timer, and the send's timer is set first with the same delay.
- **Tests changed because behaviour changed:** `graphStore.fix5` (a paid start, an approved run and "any other refusal" now read the state line, not a toast; `sceneRunLockLine` replaces `KEPT_UNTIL_RUN_ENDS`), `graphStore.fix21stops` (the run-lock try's line is a state line), and the copy ratchet (the stale `KEPT_UNTIL_RUN_ENDS` entry replaced by the "other" line's template). GM r33: `pr198Fix21Ui`'s held-look test now reads the token set (opacity 1, the grey fill) instead of `--sr-disabled-opacity`. This round's own first disabled-look tests in `pr198Fix22Ui` were rewritten the same way, and their 0.48 ratchet became GM r33's literal ratchet. The live `held21`, `clashsend21` and `following22` checks read the computed fill, label and edge.
- **Live:** `runlock21` now reads the state line. `lines21` (round 21's before and after shots) is superseded and no longer runs.
- **Gates (final):** `tsc -b` and `npm run lint` rc 0. Full vitest 609 files, 7,896 passed. Backend 12,061 passed, 71 skipped. Build budget 426,069 raw / 128,890 gzip.
- **Pinning on 4cafec5a:**
  - 25 of the 36 new tests fail there, every changed behaviour among them.
  - The 11 that pass guard behaviour that already held:
    - the five NIT-1 branches;
    - three LOW-1 orders, where the last or the successful answer happened to come out right;
    - the run lock's "lands" case;
    - the ratchet's self-test and its notice check.
- **Live (SLOW=2, ports 8797/5797):**
  - The first batch of this round: a2 35/37, c 11/11, e 16/17, e3 14/17, f 35/35, g 22/22. Rerun alone, each failure passed: m1double 6/6; held21, clashsend21, timeout21 and clashfocus21 16/16; stack 7/7. They were order and timing flakes (review 20 NIT-3).
  - GM r33: held21, clashsend21, following22, twotries22, clashbound22 and runlockfail22 15/15. In twotries22, both tries were let go at 15 s. In clashbound22, the prompt went at about 15 s and the save landed later.
  - runlock21, runlock22, other22 and timeout21 15/15.

## Fix round 23 (PR #198 review 21, GM's pr198 r34)

- **Review 21 LOW-1: the save after a run that is still the one try has the 15 s bound.** Round 22 kept `runLockTry` for GM r33 answer 3, but armed the try's bound only for `clashAnswerStop`. A post-run save that hung (or got no answer) left "Nebula will save them when the run finishes." up after the run, with no [Try again].
  - `flushCinemaScenePersistence` now arms the bound for `clashAnswerStop ?? runLockTry`.
  - `sceneTryTimedOut` accepts a run-lock try and settles it as a server failure out of the one try, so `settleKeptAnswer` calls `backToStopped` with the try's `by`: the stop's line and [Try again].
  - Its late answer goes through `lateTries` and `settleLateTry` like any try's.
  - A run lock on an ordinary save (not a one try) still has no bound, as any ordinary save.
- **Review 21 NIT-1: the run line gives way to a stop in one store update.**
  - The kept branch is now `settleKeptAnswer`, called inside a try/finally. The run line drops (`dropRunLockStop`) after the answer is handled. It does nothing once a stop has replaced the run line, and still drops it for "moved", "replaced", params-outdated and the server retries.
  - That alone didn't do it: `setSceneStopped` wrote `sceneStops` and `stoppedScenes` in two updates, and the first showed a stop with no line. It now writes both in one `setState`.
  - Pinned at store level: the post-run 400 and "other" go [run line] → [stop line]; the post-run hang goes [run line] → [server stop line].
- **GM r34 Q2: an "other" stop gets one quiet try per stop.** `stoppedForGood` still covers only 400 and 413, so another writer's change schedules the quiet try for an "other" stop. When it fires, `quietSpent` is set, and `scheduleQuietRetry` returns while it is. The person's edit, [Try again] or clash answer clears it, and so does a save that lands. Failing, the scene is stopped again and waits for the person, with no cycle. `stopSceneOther`'s comment says so.
- **GM r34 Q3: only Nebula's own reason merges.**
  - `sceneRefusal` now returns the "other" reason as data: `OtherReason { text, nebula }`.
    - `text`: what follows GM's heading. It is null for a whole line the backend wrote, which stays as written.
    - `nebula`: Nebula wrote the reason (no detail came, or the person-only copy).
  - The data goes on the entry (`refusedReason`), into the stop (`{ cause: 'other', reason, nebula, line }`), the [Try again] snapshot (`retrying`), a deleted scene's stop (`DeletedSceneStop.reason`) and a restore.
  - `sceneStopLines` merges "other" only when `nebula`. A backend reason gets a line per scene, even with identical text.
  - `otherStopOf`, which re-parsed the reason from a line against the current heading, is gone. That re-parse caused review 21's NIT-3 rename split.
- **GM r34: names read live.** `stopLineText(stop, names)` builds every state line from the cards' names at render, merged lines included, and so does `sceneStopShown`, the one stop-shown rule. `sceneMarkLine` gives the "Unsaved" mark its stop's line for that scene, with the live name. `CinemaSceneNode` uses it ahead of the stored text, which stays for lines that aren't states (the retrying event line, a clash's).
  - A rename during a try: no store update shows the new card name with the old one in a line or the mark.
  - A rename while stopped, and on a merged line.
  - Live `rename23`: the line updates at once while still busy, and refused again it keeps the new name, in the line and the mark.
- **Review 21 NIT-5: tests for the untested branches.**
  - The run line dropped by another refusal: an ordinary save's post-run 500 gives the retrying line and no run line.
  - "other" before the run line whatever the reading order.
  - Focus onto a line with no button:
    - from a stop line's [Try again];
    - from an answered clash prompt, with another scene's 400 line ranked first in the slot, so the × rule alone would land elsewhere.
- **Review 21 NIT-6: flaky tests made to wait.**
  - `pr198Fix22Ui` waits for the merged run line before it reads the single one gone.
  - `pr198Fix21Ui`'s 150 ms test flushes microtasks until the hold lands, without moving the fake clock.
  - `pr198Fix22FocusUi`'s "asked again" waits for focus.
  - I could not reproduce either of the latter two in 60 repeats under load. The waits make them depend on order, not timing.
- **Mutations against the new tests:**
  - Review 21's untested ones are now caught: `dropRunLockNone`, `rankSwap`, `lineFocusSelf` and `clashFocusLine` (after the 400 line was added).
  - So are mine:
    - the bound not armed, and `sceneTryTimedOut`'s guard without `runLockTry`;
    - the drop moved back to the top (after the watch was seeded with the current lines; it had hidden a first empty frame);
    - `setSceneStopped` split back into two updates;
    - `quietSpent` unchecked, unset, or not cleared by [Try again];
    - merging a backend reason, or a backend reason marked Nebula's;
    - the mark not live;
    - a merged line with stale names.
- **Ratchet widening (review 21 NIT-4)** goes to the pressed-state sweep, as GM ruled.
- **Tests changed because behaviour changed:** `graphStore.fix22` (the 422 stop now carries `nebula: true`); `pr198Fix22Ui`'s "other" states (`nebula: true`); the three NIT-6 waits.
- **The full gate caught a ratchet hit the targeted runs missed.** `sceneRefusal` first told "a reason under the heading" from "a whole line" by comparing with a hand-built `` `${heading} ${reason}` ``, which `errorCopy.namedLine`'s ratchet forbids. It now asks the same thing without building the line: both sides non-empty and `headedLine` didn't return the reason alone. The behaviour is unchanged; the ratchet and the Q3 tests pass.
- **Pinned on a3371c4d** (the new and changed tests copied onto the old commit): 15 of 51 fail there, all 13 of the fix23 store tests that test new behaviour, the live mark in `pr198Fix23Ui`, and `graphStore.fix22`'s 422 (now `nebula: true`). Five new tests pass there and stand as guards: the two NIT-5 focus paths, the rename-in-the-line UI test (the line was already built at render; the mark and the store lines weren't), Nebula's own reasons merging, and a quiet try again after the person acts.
- **Gates.** `tsc -b` and `npm run lint` pass. Full vitest: 611 files, 7,915 tests. Full backend: 12,061 passed, 71 skipped. Build budget 426,128 bytes raw (128,922 gzip), up 59 from round 22.
- **Live (8797/5797):** the round 23 sections (`runlockhang23`, `rename23`, `otherquiet23`) and round 22's run-lock and "other" ones 17/17, and again after the ratchet fix. The batch of round 12–22 sections: 41/41, 11/11, 20/20, 17/17, 35/35, 22/22, and h 12/14. h's two misses were `held21`'s 150 ms timing checks while tsc, lint and the a3371c4d run shared the machine; h alone passed them, then lost a page promise in `following22` (a Puppeteer protocol error), which passed 4/4 alone.

## Fix round 24 (PR #198 review 22, GM's pr198 r35)

- **Review 22 LOW-1: a one try with no answer goes back to its own stop.** `sceneTryTimedOut` gave a run-lock try (the save after the run) `stop = null`, so a 400, 413 or "other" stop came back as a server stop. It lost its line, and the next Codex change earned it a quiet try.
  - Every one try now carries the stop it came out of: `clashAnswerStop.stop` ([Try again], a clash answer, Undo's save first) and `runLockTry.stop` (from the try the run held, or the stop a quiet try was in).
  - At the bound, the try settles as that stop's kind, with its line and reason. The kind's own rule then applies.
  - The reviewer's `timedOutKeepAlways` mutant now fails 7 tests.
- **Review 22 LOW-2: a stop put back whole.** One helper, `putBackStop`, puts a deleted scene's stop back on both ways back (asked again behind the prompt, and Undo's save first). It restores the kind, line, who outpaced it, the "other" reason and whether the quiet try was spent; `stopToKeep` now records that last one.
  - A clash answer also records the stop it came out of. Before, the answer had cleared `refusedLine`, so a hung Keep mine came back with an empty line.
  - `stopLineText` never renders an empty "other" line; with no line kept it falls back to Nebula's own.
- **Review 22 LOW-3: the mark during timed retries.**
  - `markSceneUnsaved(…, retrying)` notes in a new `retryingMarks` map that the mark is the retries' line. It writes this in the same update as the mark, and every other write clears it.
  - `sceneMarkLine` then says the retry line with the card's current name, but only while the mark is still that line.
  - The retry toast is an event (GM r28) and keeps the name it was said with; see the open question.
- **Review 22 NIT-1.** `setSceneStopped(…, false, then)` writes the run's line in the same update as the stop goes, for a stopped scene's quiet try that a run holds.
- **GM r35 Q1 (review 22 NIT-2).** `setSceneStopped` clears `quietSpent` for any stop that isn't "other". This one rule replaced three per-path resets, two of which (400/413 and the timed-retries stop) were unobservable. A 500 after an "other" stop's quiet try is a server stop, so the next change makes a quiet try; a 400 after that waits.
- **GM r35 Q2 (review 22 NIT-3), sized: nothing to restructure.**
  - The person's scene save is `PUT /api/graph/node/{id}`. Its refusals that name a node are all 400s (`_check_asset_refs`, `_check_provider`, the param checks): Nebula writes its own line for a 400 and only logs the detail. The other one is `_refuse_agent_internal_params`'s 422, which is agent-only and uses the node id.
  - The rest name no scene: `CANVAS_OUT_OF_DATE` and the coded 409s, the 507 paid-fence refusal ("Cannot update graph node parameters because …"), and the recovery-storage 507.
  - The review's named line ("Couldn’t save “Opening”. It’s locked by the review.") came from the harness, not the backend.
  - A line the backend writes whole is still shown as written; no regex. Agents read the backend's own text through MCP, which is unchanged.
- **Review 22 NIT-5: the surviving mutants.**
  - The edit's and the clash answer's resets of the spent quiet try each have their own test now. Each resend is refused the same way, so no landed save covers the reset.
  - `keepReasonDrop` is pinned by the save-first hang (the Nebula reason merges with another scene's again).
  - `otherReasonKeep` and `otherRunLockKeep` mutated code that is gone. `stopSceneOther` now takes its reason always: every "other" answer carries one, and a timed-out try passes its stop's. It no longer clears `runLockTry`, since the kept case already does that for every answer that isn't a run lock.
  - `restoreReasonDrop` and `quietNoClearClash` had only been "killed" by the ratchet scanner timing out under load; both are pinned for real now.
  - `quietNoClearOk` is equivalent. After a save lands nothing is stopped, and the next stop needs a save that only the person's edit, [Try again], a clash answer or a restore sends. The first three reset `quietSpent`, and a restore sets it from the stop it kept.
- **Tests changed because behaviour changed:** none. The round 12–23 files pass unchanged.
- **Mutations (148 tests: the round 20–24 store and UI files).**
  - Killed, each by its own test:
    - the timed-out try's stop (`timedOutKeepAlways`, the old null, the line guard, the reason);
    - `runLockTry.stop`, the clash answer's stop, `putBackStop`'s reason and quiet try, `stopToKeep`'s quiet try and `keepReasonDrop`;
    - the kind reset, NIT-1's `then` (both ends), the retrying mark (writer, reader, and reading any mark), the empty-line fallback;
    - the edit, clash-answer and [Try again] resets.
  - The first runs of `putBackNoQuiet` and `keepNoQuiet` survived because the save-first test let its late answer land, which cleared the stop before the check. The late answer is now refused, and both are killed.
  - Equivalent: `quietNoClearOk` (above), and `retryNoStop` ([Try again] without `stop`). While the try is out, `retrying` holds the same stop, and `stopToKeep` rebuilds it from that. The capture stays so the bound doesn't depend on `retrying`'s lifetime.
  - Some kills were joined by focus UI tests timing out at about 5 s under the run's load; each mutant also fails its own test.
- **Pinned on 1077150e:** 14 of the 17 new tests fail there. Three pass and stand as guards: the server stop (already right), and the edit's and clash answer's resets (already there, now pinned).
- **Gates.** `tsc -b` and `npm run lint` pass. Full vitest: 613 files, 7,932 tests. The first two full runs each had one unrelated timeout (`MaskPainterPortal.round10`, then `modalStyles.round11`); this Mac's load average was 57–79 from other sessions, and both pass alone. The third run, at a lower load, passed clean. Full backend: 12,061 passed, 71 skipped. Build budget 426,128 bytes raw (128,915 gzip).
- **Live (8797/5797):**
  - New sections: `hang24-400`, `hang24-413` and `hang24-other` (back at the 15 s bound with their own line; a late refusal changes nothing; Codex's change then sends nothing for 400 and 413, and one quiet try for "other" after [Try again]) and `retrymark24` (the mark says "Opening IV" at once while retrying).
  - With round 22–23's sections: 24/25. The miss was my harness reading the label from the card's text (the header shows "Cinema Scene"); it now reads the store, and passed 5/5.
  - Regression batch: c, e, e3, f and g all pass. a2 was 37/41 and h 13/14. `clashsend21` (prompt never asked in a2) passed alone.
  - `held21`'s fast-try check (no grey look if the save answers within 150 ms) failed alone too, so I compared frontends on the same backend. The try took 127–348 ms on both, and 1077150e failed it 2 of 4 times. The backend round trip on this machine is right at the 150 ms threshold, so this is not round 24.
- **Open:** the retry toast ("…Nebula is trying again.") is an event (GM r28) and keeps the name it was said with after a rename, while the mark now follows the rename. Should it follow too?

## Merge of origin/main (#200, a8798dc4)

Both PRs' behaviour kept: a union in every hunk. Read #200's side first (its notes: `docs/notes/2026-10-27-fix-agent-presence-followups.md`).

- **Canvas lock.**
  - `LockOwn` (#200: `offline` verbs and `lock.title(own)`) and `act(own, { run, runTitle })` (#198's run lock) are both on `CanvasLock`.
  - `lockedAction` keeps #200's per-control verb when it names no verb of its own.
  - Cinema follows GM's later ruling (PR #200 r2 item 4), so three of #200's own verbs give way there:
    - "send it to motion", not "send to motion";
    - no tooltip on the prompt (a text field goes read-only), not "edit the prompt";
    - the generic line on a reference's ×, not "remove references".
  - #200's other verbs ("add swatches", "send notes", "rerun") stay as #200 shipped them.
- **One offline line.** `useBackendOffline.reconnectsLine` builds it. `offlineReason` (#198, typed verbs) and `errorCopy.offlineDisabledReason` (#200, any verb) both call it. `OFFLINE_RERUN`, `OFFLINE_RETRY` and `OFFLINE_RECOVER` are now `OFFLINE_VERBS` entries.
- **Run history's Rerun, Retry and Recover.** They use `lockedAction(…, { run: isExecuting })` with #200's offline verbs.
  - **Conflict:** while a run goes, the tooltip reads #198's one run line, "Wait for the active run to finish." (GM r9 answer 3). #200 kept "Wait for the run to finish first." here, the base's text. Both can't stand; this follows GM r9's one line everywhere.
- **Name lists.**
  - Canvas order (#200, GM answer 3) with #198's curly apostrophe ("Couldn’t save …") and nodeNameList grouping.
  - This covers `savingCutOff`, `placeholderRunConfirm` (whose canvas order replaces #198's row order, per GM r2 item 3) and the no-answer delete line.
  - Duplicate `inCanvasOrder`: #198's stays.
- **Cinema shots, backend (`_author_cinema_scene`).** A returning shot gets its media back two ways:
  - from the trusted undo's own copy (#198 `returning_media`);
  - or, for any other write, from what the server kept when the shot was taken out (#200), when its prompt and settings match.
  - Either way, a newer image a run landed after the shot left (its live `shot_<id>` port) wins. Before, #200's kept port overwrote that newer image.
  - The kept entry is consumed in both cases.
  - New tests: `test_merge_*` in `test_cinema_scene_authoring_persistence.py`. The late-image one fails with the late-port branch taken out (origin/main's code).
- **Disabled look.**
  - #198's Cinema offline rule (cinema-studio.css) now reads #200's tokens, `--sr-disabled-ink` and `--sr-disabled-edge`. The 12% outline it had is the one GM 2026-10-28 answer 3 replaced.
  - The shot ×'s hover is #200's neutral ink (GM r12). Its disabled opacity (#198) went, since #200's shared rule covers it, and the ratchet's KNOWN list dropped that entry.
  - #198's App.css `[data-offline-neutral]` rule is now `button[data-offline-neutral]` (only buttons carry it). A bare attribute rule reads as `*` to #200's loose cascade, which hid every ancestor's background from the frame check, so GM r18's corpus probe stopped being caught.
  - **Open (a GM call):** #198's notice buttons (canvasProposals.css, GM r33 tokens), the Cinema fieldset's dimming and the clip presets keep their own disabled look. They're listed in #200's `SWEEP_LATER`.
    - The ghost grey is the same in both (white at 0.55: `--disabled-label` = `--sr-ink-light`, and `--sr-disabled-ink`).
    - The filled look differs: #198's is a 0.42 fill with a dark label, #200's a 0.1 fill with a grey label.
    - #200's held proposal-bar buttons are already in #200's shared rule. The asset strip's held card has no buttons. Moving #198's notice onto #200's filled look, or the reverse, changes a GM-approved look, so it's not done here.
- **The canvas notice's buttons (found live).**
  - #200's shared filled rule lists `.canvas-undo-notice__action` and greys it, with `!important`, the moment it is `aria-disabled`. That broke #198's GM r30/r33 notice look on the merged tree:
    - a held [Try again] or Keep mine greyed at once, not after the 150 ms hold;
    - the quiet choice (Use Codex’s) was filled;
    - the filled grey was #200's 0.1 fill instead of the r33 0.42 fill with a dark label.
  - Live `held21`, `clashsend21` and `following22` failed on it.
  - The notice's own rules in canvasProposals.css now carry `!important` at a higher specificity. A button that is held but not yet greyed keeps its enabled look.
  - Live and pr198Fix21/22 pass again. Those two tests now compare values without the `!important`, and check that it's there.
  - **Open, the same GM call as above:** which filled disabled look is the app's.
- **#200's ratchet G and #198's lock forms.**
  - G now reads #198's forms: `lockedAction(lock, …)`, a local helper that returns `lock.act(…)` (`runLocked`), and an `act` prop handed down (the clash prompt, the stop line).
  - Two `CONTROL_AT` entries have reasons: the stop line's focus tracking, and Home's copy notice (locked by `busy || offline`).
  - `reachOf` follows a file's own definitions from a worklist. The recursion overflowed the stack on the first, cold-cache file (App.tsx), even with origin/main's own App.tsx.
- **Tests changed because behaviour changed (#200's, to the merged copy):**
  - r1: Send to motion's verb, and the prompt's lack of a tooltip;
  - r1, store, r2store, nodeNameList: the curly "Couldn’t". r2store's `/Couldn't save/` filter would otherwise have passed vacuously;
  - ProjectHome.unsavedEdits: both curly apostrophes;
  - round23Lines: "2 “Text” nodes".
- **#198's tests changed:**
  - pr198Fix5Offline: the verb list gained retry and recover, and the merge-check rule reads the tokens;
  - pr198Fix22Ui: KNOWN dropped the shot ×'s opacity.
- **Other ratchet updates:**
  - errorCopy.namedLine: deleteCopy's entry takes #200's form, and #200's note composer's accessible name (`${headingText} ${targetNode}`) is reviewed, since it's no failure line.
  - G's describe timeout is now 300 s. G alone took 110 s, and it timed out at 120 s in the full suite at a load average of 68.
- **Live harness:** `held21`'s fast try is deterministic now. It checks the order of events: the grey shows only once 150 ms pass with no answer (the PUT's `responseEnd` from resource timing, on the observer's clock). It doesn't time the backend.
- **Gates (merge).**
  - `tsc -b` and lint are clean.
  - Full vitest: 657 files, 8,405 tests. 3 failed and were fixed (G's timeout, two namedLine entries); those files and every test that reads the changed CSS pass on rerun.
  - Full backend: 12,185 passed, 71 skipped.
  - Build: 442,969 bytes raw (136,030 gzip).
  - Live on 8797/5797, #198's batches: a3 41/41, c 11/11, e 20/20, e3 17/17, f 35/35, g 22/22, h 14/14, r1 25/25. #200's `r34` and `r30` sections: 19/19 (held tab, promote, placeholder and real card in place, note heading on a node, held run release over a reload).
- **Checked:** "Undid Codex’s edit." and "Codex changed the canvas." keep their periods, both in canvasUndo and through `agent_line`, `agent_text` and the channel's `clean_text`.

## Fix round 24b (GM's pr198 r36)

- **The retrying line is a state (Q1).** "Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula is trying again." left the event slot (a toast) for the state slot.
  - It is a `SceneStop` of its own, `{ cause: 'retrying' }`, drawn by `sceneStopLines` like the other lines Nebula writes. It reads the names live, so a rename shows at once, and it merges across scenes in reading order.
  - It has no [Try again], no × and no timer, the same as the run-lock line: Nebula is acting on it by itself.
  - It sits in the stop line's place. A server error out of a stop moves stop → retrying in one `setSceneStopped(…, false, { cause: 'retrying' })`. Running out of retries goes back to the stop in one update. An answer that isn't a server error drops it in the update that settles that answer (`dropRunLockStop` covers both lines now). A clash prompt takes its place in the same update. A save that lands clears it (`markSceneUnsaved(null)`). A deleted scene takes it along, like the stop line.
  - The person's next change after a server stop is the try that line promised ("…will try again with your next change"), so that change, and a reconnect's resend, show the retrying line in the stop's place, in one update. `retryPromised` limits this to server stops with no clash asking and no other writer behind the stop. A 400, 413, "other" or outpaced stop clears as before (GM r32).
  - `dropRetryingLine` is gone: no toast holds that line any more. `dropSceneLines` now drops only the kept line.
  - Past-tense event toasts keep their text and their slot.
- **Tests.**
  - New `tests/store/graphStore.fix24b.test.ts`, 7 tests: the state slot with no button and no toast; stop → retrying → stop; retrying → 400; a rename during the retry; two scenes sharing one line; a clash taking its place; a deleted scene. Each records every store update's lines, so a frame with an empty slot fails. All 7 fail on f674500e.
  - Changed because the behaviour changed: fix5, fix7, fix8, fix12, fix19, fix20 and fix23 expected the toast, or a stop line that cleared before the retry. They now read the state slot. fix5's server-error test records the line's frames instead of sampling at 40 ms, which had raced the suite's 30 ms retry.
- **Live:** a new `retrying36` section in the harness. It checks the line's slot (no button, × or timer, no toast) and a Codex rename during the retry (the frame where the label changes already has the new name). It then follows stop → retrying → stop → retrying → cleared through the person's edits, each in one update. Shot: `fix24b-retrying-line-after-rename`.
- Not agent-visible: the MCP tools and the channel don't carry this line, so MCP-SETUP.md is unchanged.
- **Gates (r36).**
  - `tsc -b` and lint are clean.
  - Full vitest: 658 files, 8,412 tests.
  - Full backend: 12,185 passed, 71 skipped.
  - Build: 442,969 bytes raw.
  - Live on 8797/5797: n (retrying36, retrymark24, twotries22, rename23) 11/11, a 41/41, c 11/11, e 20/20, e3 17/17, f 35/35, g 21/22 then 22/22 on rerun, h 6/6, r1 21/21.
  - g's one miss was `askedquiet` (`asked: false`): Codex's edit landed before the person's failing save was held, so no clash was asked. It passed alone and in the full g rerun. The section doesn't touch the retrying line.
