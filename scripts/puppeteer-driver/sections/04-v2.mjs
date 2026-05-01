// Section 04 — Refined Text Input + V2 (gpt-image-2-edit).
//
// Picks up from section 03's end (canvas has TI + v1Gen + Image Input;
// chat history through refReact; camera at hold-chibi pose).
//
// Sequence:
//  1. Brief hold on chibi (carry-over).
//  2. Pan from chibi to where textInput2 will spawn.
//  3. Spawn textInput2 (empty, widened) below imageInput.
//  4. Stream REFINED_PROMPT into textInput2.
//  5. Pan to where v2 will spawn, spawn v2Edit (gpt-image-2-edit).
//  6. Wire imageInput → v2.images, textInput2 → v2.prompt.
//  7. Execute v2 (fake progress) → inject v2.png.
//  8. Daedalus v2React in chat: "Yes. Look at me fly. Now that is handsome."
//
// Voice (per-section build-vo, no music):
//   ~1.5s   Let me try this again.
//   ~3.5s   Adding the chibi cues — cream, blush, gold.
//   ~7.0s   Wiring it to gpt-image-2-edit.
//   ~10.3s  Yes. Look at me fly. Now that is handsome.
//
// Duration target: ~15s.

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

const SECTION = '04-v2';
const runId = nowSlug();
const RUN_DIR = join(SECTIONS_OUT, SECTION, runId);
const STATE_OUT = join(SECTIONS_OUT, SECTION, 'state-out.json');

const REFERENCE_IMAGE_PATH = join(REPO_ROOT, 'frontend', 'public', 'demo', 'clay_daedalus.png');

const V1_ENHANCED_PROMPT =
  'Daedalus the Greek inventor mid-flight, mechanical feathered wings spread wide, dramatic dynamic pose, sunset Aegean sky, cinematic composition, golden hour lighting, photorealistic cinematic detail';
const REFINED_PROMPT =
  'Daedalus mid-flight, mechanical feathered wings spread wide, dynamic flying pose, matching reference figurine style — soft cream background, chibi proportions, blush cheeks, gold accents on wing struts, smooth sculpted aesthetic';
const DEMO_V1 = '/demo/outputs/v1.png';
const DEMO_V2 = '/demo/outputs/v2.png';

// Chat history at start of section 04 (everything through section 03's
// refReact). The user-with-image bubble is pushed separately after the
// reference upload so it carries the image attachment.
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

const POS = {
  textInput1: { x: -700, y: -200 },
  v1Gen:      { x:  -60, y: -200 },
  imageInput: { x: -700, y:   80 },
  textInput2: { x: -700, y:  580 },
  v2Edit:     { x:  -60, y:  340 },
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

    // Restore chat (everything before the user's image message).
    for (const msg of CHAT_HISTORY_PRE_USER) {
      if (msg.role === 'user') {
        await page.evaluate((t) => window.__nebulaChat.pushUser(t), msg.text);
      } else {
        await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), msg.text);
      }
    }
    await sleep(150);

    // Restore canvas: TI (with V1 prompt) + v1Gen (with v1 output) + edge.
    const tiId = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: cfg.value } });
      return id;
    }, { pos: POS.textInput1, value: V1_ENHANCED_PROMPT });
    await sleep(220);
    await widenNode(page, tiId, 380);

    const v1Id = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('gpt-image-2-generate', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { image: { type: 'Image', value: cfg.url } },
      });
      return id;
    }, { pos: POS.v1Gen, url: DEMO_V1 });
    await sleep(220);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: tiId, t: v1Id });
    await sleep(220);

    // Upload chibi reference (creates Image Input node) + position it.
    const refUpload = await uploadReference(page, REFERENCE_IMAGE_PATH);
    log('upload', `imageInput nodeId=${refUpload.nodeId}`);
    await page.evaluate(({ id, pos }) => {
      window.__nebulaCanvas.setNodePosition(id, pos);
    }, { id: refUpload.nodeId, pos: POS.imageInput });
    await sleep(220);

    // Push the user's image message + refReact bubble (section 03's tail).
    await page.evaluate((upload) => {
      window.__nebulaChat.pushUser('I want this chibi style', {
        images: [{ nodeId: upload.nodeId, thumbUrl: upload.thumbUrl }],
      });
    }, refUpload);
    await sleep(120);
    await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), REFREACT_TEXT);
    await sleep(220);

    // Camera at section 03's hold-chibi pose.
    await page.evaluate(() => {
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(220);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');
    await page.evaluate(() => window.__nebulaCursor.moveTo(900, 500, 0));

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 80 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Brief carry-over hold on chibi.
    await sleep(900);

    // ===== Spawn refined Text Input =====
    log('beat-4', 'spawn refined TI');
    const ti2Id = await page.evaluate(async (pos) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: '' } });
      return id;
    }, POS.textInput2);
    await sleep(380);
    await widenNode(page, ti2Id, 380);
    await captureNode(ti2Id, 'Text Input (refined)');
    phases.b4_ti2Spawn = Date.now();
    await sleep(700);

    // ===== Stream REFINED_PROMPT into textInput2 =====
    {
      const prompt = REFINED_PROMPT;
      const chunkSize = 10;
      for (let i = 0; i < prompt.length; i += chunkSize) {
        const acc = prompt.slice(0, i + chunkSize);
        await page.evaluate(({ id, value }) => {
          window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value } });
        }, { id: ti2Id, value: acc });
        await sleep(85);
      }
      await sleep(500);
    }
    phases.b4_promptStreamed = Date.now();

    // ===== Spawn v2 (gpt-image-2-edit) =====
    const v2Id = await page.evaluate(async (pos) =>
      window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', pos),
    POS.v2Edit);
    await sleep(420);
    await captureNode(v2Id, 'GPT Image 2 Edit');
    await sleep(500);

    // Edge: imageInput → v2.images
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'images',
      });
    }, { s: refUpload.nodeId, t: v2Id });
    await sleep(300);
    await captureEdge(`${refUpload.nodeId}->${v2Id}`, refUpload.nodeId, v2Id);

    // Edge: textInput2 → v2.prompt
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: ti2Id, t: v2Id });
    await sleep(300);
    await captureEdge(`${ti2Id}->${v2Id}`, ti2Id, v2Id);
    await sleep(500);

    // ===== Execute v2 =====
    await page.evaluate((id) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, { state: 'executing', progress: 0.1 });
    }, v2Id);
    for (const p of [0.3, 0.55, 0.78, 0.95]) {
      await sleep(380);
      await page.evaluate(({ id, val }) => {
        window.__nebulaGraphStore.getState().updateNodeData(id, { progress: val });
      }, { id: v2Id, val: p });
    }
    await sleep(280);

    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { image: { type: 'Image', value: url } },
      });
    }, { id: v2Id, url: DEMO_V2 });
    phases.b4_v2Done = Date.now();

    // ===== v2React chat — voice fires at ~10.3s, text streams just after.
    await sleep(800);
    const reactId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of ['Yes. ', 'Look at me fly. ', 'Now that is handsome.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: reactId, c: chunk,
      });
      await sleep(700);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), reactId);

    // Tail hold so the v2React voice fully clears.
    await sleep(1500);
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
