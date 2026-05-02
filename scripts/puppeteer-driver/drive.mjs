// Path-B driver. Operates the nebula UI end-to-end via Puppeteer:
//   1. Open localhost:5173
//   2. Switch to the Daedalus agent tab
//   3. Start CDP screencast recording
//   4. Type a prompt and send
//   5. Record every .react-flow__node creation with a high-res timestamp
//   6. Wait for DOM to stabilize, stop recording, ffmpeg-mux to mp4, exit
//
// Recording uses the Chrome DevTools Protocol Page.startScreencast — frames
// arrive only on repaint, so we save them with their CDP timestamps and use
// ffmpeg's concat demuxer to preserve real timing in the muxed mp4.
// Zoom-baking is the next layer.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// Default prompt: graph-build only, no execution — keeps MVP runs cheap (one
// Kimi call, no image-model spend). Pass --prompt "..." to override.
const DEFAULT_PROMPT =
  "Build the graph for: Text Input node wired into a gpt-image-2-generate node, where the prompt is 'cyanotype blueprint of a daedalus wing, technical schematic, hand-drawn'. Just build the graph — do NOT execute or run any nodes.";

const args = parseArgs(process.argv.slice(2));
const URL = args.url ?? 'http://localhost:5173';
const PROMPT = args.prompt ?? DEFAULT_PROMPT;
const VIEWPORT = { width: 1920, height: 1080 };
const HEADLESS = args.headless === 'true' || args.headless === true;
const STABLE_MS = Number(args.stableMs ?? 8000); // exit after this long with no new nodes
const HARD_CAP_MS = Number(args.hardCapMs ?? 120000); // absolute ceiling
const RECORD = args.record !== 'false'; // record by default; --record false to skip
const FPS = Number(args.fps ?? 30);
const SCREENCAST_QUALITY = Number(args.quality ?? 80); // CDP screencast JPEG quality 0-100

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(REPO_ROOT, 'output', 'puppeteer-driver', runId);

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  log('run-dir', RUN_DIR);

  // Fresh user-data-dir per run so localStorage/IndexedDB/cookies start
  // empty. Puppeteer's default temp profile *should* be fresh, but being
  // explicit nukes any chance of profile reuse via system-default Chrome.
  const userDataDir = join(REPO_ROOT, 'output', 'puppeteer-driver', `${runId}-profile`);
  await mkdir(userDataDir, { recursive: true });
  log('profile', userDataDir);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: VIEWPORT,
    userDataDir,
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Mirror page console into ours so backend WS errors etc. surface here.
    page.on('console', (msg) => log('page', `[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => log('page-error', err.message));

    // Wipe any persisted browser storage BEFORE navigation so the app boots
    // with no graph/UI state from prior runs. Belt for the suspenders that
    // is fresh-user-data-dir.
    log('storage', 'clearing localStorage/sessionStorage');
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCookies').catch(() => {});
    await client.send('Network.clearBrowserCache').catch(() => {});
    await client.detach().catch(() => {});

    log('nav', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    // After page load, clear web storage (page must be loaded for this),
    // then pin Daedalus's provider to Nous and RELOAD so ChatPanel.tsx
    // re-initializes from the new localStorage value. Without the reload
    // the React state was already read from empty/default ('openrouter')
    // and the per-turn API call gets routed there — observed as HTTP 402
    // "this request requires more credits, visit openrouter.ai/settings".
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try { localStorage.setItem('nebula:daedalus-provider', 'nous'); } catch {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Verify the chat panel is mounted. uiStore defaults visible:true but it's
    // localStorage-persisted, so a stale state could have it closed.
    await page.waitForSelector('.chat-panel', { timeout: 10000 }).catch(() => {
      throw new Error(
        '.chat-panel not found. Open the chat panel in the app or clear localStorage and retry.',
      );
    });

    // The textarea is disabled until WebSocket connects. Wait for WS up
     // BEFORE the agent switch so we don't race with the bloom animation.
    log('connect', 'waiting for chat-panel__textarea to enable');
    await page.waitForFunction(
      () => {
        const ta = document.querySelector('.chat-panel__textarea');
        return ta && !ta.disabled;
      },
      { timeout: 15000 },
    );

    // Wipe BACKEND graph state first — same endpoint /clear uses internally
    // (see ChatPanel.tsx:885). Without this, the backend's cli_graph carries
    // nodes from prior sessions and re-pushes them via WS to the new browser.
    log('clear', 'DELETE /api/graph (backend cli_graph wipe)');
    const backendClear = await page.evaluate(async () => {
      try {
        const r = await fetch(`http://${window.location.hostname}:8000/api/graph`, { method: 'DELETE' });
        return { ok: r.ok, status: r.status };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
    log('clear', `backend: ${JSON.stringify(backendClear)}`);

    // Then clear any frontend graph state. The graphStore exposes itself on
    // window.__nebulaGraphStore in DEV builds (see graphStore.ts).
    log('clear', 'clearing frontend graph');
    await page.waitForFunction(
      () => !!window.__nebulaGraphStore,
      { timeout: 5000 },
    );
    const clearedCount = await page.evaluate(() => {
      const store = window.__nebulaGraphStore;
      const before = store.getState().nodes.length;
      store.getState().clearGraph();
      return before;
    });
    log('clear', `cleared ${clearedCount} stale nodes`);

    // Belt-and-suspenders: WS reconnects can re-push backend session state
    // and repopulate the graph after our clearGraph call. Wait long enough
    // (2s) for any deferred backend push, then re-verify and re-clear.
    await sleep(2000);
    const afterClear = await page.evaluate(() => {
      const store = window.__nebulaGraphStore;
      const n = store.getState().nodes.length;
      if (n > 0) store.getState().clearGraph();
      return n;
    });
    if (afterClear > 0) {
      log('clear', `WS re-pushed ${afterClear} nodes — re-cleared`);
      await sleep(500);
    }

    // Install the MutationObserver BEFORE sending so we don't miss the first
    // node. Records to window.__nebulaNodeEvents which we drain from Node.
    // Capture both perf.now() and Date.now() at install — derive-zoom needs
    // both anchors to align node-event timestamps onto the recording.mp4
    // timeline (CDP frame timestamps are wall-clock seconds).
    log('observer', 'installing canvas mutation observer');
    const observerAnchor = await page.evaluate(() => {
      window.__nebulaNodeEvents = [];
      window.__nebulaEdgeEvents = [];
      window.__nebulaSeenNodeIds = new Set();
      window.__nebulaSeenEdgeIds = new Set();
      const startedAt = performance.now();
      window.__nebulaObserverStartedAt = startedAt;

      const recordNode = (el) => {
        if (!(el instanceof Element)) return;
        const node = el.classList && el.classList.contains('react-flow__node')
          ? el
          : el.querySelector && el.querySelector('.react-flow__node');
        if (!node) return;
        const id = node.getAttribute('data-id') || node.id || null;
        if (!id || window.__nebulaSeenNodeIds.has(id)) return;
        window.__nebulaSeenNodeIds.add(id);
        // React Flow uses generic wrapper types (model-node, dynamic-node,
        // reroute-node) — semantic identity ("GPT Image 2", "Text Input")
        // lives in the node header label.
        const labelEl = node.querySelector('.model-node__label');
        const wrapperType = (node.className.match(/react-flow__node-([\w-]+)/) || [])[1] || null;
        const rect = node.getBoundingClientRect();
        window.__nebulaNodeEvents.push({
          ts: performance.now() - startedAt,
          nodeId: id,
          nodeLabel: labelEl ? labelEl.textContent.trim() : null,
          wrapperType,
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          dpr: window.devicePixelRatio || 1,
          kind: 'added',
        });
      };

      // Track edge additions so derive-zoom can frame the moment a connection
      // appears (Daedalus typically creates edges 1-2 frames after the second
      // node, so this lets a "show it connect" beat ride that timing).
      const recordEdge = (el) => {
        if (!(el instanceof Element)) return;
        const edge = el.classList && el.classList.contains('react-flow__edge')
          ? el
          : el.querySelector && el.querySelector('.react-flow__edge');
        if (!edge) return;
        const id = edge.getAttribute('data-id') || edge.id || null;
        if (!id || window.__nebulaSeenEdgeIds.has(id)) return;
        window.__nebulaSeenEdgeIds.add(id);
        const rect = edge.getBoundingClientRect();
        window.__nebulaEdgeEvents.push({
          ts: performance.now() - startedAt,
          edgeId: id,
          // React Flow encodes source/target into the edge id as
          // "xy-edge__<src>-<srcHandle>-<tgt>-<tgtHandle>" — keeping the raw
          // id lets derive-zoom union with the connecting nodes' bounds.
          source: edge.getAttribute('data-source') || null,
          target: edge.getAttribute('data-target') || null,
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          kind: 'edge-added',
        });
      };

      // Catch any nodes that are already on canvas (rare on a fresh load but
      // keeps repeat-runs honest).
      document.querySelectorAll('.react-flow__node').forEach(recordNode);
      document.querySelectorAll('.react-flow__edge').forEach(recordEdge);

      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((n) => { recordNode(n); recordEdge(n); });
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      window.__nebulaObserver = obs;

      // Anchors: event ts is performance.now()-relative; CDP frame timestamps
      // are seconds-since-epoch. derive-zoom needs both to align.
      return {
        perfNowAtInstall: startedAt,
        dateNowAtInstall: Date.now(),
      };
    });

    // Start CDP screencast recording BEFORE the Daedalus tab click so the
    // bloom/sigil animation is captured in full.
    let recorder = null;
    if (RECORD) {
      recorder = await Recorder.start(page, RUN_DIR, {
        quality: SCREENCAST_QUALITY,
        viewport: VIEWPORT,
      });
      log('record', `screencast started → ${recorder.framesDir}`);
    }

    // Inject a virtual cursor element + control API. CDP screencast doesn't
    // capture the OS pointer reliably, so we render our own SVG pointer in
    // page DOM (pointer-events: none, very high z-index) and animate it via
    // CSS transitions for smooth, capture-friendly motion. Click also emits
    // a brief expanding ring so the press registers visually.
    await page.evaluate(({ vw, vh }) => {
      const cursor = document.createElement('div');
      cursor.id = '__nebula-cursor';
      // Classic pointer SVG; hot-spot is near (5, 3) of the 32×32 box.
      cursor.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 3 L5 23 L11 18 L13.5 24 L16 23 L13.5 17 L21 17 Z"
                fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>`;
      Object.assign(cursor.style, {
        position: 'fixed', top: '0', left: '0',
        width: '32px', height: '32px',
        pointerEvents: 'none',
        zIndex: '99999',
        transform: `translate(${vw / 2 - 5}px, ${vh / 2 - 3}px)`,
        transition: 'transform 1.2s cubic-bezier(0.4, 0, 0.2, 1)',
        willChange: 'transform',
        filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.55))',
      });
      document.body.appendChild(cursor);

      const ripple = document.createElement('div');
      ripple.id = '__nebula-cursor-ripple';
      Object.assign(ripple.style, {
        position: 'fixed', top: '0', left: '0',
        width: '36px', height: '36px',
        pointerEvents: 'none',
        zIndex: '99998',
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.85)',
        boxSizing: 'border-box',
        opacity: '0',
        transform: 'translate(-9999px, -9999px) scale(0.3)',
      });
      document.body.appendChild(ripple);

      // Track cursor position so click() can pin the ripple to the tip.
      let cx = vw / 2, cy = vh / 2;
      window.__nebulaCursor = {
        // tx/ty are SCREEN coords of the cursor's TIP. Offset by the SVG's
        // hot-spot so a request to "click at (x, y)" lands the visible tip
        // exactly there.
        moveTo: (tx, ty, durationMs = 1200) => {
          cx = tx; cy = ty;
          cursor.style.transition = `transform ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
          cursor.style.transform = `translate(${tx - 5}px, ${ty - 3}px)`;
        },
        click: () => {
          // Press: cursor scales down briefly.
          const t = cursor.style.transform;
          cursor.style.transition = 'transform 120ms ease-out';
          cursor.style.transform = `${t} scale(0.85)`;
          setTimeout(() => { cursor.style.transform = t; }, 130);
          // Ripple: snap to tip, then expand + fade.
          ripple.style.transition = 'none';
          ripple.style.opacity = '0.9';
          ripple.style.transform = `translate(${cx - 18}px, ${cy - 18}px) scale(0.3)`;
          // Force reflow so the next transition is observed.
          void ripple.offsetWidth;
          ripple.style.transition = 'transform 520ms ease-out, opacity 520ms ease-out';
          ripple.style.transform = `translate(${cx - 18}px, ${cy - 18}px) scale(2.6)`;
          ripple.style.opacity = '0';
        },
      };
    }, { vw: VIEWPORT.width, vh: VIEWPORT.height });
    log('cursor', 'virtual cursor injected at viewport center');

    // Phase log: wall-clock Date.now() at each demo beat. derive-zoom converts
    // these to recording-timeline seconds (Date.now()/1000 - firstFrameTs).
    const phases = {};

    // Switch to Daedalus. Two buttons in .chat-panel__agent-selector — pick by
    // text rather than nth-child so a UI reorder doesn't silently break us.
    // The bloom animation fires on this transition; longest sub-animation is
    // the sigil at 2740ms (hermes.css), so we wait 2800ms for it to settle
    // before doing anything that would distract the camera.
    // Brief beat before the cursor starts moving — gives the recording a
    // moment to show the empty starting state with the cursor parked center.
    await sleep(400);

    // Animate the virtual cursor to the Daedalus button before clicking. The
    // motion is captured by the screencast and reads as intent in the cut.
    const daedalusCenter = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
      const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
      if (!dae) return null;
      const r = dae.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (daedalusCenter) {
      log('cursor', `moving to Daedalus button at ${daedalusCenter.x.toFixed(0)},${daedalusCenter.y.toFixed(0)}`);
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1200), daedalusCenter);
      await sleep(1300); // motion + tiny settle
      await page.evaluate(() => window.__nebulaCursor.click());
      await sleep(150); // ripple kickoff before real click registers
    }

    log('agent', 'switching to Daedalus');
    phases.agentSwitch = Date.now();
    await page.evaluate(() => {
      const btns = Array.from(
        document.querySelectorAll('.chat-panel__agent-selector button'),
      );
      const dae = btns.find(
        (b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus',
      );
      if (!dae) throw new Error('Daedalus agent button not found');
      dae.click();
    });
    log('bloom', 'waiting 2800ms for bloom animation');
    await sleep(2800);
    phases.bloomEnd = Date.now();

    // FINAL clear: switching agent re-establishes the chat session, which
    // can trigger another backend push of cached graph state. Clear once
    // more after bloom completes so nothing leftover spawns into the demo.
    const postBloomClear = await page.evaluate(() => {
      const store = window.__nebulaGraphStore;
      const n = store.getState().nodes.length;
      if (n > 0) store.getState().clearGraph();
      return n;
    });
    if (postBloomClear > 0) log('clear', `post-bloom: cleared ${postBloomClear} re-spawned nodes`);

    // Settle pause so derive-zoom has a clean beat between bloom-end and
    // type-start to ease the camera in.
    await sleep(800);

    // Type the prompt. Use type() so React's onChange fires naturally — direct
    // .value assignment doesn't dispatch the synthetic event. Slower delay
    // (35ms) so the typing reads as deliberate in the zoomed-in shot.
    // Walk the virtual cursor from the Daedalus button to the textarea
    // before typing — reads as the user reaching for the input deliberately.
    const textareaCenter = await page.evaluate(() => {
      const ta = document.querySelector('.chat-panel__textarea');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (textareaCenter) {
      log('cursor', `moving to textarea at ${textareaCenter.x.toFixed(0)},${textareaCenter.y.toFixed(0)}`);
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1100), textareaCenter);
      await sleep(1200);
      await page.evaluate(() => window.__nebulaCursor.click());
      await sleep(180);

      // Fire-and-forget cursor move toward the Send button so the cursor
      // doesn't sit on top of the typed text. The slow 2.5s ease overlaps
      // the typing animation — by the time typing is done, the cursor is
      // already parked at Send, ready to click. We re-target Send below
      // because the textarea auto-grows during typing and Send shifts.
      await page.evaluate(() => {
        const send = Array.from(document.querySelectorAll('.chat-panel__send'))
          .find((b) => !b.classList.contains('chat-panel__send--stop'));
        if (!send || !window.__nebulaCursor) return;
        const r = send.getBoundingClientRect();
        window.__nebulaCursor.moveTo(r.x + r.width / 2, r.y + r.height / 2, 2500);
      });
    }

    log('input', `typing prompt (${PROMPT.length} chars)`);
    phases.typeStart = Date.now();
    await page.focus('.chat-panel__textarea');
    await page.type('.chat-panel__textarea', PROMPT, { delay: 35 });
    phases.typeEnd = Date.now();

    // Capture chatbox bounds AFTER typing — the textarea auto-grows as content
    // is added (see ChatPanel.tsx auto-resize useEffect), so its post-typing
    // bounds are what derive-zoom should aim the camera at. Union with the
    // send button so both are framed.
    const chatboxBounds = await page.evaluate(() => {
      const ta = document.querySelector('.chat-panel__textarea');
      const send = Array.from(document.querySelectorAll('.chat-panel__send'))
        .find((b) => !b.classList.contains('chat-panel__send--stop'));
      if (!ta) return null;
      const taR = ta.getBoundingClientRect();
      let x = taR.x, y = taR.y, right = taR.x + taR.width, bottom = taR.y + taR.height;
      if (send) {
        const sR = send.getBoundingClientRect();
        x = Math.min(x, sR.x);
        y = Math.min(y, sR.y);
        right = Math.max(right, sR.x + sR.width);
        bottom = Math.max(bottom, sR.y + sR.height);
      }
      return { x, y, width: right - x, height: bottom - y };
    });
    log('chatbox', chatboxBounds ? `bounds ${chatboxBounds.x.toFixed(0)},${chatboxBounds.y.toFixed(0)} ${chatboxBounds.width.toFixed(0)}x${chatboxBounds.height.toFixed(0)}` : 'NOT FOUND');

    // Brief pause after typing so the viewer reads the full prompt before
    // it's submitted.
    await sleep(600);

    // Walk the cursor from the textarea to the Send button. Short distance
    // (textarea and send sit side-by-side in the chat panel), so a 700ms
    // ease feels snappy without looking jumpy.
    const sendCenter = await page.evaluate(() => {
      const send = Array.from(document.querySelectorAll('.chat-panel__send'))
        .find((b) => !b.classList.contains('chat-panel__send--stop'));
      if (!send) return null;
      const r = send.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (sendCenter) {
      // Cursor was already eased to Send during typing (2.5s overlap from
      // the textarea-click block). The textarea auto-grew while typing, so
      // Send may have shifted vertically — quick 250ms snap to the current
      // position absorbs the drift, then ripple + real click.
      log('cursor', `snapping to Send at ${sendCenter.x.toFixed(0)},${sendCenter.y.toFixed(0)}`);
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 250), sendCenter);
      await sleep(300);
      await page.evaluate(() => window.__nebulaCursor.click());
      await sleep(150);
    }

    // Send. The Send button is .chat-panel__send (and .chat-panel__send--stop
    // when busy). Click the non-stop variant.
    log('send', 'clicking send');
    phases.send = Date.now();
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__send'));
      const send = btns.find((b) => !b.classList.contains('chat-panel__send--stop'));
      if (!send) throw new Error('Send button not found');
      if (send.disabled) throw new Error('Send button is disabled');
      send.click();
    });

    // Open the Agent Log + relocate it into the empty canvas mid-bottom area
    // so the "Daedalus thinking" phase has visual content to frame on. The
    // log streams Daedalus's reasoning steps; without this, the camera holds
    // on a static chatbox while nothing visible happens.
    //
    // Inline styles override layouts.css's right-bottom anchored positioning
    // — width/height go up so the streaming text is readable, left/top
    // override the right-anchored fixed position. We capture the resulting
    // bounds and store them on focusTargets.agentLog for derive-zoom.
    await sleep(150);
    const agentLogBounds = await page.evaluate(() => {
      const headerEl = document.querySelector('.agent-log__header');
      const logEl = document.querySelector('.agent-log');
      if (!headerEl || !logEl) return null;
      // Open if not already open.
      if (!logEl.classList.contains('agent-log--open')) headerEl.click();
      // Reposition into canvas mid-bottom: wider, taller, centered between
      // library (right edge ~316) and chat panel (left edge ~1444).
      // layouts.css enforces max-width: 600px on the agent log via the shared
      // panel-resize rule; override it inline so we can go wider into canvas
      // empty space. Same for max-height (default 80vh would be fine but we
      // pin it explicitly to keep the captured bounds deterministic).
      logEl.style.maxWidth = '1100px';
      logEl.style.maxHeight = 'none';
      logEl.style.right = 'auto';
      logEl.style.bottom = 'auto';
      logEl.style.left = '430px';
      logEl.style.top = '420px';
      logEl.style.width = '1000px';
      logEl.style.height = '420px';
      const r = logEl.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    log('agent-log', agentLogBounds ? `bounds ${agentLogBounds.x.toFixed(0)},${agentLogBounds.y.toFixed(0)} ${agentLogBounds.width.toFixed(0)}x${agentLogBounds.height.toFixed(0)}` : 'NOT FOUND');

    // Suppress auto-fitView from this point on. The choreography below owns
    // node positioning AND viewport — we move both Text Input and GPT Image 2
    // to deliberate "center-left" / "center-right" canvas positions, then
    // call __nebulaCanvas.centerOn() to frame them. Letting the auto-fit
    // fire at first-node arrival would zoom in too tight on Text Input
    // alone (the user's "too zoomed in" complaint).
    await page.evaluate(() => {
      window.__nebulaSuppressFitView = true;
    });

    // Drain events as they accumulate. Exit when STABLE_MS passes with no new
    // nodes, or when HARD_CAP_MS hits.
    const startWall = Date.now();
    let lastNewEventAt = Date.now();
    let lastEventCount = 0;
    const events = [];

    while (true) {
      const elapsed = Date.now() - startWall;
      if (elapsed > HARD_CAP_MS) {
        log('timeout', `hard cap reached (${HARD_CAP_MS}ms)`);
        break;
      }

      const fresh = await page.evaluate(
        () => (window.__nebulaNodeEvents || []).slice(),
      );
      if (fresh.length > lastEventCount) {
        const firstNodeJustAppeared = lastEventCount === 0;
        const newEvents = [];
        for (let i = lastEventCount; i < fresh.length; i++) {
          const ev = fresh[i];
          events.push(ev);
          newEvents.push(ev);
          log('node', `+${ev.ts.toFixed(0)}ms id=${ev.nodeId}${ev.nodeLabel ? ` label="${ev.nodeLabel}"` : ''}`);
        }
        lastEventCount = fresh.length;
        lastNewEventAt = Date.now();

        // The first node landing means thinking is over. Close and restore
        // the agent log so the post-thinking pullback shot shows a clean
        // canvas instead of the relocated panel covering the new node.
        if (firstNodeJustAppeared && agentLogBounds) {
          await page.evaluate(() => {
            const headerEl = document.querySelector('.agent-log__header');
            const logEl = document.querySelector('.agent-log');
            if (!logEl) return;
            // Strip the inline overrides → CSS rules reclaim original layout.
            logEl.style.maxWidth = '';
            logEl.style.maxHeight = '';
            logEl.style.right = '';
            logEl.style.bottom = '';
            logEl.style.left = '';
            logEl.style.top = '';
            logEl.style.width = '';
            logEl.style.height = '';
            // Collapse if currently open.
            if (logEl.classList.contains('agent-log--open') && headerEl) headerEl.click();
          });
          log('agent-log', 'collapsed + restored after first node');
        }

        // Deliberate node placement so the cluster framing is predictable:
        //   • Text Input  → canvas (-300, -100)  → center-left of frame
        //   • GPT Image 2 → canvas ( 300, -100)  → center-right of frame
        // After moving each, call centerOn(0, 0, 0.85) so the React Flow
        // viewport puts canvas-origin at the container's screen center —
        // both nodes land on opposite sides of frame at a comfortable
        // zoom. Auto-fitView is already suppressed (set right after send),
        // so Daedalus's chosen positions never bleed into the cut.
        for (const ev of newEvents) {
          const isTextInput = ev.nodeLabel && /text input/i.test(ev.nodeLabel);
          const isGpt2 = ev.nodeLabel && /gpt[\s-]*image[\s-]*2/i.test(ev.nodeLabel);
          if (isTextInput) {
            // Canvas-x -420 puts the node center at container-x ≈ 276 with
            // zoom 1.2 → output-frame x ≈ 34% (center-left). Zoom 1.2
            // renders the node ~432 px wide on screen, ~19% of the output
            // frame after compose-scale — visible without crowding.
            log('choreo', `Text Input ${ev.nodeId} → canvas (-420, -100) @ z=1.2`);
            await page.evaluate(({ nodeId }) => {
              const canvas = window.__nebulaCanvas;
              if (!canvas) return;
              canvas.setNodePosition(nodeId, { x: -420, y: -100 });
              canvas.centerOn(0, 0, 1.2, 700);
              const nodeEl = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
              if (nodeEl) {
                const ta = nodeEl.querySelector('textarea');
                if (ta) ta.scrollTop = ta.scrollHeight;
              }
            }, { nodeId: ev.nodeId });
          } else if (isGpt2) {
            // Canvas-x 60 puts the node center at container-x ≈ 852 with
            // zoom 1.2 → output-frame x ≈ 59% (center-right). Symmetric
            // partner to the Text Input position above.
            log('choreo', `GPT Image 2 ${ev.nodeId} → canvas (60, -100) @ z=1.2`);
            await page.evaluate(({ nodeId }) => {
              const canvas = window.__nebulaCanvas;
              if (!canvas) return;
              canvas.setNodePosition(nodeId, { x: 60, y: -100 });
            }, { nodeId: ev.nodeId });
          }
        }
      }

      const sinceLast = Date.now() - lastNewEventAt;
      if (events.length > 0 && sinceLast > STABLE_MS) {
        log('stable', `no new nodes for ${sinceLast}ms — finishing`);
        break;
      }

      await sleep(250);
    }

    // Refresh per-node bounds after fitView has settled. The MutationObserver
    // captured bounds at insertion time, but Canvas.tsx auto-fits the React
    // Flow viewport ~80ms after nodes are added (panel-aware padding) and the
    // animation runs 400ms. Bounds at MO time are stale. Re-read each node's
    // current rect and update events[].bounds so derive-zoom focuses on the
    // post-fit positions.
    // Drain edge events accumulated by the observer. Captured for events.json
    // so derive-zoom can locate the connection beats; framing today still
    // rides the existing node-cluster logic because edges live inside the
    // bounding box of their connecting nodes.
    const edgeEvents = await page.evaluate(
      () => (window.__nebulaEdgeEvents || []).slice(),
    );
    if (edgeEvents.length) {
      log('edges', `captured ${edgeEvents.length} edge${edgeEvents.length === 1 ? '' : 's'}`);
    }

    let panelBounds = null;
    if (events.length > 0) {
      log('rebound', 'waiting for fitView to settle');
      await sleep(700);
      const refreshed = await page.evaluate((nodeIds) => {
        const out = { nodes: {}, panels: {} };
        for (const id of nodeIds) {
          const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          out.nodes[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        // Snapshot floating panels so derive-zoom can clamp the zoom crop
        // window to the panel-free zone. Each panel: top-left + size.
        const PANEL_SELECTORS = {
          chat: '.chat-panel',
          library: '.panel--library',
          inspector: '.panel--inspector',
          settings: '.panel--settings',
        };
        for (const [name, sel] of Object.entries(PANEL_SELECTORS)) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          out.panels[name] = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return out;
      }, events.map((e) => e.nodeId));
      let updatedCount = 0;
      for (const ev of events) {
        const r = refreshed.nodes[ev.nodeId];
        if (r && r.width > 0) {
          ev.boundsAtCapture = ev.bounds;
          ev.bounds = r;
          updatedCount++;
        }
      }
      panelBounds = refreshed.panels;
      log('rebound', `refreshed bounds on ${updatedCount}/${events.length} nodes`);
      log('panels', `captured ${Object.keys(panelBounds).join(', ') || '(none)'}`);
    }

    let recordingPath = null;
    let frameCount = 0;
    let firstFrameTs = null;
    if (recorder) {
      const stopped = await recorder.stop();
      frameCount = stopped.frameCount;
      firstFrameTs = stopped.firstFrameTs;
      log('record', `screencast stopped (${frameCount} frames, first frame ts=${firstFrameTs})`);
      try {
        recordingPath = await recorder.mux(join(RUN_DIR, 'recording.mp4'), FPS);
        log('mux', `${recordingPath}`);
      } catch (err) {
        log('mux-error', err.message);
      }
    }

    const screenshotPath = join(RUN_DIR, 'end.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log('screenshot', screenshotPath);

    const eventsPath = join(RUN_DIR, 'events.json');
    await writeFile(
      eventsPath,
      JSON.stringify(
        {
          runId,
          startedAt: new Date(startWall).toISOString(),
          endedAt: new Date().toISOString(),
          viewport: VIEWPORT,
          url: URL,
          prompt: PROMPT,
          eventCount: events.length,
          events,
          // Edge add events (separate from node events). React Flow renders
          // edges as their own DOM elements; capturing them lets derive-zoom
          // emphasize the moment a connection appears — typically right after
          // the second node lands, when Daedalus calls connect.
          edges: edgeEvents,
          // Floating panels in viewport coords. derive-zoom uses these to
          // compute the safe zone (viewport minus panels) and clamp zoomed
          // crop windows so panels never bleed into focused shots.
          panels: panelBounds,
          // Demo phases — Date.now() at each beat. derive-zoom converts to
          // recording-timeline seconds via firstFrameTs and inserts intro
          // directives (overview during bloom, ease-in to chatbox during
          // typing, ease-out after send).
          phases,
          // Named focus targets for non-node directives (e.g., chat input).
          // bypassSafeZone defaults to false; chatbox needs it true so the
          // camera can focus on the chat panel itself.
          focusTargets: {
            ...(chatboxBounds
              ? { chatbox: { ...chatboxBounds, bypassSafeZone: true } }
              : {}),
            ...(agentLogBounds
              ? { agentLog: { ...agentLogBounds, bypassSafeZone: true } }
              : {}),
          },
          // Anchors for timeline alignment. event.ts is perf.now()-relative;
          // recording.firstFrameTs is seconds-since-epoch (CDP). To convert
          // event N onto recording timeline:
          //   eventEpochMs = anchors.dateNowAtInstall + event.ts
          //   eventEpochSec = eventEpochMs / 1000
          //   eventOnRecording = eventEpochSec - recording.firstFrameTs
          anchors: observerAnchor,
          recording: recordingPath
            ? { path: recordingPath, frameCount, fps: FPS, firstFrameTs }
            : null,
        },
        null,
        2,
      ),
    );
    log('events', eventsPath);
    log('summary', `${events.length} nodes captured over ${Date.now() - startWall}ms${recordingPath ? `, ${frameCount} frames muxed` : ''}`);
  } finally {
    if (!args.keepOpen) {
      await browser.close();
    } else {
      log('keep-open', 'leaving browser open — close manually');
    }
  }
}

// CDP screencast wrapper. Frames arrive only on repaint, so we save them with
// their CDP wall-clock timestamps then build an ffmpeg concat-demuxer file
// with explicit per-frame durations. This preserves real-world pacing — long
// "thinking" gaps stay long, fast batch-renders stay fast — instead of
// compressing everything to a constant fps.
class Recorder {
  static async start(page, runDir, { quality, viewport }) {
    const framesDir = join(runDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    const client = await page.createCDPSession();
    const recorder = new Recorder(client, framesDir, viewport);
    client.on('Page.screencastFrame', (params) => recorder._onFrame(params));
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      everyNthFrame: 1,
    });
    return recorder;
  }

  constructor(client, framesDir, viewport) {
    this.client = client;
    this.framesDir = framesDir;
    this.viewport = viewport;
    this.frames = []; // { path, ts (seconds, CDP wall-clock) }
    this.pending = []; // in-flight write promises
    this.stopped = false;
  }

  _onFrame(params) {
    if (this.stopped) return;
    const idx = this.frames.length;
    const filename = `frame-${String(idx).padStart(6, '0')}.jpg`;
    const path = join(this.framesDir, filename);
    const ts = params.metadata?.timestamp ?? null;
    this.frames.push({ path, filename, ts });
    const buf = Buffer.from(params.data, 'base64');
    const write = writeFile(path, buf).catch((err) => {
      console.error('[recorder] write fail', err.message);
    });
    this.pending.push(write);
    // Ack so CDP keeps emitting. Fire-and-forget.
    this.client.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  }

  async stop() {
    this.stopped = true;
    try {
      await this.client.send('Page.stopScreencast');
    } catch {
      /* page may already be detaching */
    }
    await Promise.all(this.pending);
    return {
      frameCount: this.frames.length,
      firstFrameTs: this.frames[0]?.ts ?? null,
    };
  }

  async mux(outPath, fallbackFps) {
    if (this.frames.length < 2) {
      throw new Error(`not enough frames to mux (got ${this.frames.length})`);
    }
    // Build ffmpeg concat-demuxer playlist. Duration of frame N = ts[N+1]-ts[N].
    // The last frame gets a sensible default since there's no successor.
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const next = this.frames[i + 1];
      lines.push(`file '${f.filename}'`);
      const dur = next && f.ts != null && next.ts != null
        ? Math.max(0.001, next.ts - f.ts)
        : 1 / fallbackFps;
      lines.push(`duration ${dur.toFixed(4)}`);
    }
    // Ffmpeg concat demuxer quirk: last file must be repeated without a
    // trailing duration so it actually appears in the output.
    lines.push(`file '${this.frames[this.frames.length - 1].filename}'`);
    const playlistPath = join(this.framesDir, 'frames.txt');
    await writeFile(playlistPath, lines.join('\n') + '\n');

    return new Promise((resolve, reject) => {
      const ff = spawn(
        'ffmpeg',
        [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', playlistPath,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-vf', `scale=${this.viewport.width}:${this.viewport.height}:force_original_aspect_ratio=decrease,pad=${this.viewport.width}:${this.viewport.height}:(ow-iw)/2:(oh-ih)/2:black`,
          '-preset', 'fast',
          '-crf', '20',
          outPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) resolve(outPath);
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
      });
    });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${tag.padEnd(10)} ${msg}`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
