// Section 06 — Models-list beat: pull camera wide, highlight library panel.
//
// Picks up from section 05's end (full graph: TI + v1Gen + imageInput +
// ti2 + v2 + style + mesh + video, all populated; chat ending in
// fanout narration; camera tight on video at cx=0.64, cy=0.79, scale=2.5).
//
// Sequence:
//  1. Brief carry-over hold on video.
//  2. Pan camera out to a wide overview that fits library panel, canvas,
//     and chat panel.
//  3. Cursor moves from video region to library panel center (~40% from
//     top of panel).
//  4. Push modelsIntro chat as voice plays.
//  5. Hold wide while modelsIntro voice clears.
//
// Voice (per-section build-vo, no music):
//   ~2.5s   Each model has its own skill. They get better with every run.
//
// Duration target: ~8s.

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  REPO_ROOT, SECTIONS_OUT, FPS,
  nowSlug, log, sleep,
  launchBrowser, openApp, wipeAll,
  injectCursor,
  startRecorder, makeCaptureHelpers, writeEvents,
  saveSnapshot,
} from './lib.mjs';

const SECTION = '06-models';
const runId = nowSlug();
const RUN_DIR = join(SECTIONS_OUT, SECTION, runId);
const STATE_OUT = join(SECTIONS_OUT, SECTION, 'state-out.json');

const REFERENCE_IMAGE_PATH = join(REPO_ROOT, 'frontend', 'public', 'demo', 'clay_daedalus.png');

const V1_ENHANCED_PROMPT =
  'Daedalus the Greek inventor mid-flight, mechanical feathered wings spread wide, dramatic dynamic pose, sunset Aegean sky, cinematic composition, golden hour lighting, photorealistic cinematic detail';
const REFINED_PROMPT =
  'Daedalus mid-flight, mechanical feathered wings spread wide, dynamic flying pose, matching reference figurine style — soft cream background, chibi proportions, blush cheeks, gold accents on wing struts, smooth sculpted aesthetic';
const STYLE_PROMPT = 'watercolor remix — soft pastel washes, paper grain';
const DEMO = {
  v1:    '/demo/outputs/v1.png',
  v2:    '/demo/outputs/v2.png',
  style: '/demo/outputs/style.png',
  mesh:  '/demo/outputs/mesh.glb',
  video: '/demo/outputs/video.mp4',
};

// Chat history at start of section 06 (everything section 05 pushed).
const CHAT_HISTORY_PRE_USER = [
  { role: 'user',      text: 'show yourself flying' },
  { role: 'assistant', text: 'Showing myself flying — one moment.' },
  { role: 'assistant', text: 'Ah — you want to see me. How cute.' },
  { role: 'assistant', text: 'Let me place down a text node first.' },
  { role: 'assistant', text: 'And my favorite image model — gpt-image-2.' },
  { role: 'assistant', text: 'I have skills tuned for every model. Let me dial this one in.' },
  { role: 'assistant', text: 'If you want a specific style, give me an image to reference.' },
  { role: 'assistant', text: 'Chibi. Got it.' },
];
const REFREACT_TEXT =
  'Oh — there I am. Handsome devil. Soft cream, blush, gold accents. Let me try again.';
const V2REACT_TEXT = 'Yes. Look at me fly. Now that is handsome.';
const FANOUT_TEXT = 'Now — let me show you what else this canvas can hold.';

const POS = {
  textInput1: { x: -700, y: -200 },
  v1Gen:      { x:  -60, y: -200 },
  imageInput: { x: -700, y:   80 },
  textInput2: { x: -700, y:  580 },
  v2Edit:     { x:  -60, y:  340 },
  styleText:  { x:  340, y: -440 },
  style:      { x:  340, y: -200 },
  mesh:       { x:  340, y:  240 },
  video:      { x:  340, y:  540 },
};

async function widenNode(page, nodeId, widthPx) {
  await page.evaluate(({ id, w }) => {
    const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!wrap) return;
    wrap.style.width = `${w}px`;
    wrap.style.maxWidth = `${w}px`;
    const inner = wrap.querySelector('.model-node');
    if (inner) {
      inner.style.minWidth = `${w}px`;
      inner.style.maxWidth = `${w}px`;
    }
  }, { id: nodeId, w: widthPx });
}

async function uploadReference(page, localPath) {
  const fileBuffer = await readFile(localPath);
  const result = await page.evaluate(async (fileBytes) => {
    const blob = new Blob([new Uint8Array(fileBytes)], { type: 'image/png' });
    const fd = new FormData();
    fd.append('file', blob, 'clay_daedalus.png');
    fd.append('create_node', 'true');
    const r = await fetch('http://localhost:8000/api/uploads', { method: 'POST', body: fd });
    return await r.json();
  }, Array.from(fileBuffer));
  if (!result.nodeId) throw new Error(`upload returned no nodeId: ${JSON.stringify(result)}`);
  return result;
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
    await sleep(400);

    // Daedalus tab + bloom (off-camera).
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

    // Restore chat (8 pre-user messages).
    for (const msg of CHAT_HISTORY_PRE_USER) {
      if (msg.role === 'user') {
        await page.evaluate((t) => window.__nebulaChat.pushUser(t), msg.text);
      } else {
        await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), msg.text);
      }
    }
    await sleep(120);

    // Restore canvas: TI + v1Gen + edge.
    const tiId = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: cfg.value } });
      return id;
    }, { pos: POS.textInput1, value: V1_ENHANCED_PROMPT });
    await sleep(140);
    await widenNode(page, tiId, 380);

    const v1Id = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('gpt-image-2-generate', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { image: { type: 'Image', value: cfg.url } },
      });
      return id;
    }, { pos: POS.v1Gen, url: DEMO.v1 });
    await sleep(140);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: tiId, t: v1Id });
    await sleep(140);

    // Upload chibi reference (creates Image Input node) + position it.
    // Settle sleep before setNodePosition so the WebSocket state sync has
    // time to register the upload node — without this, page.evaluate hits
    // a "Promise was collected" GC flake here in this section.
    const refUpload = await uploadReference(page, REFERENCE_IMAGE_PATH);
    log('upload', `imageInput nodeId=${refUpload.nodeId}`);
    await sleep(500);
    await page.evaluate(({ id, pos }) => {
      window.__nebulaCanvas.setNodePosition(id, pos);
    }, { id: refUpload.nodeId, pos: POS.imageInput });
    await sleep(140);

    // Push the user's image message + refReact + v2React + fanout.
    await page.evaluate((upload) => {
      window.__nebulaChat.pushUser('I want this chibi style', {
        images: [{ nodeId: upload.nodeId, thumbUrl: upload.thumbUrl }],
      });
    }, refUpload);
    await sleep(80);
    await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), REFREACT_TEXT);
    await sleep(80);

    // Restore textInput2 + v2Edit + edges.
    const ti2Id = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: cfg.value } });
      return id;
    }, { pos: POS.textInput2, value: REFINED_PROMPT });
    await sleep(140);
    await widenNode(page, ti2Id, 380);

    const v2Id = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { image: { type: 'Image', value: cfg.url } },
      });
      return id;
    }, { pos: POS.v2Edit, url: DEMO.v2 });
    await sleep(140);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'images',
      });
    }, { s: refUpload.nodeId, t: v2Id });
    await sleep(80);
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: ti2Id, t: v2Id });
    await sleep(140);

    await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), V2REACT_TEXT);
    await sleep(80);

    // Restore fan-out: styleText + style + edges, mesh + edge, video + edge.
    const styleTiId = await page.evaluate(async ({ pos, prompt }) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: prompt } });
      return id;
    }, { pos: POS.styleText, prompt: STYLE_PROMPT });
    await sleep(140);

    const styleId = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { image: { type: 'Image', value: cfg.url } },
      });
      return id;
    }, { pos: POS.style, url: DEMO.style });
    await sleep(140);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'images',
      });
    }, { s: v2Id, t: styleId });
    await sleep(80);
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: styleTiId, t: styleId });
    await sleep(80);

    const meshId = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('meshy-image-to-3d', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { mesh: { type: 'Mesh', value: cfg.url } },
      });
      return id;
    }, { pos: POS.mesh, url: DEMO.mesh });
    await sleep(140);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'image',
      });
    }, { s: v2Id, t: meshId });
    await sleep(80);

    const videoId = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('veo-3', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { video: { type: 'Video', value: cfg.url } },
      });
      return id;
    }, { pos: POS.video, url: DEMO.video });
    await sleep(140);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'image',
      });
    }, { s: v2Id, t: videoId });
    await sleep(140);

    // Push fanout chat (last bubble before this section).
    await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), FANOUT_TEXT);
    await sleep(180);

    // Camera at section 05's hold-video pose.
    await page.evaluate(() => {
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(180);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');
    // Cursor starts where section 05 left it (offset from video, below).
    await page.evaluate(() => window.__nebulaCursor.moveTo(1300, 950, 0));


    // Make sure all categories start COLLAPSED so the cursor can click each
    // one in turn during the recording (viewer sees the expansion happen).
    // Reset any state from prior runs.
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('.panel--library .panel__group-label--button'));
      for (const label of labels) {
        const chevron = label.querySelector('.panel__group-chevron');
        // If currently expanded (▾), click to collapse.
        if (chevron && /▾/.test(chevron.textContent || '')) {
          label.click();
        }
      }
      const body = document.querySelector('.panel--library .panel__body');
      if (body) body.scrollTop = 0;
    });
    await sleep(200);

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 100 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Wait through carry-over hold (0-1.0s) + camera zoom to library
    // (1.0-2.5s). Total 2.5s.
    await sleep(2500);
    phases.b6_libraryArrived = Date.now();

    // Hold during the long intro voice (2.5-8.5s). Cursor stays parked
    // off-frame; the click cycle starts as the intro voice ends.
    await sleep(6000);
    phases.b6_clicksStart = Date.now();

    // Click through each category at exactly 1.4s intervals so the
    // category-name voice lines (8.6, 10.0, 11.4, 12.8, 14.2, 15.6, 17.0,
    // 18.4) land just before each click. Querying fresh each iteration
    // since DOM positions shift as earlier categories expand.
    const catCount = await page.evaluate(() => {
      return document.querySelectorAll('.panel--library .panel__group-label--button').length;
    });
    log('beat-6', `clicking through ${catCount} categories`);

    for (let i = 0; i < catCount; i++) {
      const center = await page.evaluate((idx) => {
        const labels = document.querySelectorAll('.panel--library .panel__group-label--button');
        const el = labels[idx];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, i);
      if (!center) continue;
      // Move cursor to the category label (200ms hop).
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 200), {
        x: center.x, y: center.y,
      });
      await sleep(200);
      // Click to expand — voice for this category fires ~100ms before this.
      await page.evaluate((idx) => {
        const labels = document.querySelectorAll('.panel--library .panel__group-label--button');
        const el = labels[idx];
        if (el) el.click();
      }, i);
      // Brief beat for the expansion to start.
      await sleep(150);

      // Auto-scroll if next cat off-screen (smooth scroll happens during
      // the dwell that follows).
      if (i + 1 < catCount) {
        await page.evaluate((nextIdx) => {
          const labels = document.querySelectorAll('.panel--library .panel__group-label--button');
          const next = labels[nextIdx];
          const body = document.querySelector('.panel--library .panel__body');
          if (!next || !body) return;
          const nextRect = next.getBoundingClientRect();
          const bodyRect = body.getBoundingClientRect();
          if (nextRect.bottom > bodyRect.bottom - 40) {
            const delta = nextRect.bottom - (bodyRect.bottom - 40);
            body.scrollTo({ top: body.scrollTop + delta, behavior: 'smooth' });
          }
        }, i + 1);
      }

      // Remaining dwell so total cycle = 1600ms (200 move + 150 + 1250).
      // Wider 1.6s spacing prevents voice overlap on the longer category
      // names like "Video generation." (1.49s).
      await sleep(1250);
    }
    phases.b6_categoriesDone = Date.now();

    // Tail hold so closing voice "Pick one. Drag it in." (fires at 21.4s)
    // can clear before recording stops.
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
