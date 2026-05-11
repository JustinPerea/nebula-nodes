import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'utility-node-test-manifest.json');
const NODE_DEFS_PATH = join(REPO_ROOT, 'backend', 'data', 'node_definitions.json');
const URL = process.env.UTILITY_CHECK_URL ?? 'http://127.0.0.1:5173/';
const BACKEND_URL = process.env.UTILITY_CHECK_BACKEND_URL ?? 'http://127.0.0.1:8000/api/graph/export';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH to run utility node checks.`);
  process.exit(1);
}

await assertManifestCoverage();
await assertReachable(URL, 'frontend dev server');
await assertReachable(BACKEND_URL, 'backend server');

const remotePort = 9800 + Math.floor(Math.random() * 400);
const userDataDir = join('/tmp', `nebula-utility-node-check-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${remotePort}`,
  `--user-data-dir=${userDataDir}`,
  URL,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

chrome.stderr.on('data', (chunk) => {
  if (process.env.UTILITY_CHECK_DEBUG === '1') process.stderr.write(String(chunk));
});

let cdp;

try {
  const pageWs = await waitForPageWebSocket(remotePort);
  cdp = await connectCdp(pageWs);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const loadEvent = cdp.waitForEvent('Page.loadEventFired', 10000).catch(() => null);
  await cdp.send('Page.navigate', { url: URL });
  await loadEvent;
  await waitForRuntime(cdp, 'window.__nebulaUIStore && window.__nebulaGraphStore');

  await runPureUtilityExecutionCheck(cdp);
  await runMockedGeminiEmbeddingCheck(cdp);

  console.log('Utility node browser smoke check passed.');
} finally {
  cdp?.close();
  if (chrome.exitCode === null) chrome.kill('SIGTERM');
  await waitForExit(chrome, 1500).catch(() => {
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  });
  await rm(userDataDir, { recursive: true, force: true });
}

async function assertManifestCoverage() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const definitions = JSON.parse(await readFile(NODE_DEFS_PATH, 'utf8'));
  const manifestIds = manifest.nodes.map((node) => node.id).sort();
  const utilityIds = Object.entries(definitions)
    .filter(([, definition]) => definition.category === 'utility')
    .map(([id]) => id)
    .sort();
  const missing = utilityIds.filter((id) => !manifestIds.includes(id));
  const extra = manifestIds.filter((id) => !utilityIds.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`Utility manifest mismatch. Missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`);
  }

  const missingBrowser = manifest.nodes.filter((node) => !node.browser).map((node) => node.id);
  if (missingBrowser.length) {
    throw new Error(`Utility manifest nodes missing browser scenario: ${missingBrowser.join(', ')}`);
  }
}

async function assertReachable(url, label) {
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  } catch (err) {
    throw new Error(`Could not reach ${label} at ${url}: ${err.message}`);
  }
}

async function runPureUtilityExecutionCheck(cdp) {
  await evaluate(cdp, async () => {
    const graph = window.__nebulaGraphStore;
    const ui = window.__nebulaUIStore;
    ui.getState().setSkin('slava-restraint');
    ui.setState((state) => ({
      selectedNodeId: null,
      panels: {
        ...state.panels,
        library: { ...state.panels.library, visible: false },
        settings: { ...state.panels.settings, visible: false },
        chat: { ...state.panels.chat, visible: false },
        inspector: { ...state.panels.inspector, visible: false },
      },
    }));

    const labels = {
      'text-input': 'Text Input',
      'image-input': 'Image Input',
      'video-input': 'Video Input',
      'audio-input': 'Audio Input',
      'sticky-note': 'Sticky Note',
      'combine-text': 'Combine Text',
      router: 'Router',
      reroute: 'Reroute',
      preview: 'Preview',
      'array-builder': 'Array Builder',
      'array-selector': 'Array Selector',
      'image-compare': 'Image Compare',
      'iterator-image': 'Image Iterator',
      'iterator-text': 'Text Iterator',
    };
    const makeNode = (id, definitionId, params, index) => ({
      id,
      type: definitionId === 'reroute' ? 'reroute-node' : 'model-node',
      position: { x: 120 + (index % 5) * 260, y: 120 + Math.floor(index / 5) * 210 },
      data: {
        label: labels[definitionId] ?? definitionId,
        definitionId,
        params: params ?? {},
        state: 'idle',
        outputs: {},
      },
    });
    const edge = (source, sourceHandle, target, targetHandle) => ({
      id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
      source,
      sourceHandle,
      target,
      targetHandle,
      type: 'typed-edge',
      data: { dataType: 'Any' },
    });

    const nodes = [
      makeNode('util-text-a', 'text-input', { value: 'Alpha' }, 0),
      makeNode('util-text-b', 'text-input', { value: 'Beta' }, 1),
      makeNode('util-image-a', 'image-input', { filePath: '/tmp/image-a.png' }, 2),
      makeNode('util-image-b', 'image-input', { filePath: '/tmp/image-b.png' }, 3),
      makeNode('util-video', 'video-input', { filePath: '/tmp/source.mp4' }, 4),
      makeNode('util-audio', 'audio-input', { filePath: '/tmp/source.wav' }, 5),
      makeNode('util-note', 'sticky-note', { content: 'Note', color: 'grey' }, 6),
      makeNode('util-combine', 'combine-text', { separator: ' | ', template: '' }, 7),
      makeNode('util-router', 'router', {}, 8),
      makeNode('util-reroute', 'reroute', {}, 9),
      makeNode('util-preview', 'preview', {}, 10),
      makeNode('util-text-array', 'array-builder', {}, 11),
      makeNode('util-image-array', 'array-builder', {}, 12),
      makeNode('util-selector', 'array-selector', { mode: 'index', index: 1 }, 13),
      makeNode('util-text-iterator', 'iterator-text', { batch_size_cap: 10 }, 14),
      makeNode('util-image-iterator', 'iterator-image', { batch_size_cap: 10 }, 15),
      makeNode('util-compare', 'image-compare', {}, 16),
    ];
    const edges = [
      edge('util-text-a', 'text', 'util-combine', 'text1'),
      edge('util-text-b', 'text', 'util-combine', 'text2'),
      edge('util-text-a', 'text', 'util-router', 'input'),
      edge('util-router', 'out1', 'util-reroute', 'input'),
      edge('util-reroute', 'output', 'util-preview', 'input'),
      edge('util-text-a', 'text', 'util-text-array', 'item1'),
      edge('util-text-b', 'text', 'util-text-array', 'item2'),
      edge('util-image-a', 'image', 'util-image-array', 'item1'),
      edge('util-image-b', 'image', 'util-image-array', 'item2'),
      edge('util-text-array', 'array', 'util-selector', 'array'),
      edge('util-text-array', 'array', 'util-text-iterator', 'array'),
      edge('util-image-array', 'array', 'util-image-iterator', 'array'),
      edge('util-image-a', 'image', 'util-compare', 'imageA'),
      edge('util-image-b', 'image', 'util-compare', 'imageB'),
    ];

    graph.setState({
      nodes,
      edges,
      isExecuting: true,
      undoStack: [],
      redoStack: [],
      backendFreshStartPending: false,
    });

    const response = await fetch('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: nodes.map((node) => ({
          id: node.id,
          definitionId: node.data.definitionId,
          params: node.data.params,
          outputs: {},
        })),
        edges: edges.map((item) => ({
          id: item.id,
          source: item.source,
          sourceHandle: item.sourceHandle,
          target: item.target,
          targetHandle: item.targetHandle,
        })),
      }),
    });
    if (!response.ok) throw new Error(`execute failed: ${response.status}`);
    const result = await response.json();
    if (result.status !== 'started') throw new Error(`execute returned ${result.status}`);
  });

  await waitForRuntime(cdp, `
    (() => {
      const state = window.__nebulaGraphStore.getState();
      const byId = Object.fromEntries(state.nodes.map((node) => [node.id, node]));
      return state.isExecuting === false
        && byId['util-preview']?.data.state === 'complete'
        && byId['util-selector']?.data.state === 'complete'
        && byId['util-image-iterator']?.data.state === 'complete'
        && byId['util-compare']?.data.state === 'complete';
    })()
  `, 10000);

  const assertions = await evaluate(cdp, () => {
    const nodes = window.__nebulaGraphStore.getState().nodes;
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const output = (id, key) => byId[id]?.data.outputs?.[key]?.value;
    return {
      renderedNodes: document.querySelectorAll('.react-flow__node').length,
      textInput: output('util-text-a', 'text'),
      imageInput: output('util-image-a', 'image'),
      videoInput: output('util-video', 'video'),
      audioInput: output('util-audio', 'audio'),
      stickyState: byId['util-note']?.data.state,
      combine: output('util-combine', 'text'),
      routerOut2: output('util-router', 'out2'),
      reroute: output('util-reroute', 'output'),
      preview: output('util-preview', 'input'),
      textArray: output('util-text-array', 'array'),
      imageArray: output('util-image-array', 'array'),
      selector: output('util-selector', 'item'),
      textIterator: output('util-text-iterator', 'text'),
      imageIterator: output('util-image-iterator', 'image'),
      compareA: output('util-compare', 'imageA'),
      compareB: output('util-compare', 'imageB'),
      errors: nodes.filter((node) => node.data.state === 'error').map((node) => [node.id, node.data.error]),
    };
  });

  assertEqual(assertions.renderedNodes, 17, 'renders seeded utility nodes');
  assertEqual(assertions.textInput, 'Alpha', 'text input output');
  assertEqual(assertions.imageInput, '/tmp/image-a.png', 'image input output');
  assertEqual(assertions.videoInput, '/tmp/source.mp4', 'video input output');
  assertEqual(assertions.audioInput, '/tmp/source.wav', 'audio input output');
  assertEqual(assertions.stickyState, 'complete', 'sticky note completes');
  assertEqual(assertions.combine, 'Alpha | Beta', 'combine text output');
  assertEqual(assertions.routerOut2, 'Alpha', 'router output');
  assertEqual(assertions.reroute, 'Alpha', 'reroute output');
  assertEqual(assertions.preview, 'Alpha', 'preview output');
  assertArrayEqual(assertions.textArray, ['Alpha', 'Beta'], 'text array output');
  assertArrayEqual(assertions.imageArray, ['/tmp/image-a.png', '/tmp/image-b.png'], 'image array output');
  assertEqual(assertions.selector, 'Beta', 'array selector output');
  assertEqual(assertions.textIterator, 'Beta', 'text iterator latest output');
  assertEqual(assertions.imageIterator, '/tmp/image-b.png', 'image iterator latest output');
  assertEqual(assertions.compareA, '/tmp/image-a.png', 'image compare A output');
  assertEqual(assertions.compareB, '/tmp/image-b.png', 'image compare B output');
  if (assertions.errors.length) {
    throw new Error(`Utility graph had errored nodes: ${JSON.stringify(assertions.errors)}`);
  }
}

async function runMockedGeminiEmbeddingCheck(cdp) {
  await evaluate(cdp, () => {
    const graph = window.__nebulaGraphStore;
    graph.setState({
      nodes: [{
        id: 'util-gemini-embeddings',
        type: 'model-node',
        position: { x: 120, y: 120 },
        data: {
          label: 'Gemini Embeddings',
          definitionId: 'gemini-embeddings',
          params: { model: 'gemini-embedding-001' },
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
      isExecuting: true,
      undoStack: [],
      redoStack: [],
      backendFreshStartPending: false,
    });

    const handle = graph.getState().handleExecutionEvent;
    handle({ type: 'queued', nodeId: 'util-gemini-embeddings' });
    handle({ type: 'executing', nodeId: 'util-gemini-embeddings' });
    handle({
      type: 'executed',
      nodeId: 'util-gemini-embeddings',
      outputs: {
        embedding: { type: 'Text', value: '[0.1,0.2,0.3]' },
        dimensions: { type: 'Text', value: '3' },
      },
    });
    handle({ type: 'graphComplete', duration: 0.01, nodesExecuted: 1 });
  });

  const assertions = await evaluate(cdp, () => {
    const node = window.__nebulaGraphStore.getState().nodes.find((item) => item.id === 'util-gemini-embeddings');
    return {
      state: node?.data.state,
      embedding: node?.data.outputs.embedding?.value,
      dimensions: node?.data.outputs.dimensions?.value,
      rendered: !!document.querySelector('[data-id="util-gemini-embeddings"]'),
    };
  });
  assertEqual(assertions.state, 'complete', 'mocked Gemini Embeddings completes');
  assertEqual(assertions.embedding, '[0.1,0.2,0.3]', 'mocked Gemini Embeddings output');
  assertEqual(assertions.dimensions, '3', 'mocked Gemini Embeddings dimensions');
  assertEqual(assertions.rendered, true, 'mocked Gemini Embeddings renders');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function evaluate(cdp, fn, ...args) {
  const source = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : String(fn);
  const result = await cdp.send('Runtime.evaluate', {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitForRuntime(cdp, expression, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await evaluate(cdp, `Boolean(${expression})`).catch(() => false);
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function waitForPageWebSocket(remotePort, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const pages = await fetch(`http://127.0.0.1:${remotePort}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chrome DevTools endpoint');
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  let opened = false;
  const pending = new Map();
  const events = new Map();

  function rejectAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();

    for (const waiters of events.values()) {
      for (const { reject, timer } of waiters) {
        clearTimeout(timer);
        reject(error);
      }
    }
    events.clear();
  }

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result ?? {});
      return;
    }
    if (msg.method && events.has(msg.method)) {
      for (const { resolve, timer } of events.get(msg.method)) {
        clearTimeout(timer);
        resolve(msg.params ?? {});
      }
      events.delete(msg.method);
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      opened = true;
      resolve({
        send(method, params = {}, timeout = 30000) {
          const callId = ++id;
          ws.send(JSON.stringify({ id: callId, method, params }));
          return new Promise((callResolve, callReject) => {
            const timer = setTimeout(() => {
              pending.delete(callId);
              callReject(new Error(`Timed out waiting for CDP command ${method}`));
            }, timeout);
            pending.set(callId, { resolve: callResolve, reject: callReject, timer });
          });
        },
        waitForEvent(method, timeout = 10000) {
          return new Promise((eventResolve, eventReject) => {
            const timer = setTimeout(() => eventReject(new Error(`Timed out waiting for ${method}`)), timeout);
            const wrapped = (params) => {
              clearTimeout(timer);
              eventResolve(params);
            };
            events.set(method, [...(events.get(method) ?? []), { resolve: wrapped, reject: eventReject, timer }]);
          });
        },
        close() {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        },
      });
    });
    ws.addEventListener('error', () => {
      const error = new Error('CDP WebSocket error');
      if (!opened) reject(error);
      rejectAll(error);
    });
    ws.addEventListener('close', () => {
      const error = new Error('CDP WebSocket closed');
      if (!opened) reject(error);
      rejectAll(error);
    });
  });
}

function waitForExit(child, timeout) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for process exit'));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      child.off('exit', onExit);
    }
    function onExit() {
      cleanup();
      resolve();
    }
    child.on('exit', onExit);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
