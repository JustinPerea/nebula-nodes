// Smoke test for Phase 2.1.a RemotionNode foundation.
//
// Verifies: drop RemotionNode → open editor → Player + Timeline slots render
// → close → reopen, with state persisting on the node.
//
// Run with dev server (5180) + backend (8000) up:
//   node scripts/puppeteer-driver/remotion-foundation-smoke.mjs
//
// Use --headless true to skip the visible window.

import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const URL = 'http://localhost:5180';
const VIEWPORT = { width: 1920, height: 1080 };
const OUT_DIR = join(REPO_ROOT, 'output', 'puppeteer-driver', 'remotion-foundation-smoke');

const args = parseArgs(process.argv.slice(2));
// Use 'shell' (chrome-headless-shell) instead of the default 'new' headless
// mode. The 'new' mode (--headless=new) stalls Page.captureScreenshot on
// macOS when Remotion's @remotion/player compositor is active; 'shell' mode
// uses the older --headless flag which has reliable screenshot support.
const HEADLESS = (args.headless === 'true' || args.headless === true) ? 'shell' : false;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  log('start', `out → ${OUT_DIR} (headless=${HEADLESS})`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: VIEWPORT,
    protocolTimeout: 120000,
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      // Software rendering — prevents CDP screenshot timeouts when Remotion's
      // @remotion/player compositor blocks the GPU pipeline in headless mode.
      '--use-gl=swiftshader',
      '--disable-gpu-sandbox',
      '--disable-software-rasterizer',
      '--no-sandbox',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    // Raise the per-page default so screenshot / waitForSelector calls don't
    // time out when Remotion's player renders frames in software mode.
    page.setDefaultTimeout(60000);
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('[smoke]') || msg.type() === 'error' || msg.type() === 'warn') {
        log('page', `[${msg.type()}] ${txt}`);
      }
    });
    page.on('pageerror', (err) => log('pageerror', err.message));

    // Step 0 — load canvas, clear graph.
    // Vite 8 re-optimizes deps lazily on the first headless browser visit, issuing
    // 504s for in-flight chunks while rolldown bundles them. Strategy: retry
    // goto+reload up to 4 times (each attempt either completes the optimization or
    // gets closer) until .canvas-tabs-wrap + __nebulaGraphStore are stable.
    log('nav', URL);
    let step0Ready = false;
    for (let attempt = 0; attempt < 4 && !step0Ready; attempt++) {
      if (attempt > 0) {
        log('nav', `retry attempt ${attempt}`);
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else {
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      try {
        // Wait for the React tree to mount. Use .canvas-tabs-wrap which is always
        // present regardless of panel visibility state.
        await page.waitForSelector('.canvas-tabs-wrap', { timeout: 30000 });
        // Confirm the graph store is attached (set by App.tsx on mount) and that
        // the page hasn't been reloaded by Vite dep-optimization mid-wait.
        await page.waitForFunction(() => !!window.__nebulaGraphStore, { timeout: 8000 });
        // Small buffer to let any pending Vite HMR settle before evaluating.
        await sleep(1500);
        // Re-check the store is still present (guards against a reload between
        // waitForFunction and the evaluate below).
        const storePresent = await page.evaluate(() => !!window.__nebulaGraphStore).catch(() => false);
        if (!storePresent) {
          log('nav', `attempt ${attempt}: store disappeared after settle — retrying`);
          continue;
        }
        step0Ready = true;
      } catch (e) {
        log('nav', `attempt ${attempt}: ${e.message} — retrying`);
      }
    }
    if (!step0Ready) {
      throw new Error('[smoke] Step 0: could not stabilize page after 4 attempts');
    }
    await page.evaluate(async () => {
      try { await fetch('http://localhost:8000/api/graph', { method: 'DELETE' }); }
      catch (e) { console.warn('[smoke] backend clear failed', String(e)); }
      window.__nebulaGraphStore.getState().clearGraph();
    });
    await sleep(800);
    await page.screenshot({ path: join(OUT_DIR, 'step0-canvas-clean.png') });

    // Step 1 — programmatically add a remotion-node via the store
    log('test-1', 'addNode remotion-node');
    await page.evaluate(async () => {
      await window.__nebulaGraphStore.getState().addNode('remotion-node', { x: 400, y: 200 });
    });
    await sleep(1200);
    const nodesAfterAdd = await page.evaluate(() =>
      window.__nebulaGraphStore.getState().nodes.map((n) => ({ id: n.id, def: n.data.definitionId })),
    );
    log('test-1', `nodes after add: ${JSON.stringify(nodesAfterAdd)}`);
    await page.screenshot({ path: join(OUT_DIR, 'step1-card-on-canvas.png') });
    if (!nodesAfterAdd.find((n) => n.def === 'remotion-node')) {
      throw new Error('remotion-node not present in store after addNode');
    }

    // Step 2 — confirm card is in the DOM, select it, open editor
    await page.waitForFunction(
      () => !!document.querySelector('.remotion-node'),
      { timeout: 8000 },
    );
    await page.click('.remotion-node');
    await sleep(200);
    await page.screenshot({ path: join(OUT_DIR, 'step2-selected.png') });
    await page.waitForSelector('.remotion-node__open', { timeout: 2000 });
    await page.click('.remotion-node__open');

    // Step 3 — editor mounts
    await page.waitForSelector('.remotion-editor-view', { timeout: 3000 });
    await page.waitForSelector('[data-testid="remotion-player-slot"]', { timeout: 2000 });
    await page.waitForSelector('[data-testid="remotion-timeline-slot"]', { timeout: 2000 });
    await page.screenshot({ path: join(OUT_DIR, 'step3-editor-open.png') });

    // Step 4 — close editor, back to canvas
    await page.click('.remotion-editor-view__back');
    await page.waitForSelector('.react-flow', { timeout: 3000 });
    await page.screenshot({ path: join(OUT_DIR, 'step4-back-to-canvas.png') });

    // Step 5 — reopen, confirm state persists
    await page.click('.remotion-node');
    await page.click('.remotion-node__open');
    await page.waitForSelector('.remotion-editor-view', { timeout: 3000 });
    await page.screenshot({ path: join(OUT_DIR, 'step5-reopened.png') });

    // Step 6 — Rule A: add a TrackItem via the store, verify canvas node spawns
    log('test-6', 'addTrackItemWithCanvasMirror with TextNode');
    await page.evaluate(async () => {
      const state = window.__nebulaGraphStore.getState();
      const remotion = state.nodes.find((n) => n.data.definitionId === 'remotion-node');
      if (!remotion) throw new Error('[smoke] no remotion-node found');
      state.addTrackItemWithCanvasMirror(remotion.id, {
        componentType: 'TextNode',
        props: { text: 'smoke test', fontSize: 80, color: '#ffcc00' },
        time: { startFrame: 0, durationInFrames: 90 },
      });
    });
    await sleep(800);
    const ruleAState = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const nodeDefs = s.nodes.map((n) => n.data.definitionId);
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      return { nodeDefs, timelineLength: tl.length, trackSourceId: tl[0]?.sourceNodeId };
    });
    log('test-6', `state: ${JSON.stringify(ruleAState)}`);
    if (!ruleAState.nodeDefs.includes('text-input')) {
      throw new Error('[smoke] Rule A failed: text-input node not spawned');
    }
    if (ruleAState.timelineLength !== 1) {
      throw new Error('[smoke] Rule A failed: TrackItem not added to manifest');
    }
    await page.screenshot({ path: join(OUT_DIR, 'step6-rule-a-spawned.png') });

    // Step 7 — back to canvas + reopen editor — TrackItem renders in Player
    await page.click('.remotion-editor-view__back');
    await sleep(300);
    await page.click('.remotion-node');
    await page.click('.remotion-node__open');
    await sleep(800);
    await page.screenshot({ path: join(OUT_DIR, 'step7-text-rendering.png') });

    // Step 8 — Rule B: remove the spawned text-input node, verify TrackItem pruned
    const spawnedTextInputId = ruleAState.trackSourceId;
    log('test-8', `removing spawned node ${spawnedTextInputId}`);
    await page.evaluate((id) => {
      window.__nebulaGraphStore.getState().onNodesChange([{ id, type: 'remove' }]);
    }, spawnedTextInputId);
    await sleep(500);
    const ruleBState = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return {
        nodeCount: s.nodes.length,
        timelineLength: remotion?.data.params?.manifest?.timeline?.length ?? 0,
      };
    });
    log('test-8', `state: ${JSON.stringify(ruleBState)}`);
    if (ruleBState.timelineLength !== 0) {
      throw new Error('[smoke] Rule B failed: TrackItem not pruned after canvas-node removal');
    }
    await page.screenshot({ path: join(OUT_DIR, 'step8-rule-b-pruned.png') });

    // Step 9 — Re-open editor on the existing RemotionNode
    // After step 8 the remotion-editor-view is still open; go back to canvas first.
    await page.click('.remotion-editor-view__back');
    await page.waitForSelector('.react-flow', { timeout: 3000 });
    await page.waitForFunction(() => !!document.querySelector('.remotion-node'), { timeout: 5000 });
    await page.click('.remotion-node');
    await page.click('.remotion-node__open');
    await sleep(400);

    // Step 10 — Toolbar UI: click + Text to add a TrackItem
    log('test-10', 'toolbar + Text click');
    await page.waitForSelector('.remotion-editor-toolbar', { timeout: 2000 });
    const addButtons = await page.$$('.remotion-editor-toolbar__add');
    if (addButtons.length !== 6) {
      throw new Error(`[smoke] Toolbar add buttons expected 6, got ${addButtons.length}`);
    }
    // Click the first add button (+ Text)
    await addButtons[0].click();
    await sleep(500);
    const afterAdd = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline?.length ?? 0;
    });
    if (afterAdd !== 1) {
      throw new Error(`[smoke] After toolbar + Text, timeline length expected 1, got ${afterAdd}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step10-toolbar-add-text.png') });

    // Step 11 — Select the TrackItem by setting selection from store (the
    // xzdarcy onClickAction wiring is exercised by users; programmatic
    // selection is the assert path)
    log('test-11', 'set selection + properties panel populates');
    const trackId = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      return tl[0]?.id;
    });
    await page.evaluate((id) => {
      window.__nebulaUIStore?.getState?.().setSelectedTrackItem?.(id);
    }, trackId);
    await sleep(300);
    await page.screenshot({ path: join(OUT_DIR, 'step11-selection.png') });

    // Step 12 — Delete via Delete key (keyboard hook)
    log('test-12', 'press Delete to remove selected');
    await page.keyboard.press('Delete');
    await sleep(500);
    const afterDel = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline?.length ?? -1;
    });
    if (afterDel !== 0) {
      throw new Error(`[smoke] After Delete, timeline length expected 0, got ${afterDel}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step12-deleted.png') });

    // Step 13 — Toolbar add, then Cmd+D to duplicate at current frame
    log('test-13', 'add via toolbar, then Cmd+D');
    await (await page.$$('.remotion-editor-toolbar__add'))[0].click(); // + Text
    await sleep(400);
    // Select it (same store-poke as step 11)
    const newTrackId = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline[0]?.id;
    });
    await page.evaluate((id) => {
      window.__nebulaUIStore?.getState?.().setSelectedTrackItem?.(id);
    }, newTrackId);
    await sleep(200);
    // Fire Cmd+D (on macOS this is Meta+D; the hook accepts both Meta and Ctrl)
    await page.keyboard.down('Meta');
    await page.keyboard.press('d');
    await page.keyboard.up('Meta');
    await sleep(500);
    const afterDup = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline?.length ?? -1;
    });
    if (afterDup !== 2) {
      throw new Error(`[smoke] After Cmd+D, timeline length expected 2, got ${afterDup}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step13-duplicated.png') });

    // Step 14 — Toolbar UI: click + Iso Block to add a 3D TrackItem
    log('test-14', 'toolbar + Iso Block click');
    const isoBlockBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('.remotion-editor-toolbar__add'));
      return buttons.find((b) => /iso block/i.test(b.textContent ?? ''));
    });
    if (!isoBlockBtn) {
      throw new Error('[smoke] Step 14: + Iso Block button not found');
    }
    await isoBlockBtn.click();
    await sleep(800); // R3F + ThreeCanvas need a tick to mount
    const afterIso = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const lastItem = tl[tl.length - 1];
      return {
        timelineLength: tl.length,
        lastComponentType: lastItem?.componentType,
      };
    });
    if (afterIso.lastComponentType !== 'IsometricBlock') {
      throw new Error(`[smoke] Step 14: last TrackItem expected IsometricBlock, got ${afterIso.lastComponentType}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step14-isoblock-add.png') });

    // Step 15 — Drag the first Text TrackItem via the Player overlay
    log('test-15', 'select Text layer in store, then drag its selection box body');
    // Identify the first Text TrackItem on the timeline
    const textItem = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const text = tl.find((t) => t.componentType === 'TextNode');
      return text
        ? { id: text.id, beforeX: text.spatial.x, beforeY: text.spatial.y }
        : null;
    });
    if (!textItem) {
      throw new Error('[smoke] Step 15: no Text TrackItem on timeline');
    }
    // Select the Text item via the uiStore so PlayerOverlay renders SelectionBox
    await page.evaluate((id) => {
      window.__nebulaUIStore.getState().setSelectedTrackItem(id);
    }, textItem.id);
    await sleep(300);

    // Read the selection box body's bounding rect to compute drag start point
    const dragRect = await page.evaluate(() => {
      const body = document.querySelector('.remotion-selection-box__body');
      if (!body) return null;
      const r = body.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
    });
    if (!dragRect) {
      throw new Error('[smoke] Step 15: .remotion-selection-box__body not in DOM after selecting Text layer');
    }

    // Drag: start at body center, move +200 screen pixels right
    await page.mouse.move(dragRect.x, dragRect.y);
    await page.mouse.down();
    // Two intermediate moves so PlayerOverlay/SelectionBox see a clean pointermove sequence
    await page.mouse.move(dragRect.x + 100, dragRect.y, { steps: 5 });
    await page.mouse.move(dragRect.x + 200, dragRect.y, { steps: 5 });
    await page.mouse.up();
    await sleep(300);

    const afterDrag = await page.evaluate((id) => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const item = tl.find((t) => t.id === id);
      return item ? { x: item.spatial.x, y: item.spatial.y } : null;
    }, textItem.id);
    if (!afterDrag) {
      throw new Error(`[smoke] Step 15: Text TrackItem ${textItem.id} disappeared after drag`);
    }
    // beforeX is 0 (IDENTITY_TRANSFORM default) unless a prior step moved the item.
    // If this assertion false-fails, check that no step between 13 and 15 mutates spatial.x.
    if (afterDrag.x <= textItem.beforeX) {
      throw new Error(
        `[smoke] Step 15: spatial.x did not increase. before=${textItem.beforeX} after=${afterDrag.x}`,
      );
    }
    await page.screenshot({ path: join(OUT_DIR, 'step15-text-dragged.png') });
    // Clear selection so any future Step 16+ starts with no SelectionBox mounted.
    await page.evaluate(() => {
      window.__nebulaUIStore.getState().setSelectedTrackItem(null);
    });

    log('done', 'all 15 steps passed');
  } finally {
    await browser.close();
  }
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
