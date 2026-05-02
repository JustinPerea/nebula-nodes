// Deterministic build orchestrator. Drives the Nebula UI through a fixed
// 8-node iterative-refinement narrative with timed beats, faking the entire
// "user types → Daedalus thinks → result appears → user reacts" loop via the
// __nebulaCanvas / __nebulaChat / __nebulaGraphStore window bridges plus
// pre-generated demo assets. No real LLM calls happen during the recording.
//
// Pipeline downstream of this script is identical to drive.mjs:
//   recording.mp4 + events.json → derive-zoom → apply-zoom → build-vo
//
// Usage:
//   node scripts/puppeteer-driver/scripted-build.mjs            # headful
//   node scripts/puppeteer-driver/scripted-build.mjs --headless true
//
// Outputs:
//   output/puppeteer-driver/<runId>-scripted/recording.mp4
//   output/puppeteer-driver/<runId>-scripted/events.json
//   output/puppeteer-driver/<runId>-scripted/end.png

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const args = parseArgs(process.argv.slice(2));
const URL = args.url ?? 'http://localhost:5173';
const HEADLESS = args.headless === 'true' || args.headless === true;
const FPS = Number(args.fps ?? 30);
const SCREENCAST_QUALITY = Number(args.quality ?? 80);
const VIEWPORT = { width: 1920, height: 1080 };

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(REPO_ROOT, 'output', 'puppeteer-driver', `${runId}-scripted`);

// Pre-generated demo asset URLs (Vite serves /demo/outputs/* from
// frontend/public/demo/outputs/). The orchestrator injects these as the
// fake "executed outputs" of generation nodes so the cut is deterministic.
const DEMO_OUTPUTS = {
  v1:    '/demo/outputs/v1.png',
  v2:    '/demo/outputs/v2.png',
  style: '/demo/outputs/style.png',
  mesh:  '/demo/outputs/mesh.glb',
  video: '/demo/outputs/video.mp4',
};

// Local filesystem path to the reference image so we can /api/uploads it.
const REFERENCE_IMAGE_PATH = join(REPO_ROOT, 'frontend', 'public', 'demo', 'clay_daedalus.png');

// What the user "types" — the casual prompt Daedalus has to refine. The
// user is addressing Daedalus, so the pronoun is "yourself" not "me".
const USER_PROMPT = 'show yourself flying';

// V1 prompt: Daedalus's skill-injected rewrite of USER_PROMPT keyed to
// gpt-image-2's prompting preferences (subject + composition + lighting +
// style cues). Still produces a hyperreal Daedalus because no chibi anchor
// exists yet — the failure that triggers the reference-image moment.
const V1_ENHANCED_PROMPT =
  'Daedalus the Greek inventor mid-flight, mechanical feathered wings spread wide, dramatic dynamic pose, sunset Aegean sky, cinematic composition, golden hour lighting, photorealistic cinematic detail';

// What Daedalus rewrites the prompt to once he sees the reference. Shows up
// in the second Text Input node (the "refined" one feeding gpt-image-2-edit).
const REFINED_PROMPT =
  'Daedalus mid-flight, mechanical feathered wings spread wide, dynamic flying pose, matching reference figurine style — soft cream background, chibi proportions, blush cheeks, gold accents on wing struts, smooth sculpted aesthetic';

const STYLE_PROMPT = 'watercolor remix — soft pastel washes, paper grain';

// Chat narration sequence. Daedalus's voice. Daedalus does NOT pre-judge
// his own v1 output (he can't know what the user wants from a vague prompt),
// so the beat after v1 lands is a teaching tip, not a self-critique.
const NARRATION = {
  building:      'Showing myself flying — one moment.',
  // Skill-injection beat — Daedalus has gpt-image-2 prompting skills loaded
  // and tells the user he's rewriting the casual ask before generating.
  // Split in two so the chat bubbles + voice land on the visual moments:
  // skillIntro1 fires when the Text Input spawns; skillIntro2 fires when
  // the prompt typing begins streaming into it.
  skillIntro1:   'I have a skill for this model.',
  skillIntro2:   'Let me re-prompt it the way gpt-image-2 likes.',
  skillIntro:    'I have a skill for this model. Let me re-prompt it the way gpt-image-2 likes.',
  // Models-list beat — Daedalus zooms back to the library panel before the
  // tagline and explains the per-model skill posture.
  modelsIntro:   'Each model has its own skill. They get better with every run.',
  // After the prompt is written, Daedalus calls out the model he's wiring
  // it to. Lands as the v1 (gpt-image-2-generate) node spawns + connects.
  favoriteModel: "Now I'll wire it to my favorite — gpt-image-2.",
  // Teaching beat after v1 lands — Daedalus offers the user a way to anchor
  // his next attempt to a specific aesthetic, without judging v1 itself.
  refTip:     'If you want a specific style, give me an image to reference.',
  // Lands the moment the reference image appears — Daedalus names the style
  // back to the user before riffing on himself in refReact.
  chibiAck:   'Chibi. Got it.',
  refReact:   'Oh — there I am. Handsome devil. Soft cream, blush, gold accents. Let me try again.',
  v2React:    'Yes. Look at me fly. Now that is handsome.',
  fanout:     'Now — let me show you what else this canvas can hold.',
  tagline:    'This is Nebula.',
};

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  log('start', `runDir=${RUN_DIR} headless=${HEADLESS}`);

  const userDataDir = join(REPO_ROOT, 'output', 'puppeteer-driver', `${runId}-scripted-profile`);
  await mkdir(userDataDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: VIEWPORT,
    userDataDir,
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('[scripted]') || msg.type() === 'error') {
        log('page', `[${msg.type()}] ${t}`);
      }
    });
    page.on('pageerror', (err) => log('pageerror', err.message));

    log('nav', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
      try { localStorage.setItem('nebula:daedalus-provider', 'nous'); } catch {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.waitForSelector('.chat-panel', { timeout: 10000 });
    await page.waitForFunction(
      () => window.__nebulaCanvas && window.__nebulaChat && window.__nebulaGraphStore,
      { timeout: 10000 },
    );
    log('bridges', '__nebulaCanvas + __nebulaChat + __nebulaGraphStore ready');

    // Clear backend + frontend graph + chat.
    log('clear', 'wiping cli_graph + frontend graph + chat');
    await page.evaluate(async () => {
      try { await fetch('http://localhost:8000/api/graph', { method: 'DELETE' }); } catch {}
      window.__nebulaGraphStore.getState().clearGraph();
      window.__nebulaChat.clear();
    });
    await sleep(800);

    // Inject the virtual cursor (copied from drive.mjs — same SVG + ripple).
    await injectCursor(page);
    log('cursor', 'virtual cursor injected');

    // Suppress auto-fitView before any agent activity so a stray fit
    // doesn't hijack the camera while bloom plays. Set the wide overview
    // anchor here so the canvas state is right from frame 0.
    await page.evaluate(() => {
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(300);

    // ----- Begin recording. The intro (cursor click on Daedalus tab +
    // bloom animation) is now the FIRST thing the viewer sees. -----
    const recorder = await Recorder.start(page, RUN_DIR, {
      quality: SCREENCAST_QUALITY,
      viewport: VIEWPORT,
    });
    log('record', `screencast started → ${recorder.framesDir}`);

    // Cursor walks to the Daedalus tab and clicks. The bloom animation
    // plays as a result of the click — this is the cold-open of the cut.
    log('agent', 'cursor → Daedalus tab → bloom');
    const daePos = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
      const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
      if (!dae) return null;
      const r = dae.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (daePos) {
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1000), daePos);
      await sleep(1100);
      await page.evaluate(() => window.__nebulaCursor.click());
      await sleep(150);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.chat-panel__agent-selector button'));
        const dae = btns.find((b) => b.textContent && b.textContent.trim().toLowerCase() === 'daedalus');
        if (dae) dae.click();
      });
    }
    // Bloom animation: ~2.8s. Hold so the viewer sees the bloom land.
    await sleep(2800);

    // Defense: wipe post-bloom (chat session re-establish can re-push
    // backend graph state through WS). Same trick drive.mjs uses. We
    // need this BEFORE beat 1 fires — and re-set the suppress + camera
    // since bloom may have triggered fit attempts.
    await page.evaluate(() => {
      const store = window.__nebulaGraphStore.getState();
      if (store.nodes.length > 0) store.clearGraph();
      window.__nebulaChat.clear();
      window.__nebulaSuppressFitView = true;
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(400);

    const phases = { recordStart: Date.now() };
    const events = [];
    const edgeEvents = [];

    // Helper to capture a node-add event with bounds (mirrors drive.mjs's
    // events.json shape so derive-zoom can consume our recording the same
    // way it consumes drive.mjs runs).
    const captureNodeEvent = async (nodeId, label) => {
      const bounds = await page.evaluate((id) => {
        const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, nodeId);
      events.push({
        ts: Date.now() - phases.recordStart,
        nodeId,
        nodeLabel: label,
        bounds: bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        kind: 'added',
      });
    };

    const captureEdgeEvent = async (edgeId, source, target) => {
      edgeEvents.push({
        ts: Date.now() - phases.recordStart,
        edgeId,
        source,
        target,
        kind: 'edge-added',
      });
    };

    // Position constants. Canvas is React Flow space (origin 0,0 = container
    // center after centerOn(0,0)). Our layout puts the iteration column
    // on the left, the v2 + fan-outs on the right. Approximate, can tweak
    // visually after first run.
    // Layout: 4 columns. Inputs on the left, iteration nodes mid-left, v2
    // bottom-mid, fan-out stack on the right with the style-remix prompt
    // sitting above its edit node. Y goes DOWN in React Flow space. Tuned
    // so nothing overlaps once each node renders its preview output.
    // Text-input nodes are widened to 380px (vs default 240) so the
    // streaming prompt is legible. Right-column generators stay at
    // default width. Spacing recalculated so the textInput → generator
    // edge has visible breathing room — the prior cramped layout was
    // explicitly called out as a fix.
    const POS = {
      textInput1: { x: -700, y: -200 },  // wider text-input (380px)
      v1Gen:      { x:  -60, y: -200 },  // gpt-image-2-generate (was -380; +320 to clear widened TI)
      imageInput: { x: -700, y:   80 },  // clay_daedalus reference
      textInput2: { x: -700, y:  580 },  // refined prompt (widened)
      v2Edit:     { x:  -60, y:  340 },  // gpt-image-2-edit (was -360; +300 to match v1 spacing)
      styleText:  { x:  340, y: -440 },  // watercolor prompt (was 240; +100 so v2 + style don't crowd)
      style:      { x:  340, y: -200 },  // gpt-image-2-edit (style remix)
      mesh:       { x:  340, y:  240 },  // meshy-image-to-3d (was 240; matched right-column shift)
      video:      { x:  340, y:  540 },  // veo-3
    };

    // ============================================================
    // BEAT 1 — User types the casual prompt
    // ============================================================
    phases.b1_typeStart = Date.now();
    log('beat-1', 'cursor → chat input → type');

    // Cursor walks to the chat textarea, click (visual only — focus too).
    const taCenter = await page.evaluate(() => {
      const ta = document.querySelector('.chat-panel__textarea');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (taCenter) {
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1100), taCenter);
      await sleep(1200);
      await page.evaluate(() => window.__nebulaCursor.click());
      await sleep(150);
      await page.focus('.chat-panel__textarea');
    }

    // Beat for the camera to fully settle on the chatbox before typing
    // starts. Without this, page.type fires while the ease-in is still
    // animating — viewer sees keystrokes appear before they've registered
    // the chat panel as the focus.
    await sleep(1600);

    // Real keyboard typing into the textarea (visual). 35ms/char, ~770ms total.
    await page.type('.chat-panel__textarea', USER_PROMPT, { delay: 35 });
    phases.b1_typeEnd = Date.now();
    await sleep(450);

    // Cursor → Send. Click is RIPPLE-ONLY — we don't fire the real submit.
    // Real submit would route to backend Daedalus and produce unpredictable
    // output. Instead the orchestrator manufactures the conversation.
    const sendCenter = await page.evaluate(() => {
      const send = Array.from(document.querySelectorAll('.chat-panel__send'))
        .find((b) => !b.classList.contains('chat-panel__send--stop'));
      if (!send) return null;
      const r = send.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (sendCenter) {
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 700), sendCenter);
      await sleep(750);
      await page.evaluate(() => window.__nebulaCursor.click());
    }

    // Inject the user bubble + clear textarea so it doesn't keep showing
    // the typed prompt after the bubble appears.
    phases.b1_send = Date.now();
    await page.evaluate((text) => {
      window.__nebulaChat.pushUser(text);
      window.__nebulaChat.setInput('');
    }, USER_PROMPT);
    await sleep(600);

    // Push Daedalus's "Showing myself flying" response IMMEDIATELY (while
    // camera is still on chatbox) so the viewer reads the conversation
    // before being shown the canvas. Previously this was inside beat 2,
    // which meant Daedalus's reply appeared off-screen during canvas pan.
    const buildId = await page.evaluate((text) => {
      return window.__nebulaChat.pushAssistant(text, { streaming: true });
    }, NARRATION.building);
    await showCaption(page, NARRATION.building);

    // Read-the-room beat for "one moment".
    await sleep(900);

    // Brief pause after building bubble — camera is panning from chatbox
    // toward the canvas while the viewer reads "Showing myself flying".
    await sleep(700);

    // ============================================================
    // BEAT 2 — Spawn Text Input + GPT Image 2 Generate, wire, "execute"
    // ============================================================
    phases.b2_spawnV1 = Date.now();
    log('beat-2', `spawn empty TI → skillIntro1 → stream prompt + skillIntro2 → v1 Generate`);

    // Spawn EMPTY first so the viewer sees Daedalus actually writing the
    // skill-injected prompt, not a teleported result.
    const tiId = await page.evaluate(async (pos) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: '' } });
      return id;
    }, POS.textInput1);
    await sleep(300);
    await widenNode(page, tiId, 380);
    // CRITICAL: ReactFlow's built-in fitView fires once when the first node
    // lands. Force our wide overview AFTER the first node arrives so
    // subsequent additions land in the same frame.
    await page.evaluate(() => {
      window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
    });
    await sleep(400);
    await captureNodeEvent(tiId, 'Text Input');

    // skillIntro1 ("I have a skill for this model.") streams in chat NOW —
    // landing on the visual moment the Text Input arrives. Voice + caption
    // line up with this beat.
    const skill1Id = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    for (const chunk of ['I have a skill ', 'for this model.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: skill1Id, c: chunk,
      });
      await sleep(640);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), skill1Id);
    await sleep(260);

    // skillIntro2 streams as the prompt typing begins — Daedalus's "Let me
    // re-prompt it the way gpt-image-2 likes." plays alongside the actual
    // typing into the Text Input.
    const skill2Id = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );

    // Stream V1_ENHANCED_PROMPT into textInput1 + skillIntro2 chat in
    // parallel: while the prompt streams char-by-char into the node, the
    // chat bubble streams "Let me re-prompt it the way gpt-image-2 likes."
    {
      const prompt = V1_ENHANCED_PROMPT;
      const chunkSize = 10;
      let acc = '';
      // Schedule chat chunks across the prompt-typing window so they pace
      // together. ~280ms per chat chunk feels right for 6 chunks.
      const skill2Chunks = [
        'Let me ',
        're-prompt it ',
        'the way ',
        'gpt-image-2 ',
        'likes.',
      ];
      let chatChunkIdx = 0;
      const promptChunkCount = Math.ceil(prompt.length / chunkSize);
      const chatChunkEvery = Math.max(1, Math.floor(promptChunkCount / skill2Chunks.length));
      for (let i = 0; i < prompt.length; i += chunkSize) {
        acc = prompt.slice(0, i + chunkSize);
        await page.evaluate(({ id, value }) => {
          window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value } });
        }, { id: tiId, value: acc });
        const promptStep = i / chunkSize;
        if (chatChunkIdx < skill2Chunks.length && promptStep % chatChunkEvery === 0) {
          await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
            id: skill2Id, c: skill2Chunks[chatChunkIdx],
          });
          chatChunkIdx += 1;
        }
        await sleep(90);
      }
      // Flush any remaining skillIntro2 chunks.
      while (chatChunkIdx < skill2Chunks.length) {
        await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
          id: skill2Id, c: skill2Chunks[chatChunkIdx],
        });
        chatChunkIdx += 1;
        await sleep(120);
      }
      await page.evaluate((id) => window.__nebulaChat.endAssistant(id), skill2Id);
      await sleep(700);
    }

    // Favorite-model beat — Daedalus calls out the model he's about to
    // wire the prompt to. Streamed in chat as the v1 node spawns + the
    // edge connects, so the named model ("gpt-image-2") and the visual
    // arrival of the gpt-image-2-generate node land together.
    const favId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    await showCaption(page, NARRATION.favoriteModel);
    for (const chunk of [
      "Now I'll wire it ",
      'to my favorite — ',
      'gpt-image-2.',
    ]) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: favId, c: chunk,
      });
      await sleep(620);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), favId);

    const v1Id = await page.evaluate(async (pos) => {
      return await window.__nebulaGraphStore.getState().addNode('gpt-image-2-generate', pos);
    }, POS.v1Gen);
    await sleep(450);
    await captureNodeEvent(v1Id, 'GPT Image 2 Generate');

    // Edge: Text Input.text → v1.prompt
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: tiId, t: v1Id });
    await sleep(400);
    await captureEdgeEvent(`${tiId}->${v1Id}`, tiId, v1Id);

    // (NARRATION.building was pushed earlier, while camera was still on
    // chatbox. buildId tracks that streaming bubble so endAssistant below
    // can close it once v1 has rendered.)
    await sleep(300);

    // Fake "executing" state so the node shows progress UI briefly.
    await page.evaluate((id) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'executing', progress: 0.1,
      });
    }, v1Id);
    // Fake progress animation in 4 ticks over ~1.6s.
    for (const p of [0.3, 0.55, 0.78, 0.95]) {
      await sleep(400);
      await page.evaluate(({ id, val }) => {
        window.__nebulaGraphStore.getState().updateNodeData(id, { progress: val });
      }, { id: v1Id, val: p });
    }
    await sleep(300);

    // Inject v1 output, mark complete, end the streaming bubble.
    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { image: { type: 'Image', value: url } },
      });
    }, { id: v1Id, url: DEMO_OUTPUTS.v1 });
    await page.evaluate((mid) => window.__nebulaChat.endAssistant(mid), buildId);
    phases.b2_v1Done = Date.now();

    // Hold a few seconds so v1's failure registers — eye needs ~3s to read
    // a hyperreal Hephaestus image and recognize it's off-aesthetic.
    await sleep(4000);

    // ============================================================
    // BEAT 2.5 — Daedalus offers a tip: "If you want a specific style…"
    // Streamed so it reads as Daedalus thinking aloud rather than a UI hint.
    // ============================================================
    phases.b2p5_tipStart = Date.now();
    log('beat-2.5', 'Daedalus offers the reference-image tip');
    const tipId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    await showCaption(page, NARRATION.refTip);
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
    // Beat between the tip ending and the user accepting the offer (drop).
    await sleep(2400);

    // ============================================================
    // BEAT 3 — User types "I want this chibi style", drags the chibi
    // reference into chat from off-screen, sends. Daedalus names the
    // style back, then riffs on himself.
    // ============================================================
    phases.b3_referenceReveal = Date.now();
    log('beat-3', 'visible type + cursor-drag chibi → upload + Image Input');

    // (a) Cursor walks back to chat textarea so the user can type the
    // style request before attaching the reference image.
    const taPos = await page.evaluate(() => {
      const ta = document.querySelector('.chat-panel__textarea');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (taPos) {
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 800), taPos);
      await sleep(900);
      await page.evaluate(() => window.__nebulaCursor.click());
      await sleep(120);
      await page.focus('.chat-panel__textarea');
    }

    // (b) Type the user's chat input visibly. 40ms/char, ~880ms total.
    await page.type('.chat-panel__textarea', 'I want this chibi style', { delay: 40 });
    await sleep(450);

    // (c) Slide a fake Finder window in from the left holding chibi.png
    // as a file thumbnail. Sells the "drag from disk" story instead of
    // the cursor exiting screen for an unseen reason.
    await injectFinder(page, '/demo/clay_daedalus.png');
    await slideFinderIn(page);
    await sleep(820);

    // (d) Cursor walks from the chat textarea to the chibi file inside
    // the Finder window.
    const filePos = await getFinderFileCenter(page);
    if (filePos) {
      await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 850), filePos);
      await sleep(900);
    }

    // (e) Cursor "picks up" the file — spawn the drag thumb at the file
    // center, then animate cursor + thumb in parallel toward the chat
    // panel. The Finder file dims slightly so the pickup is visible.
    await page.evaluate(() => {
      const f = document.getElementById('__nebula-finder-file');
      if (f) f.style.opacity = '0.35';
    });
    await injectDragThumb(page, '/demo/clay_daedalus.png', filePos?.x ?? 240, filePos?.y ?? 540, 110);
    await sleep(220);

    const chatCenter = await page.evaluate(() => {
      const cp = document.querySelector('.chat-panel');
      if (!cp) return { x: 1700, y: 540 };
      const r = cp.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1100), chatCenter);
    await moveDragThumb(page, chatCenter.x, chatCenter.y, 1100);
    await sleep(1150);

    // (f) Drop animation — fade thumb out — and simultaneously perform
    // the actual upload + chat push. Image bubble + Image Input node
    // arrive on the same beat as the visual drop.
    await dropDragThumb(page);

    // The HTTP upload spawns the Image Input node on the canvas.
    const refUpload = await uploadReference(page, REFERENCE_IMAGE_PATH);
    log('beat-3', `uploaded → nodeId=${refUpload.nodeId} thumbUrl=${refUpload.thumbUrl}`);

    // Slide the Finder back out — its job is done.
    await slideFinderOut(page);

    // Move the image-input node to our chosen left-column slot. The
    // backend auto-positions it after upload; we override.
    await page.evaluate(({ id, pos }) => {
      window.__nebulaCanvas.setNodePosition(id, pos);
    }, { id: refUpload.nodeId, pos: POS.imageInput });
    await sleep(180);
    await captureNodeEvent(refUpload.nodeId, 'Image Input');

    // Chat: clear the typed input, then push the user message with the
    // image attached. The bubble appears in chat at the same moment
    // the dragged thumb finishes fading out.
    await page.evaluate((upload) => {
      window.__nebulaChat.setInput('');
      window.__nebulaChat.pushUser('I want this chibi style', {
        images: [{ nodeId: upload.nodeId, thumbUrl: upload.thumbUrl }],
      });
    }, refUpload);
    await sleep(550);

    // Daedalus's first beat lands the moment the image arrives — short,
    // clipped acknowledgement that he heard the style name back.
    phases.b3_daedReacts = Date.now();
    const ackId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    await showCaption(page, NARRATION.chibiAck);
    for (const chunk of ['Chibi. ', 'Got it.']) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: ackId, c: chunk,
      });
      await sleep(550);
    }
    await page.evaluate((id) => window.__nebulaChat.endAssistant(id), ackId);
    await sleep(700);

    // Then the personality beat — Daedalus sees himself in the reference,
    // riffs on it, names the visual cues he'll keep, and announces the
    // retry. Chibi already named in chibiAck, so refReact skips it.
    const reactId = await page.evaluate(() =>
      window.__nebulaChat.pushAssistant('', { streaming: true }),
    );
    await showCaption(page, NARRATION.refReact);
    for (const chunk of [
      'Oh — there I am. ',
      'Handsome devil. ',
      'Soft cream, blush, gold accents. ',
      'Let me try again.',
    ]) {
      await page.evaluate(({ id, c }) => window.__nebulaChat.appendAssistant(id, c), {
        id: reactId, c: chunk,
      });
      await sleep(700);
    }

    // ============================================================
    // BEAT 4 — Refined Text Input + GPT Image 2 Edit, wire, "execute" → v2
    // ============================================================
    phases.b4_spawnV2 = Date.now();
    log('beat-4', 'spawn refined TI + v2 Edit, connect both, execute');

    // Spawn the refined TI EMPTY first so the viewer sees Daedalus actually
    // writing the enhanced prompt, not a teleported result. Then stream the
    // text in chunks of ~10 chars at a steady cadence — reads as deliberate
    // craftsmanship rather than instant generation.
    const ti2Id = await page.evaluate(async (pos) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: '' } });
      return id;
    }, POS.textInput2);
    await sleep(500);
    // Same width override as textInput1 so the refined prompt reads
    // legibly while streaming.
    await widenNode(page, ti2Id, 380);
    await captureNodeEvent(ti2Id, 'Text Input (refined)');

    // Stream REFINED_PROMPT into the Text Input. ~10 chars per tick at
    // 90ms = ~110 chars/sec — fast enough to feel intentional, slow enough
    // to feel deliberate. Total ~3s for ~330 chars.
    {
      const prompt = REFINED_PROMPT;
      const chunkSize = 10;
      let acc = '';
      for (let i = 0; i < prompt.length; i += chunkSize) {
        acc = prompt.slice(0, i + chunkSize);
        await page.evaluate(({ id, value }) => {
          window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value } });
        }, { id: ti2Id, value: acc });
        await sleep(90);
      }
      // Settle for a beat after the last keystroke so the viewer absorbs
      // the full enhanced prompt before v2 spawns.
      await sleep(700);
    }

    const v2Id = await page.evaluate(async (pos) => {
      return await window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', pos);
    }, POS.v2Edit);
    await sleep(450);
    await captureNodeEvent(v2Id, 'GPT Image 2 Edit');

    // Wire image-input.image → v2.images, refined-text.text → v2.prompt
    await page.evaluate(({ src, tgt }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: src, sourceHandle: 'image', target: tgt, targetHandle: 'images',
      });
    }, { src: refUpload.nodeId, tgt: v2Id });
    await sleep(300);
    await captureEdgeEvent(`${refUpload.nodeId}->${v2Id}`, refUpload.nodeId, v2Id);

    await page.evaluate(({ src, tgt }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: src, sourceHandle: 'text', target: tgt, targetHandle: 'prompt',
      });
    }, { src: ti2Id, tgt: v2Id });
    await sleep(300);
    await captureEdgeEvent(`${ti2Id}->${v2Id}`, ti2Id, v2Id);

    // Execute v2 — fake progress + inject v2 output.
    await page.evaluate((id) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'executing', progress: 0.1,
      });
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
    }, { id: v2Id, url: DEMO_OUTPUTS.v2 });
    await page.evaluate((mid) => window.__nebulaChat.endAssistant(mid), reactId);
    phases.b4_v2Done = Date.now();

    // Personality beat — Daedalus admires v2. Tighter timing so the joke
    // lands close to the v2 reveal and we don't sit in dead air.
    await sleep(1400);
    await page.evaluate((text) => window.__nebulaChat.pushAssistant(text), NARRATION.v2React);
    await showCaption(page, NARRATION.v2React);
    await sleep(3200);

    // ============================================================
    // BEAT 5 — Fan-out: style remix, mesh, video
    // ============================================================
    phases.b5_fanout = Date.now();
    log('beat-5', 'fan-out: style remix + meshy + veo');

    await page.evaluate((text) => window.__nebulaChat.pushAssistant(text), NARRATION.fanout);
    await showCaption(page, NARRATION.fanout);
    await sleep(600);

    // Style remix node — gpt-image-2-edit fed by v2.image + a small text
    // prompt. The text node sits ABOVE the style edit in the right column
    // so it doesn't crowd v1.
    const styleTiId = await page.evaluate(async ({ pos, prompt }) => {
      const id = await window.__nebulaGraphStore.getState().addNode('text-input', pos);
      window.__nebulaGraphStore.getState().updateNodeData(id, { params: { value: prompt } });
      return id;
    }, { pos: POS.styleText, prompt: STYLE_PROMPT });
    await sleep(280);
    await captureNodeEvent(styleTiId, 'Text Input (style)');

    const styleId = await page.evaluate(async (pos) => {
      return await window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', pos);
    }, POS.style);
    await sleep(320);
    await captureNodeEvent(styleId, 'GPT Image 2 Edit (style)');

    // Wire v2 → style.images, style-text → style.prompt
    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'images',
      });
    }, { s: v2Id, t: styleId });
    await captureEdgeEvent(`${v2Id}->${styleId}`, v2Id, styleId);

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'text', target: t, targetHandle: 'prompt',
      });
    }, { s: styleTiId, t: styleId });
    await captureEdgeEvent(`${styleTiId}->${styleId}`, styleTiId, styleId);
    await sleep(300);

    // Meshy node — image input only.
    const meshId = await page.evaluate(async (pos) => {
      return await window.__nebulaGraphStore.getState().addNode('meshy-image-to-3d', pos);
    }, POS.mesh);
    await sleep(280);
    await captureNodeEvent(meshId, 'Meshy 6 Image-to-3D');

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'image',
      });
    }, { s: v2Id, t: meshId });
    await captureEdgeEvent(`${v2Id}->${meshId}`, v2Id, meshId);
    await sleep(300);

    // Veo node — image input only (we leave prompt unfed for visual brevity;
    // real users would wire a Text Input but the cut doesn't have time).
    const videoId = await page.evaluate(async (pos) => {
      return await window.__nebulaGraphStore.getState().addNode('veo-3', pos);
    }, POS.video);
    await sleep(280);
    await captureNodeEvent(videoId, 'Veo 3.1');

    await page.evaluate(({ s, t }) => {
      window.__nebulaGraphStore.getState().onConnect({
        source: s, sourceHandle: 'image', target: t, targetHandle: 'image',
      });
    }, { s: v2Id, t: videoId });
    await captureEdgeEvent(`${v2Id}->${videoId}`, v2Id, videoId);
    await sleep(400);

    // Kick all 3 fan-out nodes into "executing" simultaneously, then resolve
    // them one at a time over ~2s so the eye registers each completing.
    for (const id of [styleId, meshId, videoId]) {
      await page.evaluate((nid) => {
        window.__nebulaGraphStore.getState().updateNodeData(nid, {
          state: 'executing', progress: 0.2,
        });
      }, id);
    }
    await sleep(900);

    // Resolve in order with bigger staggers — each reveal needs ~2s of
    // dwell so the audio "Watercolor / Sculpture / Motion" can call out
    // each modality as it lands instead of all three rendering before
    // the line begins.
    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { image: { type: 'Image', value: url } },
      });
    }, { id: styleId, url: DEMO_OUTPUTS.style });
    await showCaption(page, 'Watercolor.');
    await sleep(2800);

    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { mesh: { type: 'Mesh', value: url } },
      });
    }, { id: meshId, url: DEMO_OUTPUTS.mesh });
    await showCaption(page, 'Sculpture.');
    // Brief pause for mesh to load + initialize, then drag-rotate the
    // model-viewer canvas so the viewer sees the 3D mesh from multiple
    // angles. Real puppeteer mouse events; <model-viewer> orbit-controls
    // listens for mousedown/move/up by default.
    await sleep(900);
    await rotateMeshNode(page, meshId);
    await sleep(800);

    await page.evaluate(({ id, url }) => {
      window.__nebulaGraphStore.getState().updateNodeData(id, {
        state: 'complete',
        progress: undefined,
        outputs: { video: { type: 'Video', value: url } },
      });
    }, { id: videoId, url: DEMO_OUTPUTS.video });
    await showCaption(page, 'Motion.');
    // Hold on video for ~4.2s so the full Veo clip plays through. The
    // rendered <video> element auto-plays; we just need to dwell.
    await sleep(4200);
    phases.b5_fanoutDone = Date.now();

    // ============================================================
    // BEAT 5.5 — Models-list beat. Daedalus zooms back to the library
    // panel and explains the per-model skill posture before the tagline.
    // ============================================================
    phases.b5p5_modelsIntro = Date.now();
    log('beat-5.5', 'models-list + per-model skill narration');
    await page.evaluate(() => {
      // Pan canvas to a wider view so the library panel + the graph are
      // both visible during this beat. Camera directives will push
      // further but this gives the underlying canvas room to breathe.
      window.__nebulaCanvas.centerOn(0, 130, 0.45, 1200, { x: 880, y: 540 });
    });
    await sleep(1200);
    await page.evaluate((text) => window.__nebulaChat.pushAssistant(text), NARRATION.modelsIntro);
    await showCaption(page, NARRATION.modelsIntro);
    // Move cursor to hover over the library panel (left side of viewport)
    // so the viewer's eye is drawn to the model list while Daedalus speaks.
    const libPos = await page.evaluate(() => {
      const lib = document.querySelector('.panel--library');
      if (!lib) return { x: 158, y: 400 };
      const r = lib.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height * 0.4 };
    });
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 1100), libPos);
    await sleep(4200);

    // ============================================================
    // BEAT 6 — Tagline + final overview hold
    // ============================================================
    phases.b6_tagline = Date.now();
    log('beat-6', 'tagline + overview pullback');

    await sleep(800);
    await page.evaluate((text) => window.__nebulaChat.pushAssistant(text), NARRATION.tagline);
    await showCaption(page, NARRATION.tagline);

    // Pull camera all the way out to show the whole graph composition.
    await page.evaluate(() => {
      window.__nebulaCanvas.centerOn(-180, 130, 0.50, 1500, { x: 880, y: 540 });
    });
    await sleep(5500);
    phases.recordEnd = Date.now();

    // ----- Stop recording. -----
    const stopped = await recorder.stop();
    log('record', `${stopped.frameCount} frames, firstFrameTs=${stopped.firstFrameTs}`);
    let recordingPath = null;
    try {
      recordingPath = await recorder.mux(join(RUN_DIR, 'recording.mp4'), FPS);
      log('mux', recordingPath);
    } catch (err) {
      log('mux-error', err.message);
    }

    // Capture final panel + node bounds for derive-zoom.
    const final = await page.evaluate((nodeIds) => {
      const out = { nodes: {}, panels: {} };
      for (const id of nodeIds) {
        const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out.nodes[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
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
    }, events.map((e) => e.nodeId));
    for (const ev of events) {
      const r = final.nodes[ev.nodeId];
      if (r && r.width > 0) {
        ev.boundsAtCapture = ev.bounds;
        ev.bounds = r;
      }
    }

    // End-frame screenshot for visual verification.
    await page.screenshot({ path: join(RUN_DIR, 'end.png'), fullPage: false });

    // events.json — same shape derive-zoom expects from drive.mjs runs.
    await writeFile(
      join(RUN_DIR, 'events.json'),
      JSON.stringify(
        {
          runId,
          startedAt: new Date(phases.recordStart).toISOString(),
          endedAt: new Date(phases.recordEnd).toISOString(),
          viewport: VIEWPORT,
          url: URL,
          prompt: USER_PROMPT,
          eventCount: events.length,
          events,
          edges: edgeEvents,
          panels: final.panels,
          phases,
          // No focusTargets for now — derive-zoom can use phase + node bounds.
          focusTargets: {},
          // Anchors for derive-zoom's event-to-recording-time math. drive.mjs
          // captures perf.now()/Date.now() at MutationObserver install time;
          // we don't have an observer (events are deterministic), so we
          // synthesize equivalent anchors. event.ts is ms-from-recordStart,
          // so: eventEpochMs = recordStart + ts, eventOnRecording =
          // eventEpochMs/1000 - firstFrameTs. dateNowAtInstall=recordStart
          // and perfNowAtInstall=0 makes that math line up.
          anchors: {
            perfNowAtInstall: 0,
            dateNowAtInstall: phases.recordStart,
          },
          recording: recordingPath
            ? { path: recordingPath, frameCount: stopped.frameCount, fps: FPS, firstFrameTs: stopped.firstFrameTs }
            : null,
        },
        null,
        2,
      ),
    );
    log('events', `${events.length} nodes, ${edgeEvents.length} edges`);
    log('summary', `runDir=${RUN_DIR}`);
  } finally {
    if (!args.keepOpen) await browser.close();
  }
}

// ----- Helpers -----

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

// Override a ReactFlow node's width so its inner content (e.g. a streaming
// text-input prompt) is readable at the camera's reading distance. Default
// .model-node max-width is 240px; we bypass via inline style on both the
// react-flow wrapper and the inner .model-node so React state can't undo it.
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

// Drag-rotate the <model-viewer> inside a Meshy node so the viewer sees
// the 3D mesh from multiple angles. Uses real puppeteer mouse events;
// model-viewer's orbit-controls listens for mousedown/mousemove/mouseup
// on its element and rotates accordingly.
async function rotateMeshNode(page, nodeId) {
  const center = await page.evaluate((id) => {
    const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!wrap) return null;
    const mv = wrap.querySelector('model-viewer');
    if (!mv) return null;
    const r = mv.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  }, nodeId);
  if (!center) return;
  // Move cursor to mesh center first so the rotation has a visible anchor.
  await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 700), center);
  await new Promise((r) => setTimeout(r, 750));
  // Real mouse drag — model-viewer rotates from this. Three sweeps: right
  // → down → left so the viewer sees three sides.
  const cx = center.x;
  const cy = center.y;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Sweep right
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    await page.evaluate(({ x, y }) => window.__nebulaCursor.moveTo(x, y, 70), { x: cx + t * 80, y: cy });
    await page.mouse.move(cx + t * 80, cy);
    await new Promise((r) => setTimeout(r, 60));
  }
  // Sweep down
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const x = cx + 80;
    const y = cy + t * 50;
    await page.evaluate((p) => window.__nebulaCursor.moveTo(p.x, p.y, 70), { x, y });
    await page.mouse.move(x, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  // Sweep left back across to far-left
  for (let i = 1; i <= 16; i++) {
    const t = i / 16;
    const x = cx + 80 - t * 160;
    const y = cy + 50;
    await page.evaluate((p) => window.__nebulaCursor.moveTo(p.x, p.y, 70), { x, y });
    await page.mouse.move(x, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  await page.mouse.up();
}

// Inject a draggable thumbnail image element that follows the cursor during
// a "drag-and-drop into chat" pantomime. Image lives at fixed-position
// z-index above everything else; pointer-events:none so it doesn't block
// other interactions; transform-origin centered so its position math
// matches the cursor's center anchor.
async function injectDragThumb(page, src, x, y, sizePx = 96) {
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
    // Force reflow then fade in so the appearance is animated, not popped.
    void img.offsetWidth;
    img.style.opacity = '1';
    img.style.transform = 'scale(1)';
  }, { src, x, y, sizePx });
}

async function moveDragThumb(page, x, y, durationMs = 800) {
  await page.evaluate(({ x, y, durationMs }) => {
    const img = document.getElementById('__nebula-drag-thumb');
    if (!img) return;
    img.style.transition = `left ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1), top ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1), opacity 220ms ease, transform 220ms ease`;
    const sizePx = parseFloat(img.style.width) || 96;
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

// Persistent caption overlay — sound-off viewers see what Daedalus is
// saying. Fixed at the bottom of the viewport (screen space, survives
// camera transforms applied to the canvas frame). Background uses chat
// styling so it reads as part of the demo language even though it lives
// outside the actual app UI.
async function injectCaption(page) {
  await page.evaluate(() => {
    const cap = document.createElement('div');
    cap.id = '__nebula-caption';
    Object.assign(cap.style, {
      position: 'fixed',
      bottom: '52px',
      left: '50%',
      transform: 'translateX(-50%) translateY(20px)',
      maxWidth: '64vw',
      minWidth: '320px',
      padding: '20px 36px',
      background: 'rgba(8, 12, 18, 0.92)',
      border: '1px solid rgba(120, 200, 180, 0.22)',
      borderRadius: '14px',
      boxShadow: '0 18px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset',
      backdropFilter: 'blur(6px)',
      color: 'rgba(232, 248, 240, 0.96)',
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
      fontSize: '26px',
      lineHeight: '1.35',
      textAlign: 'center',
      letterSpacing: '0.01em',
      zIndex: '99997',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 280ms ease, transform 280ms ease',
      whiteSpace: 'pre-wrap',
    });
    cap.textContent = '';
    document.body.appendChild(cap);

    const eyebrow = document.createElement('div');
    eyebrow.id = '__nebula-caption-eyebrow';
    Object.assign(eyebrow.style, {
      fontSize: '12px',
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: 'rgba(120, 200, 180, 0.85)',
      marginBottom: '10px',
      fontWeight: '600',
    });
    eyebrow.textContent = '— Daedalus';
    cap.prepend(eyebrow);

    const body = document.createElement('div');
    body.id = '__nebula-caption-body';
    cap.appendChild(body);

    window.__nebulaCaption = {
      show: (text) => {
        body.textContent = text;
        cap.style.opacity = '1';
        cap.style.transform = 'translateX(-50%) translateY(0)';
      },
      hide: () => {
        cap.style.opacity = '0';
        cap.style.transform = 'translateX(-50%) translateY(20px)';
      },
    };
  });
}

// Captions now ride on ffmpeg drawtext in build-vo (overlay AFTER the
// camera transforms so they stay anchored to the final video bottom).
// These helpers are no-ops kept so existing call sites still work.
async function showCaption(_page, _text) {}
async function hideCaption(_page) {}

// Inject a fake Mac Finder window containing the chibi reference as a file
// thumbnail. Used as the visual source for the drag-and-drop into chat.
// Slides in from off-screen left, then becomes the cursor's pickup target.
async function injectFinder(page, imageSrc) {
  await page.evaluate(({ src }) => {
    const wrap = document.createElement('div');
    wrap.id = '__nebula-finder';
    Object.assign(wrap.style, {
      position: 'fixed',
      left: '-560px',
      top: '50%',
      transform: 'translateY(-50%)',
      width: '520px',
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
      height: '32px',
      display: 'flex',
      alignItems: 'center',
      padding: '0 14px',
      gap: '8px',
      background: 'linear-gradient(180deg, #3a3a3c 0%, #2c2c2e 100%)',
      borderBottom: '1px solid rgba(0,0,0,0.5)',
    });
    const lights = ['#ff5f57', '#febc2e', '#28c840'];
    for (const c of lights) {
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
    Object.assign(titleText.style, {
      fontSize: '13px', fontWeight: '500',
      marginLeft: '12px', color: 'rgba(255,255,255,0.85)',
    });
    titlebar.appendChild(titleText);
    wrap.appendChild(titlebar);

    const toolbar = document.createElement('div');
    Object.assign(toolbar.style, {
      height: '40px',
      display: 'flex',
      alignItems: 'center',
      padding: '0 14px',
      gap: '12px',
      background: '#262628',
      borderBottom: '1px solid rgba(0,0,0,0.45)',
      fontSize: '13px',
      color: 'rgba(255,255,255,0.55)',
    });
    toolbar.innerHTML = `
      <span style="font-size:14px;">‹</span>
      <span style="font-size:14px; color:rgba(255,255,255,0.3);">›</span>
      <span style="margin-left:14px;">Demo</span>
    `;
    wrap.appendChild(toolbar);

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      padding: '24px',
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: '20px',
      alignContent: 'start',
      background: '#1c1c1e',
    });

    const file = document.createElement('div');
    file.id = '__nebula-finder-file';
    Object.assign(file.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '8px',
      padding: '8px',
      borderRadius: '8px',
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.08)',
    });
    const fileImg = document.createElement('img');
    fileImg.src = src;
    Object.assign(fileImg.style, {
      width: '110px', height: '110px',
      objectFit: 'cover', borderRadius: '8px',
      display: 'block',
    });
    file.appendChild(fileImg);
    const fileName = document.createElement('div');
    fileName.textContent = 'chibi.png';
    Object.assign(fileName.style, {
      fontSize: '12px',
      color: 'rgba(255,255,255,0.85)',
    });
    file.appendChild(fileName);
    grid.appendChild(file);

    // Add a couple of dim placeholder file slots so the Finder doesn't read
    // as one-file-only; gives it the texture of a real folder.
    for (let i = 0; i < 2; i++) {
      const ph = document.createElement('div');
      Object.assign(ph.style, {
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
        padding: '8px', borderRadius: '8px',
        background: 'rgba(255,255,255,0.02)',
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
    f.style.left = '120px';
  });
}

// Returns the screen-space bounds of the chibi.png file thumbnail inside
// the Finder so the cursor can walk to it precisely.
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
    f.style.left = '-560px';
    setTimeout(() => f.remove(), 720);
  });
}

async function injectCursor(page) {
  // Same SVG pointer + ripple as drive.mjs. Pointer-events:none, top z-index.
  await page.evaluate(({ vw, vh }) => {
    const cursor = document.createElement('div');
    cursor.id = '__nebula-cursor';
    cursor.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 3 L5 23 L11 18 L13.5 24 L16 23 L13.5 17 L21 17 Z"
              fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>`;
    Object.assign(cursor.style, {
      position: 'fixed', top: '0', left: '0',
      width: '32px', height: '32px', pointerEvents: 'none', zIndex: '99999',
      transform: `translate(${vw / 2 - 5}px, ${vh / 2 - 3}px)`,
      transition: 'transform 1.2s cubic-bezier(0.4, 0, 0.2, 1)',
      willChange: 'transform',
      filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.55))',
    });
    document.body.appendChild(cursor);

    const ripple = document.createElement('div');
    ripple.id = '__nebula-cursor-ripple';
    Object.assign(ripple.style, {
      position: 'fixed', top: '0', left: '0',
      width: '36px', height: '36px', pointerEvents: 'none', zIndex: '99998',
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.85)',
      boxSizing: 'border-box',
      opacity: '0',
      transform: 'translate(-9999px, -9999px) scale(0.3)',
    });
    document.body.appendChild(ripple);

    let cx = vw / 2, cy = vh / 2;
    window.__nebulaCursor = {
      moveTo: (tx, ty, durationMs = 1200) => {
        cx = tx; cy = ty;
        cursor.style.transition = `transform ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
        cursor.style.transform = `translate(${tx - 5}px, ${ty - 3}px)`;
      },
      click: () => {
        const t = cursor.style.transform;
        cursor.style.transition = 'transform 120ms ease-out';
        cursor.style.transform = `${t} scale(0.85)`;
        setTimeout(() => { cursor.style.transform = t; }, 130);
        ripple.style.transition = 'none';
        ripple.style.opacity = '0.9';
        ripple.style.transform = `translate(${cx - 18}px, ${cy - 18}px) scale(0.3)`;
        void ripple.offsetWidth;
        ripple.style.transition = 'transform 520ms ease-out, opacity 520ms ease-out';
        ripple.style.transform = `translate(${cx - 18}px, ${cy - 18}px) scale(2.6)`;
        ripple.style.opacity = '0';
      },
    };
  }, { vw: VIEWPORT.width, vh: VIEWPORT.height });
}

// ----- Recorder (CDP screencast) — copied from drive.mjs to avoid coupling. -----
class Recorder {
  static async start(page, runDir, { quality, viewport }) {
    const framesDir = join(runDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    const client = await page.createCDPSession();
    const recorder = new Recorder(client, framesDir, viewport);
    client.on('Page.screencastFrame', (params) => recorder._onFrame(params));
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      everyNthFrame: 1,
    });
    return recorder;
  }

  constructor(client, framesDir, viewport) {
    this.client = client;
    this.framesDir = framesDir;
    this.viewport = viewport;
    this.frames = [];
    this.pending = [];
    this.stopped = false;
  }

  _onFrame(params) {
    if (this.stopped) return;
    const idx = this.frames.length;
    const filename = `frame-${String(idx).padStart(6, '0')}.jpg`;
    const path = join(this.framesDir, filename);
    const ts = params.metadata?.timestamp ?? null;
    this.frames.push({ path, filename, ts });
    const buf = Buffer.from(params.data, 'base64');
    const write = writeFile(path, buf).catch(() => {});
    this.pending.push(write);
    this.client.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  }

  async stop() {
    this.stopped = true;
    try { await this.client.send('Page.stopScreencast'); } catch {}
    await Promise.all(this.pending);
    return {
      frameCount: this.frames.length,
      firstFrameTs: this.frames[0]?.ts ?? null,
    };
  }

  async mux(outPath, fallbackFps) {
    if (this.frames.length < 2) {
      throw new Error(`not enough frames to mux (${this.frames.length})`);
    }
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const next = this.frames[i + 1];
      lines.push(`file '${f.filename}'`);
      const dur = next && f.ts != null && next.ts != null
        ? Math.max(0.001, next.ts - f.ts)
        : 1 / fallbackFps;
      lines.push(`duration ${dur.toFixed(4)}`);
    }
    lines.push(`file '${this.frames[this.frames.length - 1].filename}'`);
    const playlistPath = join(this.framesDir, 'frames.txt');
    await writeFile(playlistPath, lines.join('\n') + '\n');
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', playlistPath,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-vf', `scale=${this.viewport.width}:${this.viewport.height}:force_original_aspect_ratio=decrease,pad=${this.viewport.width}:${this.viewport.height}:(ow-iw)/2:(oh-ih)/2:black`,
        '-preset', 'fast',
        '-crf', '20',
        outPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) resolve(outPath);
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
      });
    });
  }
}

// ----- Misc -----

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${tag.padEnd(10)} ${msg}`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
