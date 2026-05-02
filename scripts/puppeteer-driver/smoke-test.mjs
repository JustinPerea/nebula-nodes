// Smoke test for the deterministic-build primitives.
//
// Verifies three things before we invest in the full scripted-build orchestrator:
//   1. POST /api/uploads with create_node=true atomically spawns an image-input
//      node whose preview renders the uploaded file.
//   2. addNode + onConnect creates a cli-origin node + edge that survives
//      graphSync (so handles + IDs are real, not optimistic UUIDs).
//   3. updateNodeData({ outputs: { image: { type:'Image', value:'...' }}, state:'complete' })
//      makes a generation node show its output preview without an actual run.
//
// Saves screenshots and logs full state at each step. Run while dev server +
// backend are up:
//   node scripts/puppeteer-driver/smoke-test.mjs
//
// Use --headless true to skip the visible browser window.

import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const URL = 'http://localhost:5173';
const VIEWPORT = { width: 1920, height: 1080 };
const OUT_DIR = join(REPO_ROOT, 'output', 'puppeteer-driver', 'smoke-test');
const DEMO_IMAGE_PATH = join(REPO_ROOT, 'frontend', 'public', 'demo', 'clay_daedalus.png');

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

  const findings = { test1: null, test2: null, test3: null, test4: null };

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('console', (msg) => {
      const txt = msg.text();
      // Filter the firehose; keep our smoke logs and any warnings/errors.
      if (txt.includes('[smoke]') || msg.type() === 'error' || msg.type() === 'warn') {
        log('page', `[${msg.type()}] ${txt}`);
      }
    });
    page.on('pageerror', (err) => log('pageerror', err.message));

    log('nav', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-panel', { timeout: 10000 });
    await page.waitForFunction(() => !!window.__nebulaGraphStore, { timeout: 5000 });

    // Clear backend + frontend graph so we start clean.
    log('clear', 'wiping cli_graph + frontend');
    await page.evaluate(async () => {
      try {
        await fetch('http://localhost:8000/api/graph', { method: 'DELETE' });
      } catch (e) { console.warn('[smoke] backend clear failed', String(e)); }
      window.__nebulaGraphStore.getState().clearGraph();
    });
    await sleep(800);

    // ------------------------------------------------------------
    // Test 1: upload + auto-create image-input node
    // ------------------------------------------------------------
    log('test-1', 'POST /api/uploads (create_node=true)');
    const fileBuffer = await readFile(DEMO_IMAGE_PATH);
    const uploadResp = await page.evaluate(async (fileBytes) => {
      const blob = new Blob([new Uint8Array(fileBytes)], { type: 'image/png' });
      const fd = new FormData();
      fd.append('file', blob, 'clay_daedalus.png');
      fd.append('create_node', 'true');
      const r = await fetch('http://localhost:8000/api/uploads', { method: 'POST', body: fd });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { ok: r.ok, status: r.status, body };
    }, Array.from(fileBuffer));
    log('test-1', `upload response: ${JSON.stringify(uploadResp).slice(0, 500)}`);

    // graphSync round-trip — wait for the WS push to land in the store.
    await sleep(1500);
    const test1State = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      return {
        nodes: s.nodes.map((n) => ({
          id: n.id,
          definitionId: n.data.definitionId,
          label: n.data.label,
          params: n.data.params,
          state: n.data.state,
        })),
        edges: s.edges.length,
      };
    });
    log('test-1', `store: ${JSON.stringify(test1State)}`);
    await page.screenshot({ path: join(OUT_DIR, '1-after-upload.png') });

    findings.test1 = {
      uploadOk: uploadResp.ok,
      nodeCreated: test1State.nodes.length === 1
        && test1State.nodes[0].definitionId === 'image-input',
      filePathSet: !!test1State.nodes[0]?.params?.filePath,
      previewUrlSet: !!test1State.nodes[0]?.params?._previewUrl,
      nodeId: test1State.nodes[0]?.id ?? null,
    };
    log('test-1', `findings: ${JSON.stringify(findings.test1)}`);

    // ------------------------------------------------------------
    // Test 2: addNode + onConnect chain
    // ------------------------------------------------------------
    log('test-2', 'addNode(gpt-image-2-edit) + onConnect from image-input');
    const imageNodeId = findings.test1.nodeId;
    const editNodeId = await page.evaluate(async () => {
      // gpt-image-2-edit takes 'images' (multiple) input. Returns short id (n2).
      const id = await window.__nebulaGraphStore.getState().addNode('gpt-image-2-edit', { x: 400, y: 0 });
      console.log('[smoke] addNode → ' + id);
      return id;
    });
    log('test-2', `addNode returned: ${editNodeId}`);
    await sleep(1200);

    let connectErr = null;
    if (imageNodeId && editNodeId) {
      connectErr = await page.evaluate(({ src, tgt }) => {
        try {
          window.__nebulaGraphStore.getState().onConnect({
            source: src,
            sourceHandle: 'image',
            target: tgt,
            targetHandle: 'images',
          });
          return null;
        } catch (e) {
          return String(e);
        }
      }, { src: imageNodeId, tgt: editNodeId });
    }
    log('test-2', `connect error: ${connectErr ?? '(none)'}`);
    await sleep(1200);

    const test2State = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      return {
        nodeCount: s.nodes.length,
        nodes: s.nodes.map((n) => ({ id: n.id, definitionId: n.data.definitionId })),
        edges: s.edges.map((e) => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle,
          target: e.target,
          targetHandle: e.targetHandle,
        })),
      };
    });
    log('test-2', `store: ${JSON.stringify(test2State)}`);
    await page.screenshot({ path: join(OUT_DIR, '2-after-connect.png') });

    findings.test2 = {
      editNodeAdded: test2State.nodeCount === 2,
      editNodeId,
      edgeCount: test2State.edges.length,
      edgeSurvivedSync: test2State.edges.some(
        (e) => e.source === imageNodeId && e.target === editNodeId,
      ),
    };
    log('test-2', `findings: ${JSON.stringify(findings.test2)}`);

    // ------------------------------------------------------------
    // Test 3: inject Image output preview via updateNodeData
    // ------------------------------------------------------------
    log('test-3', 'updateNodeData with synthetic Image output');
    if (editNodeId) {
      // Use the demo image as the fake "generated" output. /demo/clay_daedalus.png
      // is served by Vite. Absolute http:// URLs would also work (graphStore
      // passes them through unchanged when state syncs from execution events,
      // but we're calling updateNodeData directly so the value is rendered as-is).
      await page.evaluate((id) => {
        window.__nebulaGraphStore.getState().updateNodeData(id, {
          state: 'complete',
          outputs: {
            image: {
              type: 'Image',
              value: '/demo/clay_daedalus.png',
            },
          },
        });
        console.log('[smoke] outputs injected on ' + id);
      }, editNodeId);
      await sleep(1500);
    }
    await page.screenshot({ path: join(OUT_DIR, '3-after-output.png') });

    const test3State = await page.evaluate((id) => {
      const node = window.__nebulaGraphStore.getState().nodes.find((n) => n.id === id);
      const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      const imgs = el ? Array.from(el.querySelectorAll('img')).map((i) => ({
        src: i.src,
        complete: i.complete,
        naturalW: i.naturalWidth,
      })) : [];
      return {
        state: node?.data.state,
        outputs: node?.data.outputs,
        renderedImageCount: imgs.length,
        renderedImages: imgs,
      };
    }, editNodeId);
    log('test-3', `store+DOM: ${JSON.stringify(test3State).slice(0, 600)}`);

    findings.test3 = {
      stateUpdatedToComplete: test3State.state === 'complete',
      outputsRecorded: !!test3State.outputs?.image?.value,
      previewImageRendered: test3State.renderedImageCount > 0
        && test3State.renderedImages.some((i) => i.complete && i.naturalW > 0),
    };
    log('test-3', `findings: ${JSON.stringify(findings.test3)}`);

    // ------------------------------------------------------------
    // Test 4: __nebulaChat bridge (user, assistant, append, end, clear)
    // ------------------------------------------------------------
    log('test-4', '__nebulaChat bridge: push/append/end/clear');
    // Wait for bridge install — it sits inside ChatPanel's mount-effect.
    await page.waitForFunction(() => !!window.__nebulaChat, { timeout: 5000 });

    const bridgeState = await page.evaluate(async () => {
      const chat = window.__nebulaChat;
      const ids = {};
      ids.user = chat.pushUser('make me a daedalus toy');
      // Simulate streamed assistant narration: push empty bubble in streaming
      // state, append two chunks, then end.
      ids.asst1 = chat.pushAssistant('', { streaming: true });
      chat.appendAssistant(ids.asst1, 'Reading your reference...');
      await new Promise((r) => setTimeout(r, 120));
      chat.appendAssistant(ids.asst1, ' I see soft cream tones, a chibi sculpt, gold accents.');
      chat.endAssistant(ids.asst1);
      // Second bubble: full text in one shot, not streaming.
      ids.asst2 = chat.pushAssistant("Let me try variation one.", { streaming: false });
      // Thinking bubble (collapsed-progress UI element).
      ids.think = chat.pushThinking(['Surveying palette', 'Considering proportions']);
      chat.appendThinkingLine(ids.think, 'Drafting prompt');
      chat.endThinking(ids.think);
      return ids;
    });
    log('test-4', `pushed ids: ${JSON.stringify(bridgeState)}`);
    await sleep(400);
    await page.screenshot({ path: join(OUT_DIR, '4-after-chat.png') });

    const test4State = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('.chat__bubble')).map((b) => ({
        cls: b.className,
        text: (b.textContent || '').slice(0, 120),
      }));
      // Read DOM only — we don't have Zustand for chat state; visual presence
      // of bubbles is the real PASS criterion.
      const userBubbles = bubbles.filter((b) => b.cls.includes('chat__bubble--user')).length;
      const asstBubbles = bubbles.filter((b) => b.cls.includes('chat__bubble--assistant')).length;
      return { bubbleCount: bubbles.length, userBubbles, asstBubbles, sample: bubbles };
    });
    log('test-4', `DOM bubbles: ${JSON.stringify(test4State).slice(0, 600)}`);

    findings.test4 = {
      bridgeInstalled: !!bridgeState.user,
      userBubbleRendered: test4State.userBubbles >= 1,
      assistantBubblesRendered: test4State.asstBubbles >= 2,
      // Verify the appended text actually shows in the first assistant bubble.
      streamedTextVisible: test4State.sample.some(
        (b) => b.cls.includes('assistant') && b.text.includes('chibi sculpt'),
      ),
    };
    log('test-4', `findings: ${JSON.stringify(findings.test4)}`);

    // Verify clear() empties the panel.
    await page.evaluate(() => window.__nebulaChat.clear());
    await sleep(200);
    const afterClear = await page.evaluate(
      () => document.querySelectorAll('.chat__bubble').length,
    );
    findings.test4.clearWorks = afterClear === 0;
    log('test-4', `bubble count after clear(): ${afterClear}`);

    // ------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------
    log('summary', '');
    const pass = (cond) => (cond ? 'PASS' : 'FAIL');
    log('summary', `Test 1 (upload + auto-create image-input):`);
    log('summary', `  upload OK:           ${pass(findings.test1.uploadOk)}`);
    log('summary', `  node created:        ${pass(findings.test1.nodeCreated)}`);
    log('summary', `  filePath set:        ${pass(findings.test1.filePathSet)}`);
    log('summary', `  _previewUrl set:     ${pass(findings.test1.previewUrlSet)}`);
    log('summary', `Test 2 (addNode + onConnect):`);
    log('summary', `  edit node added:     ${pass(findings.test2.editNodeAdded)}`);
    log('summary', `  edge present:        ${pass(findings.test2.edgeSurvivedSync)} (count=${findings.test2.edgeCount})`);
    log('summary', `Test 3 (output preview injection):`);
    log('summary', `  state→complete:      ${pass(findings.test3.stateUpdatedToComplete)}`);
    log('summary', `  outputs recorded:    ${pass(findings.test3.outputsRecorded)}`);
    log('summary', `  image rendered:      ${pass(findings.test3.previewImageRendered)}`);
    log('summary', `Test 4 (__nebulaChat bridge):`);
    log('summary', `  bridge installed:    ${pass(findings.test4.bridgeInstalled)}`);
    log('summary', `  user bubble:         ${pass(findings.test4.userBubbleRendered)}`);
    log('summary', `  assistant bubbles:   ${pass(findings.test4.assistantBubblesRendered)}`);
    log('summary', `  streamed text shown: ${pass(findings.test4.streamedTextVisible)}`);
    log('summary', `  clear() empties UI:  ${pass(findings.test4.clearWorks)}`);
    log('summary', `screenshots → ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

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
