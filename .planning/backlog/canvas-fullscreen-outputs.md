# Canvas: view selected nodes' outputs full screen

Parked 2026-10-21 at Justin's request. Not scheduled; pick it up when there's room.

## The idea

Justin: "When we highlight multiple nodes, I want the option to go into full screen so you can see each node output at full resolution and screen size so you can see it better. Should be able to click next to look at all the ones you selected."

So: select several nodes on the canvas, choose View, and step through their outputs one at a time, each filling the screen at full resolution, with Next and Previous.

## What's already there

- **Multi-select has a toolbar.** `frontend/src/components/SelectionToolbar.tsx` (shown by `Canvas.tsx` in a top-centre panel) has the selection count, Ask agent, Note and Run. A **View** button fits there, shown when at least one selected node has an output.
- **A full-screen viewer exists in Create.** `frontend/src/components/create-studio/Lightbox.tsx` renders into `document.body`, traps focus, has Previous and Next, a counter ("2 / 5"), and plays video. `ResultsGallery.tsx` uses it. The canvas could reuse it rather than build a second one; it would need to move out of `create-studio/` into a shared place.

## Sketch

- **Order:** the selected nodes in canvas reading order (top to bottom, left to right), so Next follows the layout.
- **What it shows:** each node's current output at its own resolution (fit to screen, with a 1:1 / actual-size toggle for images so you can check detail), the node's name and model, and the counter. Arrow keys and Escape like the Create lightbox.
- **Output types:** images and video first. Then audio (a player), text (readable full-width), SVG, and 3D (`nodes/MeshPreview.tsx`, if it can run full screen). A node with several outputs (a batch, or several ports) shows each as its own step. A node with nothing yet is skipped, and the counter counts only what can be shown.
- **Also from one node:** the same viewer could open from a single node's output (double-click), stepping through that node's batch.

## Agent support

Every feature ships agent support (Justin, 2026-10-20). Agents already see outputs with `view_output`, so the agent half is showing the person: a tool along the lines of `show_full_screen(node_ids)` (and a CLI twin) that opens this viewer on the person's screen, for "here are the three versions, take a look". It changes nothing and the person closes it, so it needs no proposal.

## Open questions

- Should it show only the selection, or all outputs on the canvas with the selection first?
- Side-by-side compare (two or four at once) as a second mode, or keep it one at a time?
- What does Next do at the end: stop, or wrap to the first?

## Scope

Small to medium, mostly frontend: move and generalize `Lightbox`, add the toolbar button and per-type renderers, plus the one agent tool.
