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
const HEADLESS = args.headless === 'true' || args.headless === true;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  log('start', `out → ${OUT_DIR} (headless=${HEADLESS})`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: VIEWPORT,
    args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
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
    // gets closer) until .chat-panel is present, then proceed.
    log('nav', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the React tree to mount. Use .canvas-tabs-wrap which is always
    // present regardless of panel visibility state. Then confirm the graph store
    // is attached (set by App.tsx on mount).
    await page.waitForSelector('.canvas-tabs-wrap', { timeout: 60000 });
    await page.waitForFunction(() => !!window.__nebulaGraphStore, { timeout: 5000 });
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

    log('done', 'all 5 steps passed');
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
