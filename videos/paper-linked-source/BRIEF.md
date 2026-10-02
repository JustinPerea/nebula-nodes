---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Editable in Paper. Connected in Nebula. Refresh first, rerun by choice."
angle: source-to-snapshot-to-saved-recipe
destination: local-demo
aspect: "16:9"
language: en
length: 40
captions: designed-callouts
narration: none
music: none
---

The user requested a demo showing the Paper-linked source feature and explicitly
selected the "40-second captioned demo". They also verified by clicking that
Open in Paper brings them into the desktop app.

## Intent

Show the actual product: a bound editable Paper logo, a connected downstream
result, returning to the original, a real Paper edit, explicit source refresh,
the earlier result becoming out of date, then an explicit saved-recipe rerun.
Connections and both input/output histories remain intact.

## Production decisions

- 1920×1080, 30 fps, 40 seconds, locally delivered H.264 MP4.
- One finished captioned cut; no narration or music is necessary for this demo.
- Use real CUA captures and supported Paper tools; no synthetic product UI.
- The downstream node is a visibly labeled deterministic compositing fixture.
  It uses the exact exported artwork and proves the loop, not paid generation.
- The Open in Paper transition is an edited sequence of the actual source
  control and captured desktop destination. Desktop launch was verified by the
  human; browser automation previously blocked the protocol and will not retry
  or bypass that restriction.
- Use a separate demonstration output root and frontend port so the earlier
  acceptance graph/history remains intact. Only our disposable Paper fixture
  may be edited, and its original artwork will be restored after capture.
- Keep Slava black/glass surfaces, Inter, and orange for interaction focus.
- Use the already installed HyperFrames 0.8.41 (published more than 14 days ago),
  existing cached renderer browser, local GSAP and fonts. No package upgrades.
- Read the canonical owning workflow directly. Its updater would execute an
  unpinned npm package and mutate shared global skills, so it is not run.
