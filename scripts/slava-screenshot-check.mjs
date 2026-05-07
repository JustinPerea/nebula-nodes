import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'output', 'slava-screenshot-check');
const URL = process.env.SLAVA_CHECK_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH to run Slava screenshot checks.`);
  process.exit(1);
}

const port = 9300 + Math.floor(Math.random() * 500);
const userDataDir = join(OUT_DIR, `chrome-profile-${Date.now()}`);

await mkdir(OUT_DIR, { recursive: true });
await cleanupChromeProfiles();

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  URL,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

chrome.stderr.on('data', (chunk) => {
  if (process.env.SLAVA_CHECK_DEBUG === '1') process.stderr.write(String(chunk));
});

try {
  const pageWs = await waitForPageWebSocket(port);
  const cdp = await connectCdp(pageWs);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await installDeterministicChatMock(cdp);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 980,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', 10000).catch(() => null);
  await cdp.send('Page.navigate', { url: URL });
  await loadEvent;

  await waitForRuntime(cdp, 'window.__nebulaUIStore && window.__nebulaGraphStore');
  await setupSlavaScene(cdp);
  await waitForRuntime(cdp, 'document.body.classList.contains("app-slava-restraint") && document.querySelectorAll(".react-flow__node").length >= 4');

  await screenshot(cdp, '01-slava-desktop.png');

  await runSlavaInteractionChecks(cdp);
  await setupSlavaScene(cdp);
  await waitForRuntime(cdp, 'document.body.classList.contains("app-slava-restraint") && document.querySelectorAll(".react-flow__node").length >= 4');

  await evaluate(cdp, () => {
    const firstToggle = document.querySelector('.settings__section-toggle');
    if (firstToggle instanceof HTMLElement && firstToggle.getAttribute('aria-expanded') !== 'true') firstToggle.click();
  });
  await sleep(250);
  await screenshot(cdp, '02-settings-api-expanded.png');

  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      selectedNodeId: 'n3',
      panels: {
        ...state.panels,
        library: { ...state.panels.library, visible: false },
        settings: { ...state.panels.settings, visible: false },
        inspector: { ...state.panels.inspector, visible: true },
        chat: { ...state.panels.chat, visible: true },
      },
    }));
  });
  await sleep(250);
  await screenshot(cdp, '03-image-surface-selected.png');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(300);
  await screenshot(cdp, '04-mobile-slava.png');

  const assertions = await evaluate(cdp, () => {
    const required = {
      slavaBody: document.body.classList.contains('app-slava-restraint'),
      chat: !!document.querySelector('.chat-panel'),
      inspector: !!document.querySelector('.panel--inspector'),
      nodes: document.querySelectorAll('.react-flow__node').length,
      edges: document.querySelectorAll('.react-flow__edge').length,
      imageSurface: !!document.querySelector('.model-node--image-surface'),
      stickyNoteEditor: !!document.querySelector('.model-node--sticky-note .model-node__textarea'),
      dotBackground: !!document.querySelector('.react-flow__background.slava-canvas-background .slava-canvas-background__dot'),
      lineBackground: !!document.querySelector('.react-flow__background.slava-canvas-background path.react-flow__background-pattern'),
      handles: document.querySelectorAll('.react-flow__handle').length,
    };
    return required;
  });

  const missing = [];
  if (!assertions.slavaBody) missing.push('Slava body class');
  if (!assertions.chat) missing.push('chat panel');
  if (!assertions.inspector) missing.push('inspector panel');
  if (assertions.nodes < 4) missing.push('four nodes');
  if (assertions.edges < 1) missing.push('edge');
  if (!assertions.imageSurface) missing.push('image surface node');
  if (!assertions.stickyNoteEditor) missing.push('sticky note editor');
  if (!assertions.dotBackground) missing.push('Slava dot matrix background');
  if (assertions.lineBackground) missing.push('Slava line background still present');
  if (assertions.handles < 2) missing.push('handles');

  if (missing.length) {
    throw new Error(`Slava screenshot scene missing: ${missing.join(', ')}`);
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 980,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      selectedNodeId: null,
      panels: {
        ...state.panels,
        library: { ...state.panels.library, visible: false },
        settings: { ...state.panels.settings, visible: false },
        inspector: { ...state.panels.inspector, visible: false },
        chat: { ...state.panels.chat, visible: false },
      },
    }));

    window.__nebulaGraphStore.setState({
      nodes: [],
      edges: [],
      isExecuting: false,
    });
  });
  await sleep(650);
  await screenshot(cdp, '05-empty-canvas.png');

  const emptyAssertions = await evaluate(cdp, () => ({
    emptyGraph: document.querySelectorAll('.react-flow__node').length === 0,
  }));

  const emptyMissing = [];
  if (!emptyAssertions.emptyGraph) emptyMissing.push('empty graph scene');

  if (emptyMissing.length) {
    throw new Error(`Slava empty canvas scene missing: ${emptyMissing.join(', ')}`);
  }

  console.log(`Slava screenshot check passed. Screenshots saved to ${OUT_DIR}`);
} finally {
  if (chrome.exitCode === null) chrome.kill('SIGTERM');
  await waitForExit(chrome, 1500).catch(() => {
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  });
  await cleanupChromeProfiles();
}

async function setupSlavaScene(cdp) {
  await evaluate(cdp, () => {
    const ui = window.__nebulaUIStore;
    const graph = window.__nebulaGraphStore;
    ui.getState().setSkin('slava-restraint');
    window.localStorage.setItem('nebula:agentLog:enabled', '0');
    window.__nebulaChat?.clear?.();
    window.__nebulaChat?.setInput?.('');

    ui.setState((state) => ({
      selectedNodeId: 'n2',
      chatResized: false,
      agentLogEnabled: false,
      panels: {
        ...state.panels,
        library: { visible: true, position: { x: 16, y: 16 } },
        inspector: { visible: true, position: { x: -300, y: 16 } },
        settings: { visible: true, position: { x: -340, y: 70 } },
        chat: { ...state.panels.chat, visible: true, position: { x: 16, y: 16 }, width: 300, height: undefined, left: null, top: null },
      },
    }));

    graph.setState({
      nodes: [
        {
          id: 'n1',
          type: 'model-node',
          position: { x: 260, y: 250 },
          data: {
            label: 'Prompt',
            definitionId: 'text-input',
            params: { value: 'Cute robot design, soft studio lighting' },
            state: 'complete',
            outputs: { text: { type: 'Text', value: 'Cute robot design, soft studio lighting' } },
          },
        },
        {
          id: 'n2',
          type: 'model-node',
          position: { x: 610, y: 230 },
          selected: true,
          data: {
            label: 'GPT Image 2',
            definitionId: 'gpt-image-2-generate',
            params: { size: '1024x1024' },
            state: 'idle',
            outputs: {},
          },
        },
        {
          id: 'n3',
          type: 'model-node',
          position: { x: 610, y: 520 },
          data: {
            label: 'Cute Robot Design',
            definitionId: 'gpt-image-2-generate',
            params: { size: '1024x1024' },
            state: 'complete',
            outputs: { image: { type: 'Image', value: '/hermes/hermes-figure.jpeg' } },
          },
        },
        {
          id: 'n4',
          type: 'model-node',
          position: { x: 260, y: 560 },
          data: {
            label: 'Sticky Note',
            definitionId: 'sticky-note',
            params: { content: 'Composition notes and alternates', color: 'grey' },
            state: 'idle',
            outputs: {},
          },
        },
      ],
      edges: [
        {
          id: 'e-n1-n2',
          source: 'n1',
          sourceHandle: 'text',
          target: 'n2',
          targetHandle: 'prompt',
          type: 'typed-edge',
          selected: true,
          data: { dataType: 'Text' },
        },
      ],
      isExecuting: false,
    });
  });
  await sleep(500);
}

async function runSlavaInteractionChecks(cdp) {
  await waitForRuntime(cdp, 'document.querySelector(".settings__section-toggle") && !document.querySelector(".settings__loading")');

  const chromeAssertions = await evaluate(cdp, () => {
    const settings = document.querySelector('.panel--settings');
    const chat = document.querySelector('.chat-panel');
    const settingsRect = settings?.getBoundingClientRect();
    const topElement = settingsRect
      ? document.elementFromPoint(settingsRect.left + 24, settingsRect.top + 24)
      : null;
    const activeToolbarButtons = Array.from(document.querySelectorAll('.toolbar__button--active'))
      .map((button) => button.getAttribute('title'));
    return {
      settingsAboveChat: Boolean(
        settings
        && chat
        && Number(getComputedStyle(settings).zIndex) > Number(getComputedStyle(chat).zIndex),
      ),
      settingsOwnsTopHit: Boolean(topElement?.closest('.panel--settings')),
      apiKeysInitiallyCollapsed:
        document.querySelector('.settings__section-toggle')?.getAttribute('aria-expanded') === 'false'
        && !document.querySelector('.settings__collapsible-body'),
      toolbarChatActive: activeToolbarButtons.includes('Toggle chat panel'),
      toolbarSettingsActive: activeToolbarButtons.includes('Settings'),
      toolbarLibraryActive: activeToolbarButtons.includes('Toggle node library'),
      agentLogHiddenByDefault: !document.querySelector('.agent-log'),
    };
  });
  assertSlavaCheck(chromeAssertions.settingsAboveChat, 'settings panel z-index is above chat');
  assertSlavaCheck(chromeAssertions.settingsOwnsTopHit, 'settings receives pointer hits above chat');
  assertSlavaCheck(chromeAssertions.apiKeysInitiallyCollapsed, 'API Keys section is collapsed by default');
  assertSlavaCheck(chromeAssertions.toolbarChatActive, 'toolbar chat button shows active state');
  assertSlavaCheck(chromeAssertions.toolbarSettingsActive, 'toolbar settings button shows active state');
  assertSlavaCheck(chromeAssertions.toolbarLibraryActive, 'toolbar node-library button shows active state');
  assertSlavaCheck(chromeAssertions.agentLogHiddenByDefault, 'agent log is hidden by default');

  await clickSelector(cdp, '.settings__section-toggle');
  await waitForRuntime(cdp, 'document.querySelector(".settings__section-toggle")?.getAttribute("aria-expanded") === "true" && document.querySelector(".settings__collapsible-body")');

  const expandedAssertions = await evaluate(cdp, () => ({
    apiKeyInputs: document.querySelectorAll('.settings__collapsible-body .settings__key-input').length,
  }));
  assertSlavaCheck(expandedAssertions.apiKeyInputs >= 8, 'API Keys section expands to reveal provider inputs');

  await clickSelector(cdp, '.settings__section-toggle');
  await waitForRuntime(cdp, 'document.querySelector(".settings__section-toggle")?.getAttribute("aria-expanded") === "false" && !document.querySelector(".settings__collapsible-body")');

  await clickSelector(cdp, '.settings__toggle-row');
  await waitForRuntime(cdp, 'document.querySelector(".agent-log") && document.body.classList.contains("agent-log-enabled")');
  await clickSelector(cdp, '.agent-log__header');
  await waitForRuntime(cdp, 'document.querySelector(".agent-log.agent-log--open") && document.body.classList.contains("agent-log-open")');

  const agentLogAssertions = await evaluate(cdp, () => ({
    persisted: window.localStorage.getItem('nebula:agentLog:enabled') === '1',
    openEmptyText: document.querySelector('.agent-log__empty')?.textContent?.trim() ?? '',
  }));
  assertSlavaCheck(agentLogAssertions.persisted, 'agent log setting persists to localStorage');
  assertSlavaCheck(agentLogAssertions.openEmptyText === 'No events yet', 'agent log opens with empty state');

  await clickSelector(cdp, '.settings__toggle-row');
  await waitForRuntime(cdp, '!document.querySelector(".agent-log") && !document.body.classList.contains("agent-log-enabled")');

  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      panels: {
        ...state.panels,
        settings: { ...state.panels.settings, visible: false },
      },
    }));
  });
  await waitForRuntime(cdp, '!document.querySelector(".panel--settings")');

  const imageDragAssertions = await evaluate(cdp, () => ({
    imageDraggable: document.querySelector('.model-node--image-surface .model-node__preview-image')?.getAttribute('draggable'),
    imageHasNoNoDrag: !document.querySelector('.model-node--image-surface .model-node__preview-image')?.classList.contains('nodrag'),
  }));
  assertSlavaCheck(imageDragAssertions.imageDraggable === 'false', 'Slava image previews are not draggable browser images');
  assertSlavaCheck(imageDragAssertions.imageHasNoNoDrag, 'Slava image previews can participate in node drag');

  const imageNodeBefore = await evaluate(cdp, () => {
    const node = window.__nebulaGraphStore.getState().nodes.find((n) => n.id === 'n3');
    return node ? { x: node.position.x, y: node.position.y } : null;
  });
  await dragSelector(cdp, '[data-id="n3"] .model-node__preview-image', 70, 36);
  await sleep(200);
  const imageNodeAfter = await evaluate(cdp, () => {
    const node = window.__nebulaGraphStore.getState().nodes.find((n) => n.id === 'n3');
    return node ? { x: node.position.x, y: node.position.y } : null;
  });
  assertSlavaCheck(Boolean(imageNodeBefore && imageNodeAfter), 'image node exists for drag check');
  assertSlavaCheck(
    Math.abs(imageNodeAfter.x - imageNodeBefore.x) >= 20
      || Math.abs(imageNodeAfter.y - imageNodeBefore.y) >= 10,
    'dragging the image surface moves the node',
  );

  const chatRectBeforeDrag = await getRect(cdp, '.chat-panel');
  await dragSelector(cdp, '.chat-panel__header', -120, 42);
  await waitForRuntime(cdp, 'window.__nebulaUIStore.getState().panels.chat.left !== null && window.__nebulaUIStore.getState().panels.chat.top !== null');
  const chatRectAfterDrag = await getRect(cdp, '.chat-panel');
  assertSlavaCheck(
    Math.abs(chatRectAfterDrag.left - chatRectBeforeDrag.left) >= 40
      || Math.abs(chatRectAfterDrag.top - chatRectBeforeDrag.top) >= 20,
    'chat panel moves after header drag',
  );

  const chatRectBeforeResize = await getRect(cdp, '.chat-panel');
  await dragSelector(cdp, '.chat-panel__resize-handle--br', 48, 36);
  await sleep(120);
  const chatRectAfterResize = await getRect(cdp, '.chat-panel');
  assertSlavaCheck(
    chatRectAfterResize.width >= chatRectBeforeResize.width + 24
      && chatRectAfterResize.height >= chatRectBeforeResize.height + 18,
    'chat panel resizes from bottom-right handle',
  );

  await waitForRuntime(cdp, 'document.querySelector(".chat-panel__textarea") && !document.querySelector(".chat-panel__textarea").disabled');
  await evaluate(cdp, () => {
    window.__nebulaChat?.clear?.();
    const textarea = document.querySelector('.chat-panel__textarea');
    textarea?.focus();
  });
  await cdp.send('Input.insertText', { text: 'hello from slava check' });
  await key(cdp, 'Enter');
  await waitForRuntime(cdp, 'Array.from(document.querySelectorAll(".chat__bubble--user")).some((el) => el.textContent.includes("hello from slava check"))');
  await waitForRuntime(cdp, 'document.querySelector(".chat-panel__send--stop")');
  await clickSelector(cdp, '.chat-panel__send--stop');
  await waitForRuntime(cdp, 'Array.from(document.querySelectorAll(".chat__system")).some((el) => el.textContent.includes("Cancelled."))');

  const chatSendAssertions = await evaluate(cdp, () => {
    const sockets = window.__slavaMockChatSockets ?? [];
    return {
      sentMessage: sockets.some((socket) =>
        socket.sent?.some((msg) => msg.type === 'send' && msg.message === 'hello from slava check'),
      ),
      sentCancel: sockets.some((socket) =>
        socket.sent?.some((msg) => msg.type === 'cancel'),
      ),
      stopReturnedToSubmit: !!document.querySelector('.chat-panel__send--submit'),
    };
  });
  assertSlavaCheck(chatSendAssertions.sentMessage, 'chat Enter key sends message envelope');
  assertSlavaCheck(chatSendAssertions.sentCancel, 'chat Stop sends cancel envelope');
  assertSlavaCheck(chatSendAssertions.stopReturnedToSubmit, 'chat Stop returns input to send mode');

  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      chatResized: false,
      panels: {
        ...state.panels,
        chat: {
          ...state.panels.chat,
          visible: true,
          position: { x: 16, y: 16 },
          width: 300,
          height: undefined,
          left: null,
          top: null,
        },
        settings: { ...state.panels.settings, visible: true },
      },
    }));
  });
  await sleep(250);
}

async function installDeterministicChatMock(cdp) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: String.raw`
      (() => {
        const NativeWebSocket = window.WebSocket;
        const sockets = [];
        class SlavaMockChatWebSocket extends EventTarget {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;
          constructor(url) {
            super();
            this.url = String(url);
            this.readyState = SlavaMockChatWebSocket.CONNECTING;
            this.sent = [];
            this._doneTimer = null;
            sockets.push(this);
            window.__slavaMockChatSockets = sockets;
            window.setTimeout(() => {
              if (this.readyState !== SlavaMockChatWebSocket.CONNECTING) return;
              this.readyState = SlavaMockChatWebSocket.OPEN;
              const openEvent = new Event('open');
              this.onopen?.(openEvent);
              this.dispatchEvent(openEvent);
              this._emit({ type: 'session', sessionId: 'slava-check-session' });
            }, 40);
          }
          send(data) {
            let message;
            try {
              message = JSON.parse(String(data));
            } catch {
              message = { type: 'raw', data: String(data) };
            }
            this.sent.push(message);
            if (message.type === 'cancel') {
              if (this._doneTimer) window.clearTimeout(this._doneTimer);
              this._emit({ type: 'done' });
              return;
            }
            if (message.type === 'send') {
              window.setTimeout(() => {
                this._emit({ type: 'text', text: 'Received: ' + message.message });
              }, 80);
              this._doneTimer = window.setTimeout(() => {
                this._emit({ type: 'done' });
              }, 900);
            }
          }
          close() {
            if (this._doneTimer) window.clearTimeout(this._doneTimer);
            this.readyState = SlavaMockChatWebSocket.CLOSED;
            const closeEvent = new Event('close');
            this.onclose?.(closeEvent);
            this.dispatchEvent(closeEvent);
          }
          _emit(payload) {
            if (this.readyState !== SlavaMockChatWebSocket.OPEN) return;
            const event = new MessageEvent('message', { data: JSON.stringify(payload) });
            this.onmessage?.(event);
            this.dispatchEvent(event);
          }
        }
        window.WebSocket = function WebSocket(url, protocols) {
          if (String(url).includes('/ws/chat')) {
            return new SlavaMockChatWebSocket(url);
          }
          return new NativeWebSocket(url, protocols);
        };
        window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
        window.WebSocket.OPEN = NativeWebSocket.OPEN;
        window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
        window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
      })();
    `,
  });
}

function assertSlavaCheck(value, message) {
  if (!value) throw new Error(`Slava interaction check failed: ${message}`);
}

async function getRect(cdp, selector) {
  const rect = await evaluate(cdp, (targetSelector) => {
    const el = document.querySelector(targetSelector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  }, selector);
  if (!rect) throw new Error(`Element not found: ${selector}`);
  return rect;
}

async function clickSelector(cdp, selector) {
  const rect = await getRect(cdp, selector);
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function dragSelector(cdp, selector, deltaX, deltaY) {
  const rect = await getRect(cdp, selector);
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 5; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + (deltaX * step) / 5,
      y: startY + (deltaY * step) / 5,
      button: 'left',
      buttons: 1,
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: startX + deltaX,
    y: startY + deltaY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

async function key(cdp, keyName, modifiers = 0) {
  const keyCodes = {
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  };
  const keyInfo = keyCodes[keyName] ?? { code: keyName, windowsVirtualKeyCode: keyName.charCodeAt(0), nativeVirtualKeyCode: keyName.charCodeAt(0) };
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    text: keyName.length === 1 ? keyName : '',
    unmodifiedText: keyName.length === 1 ? keyName : '',
    modifiers,
    ...keyInfo,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    modifiers,
    ...keyInfo,
  });
}

async function screenshot(cdp, filename) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(OUT_DIR, filename), Buffer.from(result.data, 'base64'));
}

async function evaluate(cdp, fn, ...args) {
  const source = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : String(fn);
  const result = await cdp.send('Runtime.evaluate', {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
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

async function waitForPageWebSocket(remotePort, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const pages = await fetch(`http://127.0.0.1:${remotePort}/json/list`).then((r) => r.json());
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still booting.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chrome DevTools endpoint');
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result ?? {});
      return;
    }
    if (msg.method && events.has(msg.method)) {
      for (const resolve of events.get(msg.method)) resolve(msg.params ?? {});
      events.delete(msg.method);
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const callId = ++id;
        ws.send(JSON.stringify({ id: callId, method, params }));
        return new Promise((callResolve, callReject) => {
          pending.set(callId, { resolve: callResolve, reject: callReject });
        });
      },
      waitForEvent(method, timeout = 10000) {
        return new Promise((eventResolve, eventReject) => {
          const timer = setTimeout(() => eventReject(new Error(`Timed out waiting for ${method}`)), timeout);
          const wrapped = (params) => {
            clearTimeout(timer);
            eventResolve(params);
          };
          events.set(method, [...(events.get(method) ?? []), wrapped]);
        });
      },
    }));
    ws.addEventListener('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupChromeProfiles() {
  if (!existsSync(OUT_DIR)) return;
  const entries = await readdir(OUT_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chrome-profile-'))
      .map((entry) => rm(join(OUT_DIR, entry.name), { recursive: true, force: true })),
  );
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Chrome exit')), timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
