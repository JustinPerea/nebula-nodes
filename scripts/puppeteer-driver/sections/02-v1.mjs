// Section 02 — Beat 2: TI spawn + V1 generation.
//
// Picks up from section 01's end (chat shows user "show yourself flying"
// + Daedalus's streaming "Showing myself flying — one moment." bubble,
// camera at chatbox-high cy=0.55).
//
// Sequence:
//  1. Spawn empty Text Input node on canvas (textInput1).
//  2. Stream skillIntro1 chat: "I have a skill for this model."
//  3. Stream V1_ENHANCED_PROMPT into the Text Input + skillIntro2 chat
//     ("Let me re-prompt it the way gpt-image-2 likes.") in parallel.
//  4. Spawn v1Gen (gpt-image-2-generate). Stream favoriteModel chat
//     ("Now I'll wire it to my favorite — gpt-image-2.") as the edge
//     from TI → v1Gen connects.
//  5. Execute v1 (progress animation), inject v1 output image, end the
//     "building" streaming bubble.
//
// Voice (per-section build-vo, no music):
//   ~1.0s   I have a skill for this model.
//   ~3.5s   Let me re-prompt it the way gpt-image-2 likes.
//   ~7.5s   Now I'll wire it to my favorite — gpt-image-2.
//   ~11.0s  And here is what comes when I'm given only words.
//
// Duration target: ~13.5s.

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

const SECTION = '02-v1';
const runId = nowSlug();
const RUN_DIR = join(SECTIONS_OUT, SECTION, runId);
const STATE_OUT = join(SECTIONS_OUT, SECTION, 'state-out.json');

const USER_PROMPT = 'show yourself flying';
const DAEDALUS_BUILDING = 'Showing myself flying — one moment.';
const V1_ENHANCED_PROMPT =
  'Daedalus the Greek inventor mid-flight, mechanical feathered wings spread wide, dramatic dynamic pose, sunset Aegean sky, cinematic composition, golden hour lighting, photorealistic cinematic detail';
const DEMO_V1 = '/demo/outputs/v1.png';

const POS = {
  textInput1: { x: -700, y: -200 },
  v1Gen:      { x:  -60, y: -200 },
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

    // Activate Daedalus tab off-camera (bloom plays before we start
    // recording — we don't want it again here).
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

    // Re-establish prior chat: user message + Daedalus streaming
    // "Showing myself flying — one moment." bubble. The streaming bubble
    // stays open until v1 completes inside this section.
    await page.evaluate((text) => window.__nebulaChat.pushUser(text), USER_PROMPT);
    const buildId = await page.evaluate((text) =>
      window.__nebulaChat.pushAssistant(text, { streaming: true }),
    DAEDALUS_BUILDING);
    await sleep(200);

    await injectCursor(page);
    log('cursor', 'virtual cursor injected');

    // Park cursor at the chat send button position — same place section
    // 01 left it. Snap immediately so it's already in pose at frame 0.
    const sendCenter = await page.evaluate(() => {
      const send = Array.from(document.querySelectorAll('.chat-panel__send'))
        .find((b) => !b.classList.contains('chat-panel__send--stop'));
      if (!send) return { x: 1700, y: 950 };
      const r = send.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 0), sendCenter);

    await setOverview(page);
    await sleep(300);

    // ----- Begin recording -----
    const recorder = await startRecorder(page, RUN_DIR, { quality: 100 });
    log('record', `screencast started → ${recorder.framesDir}`);

    const phases = { recordStart: Date.now() };
    const { events, edges, captureNode, captureEdge } = makeCaptureHelpers(page, phases.recordStart);

    // Brief settle so first frames show the resumed state cleanly.
    await sleep(400);

    // ===== Reaction in chat — Daedalus reacts to the user's prompt
    // before the camera leaves the chat panel. Lays the groundwork for
    // the skill talk later: viewer hears Daedalus react, then sees the
    // canvas action begin.
    phases.b2_reaction = Date.now();
    log('beat-2', 'reaction chat → pan to canvas → spawn nodes');
    const reactId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of ['Ah — you want ', 'to see me. ', 'How cute.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: reactId, c: chunk,
      });
      await sleep(660);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), reactId);
    // Hold so reaction caption + voice can land before camera moves.
    await sleep(900);

    // ===== "Let me place down a text node first." — chat lands BEFORE
    // the TI spawns so the viewer hears the announcement, then sees
    // the placement.
    phases.b2_placeText = Date.now();
    const placeTextId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of ['Let me place down ', 'a text node first.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: placeTextId, c: chunk,
      });
      await sleep(700);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), placeTextId);
    await sleep(450);

    // ===== Spawn Text Input =====
    phases.b2_spawnTI = Date.now();
    const tiId = await page.evaluate(async (pos) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: '' } });
      return id;
    }, POS.textInput1);
    await sleep(280);
    await widenNode(page, tiId, 380);
    await page.evaluate(() => {
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(380);
    await captureNode(tiId, 'Text Input');
    // Beat to let the placement breathe before the next announcement.
    await sleep(900);

    // ===== "And my favorite image model — gpt-image-2." — chat lands
    // BEFORE v1Gen spawns. Same pattern: announce, then place.
    const favId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of ['And my favorite ', 'image model — ', 'gpt-image-2.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: favId, c: chunk,
      });
      await sleep(680);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), favId);
    await sleep(450);

    // ===== Spawn v1Gen (gpt-image-2-generate) =====
    const v1Id = await page.evaluate(async (pos) =>
      window.__nebulaGraphStore.getState().addNode('gpt-image-2-generate', pos),
    POS.v1Gen);
    await sleep(420);
    await captureNode(v1Id, 'GPT Image 2 Generate');
    await sleep(700);

    // Edge connects TI.text → v1Gen.prompt. Visible — viewer sees the
    // pipeline take shape before the prompt is enhanced.
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: tiId, t: v1Id });
    await sleep(400);
    await captureEdge(`${tiId}->${v1Id}`, tiId, v1Id);
    await sleep(700);

    // ===== Skills chat + V1 prompt streaming into TI (parallel) =====
    // Camera will pan from the pair-overview to the TI for this beat
    // (handled by zoom-directives). Daedalus talks about his per-model
    // skill posture while the prompt types itself in.
    phases.b2_skills = Date.now();
    const skillsId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    {
      const prompt = V1_ENHANCED_PROMPT;
      const chunkSize = 10;
      const skillsChunks = [
        'I have skills ',
        'tuned for every model. ',
        'Let me dial ',
        'this one in.',
      ];
      let chatChunkIdx = 0;
      const promptChunkCount = Math.ceil(prompt.length / chunkSize);
      const chatChunkEvery = Math.max(1, Math.floor(promptChunkCount / skillsChunks.length));
      for (let i = 0; i < prompt.length; i += chunkSize) {
        const acc = prompt.slice(0, i + chunkSize);
        await page.evaluate(({ id, value }) => {
          window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value } });
        }, { id: tiId, value: acc });
        const promptStep = i / chunkSize;
        if (chatChunkIdx < skillsChunks.length && promptStep % chatChunkEvery === 0) {
          await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
            id: skillsId, c: skillsChunks[chatChunkIdx],
          });
          chatChunkIdx += 1;
        }
        await sleep(90);
      }
      while (chatChunkIdx < skillsChunks.length) {
        await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
          id: skillsId, c: skillsChunks[chatChunkIdx],
        });
        chatChunkIdx += 1;
        await sleep(120);
      }
      await page.evaluate((id) => window.__nebulaChat.endAssistant(id), skillsId);
      await sleep(700);
    }
    phases.b2_promptStreamed = Date.now();

    // ===== Execute v1 (progress + complete) =====
    await page.evaluate((id) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, { state: 'executing', progress: 0.1 });
    }, v1Id);
    for (const p of [0.3, 0.55, 0.78, 0.95]) {
      await sleep(380);
      await page.evaluate(({ id, val }) => {
        window.__nebulaGraphStore.getState().updateNodeData(id, { progress: val });
      }, { id: v1Id, val: p });
    }
    await sleep(280);

    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { image: { type: 'Image', value: url } },
      });
    }, { id: v1Id, url: DEMO_V1 });
    await page.evaluate((mid) => window.__nebulaChat.endAssistant(mid), buildId);
    phases.b2_v1Done = Date.now();

    // Hold so v1 image breathes + voice "And here is what comes when
    // given only words" (~3s line) plays through fully.
    await sleep(5500);
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

    // Capture node bounds for derive-zoom (and the next section).
    const final = await page.evaluate((nodeIds) => {
      const out = { nodes: {}, panels: {} };
      for (const id of nodeIds) {
        const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out.nodes[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      const sels = {
        chat: '.chat-panel',
        library: '.panel--library',
      };
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
