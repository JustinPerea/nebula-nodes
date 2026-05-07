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
await cleanupScreenshots();

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
  await waitForRuntime(cdp, 'document.body.classList.contains("app-slava-restraint") && document.querySelectorAll(".react-flow__node").length >= 7');

  await screenshot(cdp, '01-slava-desktop.png');

  await runSlavaInteractionChecks(cdp);
  await runSlavaPersistenceChecks(cdp);
  await setupSlavaScene(cdp);
  await waitForRuntime(cdp, 'document.body.classList.contains("app-slava-restraint") && document.querySelectorAll(".react-flow__node").length >= 7');

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

  await runSlavaInspectorCoverage(cdp);
  await runSlavaExpandedVisualCoverage(cdp);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await setupSlavaScene(cdp);
  await waitForRuntime(cdp, 'document.body.classList.contains("app-slava-restraint") && document.querySelectorAll(".react-flow__node").length >= 7');
  await sleep(300);
  await screenshot(cdp, '10-mobile-slava.png');
  await runSlavaMobileLayoutChecks(cdp);

  const assertions = await evaluate(cdp, () => {
    const required = {
      slavaBody: document.body.classList.contains('app-slava-restraint'),
      chat: !!document.querySelector('.chat-panel'),
      inspector: !!document.querySelector('.panel--inspector'),
      nodes: document.querySelectorAll('.react-flow__node').length,
      edges: document.querySelectorAll('.react-flow__edge').length,
      imageSurface: !!document.querySelector('.model-node--image-surface'),
      executingNode: !!document.querySelector('.model-node--executing .model-node__loading'),
      stickyNoteEditor: !!document.querySelector('.model-node--sticky-note .model-node__textarea'),
      rerouteNode: !!document.querySelector('.reroute-node'),
      meshPreview: !!document.querySelector('.mesh-preview'),
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
  if (!assertions.executingNode) missing.push('executing/loading node');
  if (!assertions.stickyNoteEditor) missing.push('sticky note editor');
  if (!assertions.rerouteNode) missing.push('reroute node');
  if (!assertions.meshPreview) missing.push('mesh preview node');
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
  await screenshot(cdp, '11-empty-canvas.png');

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
        {
          id: 'n5',
          type: 'model-node',
          position: { x: 980, y: 250 },
          data: {
            label: 'Running Model',
            definitionId: 'openrouter-universal',
            params: { model: 'openai/gpt-4.1-mini' },
            state: 'executing',
            progress: 0.46,
            outputs: {},
          },
        },
        {
          id: 'n6',
          type: 'reroute-node',
          position: { x: 510, y: 430 },
          data: {
            label: 'Reroute',
            definitionId: 'reroute',
            params: {},
            state: 'idle',
            outputs: {},
          },
        },
        {
          id: 'n7',
          type: 'model-node',
          position: { x: 980, y: 535 },
          data: {
            label: 'Mesh Preview',
            definitionId: 'meshy-text-to-3d',
            params: { prompt: 'low poly robot mascot' },
            state: 'complete',
            outputs: { mesh: { type: 'Mesh', value: '/slava-check-mock.glb' } },
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
        {
          id: 'e-n1-n6',
          source: 'n1',
          sourceHandle: 'text',
          target: 'n6',
          targetHandle: 'input',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
        {
          id: 'e-n6-n2',
          source: 'n6',
          sourceHandle: 'output',
          target: 'n2',
          targetHandle: 'prompt',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
      ],
      isExecuting: false,
    });
  });
  await sleep(500);
}

async function runSlavaInspectorCoverage(cdp) {
  debugStep('visual coverage: inspector controls');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 980,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await setupSlavaScene(cdp);
  await waitForRuntime(cdp, 'document.querySelectorAll(".react-flow__node").length >= 7');

  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      selectedNodeId: 'n1',
      panels: {
        ...state.panels,
        library: { ...state.panels.library, visible: false },
        settings: { ...state.panels.settings, visible: false },
        chat: { ...state.panels.chat, visible: false },
        inspector: { ...state.panels.inspector, visible: true, position: { x: -320, y: 16 } },
      },
    }));
  });
  await waitForRuntime(cdp, 'document.querySelector(".panel--inspector [data-inspector-param=\\"value\\"][data-inspector-kind=\\"textarea\\"] textarea.inspector__field")');
  await sleep(650);
  await screenshot(cdp, '04-inspector-text-node.png');

  const textAssertions = await evaluate(cdp, () => ({
    textParam: !!document.querySelector('.panel--inspector [data-inspector-param="value"][data-inspector-kind="textarea"] textarea.inspector__field'),
    actionIcons: document.querySelectorAll('.panel--inspector .inspector__action-icon').length,
    infoIcon: !!document.querySelector('.panel--inspector .inspector__info-icon'),
    paramSource: document.querySelector('.panel--inspector [data-inspector-param="value"]')?.getAttribute('data-inspector-source'),
  }));
  assertSlavaCheck(textAssertions.textParam, 'Inspector text param renders through shared textarea contract');
  assertSlavaCheck(textAssertions.actionIcons >= 3, 'Inspector action buttons use icon contract');
  assertSlavaCheck(textAssertions.infoIcon, 'Inspector info action uses icon contract');
  assertSlavaCheck(textAssertions.paramSource === 'definition', 'Inspector static params expose a stable source marker');

  await evaluate(cdp, () => {
    const graph = window.__nebulaGraphStore;
    const current = graph.getState();
    const imageInputNode = {
      id: 'n8',
      type: 'model-node',
      position: { x: 960, y: 670 },
      data: {
        label: 'Reference Image',
        definitionId: 'image-input',
        params: {
          filePath: '/hermes/hermes-figure.jpeg',
          _previewUrl: '/hermes/hermes-figure.jpeg',
        },
        state: 'complete',
        outputs: { image: { type: 'Image', value: '/hermes/hermes-figure.jpeg' } },
      },
    };
    graph.setState({
      nodes: [...current.nodes.filter((node) => node.id !== 'n8'), imageInputNode],
      edges: current.edges,
    });
    window.__nebulaUIStore.setState((state) => ({
      selectedNodeId: 'n8',
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible: true, position: { x: -320, y: 16 } },
      },
    }));
  });
  await waitForRuntime(cdp, 'document.querySelector(".panel--inspector [data-inspector-param=\\"filePath\\"][data-inspector-kind=\\"file\\"] .inspector__file-preview")');
  await sleep(200);
  await screenshot(cdp, '05-inspector-image-file.png');

  const imageAssertions = await evaluate(cdp, () => ({
    fileParam: !!document.querySelector('.panel--inspector [data-inspector-param="filePath"][data-inspector-kind="file"]'),
    fileButtonIcon: !!document.querySelector('.panel--inspector .inspector__file-button .inspector__action-icon'),
    filePreview: !!document.querySelector('.panel--inspector .inspector__file-preview'),
  }));
  assertSlavaCheck(imageAssertions.fileParam, 'Inspector file param exposes stable markers');
  assertSlavaCheck(imageAssertions.fileButtonIcon, 'Inspector file button uses icon contract');
  assertSlavaCheck(imageAssertions.filePreview, 'Inspector file preview renders');

  await evaluate(cdp, () => {
    const graph = window.__nebulaGraphStore;
    const current = graph.getState();
    graph.setState({
      nodes: current.nodes.map((node) => node.id === 'n5'
        ? {
          ...node,
          data: {
            ...node.data,
            keyStatus: 'missing',
            params: {
              ...node.data.params,
              model: 'openai/gpt-4.1-mini',
            },
          },
        }
        : node),
      edges: current.edges,
    });
    window.__nebulaUIStore.setState((state) => ({
      selectedNodeId: 'n5',
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible: true, position: { x: -320, y: 16 } },
      },
    }));
  });
  await waitForRuntime(cdp, 'document.querySelector(".panel--inspector [data-inspector-param=\\"model\\"] .inspector__model-selection") && document.querySelector(".panel--inspector .inspector__notice--warning")');
  const favoritePressedBefore = await evaluate(cdp, () =>
    document.querySelector('.panel--inspector .inspector__favorite-button')?.getAttribute('aria-pressed') === 'true',
  );
  if (!favoritePressedBefore) {
    await clickSelector(cdp, '.panel--inspector .inspector__favorite-button');
  }
  await waitForRuntime(cdp, 'document.querySelector(".panel--inspector .inspector__favorite-button")?.getAttribute("aria-pressed") === "true"');
  await sleep(200);
  await screenshot(cdp, '06-inspector-model-warning.png');

  const modelAssertions = await evaluate(cdp, () => ({
    modelParam: !!document.querySelector('.panel--inspector [data-inspector-param="model"][data-inspector-kind="string"]'),
    notice: document.querySelector('.panel--inspector .inspector__notice--warning')?.textContent?.trim() ?? '',
    modelSelection: !!document.querySelector('.panel--inspector .inspector__model-selection-text'),
    favoritePressed: document.querySelector('.panel--inspector .inspector__favorite-button')?.getAttribute('aria-pressed'),
  }));
  assertSlavaCheck(modelAssertions.modelParam, 'Inspector model param exposes stable markers');
  assertSlavaCheck(modelAssertions.notice.includes('OPENROUTER_API_KEY'), 'Inspector missing API key notice names the required key');
  assertSlavaCheck(modelAssertions.modelSelection, 'Inspector selected model summary renders');
  assertSlavaCheck(modelAssertions.favoritePressed === 'true', 'Inspector favorite button exposes pressed state');

  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      selectedNodeId: 'n4',
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible: true, position: { x: -320, y: 16 } },
      },
    }));
  });
  await waitForRuntime(cdp, 'document.querySelector(".panel--inspector [data-inspector-param=\\"content\\"][data-inspector-kind=\\"textarea\\"] textarea") && document.querySelector(".panel--inspector [data-inspector-param=\\"color\\"][data-inspector-kind=\\"enum\\"] select")');
  await sleep(200);
  await screenshot(cdp, '07-inspector-sticky-note.png');

  const stickyAssertions = await evaluate(cdp, () => ({
    contentTextarea: !!document.querySelector('.panel--inspector [data-inspector-param="content"][data-inspector-kind="textarea"] textarea.inspector__field'),
    colorSelect: !!document.querySelector('.panel--inspector [data-inspector-param="color"][data-inspector-kind="enum"] select.inspector__field'),
  }));
  assertSlavaCheck(stickyAssertions.contentTextarea, 'Inspector sticky note textarea renders through shared contract');
  assertSlavaCheck(stickyAssertions.colorSelect, 'Inspector sticky note enum renders through shared contract');
}

async function runSlavaExpandedVisualCoverage(cdp) {
  debugStep('visual coverage: popovers and node states');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 980,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await setupSlavaScene(cdp);
  await waitForRuntime(cdp, 'document.querySelectorAll(".react-flow__node").length >= 7');

  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      selectedNodeId: 'n5',
      contextMenu: {
        visible: true,
        position: { x: 930, y: 190 },
        nodeId: 'n5',
      },
      connectionPopup: {
        visible: true,
        position: { x: 520, y: 150 },
        nodeId: 'n1',
        handleId: 'text',
        handleType: 'source',
      },
      panels: {
        ...state.panels,
        library: { ...state.panels.library, visible: false },
        inspector: { ...state.panels.inspector, visible: false },
        settings: { ...state.panels.settings, visible: false },
        chat: { ...state.panels.chat, visible: false },
      },
    }));
  });
  await waitForRuntime(cdp, 'document.querySelector(".context-menu") && document.querySelector(".connection-popup")');
  await sleep(200);
  await screenshot(cdp, '08-slava-popovers-and-states.png');

  const stateAssertions = await evaluate(cdp, () => {
    const progress = document.querySelector('.model-node--executing .model-node__progress-bar');
    const progressRect = progress?.getBoundingClientRect();
    const rerouteRect = document.querySelector('.reroute-node')?.getBoundingClientRect();
    const contextMenu = document.querySelector('.context-menu');
    const connectionPopup = document.querySelector('.connection-popup');
    return {
      contextMenuItems: document.querySelectorAll('.context-menu__item').length,
      connectionPopupCategories: document.querySelectorAll('.connection-popup__category-label').length,
      connectionPopupTopLayer: Boolean(connectionPopup && Number(getComputedStyle(connectionPopup).zIndex) >= 40),
      contextMenuTopLayer: Boolean(contextMenu && Number(getComputedStyle(contextMenu).zIndex) >= 40),
      executingNode: !!document.querySelector('.model-node--executing .model-node__loading-spinner'),
      progressWidth: progressRect?.width ?? 0,
      textSurfaceNodes: document.querySelectorAll('.model-node--text-surface').length,
      stickyNoteEditor: !!document.querySelector('.model-node--sticky-note .model-node__textarea'),
      rerouteSize: rerouteRect?.width ?? 0,
      meshPreview: !!document.querySelector('[data-id="n7"] .mesh-preview'),
    };
  });

  assertSlavaCheck(stateAssertions.contextMenuItems === 3, 'context menu renders all actions');
  assertSlavaCheck(stateAssertions.connectionPopupCategories >= 1, 'connection popup renders compatible categories');
  assertSlavaCheck(stateAssertions.connectionPopupTopLayer, 'connection popup uses Slava popover layer');
  assertSlavaCheck(stateAssertions.contextMenuTopLayer, 'context menu uses Slava popover layer');
  assertSlavaCheck(stateAssertions.executingNode, 'executing node shows Slava loading indicator');
  assertSlavaCheck(stateAssertions.progressWidth > 0, 'executing node progress bar is visible');
  assertSlavaCheck(stateAssertions.textSurfaceNodes >= 2, 'text input and sticky note render as text surfaces');
  assertSlavaCheck(stateAssertions.stickyNoteEditor, 'sticky note renders inline text editor');
  assertSlavaCheck(stateAssertions.rerouteSize >= 18, 'reroute node keeps Slava dot hit target');
  assertSlavaCheck(stateAssertions.meshPreview, 'mesh node renders preview surface');

  debugStep('visual coverage: mesh modal');
  await evaluate(cdp, () => {
    window.__nebulaUIStore.setState((state) => ({
      contextMenu: { visible: false, position: { x: 0, y: 0 }, nodeId: null },
      connectionPopup: { ...state.connectionPopup, visible: false },
    }));
  });
  await waitForRuntime(cdp, '!document.querySelector(".context-menu") && !document.querySelector(".connection-popup")');
  await clickSelector(cdp, '[data-id="n7"] .mesh-preview');
  await waitForRuntime(cdp, 'document.querySelector(".mesh-modal-overlay") && document.querySelector(".mesh-modal__download")');
  await sleep(200);
  await screenshot(cdp, '09-slava-mesh-modal.png');

  const meshAssertions = await evaluate(cdp, () => ({
    modal: !!document.querySelector('.mesh-modal'),
    closeIcon: !!document.querySelector('.mesh-modal__close-icon'),
    downloadIcon: !!document.querySelector('.mesh-modal__download-icon'),
    viewer: !!document.querySelector('.mesh-modal__viewer'),
  }));
  assertSlavaCheck(meshAssertions.modal, 'mesh modal renders');
  assertSlavaCheck(meshAssertions.closeIcon, 'mesh modal close uses icon contract');
  assertSlavaCheck(meshAssertions.downloadIcon, 'mesh modal download uses icon contract');
  assertSlavaCheck(meshAssertions.viewer, 'mesh modal viewer renders');

  await clickSelector(cdp, '.mesh-modal__close');
  await waitForRuntime(cdp, '!document.querySelector(".mesh-modal-overlay")');
}

async function runSlavaInteractionChecks(cdp) {
  debugStep('interaction: start');
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

  debugStep('interaction: agent log drag/reset');
  const agentLogRectBeforeDrag = await getRect(cdp, '.agent-log');
  await dragSelector(cdp, '.agent-log__drag-row', -84, -38);
  await waitForRuntime(cdp, 'Boolean(window.localStorage.getItem("nebula:agentLog:pos"))');
  const agentLogRectAfterDrag = await getRect(cdp, '.agent-log');
  assertSlavaCheck(
    Math.abs(agentLogRectAfterDrag.left - agentLogRectBeforeDrag.left) >= 30
      || Math.abs(agentLogRectAfterDrag.top - agentLogRectBeforeDrag.top) >= 20,
    'agent log moves after header drag',
  );

  await clickSelector(cdp, 'button[title="Reset panel positions and sizes"]');
  await waitForRuntime(cdp, '!window.localStorage.getItem("nebula:agentLog:pos") && !document.querySelector(".agent-log")?.style.left');
  const agentLogResetAssertions = await evaluate(cdp, () => ({
    persistedPositionCleared: !window.localStorage.getItem('nebula:agentLog:pos'),
    inlinePositionCleared:
      !document.querySelector('.agent-log')?.style.left
      && !document.querySelector('.agent-log')?.style.top,
  }));
  assertSlavaCheck(agentLogResetAssertions.persistedPositionCleared, 'layout reset clears persisted agent log position');
  assertSlavaCheck(agentLogResetAssertions.inlinePositionCleared, 'layout reset clears visible agent log position');

  await clickSelector(cdp, '.settings__toggle-row');
  await waitForRuntime(cdp, '!document.querySelector(".agent-log") && !document.body.classList.contains("agent-log-enabled")');

  debugStep('interaction: image drag');
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

  debugStep('interaction: chat drag/resize');
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
    window.__nebulaChat?.setInput?.('hello from slava check');
  });
  await waitForRuntime(cdp, 'document.querySelector(".chat-panel__textarea")?.value === "hello from slava check"');
  await dispatchDomKey(cdp, '.chat-panel__textarea', 'Enter');
  await waitForRuntime(cdp, 'Array.from(document.querySelectorAll(".chat__bubble--user")).some((el) => el.textContent.includes("hello from slava check"))');
  await waitForRuntime(cdp, 'document.querySelector(".chat-panel__send--stop")');
  await clickSelector(cdp, '.chat-panel__send--stop');
  await waitForRuntime(cdp, 'Array.from(document.querySelectorAll(".chat__system")).some((el) => el.textContent.includes("Cancelled."))');

  debugStep('interaction: chat send assertions');
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

  debugStep('interaction: shift enter');
  await evaluate(cdp, () => {
    window.__nebulaChat?.clear?.();
    window.__nebulaChat?.setInput?.('line one');
  });
  await waitForRuntime(cdp, 'document.querySelector(".chat-panel__textarea")?.value === "line one"');
  await dispatchDomKey(cdp, '.chat-panel__textarea', 'Enter', { shiftKey: true });
  await sleep(100);
  const shiftEnterAssertions = await evaluate(cdp, () => {
    const sockets = window.__slavaMockChatSockets ?? [];
    return {
      noUserBubble: !Array.from(document.querySelectorAll('.chat__bubble--user')).some((el) =>
        el.textContent.includes('line one'),
      ),
      noSendEnvelope: !sockets.some((socket) =>
        socket.sent?.some((msg) => msg.type === 'send' && msg.message === 'line one'),
      ),
    };
  });
  assertSlavaCheck(shiftEnterAssertions.noUserBubble, 'Shift+Enter does not submit chat input');
  assertSlavaCheck(shiftEnterAssertions.noSendEnvelope, 'Shift+Enter does not send a chat envelope');

  debugStep('interaction: connection popup escape');
  await evaluate(cdp, () => {
    const textarea = document.querySelector('.chat-panel__textarea');
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.value = '';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    window.__nebulaUIStore.getState().showConnectionPopup({
      position: { x: 620, y: 430 },
      nodeId: 'n1',
      handleId: 'text',
      handleType: 'source',
    });
  });
  await waitForRuntime(cdp, 'document.querySelector(".connection-popup") && document.activeElement?.classList.contains("connection-popup__search")');
  await dispatchDomKey(cdp, '.connection-popup__search', 'Escape');
  await waitForRuntime(cdp, '!document.querySelector(".connection-popup")');

  debugStep('interaction: tab focus');
  await evaluate(cdp, () => {
    const focusable = Array.from(document.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'));
    const target = focusable.find((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    target?.focus();
  });
  await sleep(80);
  const focusAssertions = await evaluate(cdp, () => {
    const active = document.activeElement;
    const rect = active?.getBoundingClientRect();
    return {
      activeTag: active?.tagName ?? '',
      isInteractive: Boolean(
        active?.matches('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'),
      ),
      isVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
    };
  });
  assertSlavaCheck(focusAssertions.isInteractive, `Slava exposes a visible focus target, got ${focusAssertions.activeTag}`);
  assertSlavaCheck(focusAssertions.isVisible, 'focused Slava element is visible');

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
  debugStep('interaction: complete');
}

async function runSlavaPersistenceChecks(cdp) {
  await evaluate(cdp, () => {
    window.__nebulaUIStore.getState().setSkin('slava-restraint');
    window.__nebulaUIStore.getState().setAgentLogEnabled(true);
    window.localStorage.setItem('nebula:agentLog:pos', JSON.stringify({ left: 84, top: 120 }));
  });

  const loadEvent = cdp.waitForEvent('Page.loadEventFired', 10000).catch(() => null);
  await cdp.send('Page.reload', { ignoreCache: true });
  await loadEvent;
  await waitForRuntime(cdp, 'window.__nebulaUIStore && window.__nebulaGraphStore && document.body.classList.contains("app-slava-restraint")');
  await waitForRuntime(cdp, 'document.querySelector(".agent-log")');

  const persistenceAssertions = await evaluate(cdp, () => {
    const agentLog = document.querySelector('.agent-log');
    const rect = agentLog?.getBoundingClientRect();
    return {
      storedSkin: window.localStorage.getItem('nebula:skin'),
      storeSkin: window.__nebulaUIStore.getState().skin,
      bodySkin: document.body.classList.contains('app-slava-restraint'),
      storedAgentLog: window.localStorage.getItem('nebula:agentLog:enabled'),
      storeAgentLog: window.__nebulaUIStore.getState().agentLogEnabled,
      renderedAgentLog: Boolean(agentLog),
      persistedAgentLogPosition: Boolean(rect && Math.abs(rect.left - 84) <= 1 && Math.abs(rect.top - 120) <= 1),
    };
  });

  assertSlavaCheck(persistenceAssertions.storedSkin === 'slava-restraint', 'Slava skin persists to localStorage');
  assertSlavaCheck(persistenceAssertions.storeSkin === 'slava-restraint', 'Slava skin rehydrates into UI store');
  assertSlavaCheck(persistenceAssertions.bodySkin, 'Slava body class rehydrates after reload');
  assertSlavaCheck(persistenceAssertions.storedAgentLog === '1', 'agent log enabled preference persists to localStorage');
  assertSlavaCheck(persistenceAssertions.storeAgentLog, 'agent log enabled preference rehydrates into UI store');
  assertSlavaCheck(persistenceAssertions.renderedAgentLog, 'agent log renders from persisted preference');
  assertSlavaCheck(persistenceAssertions.persistedAgentLogPosition, 'agent log drag position rehydrates after reload');

  await evaluate(cdp, () => {
    window.__nebulaUIStore.getState().setAgentLogEnabled(false);
    window.localStorage.removeItem('nebula:agentLog:pos');
  });
}

async function runSlavaMobileLayoutChecks(cdp) {
  const mobileAssertions = await evaluate(cdp, () => {
    const selectors = ['.chat-panel', '.toolbar', '.panel--library', '.panel--inspector', '.panel--settings', '.agent-log'];
    const overflow = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (
          rect.left < -1
          || rect.top < -1
          || rect.right > window.innerWidth + 1
          || rect.bottom > window.innerHeight + 1
        ) {
          overflow.push({
            selector,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          });
        }
      }
    }
    return {
      overflow,
      hasHorizontalDocumentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

  assertSlavaCheck(
    mobileAssertions.overflow.length === 0,
    `mobile Slava fixed surfaces stay inside the viewport: ${JSON.stringify(mobileAssertions.overflow)}`,
  );
  assertSlavaCheck(!mobileAssertions.hasHorizontalDocumentOverflow, 'mobile Slava page has no document-level horizontal overflow');
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

function debugStep(message) {
  if (process.env.SLAVA_CHECK_DEBUG_STEPS === '1') {
    console.log(`[slava-check] ${message}`);
  }
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

async function dispatchDomKey(cdp, selector, keyName, init = {}) {
  await evaluate(cdp, (targetSelector, key, eventInit) => {
    const target = document.querySelector(targetSelector);
    if (!target) throw new Error(`Element not found: ${targetSelector}`);
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
      ...eventInit,
    }));
  }, selector, keyName, init);
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

async function waitForPageWebSocket(remotePort, timeout = 30000) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupChromeProfiles() {
  if (!existsSync(OUT_DIR)) return;
  const entries = await readdir(OUT_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chrome-profile-'))
      .map((entry) => rmWithRetry(join(OUT_DIR, entry.name))),
  );
}

async function cleanupScreenshots() {
  if (!existsSync(OUT_DIR)) return;
  const entries = await readdir(OUT_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
      .map((entry) => rm(join(OUT_DIR, entry.name), { force: true })),
  );
}

async function rmWithRetry(path, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(100 * attempt);
    }
  }
  throw lastError;
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
