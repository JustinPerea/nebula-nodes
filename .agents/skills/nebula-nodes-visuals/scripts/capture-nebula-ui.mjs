// Recapture chat + wiring states via the repo's Puppeteer.
// Drives the live Nebula app stores and screenshots deterministic states at 1920x1080.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../scripts/puppeteer-driver/package.json', import.meta.url));
const puppeteer = require('puppeteer');
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = process.env.NEBULA_URL ?? 'http://localhost:5188';
const OUT = join(__dirname, 'assets', 'real-ui');
const VP = { width: 1920, height: 1080 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N1 = { id: 'n1', type: 'model-node', position: { x: 380, y: 420 }, data: { label: 'Product brief', definitionId: 'text-input', params: { value: 'Premium product shot, soft studio light, three angles' }, state: 'complete', outputs: { text: { type: 'Text', value: 'Premium product shot, soft studio light, three angles' } } } };
const N2 = { id: 'n2', type: 'model-node', position: { x: 860, y: 280 }, data: { label: 'Hero shot', definitionId: 'gpt-image-2-generate', params: { size: '1024x1024' }, state: 'idle', outputs: {} } };
const N3 = { id: 'n3', type: 'model-node', position: { x: 860, y: 600 }, data: { label: 'Detail shot', definitionId: 'gpt-image-2-generate', params: { size: '1024x1024' }, state: 'idle', outputs: {} } };
const E1 = { id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt', type: 'typed-edge', data: { dataType: 'Text' } };
const E2 = { id: 'e2', source: 'n1', sourceHandle: 'text', target: 'n3', targetHandle: 'prompt', type: 'typed-edge', data: { dataType: 'Text' } };

const L1 = "Here's the plan:";
const L2 = 'Product brief feeds Hero shot and Detail shot.';
const L3 = 'One prompt, two variants — wiring now.';
const FULL = [L1, L2, L3].join('\n'); // chat bubbles are white-space:pre-wrap → real line breaks in ONE bubble

async function main() {
  const browser = await puppeteer.launch({ headless: true, defaultViewport: VP, protocolTimeout: 120000, args: ['--window-size=1920,1080', '--use-gl=swiftshader', '--no-sandbox', '--disable-gpu-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VP);

  let ready = false;
  for (let i = 0; i < 5 && !ready; i++) {
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction(() => window.__nebulaUIStore && window.__nebulaGraphStore && window.__nebulaChat, { timeout: 12000 });
      await sleep(1200);
      ready = await page.evaluate(() => !!window.__nebulaChat).catch(() => false);
    } catch (e) { console.log('load attempt', i, e.message); }
  }
  if (!ready) throw new Error('Nebula stores never appeared');

  await page.evaluate(() => {
    window.__nebulaUIStore.getState().setSkin('slava-restraint');
    let s = document.getElementById('capture-clean');
    if (!s) { s = document.createElement('style'); s.id = 'capture-clean'; document.head.appendChild(s); }
    s.textContent = '.panel--moodboard-library,.panel--character-library{display:none !important;}';
  });
  await page.evaluate(() => {
    window.__nebulaUIStore.setState((st) => ({ chatResized: true, selectedNodeId: null, panels: { ...st.panels, chat: { ...st.panels.chat, visible: true, width: 700, height: 540, left: 610, top: 250 }, library: { ...st.panels.library, visible: false }, inspector: { ...st.panels.inspector, visible: false }, settings: { ...st.panels.settings, visible: false } } }));
  });
  await sleep(400);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.chat-panel button')).find((x) => x.textContent.trim() === 'Codex'); if (b && !/--active/.test(b.className)) b.click(); });
  await sleep(600);
  await page.evaluate(() => window.__nebulaGraphStore.setState({ nodes: [], edges: [], isExecuting: false }));

  const reply = (text, streaming) => page.evaluate(({ text, streaming }) => {
    const c = window.__nebulaChat; c.clear(); c.setInput(''); c.setBusy(false);
    c.pushUser('Build a product-shot generator with prompt variants');
    c.pushAssistant(text, { streaming });
  }, { text, streaming });

  // ---- centered chat: ONE bubble, typed out line by line (streaming cursor) ----
  await reply(L1, true); await sleep(400); await page.screenshot({ path: join(OUT, 'chatp-1.png') });
  await reply([L1, L2].join('\n'), true); await sleep(400); await page.screenshot({ path: join(OUT, 'chatp-2.png') });
  await reply(FULL, false); await sleep(400); await page.screenshot({ path: join(OUT, 'chatp-3.png') });

  // ---- docked chat (full reply) + node-by-node wiring ----
  await page.evaluate(() => window.__nebulaUIStore.setState((st) => ({ panels: { ...st.panels, chat: { ...st.panels.chat, width: 340, height: 600, left: 1545, top: 100 } } })));
  await reply(FULL, false);
  await sleep(400);

  const wire = async (name, nodes, edges) => {
    await page.evaluate(({ nodes, edges }) => { window.__nebulaGraphStore.setState({ nodes, edges, isExecuting: false }); window.__nebulaCanvas.setViewport({ x: 40, y: 0, zoom: 1.05 }); }, { nodes, edges });
    await sleep(450);
    await page.screenshot({ path: join(OUT, name) });
  };
  await wire('nw-1.png', [N1], []);                 // node 1
  await wire('nw-2.png', [N1, N2], []);             // node 2
  await wire('nw-3.png', [N1, N2], [E1]);           // wire 1-2
  await wire('nw-4.png', [N1, N2, N3], [E1]);       // node 3
  await wire('nw-5.png', [N1, N2, N3], [E1, E2]);   // wire 1-3

  await browser.close();
  console.log('captured: chatp-1..3, nw-1..5');
}
main().catch((e) => { console.error(e); process.exit(1); });
