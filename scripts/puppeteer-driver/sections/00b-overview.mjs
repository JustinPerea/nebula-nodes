// Section 00b — Canvas + chat overview.
//
// Slots between section 00 (intro/bloom) and section 01 (prompt typing).
// Daedalus has just introduced himself. Camera pulls back from the
// chatbox to a wide overview, cursor drags a node from the library to
// the canvas (showing the manual interaction model), then pulls back to
// the chatbox so section 01 can pick up with typing.
//
// Sequence:
//  1. Brief carry-over hold on chatbox textarea (matches section 00 end).
//  2. Pan to overview while voice introduces the drag interaction.
//  3. Cursor walks to the library panel, "grabs" a node ghost, drags it
//     to the canvas, drops — node spawns programmatically.
//  4. Pan back to chatbox textarea while voice cues the chat alternative.
//
// Voice (per-section build-vo, no music):
//   ~0.5s   You can drag nodes in yourself.
//   ~5.5s   Or just chat with me.
//
// Duration target: ~8s.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SECTIONS_OUT, FPS,
  nowSlug, log, sleep,
  launchBrowser, openApp, wipeAll,
  injectCursor, setOverview,
  startRecorder, makeCaptureHelpers, writeEvents,
  saveSnapshot,
} from './lib.mjs';

const SECTION = '00b-overview';
const runId = nowSlug();
const RUN_DIR = join(SECTIONS_OUT, SECTION, runId);
const STATE_OUT = join(SECTIONS_OUT, SECTION, 'state-out.json');

// Where the ghost-dragged node will land in screen coords. Maps to canvas
// position via the camera transform (centerOn -180,130, 0.55).
const DROP_SCREEN = { x: 1040, y: 480 };
// canvas_x = (screen_x - 880) / 0.55 - 180 ≈ 110 (close to -60 v1Gen slot)
// canvas_y = (screen_y - 540) / 0.55 + 130 ≈ 21
const DROP_CANVAS = { x: 110, y: 21 };

// Render a small "node card" element that follows the cursor during the
// pretend drag. Styled to read as a library item being held.
async function showNodeGhost(page, label, x, y) {
  await page.evaluate(({ label, x, y }) => {
    const existing = document.getElementById('__nebula-node-drag-ghost');
    if (existing) existing.remove();
    const ghost = document.createElement('div');
    ghost.id = '__nebula-node-drag-ghost';
    ghost.textContent = label;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${x - 60}px`,
      top: `${y - 16}px`,
      padding: '7px 14px',
      background: 'linear-gradient(180deg, #2a2c3e 0%, #1c1e2c 100%)',
      color: 'rgba(255,255,255,0.92)',
      borderRadius: '8px',
      fontSize: '13px',
      fontWeight: '500',
      fontFamily: '-apple-system, "SF Pro Display", system-ui, sans-serif',
      pointerEvents: 'none',
      zIndex: '99998',
      border: '1px solid rgba(255,255,255,0.18)',
      boxShadow: '0 12px 28px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset',
      opacity: '0',
      transform: 'scale(0.85)',
      transition: 'opacity 200ms ease, transform 200ms ease',
      willChange: 'left, top, opacity, transform',
    });
    document.body.appendChild(ghost);
    void ghost.offsetWidth;
    ghost.style.opacity = '1';
    ghost.style.transform = 'scale(1)';
  }, { label, x, y });
}

async function moveNodeGhost(page, x, y, durationMs = 800) {
  await page.evaluate(({ x, y, durationMs }) => {
    const ghost = document.getElementById('__nebula-node-drag-ghost');
    if (!ghost) return;
    ghost.style.transition = `left ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1), top ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease, transform 200ms ease`;
    ghost.style.left = `${x - 60}px`;
    ghost.style.top = `${y - 16}px`;
  }, { x, y, durationMs });
}

async function dropNodeGhost(page) {
  await page.evaluate(() => {
    const ghost = document.getElementById('__nebula-node-drag-ghost');
    if (!ghost) return;
    ghost.style.transition = 'opacity 220ms ease, transform 220ms ease';
    ghost.style.opacity = '0';
    ghost.style.transform = 'scale(0.7)';
    setTimeout(() => ghost.remove(), 260);
  });
}

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
    await sleep(500);

    // Activate Daedalus tab off-camera (bloom played in section 00 already).
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
      const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
      if (dae) dae.click();
    });
    await sleep(2900);
    await page.evaluate(() => {
      const store = window.__nebulaGraphStore.getState();
      if (store.nodes.length > 0) store.clearGraph();
      window.__nebulaChat.clear();
    });
    await sleep(300);

    // Wide canvas anchor — same as other sections.
    await page.evaluate(() => {
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(200);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');

    // Park cursor at the Daedalus tab — that's where section 00 leaves it
    // (after the bloom click). Section 00b walks it from there to the
    // library, then back down to the textarea for section 01.
    const daePos = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
      const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
      if (!dae) return { x: 1700, y: 60 };
      const r = dae.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 0), daePos);

    // Need taPos for the final cursor move back to the textarea.
    const taPos = await page.evaluate(() => {
      const ta = document.querySelector('.chat-panel__textarea');
      if (!ta) return { x: 1700, y: 950 };
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 100 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Brief carry-over hold on textarea (camera will pan during 0.5-2.0).
    await sleep(500);

    // ===== Pan to overview (camera handled by directives) — voice "You
    // can drag nodes in yourself" plays during this pan + the next beat.
    // Cursor walks toward the library panel.
    const libPos = await page.evaluate(() => {
      const lib = document.querySelector('.panel--library .panel__body');
      if (!lib) return { x: 158, y: 200 };
      const r = lib.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + 80 };
    });
    log('beat-0b', `library at (${libPos.x.toFixed(0)}, ${libPos.y.toFixed(0)})`);
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1600), libPos);
    await sleep(1700);
    phases.b0b_atLibrary = Date.now();

    // "Pick up" — show node ghost at cursor position.
    await showNodeGhost(page, 'GPT Image 2', libPos.x, libPos.y);
    await sleep(280);

    // Drag to canvas drop position. Cursor and ghost travel together.
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1100), DROP_SCREEN);
    await moveNodeGhost(page, DROP_SCREEN.x, DROP_SCREEN.y, 1100);
    await sleep(1150);
    phases.b0b_dropPos = Date.now();

    // Drop — fade ghost, spawn node at corresponding canvas position.
    await dropNodeGhost(page);
    const spawnedId = await page.evaluate(async (pos) => {
      return await window.__nebulaGraphStore.getState().addNode('gpt-image-2-generate', pos);
    }, DROP_CANVAS);
    log('beat-0b', `spawned ${spawnedId} at canvas (${DROP_CANVAS.x}, ${DROP_CANVAS.y})`);
    await sleep(450);
    await captureNode(spawnedId, 'GPT Image 2 Generate (demo drag)');

    // Beat to let the node settle on canvas.
    await sleep(550);

    // ===== Cursor moves back to chatbox textarea — voice "Or just chat
    // with me" lands as the cursor returns. Camera also pans back via
    // directives so section 01 picks up at chatbox-tight pose.
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1100), taPos);
    await sleep(1200);
    phases.b0b_backAtTextarea = Date.now();

    // Tail hold — covers "Or just chat with me" (5.5s) + "Tell me what to
    // build" (7.5s) voice lines before recording stops.
    await sleep(2600);
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

    const final = await page.evaluate((nodeIds) => {
      const out = { nodes: {}, panels: {} };
      for (const id of nodeIds) {
        const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out.nodes[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      const sels = { chat: '.chat-panel', library: '.panel--library' };
      for (const [name, sel] of Object.entries(sels)) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        out.panels[name] = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return out;
    }, events.map((e) => e.nodeId));
    for (const ev of events) {
      const r = final.nodes[ev.nodeId];
      if (r && r.width > 0) {
        ev.boundsAtCapture = ev.bounds;
        ev.bounds = r;
      }
    }

    await page.screenshot({ path: join(RUN_DIR, 'end.png'), fullPage: false });

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
