// Section 01 — Prompt typing.
//
// Picks up where section 00 left off (camera at chatbox, cursor at the
// chat textarea, no chat history). User clicks the textarea, types
// "show yourself flying", clicks Send. The user bubble appears and
// Daedalus pushes his "Showing myself flying — one moment." reply.
//
// Voice (per-section build-vo, no music here — music gets layered in at
// the final stitch step):
//   ~4.5s  A casual ask.
//
// Duration target: ~6s.
//
// Output:
//   output/sections/01-prompt/<runId>/recording.mp4
//   output/sections/01-prompt/<runId>/events.json
//   output/sections/01-prompt/state-out.json   (passed to section 02)

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SECTIONS_OUT, FPS,
  nowSlug, log, sleep,
  launchBrowser, openApp, wipeAll,
  injectCursor, setOverview,
  startRecorder, makeCaptureHelpers, writeEvents,
  saveSnapshot, loadSnapshot,
} from './lib.mjs';

const SECTION = '01-prompt';
const PRIOR_STATE = join(SECTIONS_OUT, '00-intro', 'state-out.json');
const runId = nowSlug();
const RUN_DIR = join(SECTIONS_OUT, SECTION, runId);
const STATE_OUT = join(SECTIONS_OUT, SECTION, 'state-out.json');

const USER_PROMPT = 'show yourself flying';
const DAEDALUS_BUILDING = 'Showing myself flying — one moment.';

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  log('start', `runDir=${RUN_DIR}`);

  const userDataDir = join(SECTIONS_OUT, SECTION, `${runId}-profile`);
  await mkdir(userDataDir, { recursive: true });
  const { browser, page } = await launchBrowser(userDataDir);

  try {
    await openApp(page);
    log('bridges', '__nebulaCanvas + __nebulaChat + __nebulaGraphStore ready');

    // Wipe app state then load the prior section's snapshot. Section 00
    // left empty graph + empty chat; this is effectively a fresh start
    // but with the Daedalus tab already active.
    await wipeAll(page);
    await loadSnapshot(page, PRIOR_STATE);
    await sleep(400);

    // Set Daedalus as the active agent without firing the bloom (we don't
    // want the cold-open to play again here). Setting the agent state in
    // localStorage / the chat UI reflects this — but the simplest path is
    // to programmatically click the tab without animating cursor or
    // capturing the bloom (it'll fire briefly off-camera before the
    // section's recording starts).
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
      const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
      if (dae) dae.click();
    });
    await sleep(2900); // bloom plays + completes off-camera

    // Re-clear post-bloom (chat session re-establish can re-push old data).
    await page.evaluate(() => {
      const store = window.__nebulaGraphStore.getState();
      if (store.nodes.length > 0) store.clearGraph();
      window.__nebulaChat.clear();
    });
    await sleep(300);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');

    // Cursor starts at the chat textarea — match section 00's end pose.
    const taPos = await page.evaluate(() => {
      const ta = document.querySelector('.chat-panel__textarea');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!taPos) throw new Error('chat textarea not found');
    // Snap cursor instantly to the textarea (0ms transition) so it's
    // already in position when recording starts.
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 0), taPos);

    await setOverview(page);
    await sleep(300);

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 100 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Brief settle so the first frame shows the cursor parked on the
    // textarea before any motion.
    await sleep(500);

    // Click the textarea (visual ripple) + focus.
    await page.evaluate(() => window.__nebulaCursor.click());
    await sleep(150);
    await page.focus('.chat-panel__textarea');
    phases.b1_clickTextarea = Date.now();

    // Type the casual prompt.
    await page.type('.chat-panel__textarea', USER_PROMPT, { delay: 35 });
    phases.b1_typeEnd = Date.now();
    await sleep(400);

    // Cursor walks to Send + clicks.
    const sendCenter = await page.evaluate(() => {
      const send = Array.from(document.querySelectorAll('.chat-panel__send'))
        .find((b) => !b.classList.contains('chat-panel__send--stop'));
      if (!send) return null;
      const r = send.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!sendCenter) throw new Error('Send button not found');
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 700), sendCenter);
    await sleep(750);
    await page.evaluate(() => window.__nebulaCursor.click());
    phases.b1_send = Date.now();

    // Push user bubble + clear textarea.
    await page.evaluate((text) => {
      window.__nebulaChat.pushUser(text);
      window.__nebulaChat.setInput('');
    }, USER_PROMPT);
    await sleep(450);

    // Daedalus's "Showing myself flying — one moment." streaming reply.
    const buildId = await page.evaluate((text) => {
      return window.__nebulaChat.pushAssistant(text, { streaming: true });
    }, DAEDALUS_BUILDING);
    phases.b1_daedReply = Date.now();

    // Hold so viewer reads the reply before section ends. Long enough
    // to cover "A casual ask." voice (~1s) plus breathing room.
    await sleep(2400);
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

    const final = await page.evaluate(() => {
      const out = { panels: {} };
      const sels = {
        chat: '.chat-panel',
        library: '.panel--library',
        inspector: '.panel--inspector',
        settings: '.panel--settings',
      };
      for (const [name, sel] of Object.entries(sels)) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        out.panels[name] = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return out;
    });

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

    // End-of-section snapshot: user + Daedalus messages so far.
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
