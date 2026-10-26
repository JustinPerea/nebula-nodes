# 2026-10-24 — GM copy batch: held delete, switch toasts, too big for a browser, agent opening line

Branch `fix/gm-copy-batch`, based on `main` at c9e1ff3d.

## What changed and why

Justin: "go with your suggestions". The lines are GM - Design's (GM owns copy), built word for word with curly quotes as given.

- **Held delete, every node held, forget form.** `lib/worldLabsWaiting.ts` `heldDeleteText(count > 1, unlock = false, held >= count)` now reads "Couldn't delete them. They're waiting on World Labs. Check Marble and Run History." It used to read "… Check Marble, then use Run History." The one-node line, the unlock lines and the some-held forget lines ("One is …", "{n} are … then use Run History.") are unchanged. Both callers go through this one function: the canvas's own refusal (`graphStore.refuseHeldNodeDelete`) and the backend-refusal path (`deleteRefusalText`, graphStore ~1866). No other copy of the line exists. `backend/main.py` never wrote these canvas lines (its World Labs lines are the longer `_paid_state_person` ones, mapped by exact match), so the old line can't come back another way.
- **Project switch toasts** (`store/projectStore.ts` `switchMessage`). GM's reason: the project is on screen, so "made" already says it opened.
  - opened, copy kept: "Claude Code opened “{name}”. Edits saved as a copy."
  - made, copy kept: "Claude Code made “{name}”. Edits saved as a copy."
  - made, no copy: "Claude Code made “{name}”."
  - Opened with no copy ("Claude Code opened “{name}”.") and the "couldn't follow it" line are unchanged. The name is still whatever the switch carries. The doc comment is updated.
- **Save graph, too big for a browser** (`lib/graphFile.ts` `saveToFile`). The size window comes from the browser engine, not from Nebula's own limits. Chromium's V8 (also the desktop app's engine) caps a string at 2^29 − 24 = 536,870,888 characters, 24 short of 512 MiB. `JSON.stringify(file, null, 2)` of a longer graph throws `RangeError: Invalid string length`. Nebula's own limit is `GRAPH_BUNDLE_MAX_IMPORT_BYTES` = 528 MiB, checked with `TextEncoder` after the stringify, so it never gets to run. A graph.json between about 512.0 and 528.0 MiB is one Nebula would open but the browser can't write. It used to fall into the catch and show "Couldn't save the graph. Try again, or reload if it keeps happening.", which is wrong because trying again fails the same way. Now that RangeError reads "Couldn't save the graph. It's too big to save in a browser." Every other failure keeps its text, including the other RangeError stringify can throw (a stack overflow).
- **#178's held edits screen when an agent is leaving the project.** "{agent} is opening “{name}”." now sits above the heading, e.g. "Claude Code is opening “Moodboard v2”.". The new copy is `unsavedEditsCopy.agentOpeningLine`, and the store field is `unsavedEdits.agentOpening`. It is set only by `followProjectSwitch`, on both of its ways to the screen: edits over the save limit (`holdOverLimitEdits`) and a recovered copy refused for good (`EditsRefused`). The heading, reason, confirm and both buttons are unchanged. A download that couldn't be written keeps the line (`downloadUnsavedEdits` now keeps every field but `downloadFailed`).

## Decisions not in the spec

- **The agent line needs an agent's name.** It shows only when the switch's actor is `kind: 'agent'` with a name, the same test the toast uses. An unnamed script's switch (the toast's "An outside app") shows the screen without the line, since GM's line names an agent.
- **A screen that was already up keeps its cause.** If the person's own open or create put the screen up first and an agent's switch comes in after, no agent line is added. The screen was the person's, and the agent didn't cause it.
- **Item 3 covers Save graph only.** Two other writers hit the same V8 cap with their own headings: "Download your edits" (`saveEditsToFile`) and "Download a copy" (`saveProjectCopyToFile`), both `JSON.stringify` in `graphFileShared.ts`. Their copy is GM's call, so they are listed under Open items and left unchanged.
- **Above 528 MiB the new line shows too.** When the stringify fails, the graph's size can't be measured, so a graph past both limits also reads "too big to save in a browser" rather than "This graph is {n} MB. Nebula opens graphs up to 528 MB." Both are true. Firefox (string cap about 1 GiB) and Safari (about 2 GiB) can build the string and keep the 528 MB line. The desktop app is always V8.

## Agent-facing strings

None changed. None of these four lines is shown to agents today: the held-delete notice is the canvas's own, since an agent's delete goes through the backend's specific text. The toast, the Save graph notice and #178's screen are browser-only. `backend/main.py:9206` journals "made and opened project “{name}”" for agents (journal summary, a different string), and it stays as it was. No MCP tool, CLI command or doc mentions these lines, so `mcp_server.py`, the `nebula` CLI, `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md` need no change.

## Tradeoffs

- The browser-limit check matches any RangeError from the stringify except a call-stack one, so it doesn't depend on V8's exact message. Today the shape walk caps depth at 64 before the stringify, so a stack overflow can't really happen there anyway.

## Surprises

- `frontend/src/lib/worldLabsWaiting.ts` had no unit test of its own. Its lines were pinned only in `tests/store/graphStore.heldNodeDelete.test.ts`. A new `src/lib/worldLabsWaiting.test.ts` pins every branch.
- A `TypeError` while building graph.json (say, a BigInt) reads as "Nebula's server isn't answering…", because `copyForError` takes any TypeError for a lost fetch. This was already true and is out of scope; noted below.

## Tests (written first, failing on the base)

- `src/lib/worldLabsWaiting.test.ts` (new): the all-held forget line, for 2 and 5 nodes, plus the same through `deleteRefusalText`. 2 of 3 failed first ("Check Marble, then use Run History." received). The test that pins the unchanged forms passed.
- `tests/store/graphStore.heldNodeDelete.test.ts`: `ALL_FORGET` is now GM's line. 2 of 20 failed first: the canvas's own refusal and the backend-refusal path.
- `src/store/projectStore.switch.test.ts`: the three new toast lines. 7 of 25 failed first ("made and opened" / "Your edits are saved as a copy.").
- `tests/graphFile.test.ts`: a stringify RangeError("Invalid string length") gives GM's line, with no asset fetch and no zip. This failed first (the generic line was received). A stack-overflow RangeError keeps the generic line, which passes on both the old and new code and pins it unchanged.
- `src/components/projects/ProjectHome.unsavedEdits.test.tsx`: the agent line comes first, above the heading, and the buttons are unchanged. This failed first. "Any other cause: no opening line" passes on both.
- `tests/savePaused.store.test.ts`: an agent's switch while paused gives `agentOpening: { agent: 'Claude', projectName: 'beta' }`, and it is kept after a failed download. This failed first. Two tests pass on both: an unnamed script's switch adds no line, and an agent's switch after the person's own screen adds no line.
- `tests/unsavedEdits.store.test.ts`: the refused-copy path after an agent's switch carries the line. This failed first.

## Live check

The worktree's own app ran on an isolated stack: backend 8795 through `iso.sh` (temp HOME and NEBULA_* roots, no keys, a loopback-only httpx guard) and Vite 5795 with `VITE_NEBULA_BACKEND_PORT=8795`. In the browser, 8000-8010 and 5173 were blocked twice over: CDP `Network.setBlockedURLs` and the dead proxy 127.0.0.1:9. The canary on 8799 couldn't be reached. **0 blocked attempts**, no page errors, no dialogs. 10/10 checks passed, with screenshots at 1280x800 and 1440x900:
- Item 4, a real flow: a 17 MiB edit paused saving, then `POST /api/projects/{id}/open` with `X-Nebula-Agent: Claude Code` brought up #178's screen. It read "Claude Code is opening “Moodboard v2”." / "Couldn't save your edits." / the reason, with both buttons unchanged. "Continue without them" let go.
- Item 2: an agent's real `POST /api/projects` gave the toast "Claude Code made “Agent sketches”." The two kept-copy toasts were shown by setting `switchNotice` in the page, because a failed handoff save is hard to force without request interception (which breaks this setup). They read "Claude Code made “Agent sketches”. Edits saved as a copy." and "Claude Code opened “Agent sketches”. Edits saved as a copy." and fit on one line at both sizes.
- Item 1: two nodes were given recovery records in the page store, both were selected, then Delete. The notice read GM's line and both nodes stayed.
- Item 3: `JSON.stringify` was made to throw V8's RangeError for the pretty-printed call, then Save graph ran. The notice read "Couldn't save the graph. It's too big to save in a browser." A real 512 MiB graph was not built, because this Mac is memory-bound.
- Nothing paid ran and no node was run. Both servers were stopped and the state dir deleted.

## Open items

- For GM: "Download your edits" and "Download a copy" hit the same V8 string cap for a canvas over about 512 MiB, and show their own generic failure. They need lines if GM wants them.
- A TypeError while building graph.json reads as "Nebula's server isn't answering…" (`copyForError` takes any TypeError for a lost fetch). This was already the case and is out of scope.
