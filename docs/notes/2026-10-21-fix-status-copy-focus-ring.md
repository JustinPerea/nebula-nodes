# 2026-10-21 — Short Commons worker status, and a light neutral focus ring app-wide

Branch `fix/status-copy-focus-ring`, from main `4fc4ce68` (after #157). Uncommitted (the coordinator commits). No paid provider call, no package installed.

## 1. The Commons worker status

- **What changed and why.** GM - Design: "Keep the worker status to its state plus one action, short enough to show whole at 1280 (about 36 characters), with the full explanation in the tooltip. 'Library analysis paused until reference labels are sealed' → 'Paused until labels are sealed'. '…close the agent review to resume' → 'Paused · close agent review to resume' (adjust the start to fit). The ellipsis stays as the safety net."
  - Every status is built in one place, `StatusLine` in `frontend/src/components/commons/CommonsView.tsx`. The backend sends only state (`worker.state`, `queue`, `meter`, `load`, `evaluation_waiting`, `evaluation_assisted`), never text.
  - Each status is now its state plus at most one action. The tooltip (`title`) on `.commons-status__text` is now a full sentence: what the state means, and what resumes it. Before, the title was the same text as the label.
  - The p157c layout is unchanged: the text still truncates on one line down to `--commons-status-min`. Every status now fits whole at 1280 and 1440, so the ellipsis is only a safety net.
- **Old → new → tooltip** (for GM's review). Counts are the parts; `· N held` is added to every worker status when agent adds are held.

| Old | New | Tooltip (title) |
|---|---|---|
| Connecting… | Connecting… | Connecting to library analysis… |
| Library analysis paused until reference labels are sealed | **Paused until labels are sealed** | Library analysis is paused while blind labeling is open, so it can't sway your reference labels. Seal the labels, or close the batch without sealing, in Blind labeling to resume. (Worker stopped: "…in Blind labeling, then press Start: library analysis is stopped, so it won't resume on its own.", with Start beside the text.) |
| Library analysis paused · close the agent review to resume | **Paused · close agent review to resume** | Library analysis is paused: the agent graded these references before the blind labels were sealed, so they can no longer be sealed as blind labels. Close them as an assisted review (in Agent review or Blind labeling) to resume. (Worker stopped: "…, then press Start: …", with Start.) |
| Worker stopped [Start] | Stopped [Start] | Library analysis is stopped. Start runs it while Nebula is open. |
| Worker stopped · 12 queued · 3 held [Start] | Stopped · 12 queued · 3 held [Start] | Library analysis is stopped. 12 references are waiting to be read. 3 references added by agents are held until you accept them in the Inbox. Start runs it while Nebula is open. |
| Analyzing (12 queued) [Stop] | Analyzing · 12 queued [Stop] | Library analysis is reading references: 12 waiting. |
| Analyzing (0 queued) [Stop] | Analyzing [Stop] | Library analysis is reading references. |
| Worker idle [Stop] | Idle · nothing queued [Stop] | Library analysis is running and has nothing to read. New references are read as they arrive. |
| Paused: machine busy (load 41.5 / 32) [Stop] | Paused · machine busy (41.5/32) [Stop] | Library analysis is paused while this computer is busy: its load average is 41.5, above 32 (Pause above load, in Settings). It resumes on its own when the load drops. |
| Daily cap reached, resets 09:00 AM [Stop] | Paused until 9:00 AM · daily cap [Stop] | Library analysis is paused: it made 20 analysis calls today, and the daily cap is 20 (Analysis calls per day, in Settings). It resumes on its own at 9:00 AM. |
| Daily cap reached, resets 09:00 AM [Stop] (cap set to 0) | Paused · daily cap is 0 [Stop] | Library analysis is paused: Analysis calls per day is set to 0 in Settings, so it reads nothing. Raise it to resume. |
| Call budget used (40/40) | Stopped · call budget used (40/40) | Library analysis is stopped: it used this run's call budget (40 of 40 calls). Restart Nebula to reset it. |
| any of the above · 3 held | … · 3 held | … 3 references added by agents are held until you accept them in the Inbox. (1: "1 reference added by an agent is held until you accept it in the Inbox.") |

- **Widths** (Inter 400 11 px, measured live as the text's natural width). The room the text gets is 244-245 px beside Start/Stop and 301 px with no control, at both 1280x800 and 1440x900 with the Updates chip present.
  - Paused until labels are sealed 154.3. Paused · close agent review to resume 200.6. Stopped 43.8. Stopped · 12 queued · 3 held 148.3. Analyzing · 12 queued 114.1. Idle · nothing queued 109.6. Paused · machine busy (41.5/32) 170.0. Paused until 11:59 PM · daily cap 168.5. Stopped · call budget used (40/40) 182.6.
  - **Longest realistic, with parts:** Stopped · 9999 queued · 999 held 178.0 (Start). Analyzing · 999 queued · 99 held 171.8 (Stop). Idle · nothing queued · 99 held 158.0. **Paused · machine busy (140.2/128) · 99 held 230.1** (Stop; the tightest, 15 px to spare). Paused until 11:59 PM · daily cap · 99 held 217.0 (Stop). Stopped · call budget used (9999/9999) · 99 held 257.5 (no control, 44 px to spare).
  - Every one of these showed whole (no ellipsis) at 1280 and 1440, with the header at 49 px and 0 overlaps.
- **Decisions not in the spec.**
  - Every status starts with its state word, as GM's two do: "Worker" and "Library analysis" are gone from the label (the tooltip says "Library analysis"). "Worker" was the jargon.
  - The load numbers lost the word "load" ("(41.5/32)"): with it, the busy status plus a held count would not fit beside Stop. The tooltip names the load average and the setting.
  - The cap's time now uses `hour: 'numeric'` ("9:00 AM", was "09:00 AM").
  - The cap and budget tooltips name the settings by their labels in Commons Settings ("Analysis calls per day", "Pause above load").
  - The character cap in the test is 37, GM's own assisted string; its "about 36" was a guide. The binding limit is pixels, measured live.
- **Agents.** None of these strings reach agents. `commons_status` (MCP) and `nebula commons status` (CLI, which prints the JSON) return the route's structured state. Nothing in docs/MCP-SETUP.md, skills/nebula/SKILL.md or `commons/skill.py` quoted the old wording. So agents keep the state, and the UI copy did not move to them. What did change: the `commons_status` docstring now says what `held` means, lists the worker states, and says what lifts each pause and that analysis then resumes only if `worker.running` (`evaluation_assisted` was in the payload but undocumented). docs/MCP-SETUP.md says the tool returns structured state, not the toolbar's wording. A backend test pins both.

## 2. The focus ring, app-wide

- **What changed and why.** GM - Design: "Yes, fix the focus ring at the token, app-wide. But make it a light neutral, not --sr-accent. Orange already means two things in Nebula: the agent (its cursor, and the orange outline on the cards its notes name) and the primary action (Add, Start, Generate) … A light neutral ring carries no meaning of its own: about #E8E6E1 or the app's primary text colour, at 2px with the 2px offset."
  - `--sr-focus-outline` is now `2px solid var(--sr-ink)`. `--sr-ink` is the primary type token (white at 92 %, #EBEBEB on black), next to GM's #E8E6E1, so no new hex. `--sr-focus-offset` stays 2px. It was `2px solid var(--sr-accent-soft)`, orange at 10 % alpha: 1.08:1 on the canvas.
  - New `--sr-focus-outline-on-light: 2px solid var(--sr-canvas)`. It is for the one light surface a ring sits on, the Commons evaluation form (#eff1e8), where the light ring is 1.13:1.
  - A zero-specificity baseline, `:where(body.app-slava-restraint :focus-visible)`, draws the token wherever no component draws its own ring. It replaces the browser's blue default; any component rule still wins.
  - Canvas nodes had no focus ring at all: React Flow sets `outline: none` on `.react-flow__node.selectable:focus-visible`. A focused node now rings its drawn card (`.canvas-wrapper .react-flow__node:focus-visible .model-node__card`). A node type without a card gets the ring on its wrapper.
  - The accent comments at the top of slava-restraint.css said the accent was "used ONLY for focus rings, primary CTA, selected state". They now say focus is the neutral ring.
- **The sweep.** I found every `:focus` / `:focus-visible` / `:focus-within` rule and every base `outline: none` in `frontend/src` with a CSS parser (158 rules). Each was brought onto the token, or listed below. Hover, active and selected looks are unchanged. Where a rule shared `:hover` and `:focus-visible`, I split it, so hover keeps its look.
  - **Orange rings → token:** onboarding, asset proposals (button), canvas next steps, selection toolbar, assets panel items, Cinema Studio (2), command palette, Create gallery (2), model picker (2), project home, provider readiness, result comparison, workspace rail, world preview (3, plus a 4px accent-soft halo removed).
  - **Faint or other colours → token:** agent notes (7 rings at 40-55 % ink), agent log (2, 1px edge-strong), structured preview (1px ink-light), canvas pins and proposals (#fff), moodboard board controls (3, already white 92 %), paper source links (currentColor), the provider recovery banner (1px peach, hover keeps it), world preview's unscoped cyan fallbacks, the Commons evaluation (green #91b769).
  - **Settings:** the `--settings-focus` box-shadow (orange at 45 %) is gone. Its 10 rules use the token outline. Rows and links are inset (-2px), as their shadow was. The app-colour dot and swatch rings sit 4px out, outside the checked/open ring (2px gap + 1px ink), so focus and choice read apart.
  - **Orange focus borders removed** from 7 token rules in slava-restraint.css (panel and node header actions, inspector and panel controls, chat controls, the loop toggle, canvas tabs, the editor empty state, editor transport). Also from the chat input row's `:focus-within` (now edge-strong), the settings key box (now ink-meta, plus the ring), character definition inputs, Remotion property inputs, settings paste and folder inputs, and the panel search and inspector field `:focus` rules. Those last two also cleared the outline, which beat the token rule (same specificity, later in the file).
  - **Fields that cleared their outline with no focus at all, now ringed:** the Create composer prompt (ring on the composer card), param pills (on the pill), preset search and settings search (on their search row), the settings key field (on its box), the command palette field (inset), the assets panel search, and the node and project rename fields. The rename fields' inset orange line was their only focus mark; they only exist while focused.
  - **Menus:** Move/More items, provider switcher items and setup links had `outline: none` with an orange or faint wash as focus. They now keep the hover wash and add the token ring inset (-2px) inside the menu edge.
  - **Asset proposal strip:** Review focuses it (tabIndex -1). From the keyboard it now shows the token ring; the agent-colour Review flash is unchanged.
  - **Kept, with why (the test's allow-list):**
    - The text card's textarea (`.model-node--text-surface .model-node__textarea`). The card body is the field: the caret and the node's selected ring show it, and a ring inside the card would read as the node's own focus ring.
    - The moodboard board card draws focus on the card inside React Flow's wrapper, as a 2px ring in the token's colour plus a 5px halo that tells it from selected.
    - The Jev demo card's question field keeps its "pink focus" in the TypeSafe brand colour, Justin's v6 choice.
    - The pre-Slava skin's `body:not(.app-slava-restraint)` rules never match (skins.ts always adds the class), so they were left.
  - **Offsets kept where the layout needs them:** inset -2px (canvas toolbar, menus, settings rows, model picker, command palette, the 3D viewer canvas), 0 (rename fields, Jev input), 1px (selection toolbar, assets items, agent note close/buttons, moodboard controls), 3-4px (onboarding, next steps, result comparison, project home, evaluation).
- **Contrast** (WCAG 2.2 1.4.11, ring against the surface it sits on, translucent layers composited over the black canvas). Every one is ≥ 3:1:
  - canvas #000 17.6; dialogs (--sr-canvas-elevated) 17.0; header and panels (--sr-glass) 16.2; popovers (--sr-glass-raised) 15.4; Commons panels, composer, Updates list (--sr-glass-strong) 14.1;
  - a header control (--sr-surface-control on glass) 16.6; a hovered control on glass-strong 12.3; an input (--sr-surface-control-focus) 16.0; node chrome (--sr-node-pill-bg) 16.1;
  - Commons evaluation panel #1c211d 14.0; its current nav button #3b4b2e 8.3; the provider recovery banner 14.8;
  - the evaluation form, with the dark twin: #eff1e8 18.4, #d9e1cf 15.6, #f9faf5 20.0 (the light ring there: 1.13, 1.31, 1.04).
  - Against the orange of Start/Add the ring is 2.6:1, but it never touches them: the 2px offset puts the page between them.
- **The canvas: a focused node and an agent-outlined node.** At 1280, n0 had keyboard focus (Tab) and n1 was outlined by an Update that names it (`post_note` with `refs: ["n1"]`).
  - n0: a crisp 2px ring of white at 92 %, 2px off the card, following its 8px radius, no glow.
  - n1: the agent's outline, 2.5px in the agent's colour, 6px out, radius 15, with a soft glow.
  - They read as two things. Screenshot `canvas-focus-vs-agent-1280.png`.
  - Surprise: in this run the agent's colour was lime (#C3E86B, the colour the app gave "Claude Code"), not orange. The author colour is per agent. Against the lime the neutral ring differs in hue, glow, thickness and distance, not in lightness (1.16:1). See open items.
- **Tradeoffs.**
  - Rings inside the canvas scale with zoom, like the card's own border (2px at 100 %, about 1.2px at the 0.62 first-fit zoom). The agent outline divides by zoom; the focus ring doesn't.
  - Over rendered pixels (the 3D viewer's canvas) one ring colour can't clear 3:1 on every frame; it was a 3px accent ring, now the token inset.
  - The baseline gives the token ring to every focusable element no component styled, including the canvas wrapper (tabIndex 0). Before, they had the browser's default ring.
- **Surprises.**
  - The Commons view's own focus rule out-ranks `.commons-evaluation :focus-visible`. So the evaluation's buttons and inputs had the accent-soft ring, not its green; only the other elements had the green. The new evaluation rules are scoped higher, so the form's dark ring applies to its buttons too.
  - The panel search and inspector field's `:focus { outline: none }` came after the token rule at equal specificity, so they had no ring, only an orange border.

## Tests (written first, run on the old code, seen failing)

- `frontend/tests/commonsStatusLine.test.tsx` (rewritten): GM's two exact strings, each status's text and its tooltip (key phrases, every count in the text named in the title), the state ≤ 37 characters, the longest realistic statuses ≤ 43 characters beside a control and ≤ 48 without, and the p157c structure checks. On the old code, 17 of its 20 failed. `commonsTabsOverflow.test.tsx` pinned the title "Worker stopped" and failed too (18 in the two files). Now all pass.
- New `frontend/tests/focusRingCss.test.ts`. It parses every stylesheet under `src` and checks:
  - the token (2px solid `var(--sr-ink)`, offset 2px, `--sr-ink` is the primary type), its dark twin, the `:where()` baseline and the node card ring;
  - the ring's contrast against 12 surfaces, and the dark twin on 3 light ones;
  - the ring is neutral in hue;
  - the sweep: no focus rule uses `--sr-accent*`; every focus `outline` is the token; no `outline-color/width/style` and no box-shadow ring; no `outline: none` on focus without the token ring back (allow-listed by selector, with reasons);
  - every base `outline: none` names the rule that shows that field's focus (22 entries).
  - On the old CSS: 44 failed (all the token, contrast and sweep tests, and 23 of the cleared-field entries). Now 44 pass.
- `backend/tests/test_commons_mcp_parity.py`: new test that `commons_status` documents `evaluation_waiting`, `evaluation_assisted`, `held`, the worker states and what lifts each pause, and that MCP-SETUP names `evaluation_assisted`. 1 failed first, now passes.
- **Gates.**
  - Backend, whole suite: 9466 passed, 61 skipped, 1 failed. The failure was `test_agent_guardian.py::test_registration_racing_the_backend_kill_is_still_reaped`, a process-reaping timing test under machine load; untouched here, and the file passes alone (5/5).
  - Frontend `npx vitest run`: 4105 passed, 11 failed in 7 files. 8 were "Test timed out in 5000ms" under load, the rest focus/find timing in the same files. The 7 files rerun alone: 136/136 passed.
  - `npx tsc -b` clean. `npm run -s lint` clean.
  - `vite build` + `check-build-budget.mjs`: the entry is 511,428 bytes raw (unchanged; budget 512,000).

## Live check

- Isolated backend on 8859 and Vite on 5859 (`VITE_NEBULA_BACKEND_PORT=8859`). `/api/projects` through Vite returned the seeded "Dusk"/"Harbor", so the proxy reached the isolated backend.
- Temp HOME and every NEBULA_* root under `scratchpad/sf/state`. The env was built from scratch, so there were no keys or tokens. Commons on; nothing paid ran; no model was called.
- One real MCP stdio agent ("Claude Code") posted one Update naming n1.
- Headless Chromium had 8000-8010 and 5173 blocked (CDP `Network.setBlockedURLs` plus a dead proxy that bypasses only 8859/5859). **Blocked requests: 0 during the run, 2 in the deliberate canary probe.** One console 403 at startup (the known settings 403 without the person link).
- **Statuses:** "Stopped" + Start (seeded). "Paused until labels are sealed", reached by preparing the held-out set through Blind labeling, as in #157. "Paused · close agent review to resume", reached by one stand-in `failed` row in `assisted_reviews` in the isolated DB (removed after). The rest came from a page-level stand-in for the status poll only (a `window.fetch` wrapper, not CDP interception), with real-world and longest-realistic values.
  - At 1280x800 and 1440x900 every one showed whole (scrollWidth = clientWidth, no ellipsis). The header stayed 49 px, with 0 overlaps and the Updates chip on top. Start/Stop were whole and left of the chip.
- **Focus (Tab, `:focus-visible` true each time; the computed outline was `2px solid rgba(255,255,255,0.92)`, offset 2px, unless noted):**
  - the header's Back to projects;
  - the Inbox tab;
  - More with Settings open ("More: Settings"), and its menu's item (inset ring);
  - Canvas actions and Zoom in on the canvas toolbar;
  - the keyboard shortcuts dialog's Close (on #060607);
  - Start and Add, whose border stays orange at 34 %: the ring sits 2px outside, clear of it;
  - the rail's white Add nodes;
  - the evaluation nav (3px offset), and an evaluation form checkbox (black ring, 3px offset, on #eff1e8);
  - the settings tab, the settings search (ring on its box), and the Create composer (ring on the card).
- Screenshots in `scratchpad/sf/shots/`: `canvas-focus-vs-agent-1280.png`; `commons-status-<case>-1280/1440.png`, 13 cases; `focus-*-1280(-zoom).png`.
- Servers stopped (ports free) and the state dir deleted.

## Review

- **Review (four confirmed findings, each with a test that failed first, then the fix).**
  - *The pause tooltips promised a resume a stopped worker never makes.* Sealing or closing only lifts the hold; the worker starts stopped at launch and only Start runs it. Now, with the worker stopped, both pause tooltips end "…, then press Start: library analysis is stopped, so it won't resume on its own." and Start sits beside the text; with the call budget used they say to restart Nebula (no Start, since it would stop at once). The `commons_status` docstring now says "the hold lifts once …; analysis then resumes only if `worker.running`", and MCP-SETUP says the same.
  - *The daily-cap tooltip used the cap as the call count and always promised a resume.* A cap of 0 now reads "Paused · daily cap is 0" (23 characters), tooltip "Library analysis is paused: Analysis calls per day is set to 0 in Settings, so it reads nothing. Raise it to resume." Otherwise the tooltip reports calls made and the cap apart ("it made 25 analysis calls today, and the daily cap is 10").
  - *The test comment's room widths (233/290 px) were the #157 figures.* Now 244-245 and 301 px, as measured here and again in this round.
  - *The bright ring covered half the lime unread ring on the Updates chip.* `.agent-notes-chip--ringed:focus-visible` now sets `outline-offset: 4px`: the lime ring fills 1-3px outside the chip, the focus ring 4-6px, so the whole lime ring shows with a 1px gap. Without unread items the chip keeps the 2px offset. A new test in focusRingCss.test.ts reads both rules and checks the gap.
  - Tests that failed first: 9 in the frontend (8 in commonsStatusLine.test.tsx: the two stopped-worker pauses, the budget-used pause, the daily cap's new wording, cap 0, a lowered cap, the no-false-promise test and Start from the pause line; 1 in focusRingCss.test.ts, the chip gap) and 1 backend (`test_status_does_not_promise_a_stopped_worker_resumes`). All pass now.
  - Live check, rerun on 8859/5859 (`VITE_NEBULA_BACKEND_PORT=8859`; `/api/projects` through Vite listed the seeded projects): "Stopped [Start]" at launch; preparing the held-out set in Blind labeling gave "Paused until labels are sealed" with Start and the "then press Start" tooltip (154.3 px, room 244, whole); pressing Start there ran the worker (real status idle/running, evaluation still waiting), Start went away and the tooltip said "to resume." (room 301). The assisted pause with Start (200.6 px in 244), the budget-used pause, cap 0 (116.5 px; with 99 held 164.9), a lowered cap and the longest cap status (217.0 px in 245) came from the page-level status stand-in; all whole at 1280x800 and 1440x900, header 49 px, 0 overlaps, Updates chip on top. The ringed chip with Tab focus: `2px solid rgba(255,255,255,0.92)`, offset 4px (2px with the class off), the full lime ring visible inside it (`shots/rv2-chip-focus-hi.png`, `rv2-chip-blur-hi.png`). Blocked requests: 0 during the run, 2 in the canary probe. Servers stopped, state deleted.
  - Gates after the review fixes: backend whole suite 9468 passed, 61 skipped, 0 failed. Frontend `npx vitest run` 4098 passed, 26 failed in 7 files under load (20 of them "Test timed out in 5000ms", the rest focus/find timing in the same files); those 7 files rerun alone: 136/136 passed. `npx tsc -b` clean, `npm run -s lint` clean, the build entry 511,428 bytes raw (budget 512,000, unchanged).

## Open items

- GM: the old → new → tooltip table above, before merge.
- GM: the agent's outline colour is per agent (lime for "Claude Code" here), so on canvas the neutral focus ring and a light agent colour differ in hue, glow and distance, not lightness. They still read apart in the screenshot. If GM wants more separation, the ring could follow zoom like the agent outline does.
- The focus ring scales with canvas zoom (thinner below 100 %).
- The 3D viewer canvas's ring sits over rendered pixels; a two-tone ring would be safer there.
