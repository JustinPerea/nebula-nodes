// Section 03 — Reference + chibi reactions.
//
// Picks up from section 02's end (TI + v1Gen on canvas with v1 image
// rendered; chat history populated; camera at v1).
//
// Sequence:
//  1. Brief hold on v1 (carry-over framing).
//  2. Pan to chatbox. Daedalus chat: tip line ("If you want a specific
//     style, give me an image to reference.").
//  3. Cursor walks to textarea, types "I want this chibi style".
//  4. Camera widens to overview so the Finder window + chat are both
//     visible.
//  5. Finder window slides in from the left holding chibi.png.
//  6. Cursor walks to the chibi file, picks it up (drag thumb appears).
//  7. Cursor + thumb travel to chat panel center.
//  8. Drop animation. Upload + pushUser fire — Image Input node lands
//     on canvas, chat bubble shows the user's message + image.
//  9. Pan to canvas chibi. Daedalus chat: chibiAck ("Chibi. Got it.")
// 10. Daedalus chat: refReact ("Oh — there I am. Handsome devil. Soft
//     cream, blush, gold accents. Let me try again.")
//
// Voice (per-section build-vo, no music):
//   ~0.5s   (silent on v1 hold)
//   ~3.0s   If you want a specific style, give me an image to reference.
//   ~9.5s   (typing burst SFX during typing)
//   ~14.0s  (drop SFX as image lands in chat)
//   ~14.5s  Chibi. Got it.
//   ~16.5s  Oh — there I am. Handsome devil.
//   ~19.0s  Soft cream, blush, gold accents.
//   ~22.0s  Let me try again.
//
// Duration target: ~24s.

import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, SECTIONS_OUT, FPS,
  nowSlug, log, sleep,
  launchBrowser, openApp, wipeAll,
  injectCursor, setOverview,
  startRecorder, makeCaptureHelpers, writeEvents,
  saveSnapshot,
} from './lib.mjs';

const SECTION = '03-reference';
const runId = nowSlug();
const RUN_DIR = join(SECTIONS_OUT, SECTION, runId);
const STATE_OUT = join(SECTIONS_OUT, SECTION, 'state-out.json');

const REFERENCE_IMAGE_PATH = join(REPO_ROOT, 'frontend', 'public', 'demo', 'clay_daedalus.png');

const USER_PROMPT = 'show yourself flying';
const V1_ENHANCED_PROMPT =
  'Daedalus the Greek inventor mid-flight, mechanical feathered wings spread wide, dramatic dynamic pose, sunset Aegean sky, cinematic composition, golden hour lighting, photorealistic cinematic detail';
const DEMO_V1 = '/demo/outputs/v1.png';

// Chat history at start of section 03.
const CHAT_HISTORY = [
  { role: 'user',      text: 'show yourself flying' },
  { role: 'assistant', text: 'Showing myself flying — one moment.' },
  { role: 'assistant', text: 'Ah — you want to see me. How cute.' },
  { role: 'assistant', text: 'Let me place down a text node first.' },
  { role: 'assistant', text: 'And my favorite image model — gpt-image-2.' },
  { role: 'assistant', text: 'I have skills tuned for every model. Let me dial this one in.' },
];

const POS = {
  textInput1: { x: -700, y: -200 },
  v1Gen:      { x:  -60, y: -200 },
  imageInput: { x: -700, y:   80 },
};

// ----- Helpers (inline for section 03) -----

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

async function injectDragThumb(page, src, x, y, sizePx = 110) {
  await page.evaluate(({ src, x, y, sizePx }) => {
    const existing = document.getElementById('__nebula-drag-thumb');
    if (existing) existing.remove();
    const img = document.createElement('img');
    img.id = '__nebula-drag-thumb';
    img.src = src;
    Object.assign(img.style, {
      position: 'fixed',
      left: `${x - sizePx / 2}px`,
      top: `${y - sizePx / 2}px`,
      width: `${sizePx}px`,
      height: `${sizePx}px`,
      objectFit: 'cover',
      borderRadius: '12px',
      border: '2px solid rgba(255,255,255,0.95)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
      pointerEvents: 'none',
      zIndex: '100000',
      opacity: '0',
      transform: 'scale(0.8)',
      transition: 'opacity 220ms ease, transform 220ms ease',
      willChange: 'left, top, opacity, transform',
    });
    document.body.appendChild(img);
    void img.offsetWidth;
    img.style.opacity = '1';
    img.style.transform = 'scale(1)';
  }, { src, x, y, sizePx });
}

async function moveDragThumb(page, x, y, durationMs = 1100) {
  await page.evaluate(({ x, y, durationMs }) => {
    const img = document.getElementById('__nebula-drag-thumb');
    if (!img) return;
    img.style.transition = `left ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1), top ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1), opacity 220ms ease, transform 220ms ease`;
    const sizePx = parseFloat(img.style.width) || 110;
    img.style.left = `${x - sizePx / 2}px`;
    img.style.top = `${y - sizePx / 2}px`;
  }, { x, y, durationMs });
}

async function dropDragThumb(page) {
  await page.evaluate(() => {
    const img = document.getElementById('__nebula-drag-thumb');
    if (!img) return;
    img.style.transition = 'opacity 240ms ease, transform 240ms ease';
    img.style.opacity = '0';
    img.style.transform = 'scale(0.7)';
    setTimeout(() => img.remove(), 280);
  });
}

async function injectFinder(page, imageSrc) {
  await page.evaluate(({ src }) => {
    const wrap = document.createElement('div');
    wrap.id = '__nebula-finder';
    Object.assign(wrap.style, {
      position: 'fixed',
      // Off-screen RIGHT initially; slides in toward chat panel from
      // the right side so the drag motion goes from right (Finder) to
      // chat textarea (also right).
      left: '1980px',
      top: '50%',
      transform: 'translateY(-50%)',
      width: '480px',
      height: '380px',
      background: 'linear-gradient(180deg, #2c2c2e 0%, #1c1c1e 100%)',
      borderRadius: '14px',
      boxShadow: '0 30px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06)',
      overflow: 'hidden',
      zIndex: '99996',
      pointerEvents: 'none',
      transition: 'left 720ms cubic-bezier(0.4, 0, 0.2, 1), opacity 320ms ease',
      opacity: '1',
      display: 'grid',
      gridTemplateRows: 'auto auto 1fr',
      fontFamily: '-apple-system, "SF Pro Display", system-ui, sans-serif',
      color: '#fff',
    });

    const titlebar = document.createElement('div');
    Object.assign(titlebar.style, {
      height: '32px', display: 'flex', alignItems: 'center', padding: '0 14px', gap: '8px',
      background: 'linear-gradient(180deg, #3a3a3c 0%, #2c2c2e 100%)',
      borderBottom: '1px solid rgba(0,0,0,0.5)',
    });
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
      const dot = document.createElement('span');
      Object.assign(dot.style, {
        width: '12px', height: '12px', borderRadius: '50%',
        background: c, display: 'inline-block',
        boxShadow: '0 0 0 0.5px rgba(0,0,0,0.3) inset',
      });
      titlebar.appendChild(dot);
    }
    const titleText = document.createElement('span');
    titleText.textContent = 'Demo Assets';
    Object.assign(titleText.style, { fontSize: '13px', fontWeight: '500', marginLeft: '12px', color: 'rgba(255,255,255,0.85)' });
    titlebar.appendChild(titleText);
    wrap.appendChild(titlebar);

    const toolbar = document.createElement('div');
    Object.assign(toolbar.style, {
      height: '40px', display: 'flex', alignItems: 'center', padding: '0 14px', gap: '12px',
      background: '#262628', borderBottom: '1px solid rgba(0,0,0,0.45)',
      fontSize: '13px', color: 'rgba(255,255,255,0.55)',
    });
    toolbar.innerHTML = `<span style="font-size:14px;">‹</span><span style="font-size:14px; color:rgba(255,255,255,0.3);">›</span><span style="margin-left:14px;">Demo</span>`;
    wrap.appendChild(toolbar);

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      padding: '24px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
      gap: '20px', alignContent: 'start', background: '#1c1c1e',
    });

    const file = document.createElement('div');
    file.id = '__nebula-finder-file';
    Object.assign(file.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
      padding: '8px', borderRadius: '8px',
      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
    });
    const fileImg = document.createElement('img');
    fileImg.src = src;
    Object.assign(fileImg.style, {
      width: '110px', height: '110px', objectFit: 'cover', borderRadius: '8px', display: 'block',
    });
    file.appendChild(fileImg);
    const fileName = document.createElement('div');
    fileName.textContent = 'chibi.png';
    Object.assign(fileName.style, { fontSize: '12px', color: 'rgba(255,255,255,0.85)' });
    file.appendChild(fileName);
    grid.appendChild(file);

    for (let i = 0; i < 2; i++) {
      const ph = document.createElement('div');
      Object.assign(ph.style, {
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
        padding: '8px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)',
      });
      const phImg = document.createElement('div');
      Object.assign(phImg.style, {
        width: '110px', height: '110px',
        background: 'linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))',
        borderRadius: '8px',
      });
      ph.appendChild(phImg);
      const phName = document.createElement('div');
      phName.textContent = i === 0 ? 'reference-2.png' : 'sketch-3.png';
      Object.assign(phName.style, { fontSize: '12px', color: 'rgba(255,255,255,0.35)' });
      ph.appendChild(phName);
      grid.appendChild(ph);
    }

    wrap.appendChild(grid);
    document.body.appendChild(wrap);
  }, { src: imageSrc });
}

async function slideFinderIn(page) {
  await page.evaluate(() => {
    const f = document.getElementById('__nebula-finder');
    if (!f) return;
    // Right-side anchor — sits between canvas and chat panel.
    f.style.left = '920px';
  });
}

async function getFinderFileCenter(page) {
  return await page.evaluate(() => {
    const file = document.getElementById('__nebula-finder-file');
    if (!file) return null;
    const r = file.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
}

async function slideFinderOut(page) {
  await page.evaluate(() => {
    const f = document.getElementById('__nebula-finder');
    if (!f) return;
    f.style.opacity = '0';
    f.style.left = '1980px';
    setTimeout(() => f.remove(), 720);
  });
}

// ----- Main -----

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

    // Restore chat history (all completed bubbles).
    for (const msg of CHAT_HISTORY) {
      if (msg.role === 'user') {
        await page.evaluate((t) => window.__nebulaChat.pushUser(t), msg.text);
      } else {
        await page.evaluate((t) => window.__nebulaChat.pushAssistant(t), msg.text);
      }
    }
    await sleep(150);

    // Restore canvas state: TI (with V1 prompt) + v1Gen (with v1 output) + edge.
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
    await sleep(300);

    // Camera at v1 (carry-over from section 02 end).
    await page.evaluate(() => {
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(300);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');

    // Park cursor near the v1 area (off-canvas right edge of the v1
    // visible region) so it's nominally in pose at frame 0.
    await page.evaluate(() => window.__nebulaCursor.moveTo(900, 500, 0));

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 80 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Brief carry-over hold on v1 — kept tight to avoid awkward dead air.
    await sleep(300);
    phases.b3_holdEnd = Date.now();

    // ===== Tip line (chatbox) =====
    log('beat-3', 'pan to chatbox → tip line');
    const tipId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of [
      'If you want a specific style, ',
      'give me an image ',
      'to reference.',
    ]) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: tipId, c: chunk,
      });
      await sleep(700);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), tipId);
    await sleep(800);
    phases.b3_tipDone = Date.now();

    // ===== Cursor → textarea, type "I want this chibi style" =====
    const taPos = await page.evaluate(() => {
      const ta = document.querySelector('.chat-panel__textarea');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!taPos) throw new Error('chat textarea not found');
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 800), taPos);
    await sleep(900);
    await page.evaluate(() => window.__nebulaCursor.click());
    // Wait for the camera pan to textarea (directive 4.3-5.0s) to settle
    // before typing starts. Typing SFX in voice.json is timed to 5.2s.
    await sleep(800);
    await page.focus('.chat-panel__textarea');
    phases.b3_typeStart = Date.now();
    // Split typing so chibiAck chat bubble can land MID-TYPING — right
    // after the word "chibi" appears in the textarea. Voice/caption
    // "Chibi. Got it." then lands in sync with the typed word.
    await page.type('.chat-panel__textarea', 'I want this chibi', { delay: 40 });
    phases.b3_chibiTyped = Date.now();

    // Push chibiAck IMMEDIATELY after the word "chibi" hits the textarea.
    const ackId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of ['Chibi. ', 'Got it.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: ackId, c: chunk,
      });
      await sleep(420);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), ackId);

    // Finish typing the rest of the message after Daedalus's ack.
    await page.type('.chat-panel__textarea', ' style', { delay: 40 });
    phases.b3_typeEnd = Date.now();
    await sleep(300);

    // ===== Inject Finder + slide in =====
    await injectFinder(page, '/demo/clay_daedalus.png');
    await slideFinderIn(page);
    await sleep(820);
    phases.b3_finderIn = Date.now();

    // ===== Cursor walks to chibi file =====
    const filePos = await getFinderFileCenter(page);
    if (filePos) {
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 850), filePos);
      await sleep(900);
    }

    // Pick up — drag thumb appears at file center, file dims slightly.
    await page.evaluate(() => {
      const f = document.getElementById('__nebula-finder-file');
      if (f) f.style.opacity = '0.35';
    });
    await injectDragThumb(page, '/demo/clay_daedalus.png', filePos?.x ?? 240, filePos?.y ?? 540, 110);
    await sleep(220);

    // Drag toward chat panel.
    const chatCenter = await page.evaluate(() => {
      const cp = document.querySelector('.chat-panel');
      if (!cp) return { x: 1700, y: 540 };
      const r = cp.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1100), chatCenter);
    await moveDragThumb(page, chatCenter.x, chatCenter.y, 1100);
    await sleep(1150);

    // Drop animation + actual upload + pushUser.
    await dropDragThumb(page);
    const refUpload = await uploadReference(page, REFERENCE_IMAGE_PATH);
    log('beat-3', `uploaded → nodeId=${refUpload.nodeId}`);
    phases.b3_drop = Date.now();
    await slideFinderOut(page);

    // Move image-input node to its slot.
    await page.evaluate(({ id, pos }) => {
      window.__nebulaCanvas.setNodePosition(id, pos);
    }, { id: refUpload.nodeId, pos: POS.imageInput });
    await sleep(180);
    await captureNode(refUpload.nodeId, 'Image Input');

    // Chat: clear input, push user message + image bubble.
    await page.evaluate((upload) => {
      window.__nebulaChat.setInput('');
      window.__nebulaChat.pushUser('I want this chibi style', {
        images: [{ nodeId: upload.nodeId, thumbUrl: upload.thumbUrl }],
      });
    }, refUpload);
    await sleep(550);
    phases.b3_userMsg = Date.now();

    // ===== refReact (chibiAck moved earlier, before Finder) =====
    // refReact paced to match voice segments (each chunk appears as
    // its voice line plays). Sleeps roughly equal each voice segment
    // duration so chat bubble doesn't outrun the audio.
    const reactId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    const reactBeats = [
      { chunk: 'Oh — there I am. Handsome devil. ', holdMs: 2700 },
      { chunk: 'Soft cream, blush, gold accents. ', holdMs: 2800 },
      { chunk: 'Let me try again.',                  holdMs: 1500 },
    ];
    for (const { chunk, holdMs } of reactBeats) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: reactId, c: chunk,
      });
      await sleep(holdMs);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), reactId);
    phases.b3_reactDone = Date.now();

    // Tail hold so the final voice line clears.
    await sleep(800);
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
