// Section 0 — Intro.
//
// Cold-open: cursor walks to the Daedalus tab in the chat-panel agent
// selector, clicks it, the bloom animation plays, then the cursor pans
// down toward the chat textarea ready for the user to type.
//
// Voice (applied during the per-section build-vo step):
//   0.5s  Welcome to Nebula Nodes.
//   2.0s  I am Daedalus.
//   5.0s  Tell me what to build.
//
// Duration target: ~6.5s.
//
// Output:
//   output/sections/00-intro/<runId>/recording.mp4
//   output/sections/00-intro/<runId>/events.json
//   output/sections/00-intro/<runId>/state-out.json   (passed to section 01)
//
// Usage:
//   node scripts/puppeteer-driver/sections/00-intro.mjs

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  REPO_ROOT, SECTIONS_OUT, FPS,
  nowSlug, log, sleep,
  launchBrowser, openApp, wipeAll,
  injectCursor, setOverview,
  startRecorder, makeCaptureHelpers, writeEvents,
  saveSnapshot,
} from './lib.mjs';

const SECTION = '00-intro';
const runId = nowSlug();
const RUN_DIR = join(SECTIONS_OUT, SECTION, runId);
const STATE_OUT = join(SECTIONS_OUT, SECTION, 'state-out.json');

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  log('start', `runDir=${RUN_DIR}`);

  const userDataDir = join(SECTIONS_OUT, SECTION, `${runId}-profile`);
  await mkdir(userDataDir, { recursive: true });
  const { browser, page } = await launchBrowser(userDataDir);

  try {
    await openApp(page);
    log('bridges', '__nebulaCanvas + __nebulaChat + __nebulaGraphStore ready');

    await wipeAll(page);
    await sleep(800);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');

    // Suppress auto-fitView and set the wide canvas overview anchor before
    // the camera starts rolling — keeps the (currently empty) canvas
    // composed for the bloom + later pan beats.
    await setOverview(page);
    await sleep(300);

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 100 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Brief beat at frame 0 so the "Welcome" voice line has cover.
    await sleep(800);

    // Cursor walks to the Daedalus tab in the chat-panel agent selector.
    log('agent', 'cursor → Daedalus tab');
    const daePos = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
      const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
      if (!dae) return null;
      const r = dae.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!daePos) throw new Error('Daedalus tab not found in agent selector');
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1000), daePos);
    await sleep(1100);
    phases.b0_cursorAtTab = Date.now();

    // Click — fires the agent switch + bloom.
    await page.evaluate(() => window.__nebulaCursor.click());
    await sleep(150);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
      const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
      if (dae) dae.click();
    });
    phases.b0_clicked = Date.now();
    log('agent', 'clicked → bloom');

    // Hold so bloom plays.
    await sleep(2800);

    // Defense: post-bloom WS may push old graph state — wipe + re-anchor.
    await page.evaluate(() => {
      const store = window.__nebulaGraphStore.getState();
      if (store.nodes.length > 0) store.clearGraph();
      window.__nebulaChat.clear();
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    phases.b0_bloomDone = Date.now();

    // Camera will pan from bloom-center back to overview while voice
    // delivers "A node-based canvas for artistic AI." Cursor stays at
    // the Daedalus tab — section 00b picks up from there and walks it
    // toward the library for the drag demo.
    await sleep(3500);
    phases.recordEnd = Date.now();

    // ----- Stop recording -----
    const stopped = await recorder.stop();
    log('record', `${stopped.frameCount} frames, firstFrameTs=${stopped.firstFrameTs}`);
    let recordingPath = null;
    try {
      recordingPath = await recorder.mux(join(RUN_DIR, 'recording.mp4'), {
        targetDurationSec: (phases.recordEnd - phases.recordStart) / 1000,
      });
      log('mux', recordingPath);
    } catch (err) {
      log('mux-error', err.message);
    }

    // Capture panel bounds for derive-zoom.
    const final = await page.evaluate(() => {
      const out = { panels: {} };
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
    });

    await page.screenshot({ path: join(RUN_DIR, 'end.png'), fullPage: false });

    // events.json — derive-zoom shape.
    await writeEvents(RUN_DIR, {
      runId,
      section: SECTION,
      startedAt: new Date(phases.recordStart).toISOString(),
      endedAt: new Date(phases.recordEnd).toISOString(),
      viewport: { width: 1920, height: 1080 },
      eventCount: events.length,
      events,
      edges,
      panels: final.panels,
      phases,
      focusTargets: {},
      anchors: { perfNowAtInstall: 0, dateNowAtInstall: phases.recordStart },
      recording: recordingPath
        ? { path: recordingPath, frameCount: stopped.frameCount, fps: FPS, firstFrameTs: stopped.firstFrameTs }
        : null,
    });

    // Save snapshot for the next section. Intro starts the cut on a
    // freshly-blank canvas so this snapshot will be empty — that's the
    // expected starting state for section 01 (beat 1).
    await saveSnapshot(page, STATE_OUT);

    log('summary', `runDir=${RUN_DIR} duration=${((phases.recordEnd - phases.recordStart) / 1000).toFixed(2)}s`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
