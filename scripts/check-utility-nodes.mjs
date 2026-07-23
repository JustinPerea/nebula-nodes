import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'utility-node-test-manifest.json');
const NODE_DEFS_PATH = join(REPO_ROOT, 'backend', 'data', 'node_definitions.json');
const UTILITY_IMAGE_A = join(REPO_ROOT, 'docs', 'assets', 'helix-mark-paper.png');
const UTILITY_IMAGE_B = join(REPO_ROOT, 'docs', 'assets', 'helix-phase1-core.png');
const UTILITY_VIDEO = join(REPO_ROOT, 'docs', 'demo', 'nebula-nodes-demo-720p.mp4');
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
  await runHistoryRerunAndReloadCheck(cdp);
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
  await evaluate(cdp, async (imageAPath, imageBPath, videoPath) => {
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
      makeNode('util-image-a', 'image-input', { filePath: imageAPath }, 2),
      makeNode('util-image-b', 'image-input', { filePath: imageBPath }, 3),
      makeNode('util-video', 'video-input', { filePath: videoPath }, 4),
      makeNode('util-audio', 'audio-input', { filePath: videoPath }, 5),
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
      isExecuting: false,
      undoStack: [],
      redoStack: [],
      backendFreshStartPending: false,
    });

    window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', {
      detail: { addedCount: nodes.length, totalCount: nodes.length },
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 600));

    // Exercise the real frontend execution path so this smoke check covers
    // UUID correlation, run-history opening/closing, and request serialization.
    await graph.getState().executeGraph();
  }, UTILITY_IMAGE_A, UTILITY_IMAGE_B, UTILITY_VIDEO);

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
  `, 10000, `
    (() => {
      const state = window.__nebulaGraphStore.getState();
      return {
        isExecuting: state.isExecuting,
        nodes: state.nodes.map((node) => ({
          id: node.id,
          state: node.data.state,
          error: node.data.error,
          outputKeys: Object.keys(node.data.outputs ?? {}),
        })),
      };
    })()
  `);

  const assertions = await evaluate(cdp, () => {
    const nodes = window.__nebulaGraphStore.getState().nodes;
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const output = (id, key) => byId[id]?.data.outputs?.[key]?.value;
    return {
      renderedNodes: document.querySelectorAll('.react-flow__node').length,
      textInput: output('util-text-a', 'text'),
      imageInput: output('util-image-a', 'image'),
      imageInputB: output('util-image-b', 'image'),
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
      runHistory: window.__nebulaGraphStore.getState().runHistory,
      errors: nodes.filter((node) => node.data.state === 'error').map((node) => [node.id, node.data.error]),
    };
  });

  assertEqual(assertions.renderedNodes, 17, 'renders seeded utility nodes');
  assertEqual(assertions.textInput, 'Alpha', 'text input output');
  assertStartsWith(assertions.imageInput, '/api/outputs/chat-uploads/', 'image input A output');
  assertStartsWith(assertions.imageInputB, '/api/outputs/chat-uploads/', 'image input B output');
  assertEqual(assertions.videoInput, UTILITY_VIDEO, 'video input output');
  assertEqual(assertions.audioInput, UTILITY_VIDEO, 'audio input output');
  assertEqual(assertions.stickyState, 'complete', 'sticky note completes');
  assertEqual(assertions.combine, 'Alpha | Beta', 'combine text output');
  assertEqual(assertions.routerOut2, 'Alpha', 'router output');
  assertEqual(assertions.reroute, 'Alpha', 'reroute output');
  assertEqual(assertions.preview, 'Alpha', 'preview output');
  assertArrayEqual(assertions.textArray, ['Alpha', 'Beta'], 'text array output');
  assertOutputRefArray(assertions.imageArray, [assertions.imageInput, assertions.imageInputB], 'image array output');
  assertEqual(assertions.selector, 'Beta', 'array selector output');
  assertEqual(assertions.textIterator, 'Beta', 'text iterator latest output');
  assertEqual(assertions.imageIterator, assertions.imageInputB, 'image iterator latest output');
  assertEqual(assertions.compareA, assertions.imageInput, 'image compare A output');
  assertEqual(assertions.compareB, assertions.imageInputB, 'image compare B output');
  assertEqual(assertions.runHistory.length, 1, 'records utility run history');
  assertEqual(assertions.runHistory[0]?.status, 'complete', 'closes utility run history');
  assertEqual(assertions.runHistory[0]?.snapshot?.nodes?.length, 17, 'stores utility run snapshot');
  if (assertions.errors.length) {
    throw new Error(`Utility graph had errored nodes: ${JSON.stringify(assertions.errors)}`);
  }
}

async function runHistoryRerunAndReloadCheck(cdp) {
  const sourceRunId = await evaluate(cdp, () => {
    const graph = window.__nebulaGraphStore;
    const source = graph.getState().runHistory[0];
    graph.setState((state) => ({
      nodes: state.nodes.map((node) => node.id === 'util-text-a'
        ? { ...node, data: { ...node.data, params: { value: 'MUTATED AFTER RUN' } } }
        : node),
      edges: [],
    }));
    return source.id;
  });

  await evaluate(cdp, async (id) => {
    await window.__nebulaGraphStore.getState().rerunHistoryRecord(id);
  }, sourceRunId);

  const quotedSourceRunId = JSON.stringify(sourceRunId);
  await waitForRuntime(cdp, `
    (() => {
      const history = window.__nebulaGraphStore.getState().runHistory;
      return history.length === 2
        && history[0].sourceRunId === ${quotedSourceRunId}
        && history[0].status === 'complete';
    })()
  `, 10000, `window.__nebulaGraphStore.getState().runHistory`);

  const replay = await evaluate(cdp, () => {
    const [latest, source] = window.__nebulaGraphStore.getState().runHistory;
    return {
      latestId: latest.id,
      latestStatus: latest.status,
      sourceRunId: latest.sourceRunId,
      replayAction: latest.replayAction,
      nodesExecuted: latest.nodesExecuted,
      savedText: latest.snapshot.nodes.find((node) => node.id === 'util-text-a')?.params?.value,
      savedEdgeCount: latest.snapshot.edges.length,
      sourceId: source.id,
    };
  });
  if (replay.latestId === replay.sourceId) throw new Error('history rerun reused its source run id');
  assertEqual(replay.latestStatus, 'complete', 'history rerun completes');
  assertEqual(replay.sourceRunId, sourceRunId, 'history rerun links its source');
  assertEqual(replay.replayAction, 'rerun', 'history rerun records action');
  assertEqual(replay.nodesExecuted, 17, 'history rerun executes saved graph');
  assertEqual(replay.savedText, 'Alpha', 'history rerun preserves pre-mutation params');
  assertEqual(replay.savedEdgeCount, 14, 'history rerun preserves pre-mutation edges');

  const loadEvent = cdp.waitForEvent('Page.loadEventFired', 10000);
  await cdp.send('Page.reload', { ignoreCache: true });
  await loadEvent;
  await waitForRuntime(cdp, `
    window.__nebulaGraphStore
      && window.__nebulaGraphStore.getState().runHistory.length === 2
      && window.__nebulaGraphStore.getState().runHistory.every((run) => run.status === 'complete')
  `, 10000);

  const persisted = await evaluate(cdp, () => window.__nebulaGraphStore.getState().runHistory.map((run) => ({
    id: run.id,
    status: run.status,
    sourceRunId: run.sourceRunId,
    savedText: run.snapshot.nodes.find((node) => node.id === 'util-text-a')?.params?.value,
  })));
  assertEqual(persisted[0].id, replay.latestId, 'reload retains newest run id');
  assertEqual(persisted[0].sourceRunId, sourceRunId, 'reload retains replay lineage');
  assertEqual(persisted[0].savedText, 'Alpha', 'reload retains frozen snapshot');
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

function assertStartsWith(actual, expectedPrefix, label) {
  if (typeof actual !== 'string' || !actual.startsWith(expectedPrefix)) {
    throw new Error(`${label}: expected prefix ${JSON.stringify(expectedPrefix)}, got ${JSON.stringify(actual)}`);
  }
}

function assertOutputRefArray(actual, expected, label) {
  const filename = (value) => typeof value === 'string' ? value.split('/').pop() : value;
  if (!Array.isArray(actual)
    || actual.length !== expected.length
    || actual.some((value, index) => filename(value) !== filename(expected[index]))) {
    throw new Error(`${label}: expected refs ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

async function waitForRuntime(cdp, expression, timeout = 10000, diagnosticsExpression) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await evaluate(cdp, `Boolean(${expression})`).catch(() => false);
    if (ok) return;
    await sleep(100);
  }
  const diagnostics = diagnosticsExpression
    ? await evaluate(cdp, diagnosticsExpression).catch((err) => ({ diagnosticError: err.message }))
    : undefined;
  throw new Error(`Timed out waiting for ${expression}${diagnostics ? `\nRuntime state: ${JSON.stringify(diagnostics)}` : ''}`);
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
