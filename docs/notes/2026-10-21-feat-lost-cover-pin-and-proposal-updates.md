# 2026-10-21 — A lost cover pin stops counting, and every asset proposal posts an Update

Branch `feat/lost-cover-pin-and-proposal-updates` from origin/main 6f9489dc (after #129, asset proposals). Justin's answers to Q90 and Q92.

- **Q90, what changed.** Justin: "a) It stops counting: agents may set a cover directly, and your next pin counts again." A pinned project cover counts only while its image is still one of the project's choices, using the same test the cover picker lists by (`project_cover.is_choice`, now wrapped as `pin_counts`). For the open project, the test reads the live canvas, not the saved snapshot, which lags it. When the pin stops counting:
  - the cover is automatic everywhere: `list_project_covers`, `get_project` and the card all say so;
  - nobody owns the cover any more, so an agent's `set_project_cover` applies directly;
  - the old pin is named as `lostPin: {url, by}` (`coverLostPin` on the card), so the picker and the strip can say "The image you pinned is no longer in this project, so the cover is automatic." The strip never shows "You pinned" over an image that is gone.
- **The stored pin is kept.** Nothing deletes `coverPin`. Whether it counts is worked out each time from whether its image is there, so Cmd+Z on the deleted node makes it count again. Two exceptions:
  - an agent resetting the cover to automatic leaves a lost pin's record alone (the cover is already automatic, so nothing changes and nothing is journaled);
  - the person clearing the cover, or the person's next pin, replaces it.
- **Q92, what changed.** Justin: "a) Keep the wording, and each proposal also posts an Update ("Claude Code asks to change the cover of X", with Review)." Every asset proposal (a cover, Send notes, a Commons curation) posts one Update through `agent_notes`:
  - It's attributed to the proposing agent, with `source: "nebula"` and `about: "proposal"`, and has one action, `proposal.review`.
  - Nebula writes the text from names only, never the agent's note or the board's text: "… asks to change the cover of X", "… asks to send X's notes to generators", "… asks to make N changes to a reference in the Commons", "… asks to take a reference out of the inbox".
  - Review goes to where the person decides. For a cover, that's Projects, where the strip scrolls to the middle of the screen, takes focus and shows a 1.6 s ring on the `--agent-log-spring` token (reduced motion gets a plain outline). For Send notes it's Moodboard Studio on that board, and for a Commons change it's that reference's detail.
  - The Update resolves on accept, reject, withdraw, expiry or invalidation, with a short outcome line: "Accepted: the cover changed", "You kept your cover", "Withdrawn by Claude Code", "Expired" or "No longer fits". The person's reason for a reject never goes in it.
  - The proposal view and brief carry `update` (the note id). `start_here` lists open asset proposals with their Update, `list_notes` shows `outcome`/`resolvedAt`, and `nebula notes` prints `[outcome]`.
- **Decision: an open proposal whose pin lost its image stays open.** The strip shows it against the automatic cover, plus the lost-pin line. Accept still applies it, and the result counts as the person's pin. Closing it would surprise more: an undo brings the image back, and the agent would have to ask again. `before`/expect compare against the stored pin, so an undo doesn't invalidate it either. One exception (from review): a proposal back to automatic. Once the pin's image is gone it changes nothing, and accepting it would only delete the stored pin an undo brings back, so it closes as "No longer fits", the same as the 409 a new one gets.
- **Decision: one Update per agent and target.** A new proposal from the same agent on the same project, board or reference replaces that agent's earlier Update on it, even one that has already resolved. The list keeps one line per ask instead of stacking, and the journal keeps the history. When an agent withdraws one proposal while another of its proposals on the same target is still open, the Update re-points to the open one (`changed` op) instead of resolving.
- **Decision: the Update lives in the project it was posted in.** Updates are stored per project (`agentNotes`), so a proposal made while no project is open posts no Update. The proposal still opens, and its view's `update` is null. An outcome resolves the note in its own project, and the socket broadcast goes out only if that project is the one open.
- **Board covers (the gap Justin asked about).** Removing a board's cover image already clears `coverImageId` (`moodboard_store.follow_cover`), so a board can't hold a lost pin. But board covers have no owner at all. The PR3b follow-up ("a cover the person chose counts as pinned; an agent's change becomes a proposal") was planned and not built in #129. Agents set board covers directly today. Not built here; flagged below.
- **Surprise: the Updates corner is canvas only.** The brief said every screen, but `AgentNotes` mounts only on the canvas. So Review from the canvas opens Projects, and the Projects screen itself shows no corner.
- **Fixed on the way.** The corner's `actionState` treated any proposal note as a canvas proposal, so an asset proposal's Update read "Expired" straight away. It now applies only to `proposal.accept`/`reject`.
- **Tradeoffs.**
  - The review helpers (`lib/assetProposalReview.ts`, `store/assetProposalReviewRequest.ts`) live outside the eager proposals store and are listed in `DEFERRED_MODULES`. Entry growth is +645 bytes raw: 509,461 → 510,106 of 512,000. A first try sat at 510,256.
  - The strip's review ring uses a DOM `data-review` attribute and a ref timer rather than React state, because the lint rule forbids setState in an effect.
  - The "Automatic now" side of a cover proposal still shows the "Newest image" placeholder (unchanged from #129) rather than the automatic cover itself.
- **Tests (written first).**
  - Backend: `test_lost_cover_pin.py` (14), `test_asset_proposal_updates.py` (13) and `test_commons_proposal_updates.py` (2). Before the change, 25 of the 28 non-CLI tests failed (404s, missing `lostPin`/`update` keys, 403 where an agent should now set the cover, no notes), and both CLI tests failed on the missing outcome and the missing lost-pin line.
  - Frontend:
    - extended: the strip (lost pin, review scroll and focus, other target left alone), the socket relist refresh, the store `refresh`, `agentNotes` sanitize/labels, `ProjectHome` lost pin, and the Updates corner (5: Review on a cover/board/Commons, outcome shown, no "Expired");
    - new: `assetProposalReviewRequest` and `commonsReviewRequest`.
    - 12 failed first (`refresh`/`requestReview` not functions, no outcome, no lost-pin line, the corner saying "Expired"). The Commons review test failed with its effect commented out.
- **Live check.**
  - Setup: isolated backend on 8817 (temp HOME, every `NEBULA_*` root in scratch, keys/tokens dropped) and Vite on 5817 with `VITE_NEBULA_BACKEND_PORT=8817`. Puppeteer blocked 8000-8010 and 5173 on 127.0.0.1, localhost and [::1] (CDP `setBlockedURLs` plus a dead proxy). The agent was a real MCP stdio session named "Claude Code"; the person was the page.
  - Proposal and Update, at 1440x900 and 1280x800:
    1. The person pinned dusk, and the agent's `set_project_cover` was refused.
    2. While the person was on the canvas, the agent proposed tide. "Claude Code asks to change the cover of Cover run", with Review, dropped in top right (card at x 1064-1424, y 72).
    3. Review opened Projects with the strip in view and focused.
    4. "Use this cover" → `get_proposal` said accepted, and `list_notes` showed "Accepted: the cover changed", read. The canvas list showed the outcome with no Review.
  - Lost pin:
    1. Deleting the pinned node (click + Backspace) → `list_project_covers` gave `pinned: null`, `lostPin` naming tide by You.
    2. Cmd+Z brought the node back → the pin counted again, and the agent was refused again.
    3. Deleting it again → the agent's new proposal showed from automatic with `lostPin`. The strip read "The image you pinned is no longer in this project, so the cover is automatic." with no "You pinned".
    4. The agent withdrew → the Update said "Withdrawn by Claude Code".
    5. The agent's `set_project_cover` applied directly (`coverBy` Claude Code, `previous.cover` null), and the card's title read "Cover: set by Claude Code (agent)".
  - Blocked requests: 0 attempts to 8000-8010/5173 during the run. The canary's 3 probes (8000, 8123, 5173) were all blocked. One external Google Fonts request failed against the dead proxy.
  - Two of the driver's own checks misfired. Its "node deleted" probe read the graph store before the delete finished, but the backend and the undo both confirmed the delete. Its "one Update per proposal" expectation was wrong: the second ask replaced the first, as designed and tested.
- **Gates.**
  - Backend: 9159 passed, 61 skipped.
  - Vitest: 328 files, 3848 tests passed.
  - `tsc -b`: clean. Lint: clean.
  - Build budget: 510,106 bytes raw / 149,114 gzip, under 512,000.
- **Review.** Four confirmed findings fixed, tests first:
  - Expiry on time (two findings, one cause). Only reads swept proposals, so an agent that proposed and stopped left the Update saying "waiting for your OK" with a live Review past 15 minutes. Now each proposal gets a one-shot timer (`_schedule_asset_expiry`, via `_call_later` so tests can fire it) that sweeps just after it is due. If an accept has pushed the expiry out, the timer checks again at the new time. `list_notes` (`GET /api/canvas/agent-notes`), the canvas socket's connect and a project switch also settle first (`_settle_asset_updates`). That settle also catches what the findings didn't: proposals live in memory and Updates on the project, so after a restart an Update would wait forever. Now it resolves as "Expired".
  - A stale Commons Review. `requestReview` now clears itself after its 10 s when no strip takes it, and the Commons opens each request once (`openOnce`, a WeakSet), so leaving and coming back doesn't reopen the reference.
  - "Back to automatic" on a lost pin closes as above. The stored pin stays, and Cmd+Z makes it count again.
  - Tests that failed first: 4 backend ones in `test_asset_proposal_updates.py` (no `_call_later`; the list and restart tests fail on that same missing hook), 2 in `test_lost_cover_pin.py` (the proposal stayed listed; Accept returned 200 and dropped the pin), 2 in `assetProposalReviewRequest.test.ts` (the request stayed set) and 1 in `commonsReviewRequest.test.tsx` (the detail reopened on the second mount). Two more pass by design (`an open proposal's Update is left alone`, `a timer that fires early waits`).
  - Live check (8817/5817, proposal TTL patched to 25 s in the launcher only, 1440x900 and 1280x800). The person sat on the canvas while the agent (MCP "Claude Code") proposed a cover. The Update showed "waiting for your OK" with Review and badge 1. After 30 s with zero proposal reads from the page and none from the agent, the corner read "Expired", all read, badge 0, no Review, and `list_notes` said Expired. Then the agent proposed back to automatic, the person deleted the pinned node and went home: the strip was already closing (gone within about 1 s, after the autosave's relist), `get_proposal` said invalidated ("already the automatic one"), `lostPin` was still recorded, and Cmd+Z made the pin count again. A Commons Review for a gone reference opened its detail once; leaving and re-entering didn't reopen it, and the request was null 10 s later. The canary's 3 probes were blocked; 0 attempts to 8000-8010/5173 during the run; 1 Google Fonts request failed on the dead proxy.
  - Gates after review (machine load 30 to 55). Backend: 9165 passed, 61 skipped, 1 failed: `test_agent_process::test_terminate_agent_process_tree_kills_descendant_sentinel`, a timing test this change doesn't touch, which passes alone (4/4). Vitest, whole suite: 324 files and 3760 tests, of which 3400 passed and 360 failed in 82 files, nearly all 5 s timeouts. Rerunning those 82 files: 78 ran and 18 still failed. Rerunning the 18 with two workers left 1 failure (ModelPicker), which passed alone (11/11). `tsc -b` and lint are clean. Budget: 510,109 bytes raw, up 3 bytes, out of 512,000.
  - Seen in the live check, not fixed: a cover proposal made before the pin's node is deleted keeps its old view in the person's store until the canvas autosave's relist (about 2 s after the delete). Arriving on Projects inside that window shows the old strip (with "You pinned") as it fades out.
- **Open items.**
  - Board cover ownership (PR3b follow-up) is still unbuilt, so agents set board covers directly.
  - The Updates corner shows only on the canvas.
  - No Update is posted when no project is open.
  - A cover strip can still show the old view while the person's own delete is in flight (see Follow-up).
- **Follow-up.** The two items left after review, tests first.
  - The stale strip window, fixed on the backend. Every live canvas change goes through `_broadcast_graph_sync` (the person's delete, Undo/Redo's `POST /api/graph/restore`, an agent's edits, a clear, a run's outputs, a project switch). After its broadcast it now calls `_follow_cover_proposals(export)`. That re-checks the open project's cover proposals against the export the sync already made, closes the ones that no longer fit (`assetProposalClosed`), and, if an open one's view changed (lost pin, pin back, automatic cover moved), sends the person's tabs `assetProposalSync`. The client doesn't guess and the autosave's relist isn't needed. It costs almost nothing:
    - with no cover proposal open for the open project it returns after an in-memory check and `project_store.workspace()` (cached, no catalog copy);
    - otherwise it reads that project's record once per catalog write (`_open_project_record`, keyed on catalog.json's signature, via a new `ProjectStore.signature()`), so a run's many output syncs don't re-read the catalog;
    - any failure is swallowed.
  - The check itself is now `_cover_proposal_misfit(proposal, project, images)`, which `_asset_proposal_misfit` also uses.
  - The placeholder. The view's `change.cover` now has `auto`: the image the automatic cover shows now (`project_cover.cover` with no pin, its first image), or null. It's set when the proposal is made and refreshed with `lostPin`. The strip shows it on whichever side is automatic ("Automatic now" or the proposed "Automatic") and keeps the "Newest image" text when it's null. For a references-only project the card shows a mosaic, but the strip shows only its first image.
  - **Agents see `auto` too.** It is the same kind of URL `list_project_covers` already gives them (a `/api/outputs/...` path or the image's own URL). Nothing is signed: the browser builds the full URL with `backendAssetUrlSync`, the same way it does for the pinned image. Documented in `propose_asset_change`'s description, MCP-SETUP.md and SKILL.md.
  - **Tests that failed first.** Backend `test_lost_cover_pin.py`, 6 of the 9 new ones:
    - no `assetProposalSync` on delete or restore, and no immediate `assetProposalClosed` for "back to automatic";
    - `KeyError: 'auto'` ×3.
    - Three pass by design: nothing is pushed when no view changed, the check is skipped when no cover proposal waits on the open project, and a failing check doesn't fail the edit.
    - Two exact-shape asserts in `test_asset_proposals.py` gained `auto`.
    - Frontend `AssetProposalStrip.test.tsx`: 2 of 3 new ones failed (no automatic image on either side); the "Newest image" fallback passes by design.
  - **Live check.** Backend 8817 and Vite 5817 (`VITE_NEBULA_BACKEND_PORT=8817`), every root under `scratchpad/covers-final/`, an MCP stdio "Claude Code" agent, run at 1440x900 and 1280x800. Steps: the person pinned dusk; the agent's `set_project_cover` was refused; the agent proposed moss (its view had `auto` = dusk); the person deleted dusk's node (click + Backspace) and went to Projects 150 ms later.
    - `assetProposalSync` arrived 2 ms after the delete's `graphSync`, before any `projectsChanged` (that came about 1.2 s later, or not at all within the window).
    - Once it arrived the strip read "Automatic now" with tide's image (the real automatic cover) → moss, plus the lost-pin line, and no placeholder.
    - Remaining window: Projects showed at about 200 ms. Until the backend answered the delete (1.3 to 1.6 s with load around 20 and goHome's save racing it; 0.3 to 0.8 s without the race), the strip still showed the old "You pinned" view. Every stale sample came before that answer. Closing it needs the client: for example, Projects waiting for the canvas's in-flight graph mutations, or the strip treating its own tab's pending delete as already applied. Not built; it's the coordinator's call.
    - Blocking: 0 attempts to 8000-8010/5173; the canary's probes were blocked (2 attempts recorded); 1 Google Fonts request failed on the dead proxy.
  - **Gates.**
    - Backend: `test_lost_cover_pin` + `test_asset_proposal_updates` + `test_commons_proposal_updates` + `test_asset_proposals*` (which includes `test_asset_proposals_mcp`): 82 passed; with the project/undo/restore files, 215 passed; `test_asset_proposals_mcp`, `test_commons_mcp_parity` and `test_mcp*` gave 70 passed.
    - Vitest (AssetProposalStrip, assetProposalsSocket, assetProposalsStore, assetProposalReviewRequest, ProjectHome, AgentNotesCorner): 6 files, 78 tests passed.
    - `tsc -b` and lint: clean.
    - Budget: 510,109 bytes raw / 149,107 gzip, unchanged (the strip stays in its lazy chunk).
