# Capture pipeline — driving the live Nebula app

The video uses **real captured Slava UI**, not mockups. You drive the running Nebula app to deterministic states and screenshot them at 1920×1080. The app exposes Zustand stores + a chat dev-bridge on `window`, so you can set any graph/chat/panel state programmatically.

Use `scripts/capture-nebula-ui.mjs` as the template. It uses the repo's own Puppeteer install (`scripts/puppeteer-driver/node_modules/puppeteer`) — no extra deps. (Playwright MCP also works for interactive exploration, but the node script is repeatable and survives MCP disconnects.)

> **Placement:** copy the template next to your composition (e.g. `hyperframes/<your-video>/capture-<name>.mjs`) so its `../../scripts/puppeteer-driver` require resolves from the repo root. Then point `NEBULA_URL` at your running dev server and edit the state-setup + screenshot list for your video's beats.

## The window API (DEV build only)

| Global | Use |
|---|---|
| `window.__nebulaUIStore` | Zustand UI store. `getState().setSkin('slava-restraint')`, `setState(st => ({ panels: {...}, chatResized: true, ... }))`. |
| `window.__nebulaGraphStore` | Graph store. `setState({ nodes, edges, isExecuting })` to build any graph instantly. `getState().addNode(...)`, `clearGraph()`. |
| `window.__nebulaCanvas` | `getViewport()`, `setViewport({x,y,zoom})`, `centerOn`, `zoomTo` — frame the graph precisely. |
| `window.__nebulaChat` | DEV chat bridge: `clear()`, `setInput(t)`, `pushUser(t, {images})`, `pushAssistant(t, {streaming})`, `pushThinking(lines)`, `setBusy(b)`. |

`__nebulaChat` only exists in the **dev build** (`import.meta.env.DEV`). The Vite preview/production build (`vite preview`) does NOT have it — always capture against `npm run dev`.

## Building real states

**Slava skin:** `ui.getState().setSkin('slava-restraint')` (it's the default; body gets `app-slava-restraint`).

**A graph** — `graphStore.setState` with genuine `definitionId`s so it renders as the real product:
```js
const N1 = { id:'n1', type:'model-node', position:{x:380,y:420}, data:{ label:'Product brief',
  definitionId:'text-input', params:{ value:'…' }, state:'complete', outputs:{ text:{ type:'Text', value:'…' } } } };
const N2 = { id:'n2', type:'model-node', position:{x:860,y:280}, data:{ label:'Hero shot',
  definitionId:'gpt-image-2-generate', params:{ size:'1024x1024' }, state:'idle', outputs:{} } };
const E1 = { id:'e1', source:'n1', sourceHandle:'text', target:'n2', targetHandle:'prompt',
  type:'typed-edge', data:{ dataType:'Text' } };
graphStore.setState({ nodes:[N1,N2], edges:[E1], isExecuting:false });
canvas.setViewport({ x:40, y:0, zoom:1.05 });   // frame it
```
Real `definitionId`s seen in the app: `text-input`, `gpt-image-2-generate`, `image-input`, `sticky-note`, `reroute`, `openrouter-universal`, `meshy-text-to-3d`. Typed edges are colored by data type (Text = purple) — that's authentic, keep it.

**Chat** — show the panel, switch agent, inject a conversation:
```js
ui.setState(st => ({ chatResized:true, panels:{ ...st.panels,
  chat:{ ...st.panels.chat, visible:true, width:700, height:540, left:610, top:250 } } }));
// agent tabs are <button class="chat-panel__agent-btn">; the active one is ...--active
const codex = [...document.querySelectorAll('.chat-panel button')].find(b => b.textContent.trim()==='Codex');
if (codex && !/--active/.test(codex.className)) codex.click();
chat.clear();
chat.pushUser('Build a product-shot generator with prompt variants');
chat.pushAssistant("Here's the plan:\nProduct brief feeds Hero shot and Detail shot.\nOne prompt, two variants — wiring now.", { streaming:false });
```
- The three agents are real: **Claude / Codex / Daedalus**. Codex status `Codex · ChatGPT · ready` is real when Codex is logged in on the machine (backend on `:8000`).
- **Chat bubbles are `white-space: pre-wrap`**, so `\n` makes real line breaks inside ONE bubble. Use this for multi-line replies. `{streaming:true}` shows the `▊` cursor.
- `pushThinking(lines)` routes to the Agent Log, not the chat bubble — so for a visible "digesting" beat, rely on the `thinking…` status + the stop button (set busy), not the thinking lines.

**Hide clutter** for clean frames (these panels render whenever data exists):
```js
const s = document.createElement('style'); s.id='capture-clean';
s.textContent = '.panel--moodboard-library,.panel--character-library{display:none !important;}';
document.head.appendChild(s);
```

**Measure click targets** (for cursor choreography in the composition) — never guess:
```js
const r = el.getBoundingClientRect();  // → { cx: r.x+r.width/2, cy: r.y+r.height/2 }
```
Key selectors: agent tabs `.chat-panel__agent-btn`, input `.chat-panel textarea`, send `.chat-panel__send--submit`, the canvas launchers `.panel-launcher--chat` / `--nodes`.

## Gotchas (these cost real time)

- **Dev-server port collisions.** Other Vite apps may hold `5173`; Nebula then binds the same port on the other IP stack (`[::1]:5173` vs `127.0.0.1:5173`), so `localhost` is ambiguous. **Start Nebula on a fixed unique port and address it explicitly:**
  ```bash
  npm --prefix frontend run dev -- --port 5188 --strictPort   # background; then NEBULA_URL=http://localhost:5188
  ```
  The dev server is long-running — run it in the background, and note it gets recycled on session resume (restart it).
- **Backend on `:8000`** must be up for real chat status (`uvicorn main:app --port 8000`). Graph/chat *visuals* only need the frontend + the stores, but the live `Codex · ChatGPT` status needs the backend.
- **Render fidelity:** Puppeteer headless renders the app's own fonts (loaded by the app), so captures match across Playwright/Puppeteer. Capture at the video resolution (1920×1080).
- **"Compose freely" is allowed.** Components don't have to behave like the live app — you can place a chat icon where you want, fake the agent state, etc. The bar is that it *looks* like the real product and reads clearly.

## Capturing for the composition

For staged sequences (line-by-line typing, node-by-node wiring), capture **one PNG per state** at the SAME framing, e.g.:
- chat: `chatp-1/2/3.png` = same bubble with 1, 2, 3 lines (streaming cursor on the in-progress ones).
- wiring: `nw-1..5.png` = node1 / node1+node2 / +edge1 / +node3 / +edge2 (docked chat constant in all).

Because consecutive states share identical pixels except the new element, the composition can **hard-cut** between them (see hyperframes-gotchas) for a clean, flash-free "it's happening live" feel.

## Static-brand handoff (for motion-ref)

The capture script can emit a small JSON that the global `motion-ref` skill consumes as the **static-brand source** when merging a reference video's motion half into a Nebula `frame.md`:

```json
{ "palette": {"bg": "#050506", "ink": "#ffffff", "accent": "#ff5a1f"},
  "typography": {"ui": "Inter", "mono": "JetBrains Mono"},
  "corners": {"glass": "16px", "nodes": "12px", "pills": "999px"},
  "depth": "glass blur(28px) + 1px hairline, no shadow",
  "avoidance": ["never wash the background in orange (it's a signal)"] }
```

Read these off the running app via `window.__nebula*` (palette/fonts) or hard-code from the Slava tokens. `motion-ref` supplies the motion half (easing/beats/transitions); this supplies the exact static tokens — together they make the full `frame.md`.
