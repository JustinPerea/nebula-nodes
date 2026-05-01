// Section 05 — Fan-out beat: style remix + Meshy 3D + Veo video.
//
// Picks up from section 04's end (canvas has full pipeline through v2;
// chat history ending in v2React; camera at hold-v2 pose).
//
// Sequence:
//  1. Brief carry-over hold on v2 while fanout narration plays.
//  2. Pan to fanout overview (shows v2 + right column for fan-out targets).
//  3. Spawn styleText + style (gpt-image-2-edit), wire v2→style.images
//     and styleText→style.prompt.
//  4. Spawn mesh (meshy-image-to-3d), wire v2→mesh.image.
//  5. Spawn video (veo-3), wire v2→video.image.
//  6. Kick all 3 to executing simultaneously.
//  7. Resolve style with "Watercolor." voice.
//  8. Resolve mesh with "Sculpture." voice + cursor mouse-rotate gesture.
//  9. Resolve video with "Motion." voice + 4s dwell so the clip plays.
//
// Voice (per-section build-vo, no music):
//   ~0.5s   Now — let me show you what else this canvas can hold.
//   ~7.3s   Watercolor.
//   ~10.1s  Sculpture.
//   ~14.8s  Motion.
//
// Duration target: ~20s.

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

const SECTION = '05-fanout';
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

// Chat history at start of section 05 (everything through section 04's v2React).
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

// Drag-rotate the model-viewer canvas in the mesh node so the viewer sees
// the 3D mesh from multiple angles. Three sweeps: right, down, left.
async function rotateMeshNode(page, nodeId) {
  const center = await page.evaluate((id) => {
    const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!wrap) return null;
    const mv = wrap.querySelector('model-viewer');
    if (!mv) return null;
    const r = mv.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, nodeId);
  if (!center) return;
  await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 600), center);
  await sleep(650);
  const cx = center.x;
  const cy = center.y;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 70), { x: cx + t * 130, y: cy });
    await page.mouse.move(cx + t * 130, cy);
    await sleep(60);
  }
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const x = cx + 130;
    const y = cy + t * 90;
    await page.evaluate((p) => window.__nebulaCursor.moveTo(p.x, p.y, 70), { x, y });
    await page.mouse.move(x, y);
    await sleep(60);
  }
  for (let i = 1; i <= 16; i++) {
    const t = i / 16;
    const x = cx + 130 - t * 260;
    const y = cy + 90;
    await page.evaluate((p) => window.__nebulaCursor.moveTo(p.x, p.y, 70), { x, y });
    await page.mouse.move(x, y);
    await sleep(60);
  }
  await page.mouse.up();
}

// Move cursor onto the video element + click to grant user-gesture, then
// explicitly call .play() (Veo videos render with controls but no autoplay
// attribute — browser autoplay policy needs the click to allow play()).
async function pressPlayOnVideo(page, nodeId) {
  const center = await page.evaluate((id) => {
    const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!wrap) return null;
    const video = wrap.querySelector('video');
    if (!video) return null;
    const r = video.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, nodeId);
  if (!center) return;
  await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 700), center);
  await sleep(750);
  await page.mouse.click(center.x, center.y);
  await page.evaluate((id) => {
    const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    const video = wrap?.querySelector('video');
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
    }
  }, nodeId);
  // Move both the virtual cursor + real mouse off the video so the
  // browser's hover controls / timeline scrubber don't cover the playback.
  await sleep(350);
  const offX = 1300;
  const offY = 950;
  await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 600), { x: offX, y: offY });
  await page.mouse.move(offX, offY);
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

    // Restore canvas: TI + v1Gen (with v1.png) + edge.
    const tiId = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: cfg.value } });
      return id;
    }, { pos: POS.textInput1, value: V1_ENHANCED_PROMPT });
    await sleep(180);
    await widenNode(page, tiId, 380);

    const v1Id = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('gpt-image-2-generate', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { image: { type: 'Image', value: cfg.url } },
      });
      return id;
    }, { pos: POS.v1Gen, url: DEMO.v1 });
    await sleep(180);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: tiId, t: v1Id });
    await sleep(180);

    // Upload chibi reference (creates Image Input node) + position it.
    const refUpload = await uploadReference(page, REFERENCE_IMAGE_PATH);
    log('upload', `imageInput nodeId=${refUpload.nodeId}`);
    await page.evaluate(({ id, pos }) => {
      window.__nebulaCanvas.setNodePosition(id, pos);
    }, { id: refUpload.nodeId, pos: POS.imageInput });
    await sleep(180);

    // Push the user's image message + refReact + v2React (section 03/04 tail).
    await page.evaluate((upload) => {
      window.__nebulaChat.pushUser('I want this chibi style', {
        images: [{ nodeId: upload.nodeId, thumbUrl: upload.thumbUrl }],
      });
    }, refUpload);
    await sleep(120);
    await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), REFREACT_TEXT);
    await sleep(120);

    // Restore textInput2 + v2Edit (with v2.png) + edges.
    const ti2Id = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: cfg.value } });
      return id;
    }, { pos: POS.textInput2, value: REFINED_PROMPT });
    await sleep(180);
    await widenNode(page, ti2Id, 380);

    const v2Id = await page.evaluate(async (cfg) => {
      const id = await window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', cfg.pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        outputs: { image: { type: 'Image', value: cfg.url } },
      });
      return id;
    }, { pos: POS.v2Edit, url: DEMO.v2 });
    await sleep(180);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'images',
      });
    }, { s: refUpload.nodeId, t: v2Id });
    await sleep(120);
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: ti2Id, t: v2Id });
    await sleep(180);

    await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), V2REACT_TEXT);
    await sleep(220);

    // Camera at section 04's hold-v2 pose.
    await page.evaluate(() => {
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(220);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');
    await page.evaluate(() => window.__nebulaCursor.moveTo(940, 600, 0));

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 80 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Brief carry-over hold on v2 — fanout voice "Now — let me show you
    // what else this canvas can hold." plays here.
    await sleep(800);

    // Push fanout chat narration as a streaming bubble (3 chunks paced
    // to roughly match the voice cadence).
    const fanoutId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of ['Now — ', 'let me show you what else ', 'this canvas can hold.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: fanoutId, c: chunk,
      });
      await sleep(700);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), fanoutId);
    phases.b5_fanoutChat = Date.now();
    await sleep(400);

    // ===== Spawn style remix (text input + edit node) =====
    log('beat-5', 'spawn style remix');
    const styleTiId = await page.evaluate(async ({ pos, prompt }) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: prompt } });
      return id;
    }, { pos: POS.styleText, prompt: STYLE_PROMPT });
    await sleep(220);
    await captureNode(styleTiId, 'Text Input (style)');
    await sleep(180);

    const styleId = await page.evaluate(async (pos) =>
      window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', pos),
    POS.style);
    await sleep(280);
    await captureNode(styleId, 'GPT Image 2 Edit (style)');
    await sleep(180);

    // Wire v2 → style.images, styleText → style.prompt
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'images',
      });
    }, { s: v2Id, t: styleId });
    await sleep(180);
    await captureEdge(`${v2Id}->${styleId}`, v2Id, styleId);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: styleTiId, t: styleId });
    await sleep(180);
    await captureEdge(`${styleTiId}->${styleId}`, styleTiId, styleId);
    await sleep(220);

    // ===== Spawn mesh =====
    log('beat-5', 'spawn mesh');
    const meshId = await page.evaluate(async (pos) =>
      window.__nebulaGraphStore.getState().addNode('meshy-image-to-3d', pos),
    POS.mesh);
    await sleep(280);
    await captureNode(meshId, 'Meshy 6 Image-to-3D');
    await sleep(180);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'image',
      });
    }, { s: v2Id, t: meshId });
    await sleep(180);
    await captureEdge(`${v2Id}->${meshId}`, v2Id, meshId);
    await sleep(220);

    // ===== Spawn video =====
    log('beat-5', 'spawn video');
    const videoId = await page.evaluate(async (pos) =>
      window.__nebulaGraphStore.getState().addNode('veo-3', pos),
    POS.video);
    await sleep(280);
    await captureNode(videoId, 'Veo 3.1');
    await sleep(180);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'image',
      });
    }, { s: v2Id, t: videoId });
    await sleep(180);
    await captureEdge(`${v2Id}->${videoId}`, v2Id, videoId);
    await sleep(400);

    // ===== Kick all 3 to executing simultaneously =====
    for (const id of [styleId, meshId, videoId]) {
      await page.evaluate((nid) => {
        window.__nebulaGraphStore.getState().updateNodeData(nid, {
          state: 'executing', progress: 0.2,
        });
      }, id);
    }
    phases.b5_executing = Date.now();
    await sleep(700);

    // ===== Resolve style — "Watercolor." voice fires at ~7.3s =====
    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { image: { type: 'Image', value: url } },
      });
    }, { id: styleId, url: DEMO.style });
    await sleep(2700);

    // ===== Resolve mesh + rotate gesture — "Sculpture." voice at ~10.1s
    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { mesh: { type: 'Mesh', value: url } },
      });
    }, { id: meshId, url: DEMO.mesh });
    await sleep(900);
    await rotateMeshNode(page, meshId);
    // Hold + give the camera time to pan from mesh down to video before
    // the video reveal lands.
    await sleep(1100);

    // ===== Resolve video — "Motion." voice at ~15.2s, then cursor presses
    // play. Hold for clip playback.
    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { video: { type: 'Video', value: url } },
      });
    }, { id: videoId, url: DEMO.video });
    await sleep(400);
    await pressPlayOnVideo(page, videoId);
    // Dwell so the Veo clip plays through (~3.5s after press-play gesture).
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
