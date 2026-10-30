import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ReactElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CinemaSceneSpec, NodeData } from '../src/types';

/**
 * Round 23 of PR #195 (review 22, L-3): the read-only state reaches every
 * control that acts, and the ratchet is one that would have caught the
 * misses. Review 22: "Make the ratchet render-based. Mount each canvas
 * surface in a follow and assert that every button/input not on an explicit
 * allowlist carries data-following-disabled. Or grep for onClick handlers
 * that call an EDIT_GATES action from a file that doesn't apply lock.act."
 * Both, here:
 * 1. Static: every component that reaches a gated store action (EDIT_GATES)
 *    or a pin write reads the canvas lock, or names the locked surfaces it
 *    hands its actions to (which are rendered below).
 * 2. Rendered: each of those surfaces, following, offline, and offline plus
 *    following: every button, input, select and textarea is disabled (or
 *    read-only) and marked, unless it is on that surface's list of controls
 *    that only look, copy or stop (GM: Settings and Copy stay enabled; a stop
 *    is never refused).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/hooks/useRenderJob', () => ({
  useRenderJob: () => ({ job: null, error: null, begin: vi.fn(), cancel: vi.fn(), reset: vi.fn() }),
}));
vi.mock('../src/components/create-studio/ParamPills', () => ({ ParamPills: () => null }));

import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { CinemaShotsRail } from '../src/components/cinema-studio/CinemaShotsRail';
import { CinemaStudioToolbar } from '../src/components/cinema-studio/CinemaStudioToolbar';
import { CommandPalette } from '../src/components/CommandPalette';
import { CreateComposer } from '../src/components/create-studio/CreateComposer';
import { ResultCard } from '../src/components/create-studio/ResultCard';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';
import { CharacterTestPanel } from '../src/components/character-studio/CharacterTestPanel';
import { ProviderRecoveryStatus } from '../src/components/ProviderRecoveryStatus';
import { PinComposer } from '../src/components/canvas/PinComposer';
import { RemotionEditorToolbar } from '../src/components/video-editor/RemotionEditorToolbar';
import { RemotionPropertiesPanel } from '../src/components/video-editor/RemotionPropertiesPanel';
import { EditorTransport } from '../src/components/editor/EditorTransport';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { buildCommands } from '../src/lib/commandPalette';
import { COMMAND_PALETTE_OPEN_EVENT } from '../src/lib/commandPaletteKeys';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { gatedGraphActions, useGraphStore } from '../src/store/graphStore';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const INITIAL_PINS = { ...useCanvasPinsStore.getState() };
const WAIT = 'Wait for “beta” to open.';

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  resetCanvasFollowForTests();
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  useCanvasPinsStore.setState(INITIAL_PINS, true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  resetCanvasFollowForTests();
  resetBackendConnectionForTests();
  vi.unstubAllGlobals();
});

// ── 1. Static ───────────────────────────────────────────────────────────────

const SRC = join(__dirname, '../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
});

/** Components that reach a gated action but hand every control that acts to
 * other components; each named delegate must read the lock and be rendered
 * below. */
const DELEGATES: Record<string, string[]> = {
  'components/cinema-studio/CinemaStudioView.tsx': ['CinemaShotsRail', 'CinemaShotPanel'],
  'components/create-studio/CreateView.tsx': ['CreateComposer', 'ResultCard'],
};

/** What each file reaches: the gated store actions it selects or calls, and
 * the pin writes. */
function gatedUses(source: string): string[] {
  const names = gatedGraphActions().join('|');
  const store = new RegExp(`(?:\\(\\s*(\\w+)\\s*\\)\\s*=>\\s*\\1\\.|getState\\(\\)\\.|\\bstore\\.|\\blifecycle\\.)(${names})\\b`, 'g');
  const pins = /useCanvasPinsStore(?:\(\(\w+\)\s*=>\s*\w+|\.getState\(\))\.(submit|remove|compose)\b/g;
  return [...new Set([...source.matchAll(store)].map((m) => m[2]).concat([...source.matchAll(pins)].map((m) => m[1])))];
}

describe('L-3 static: every component that reaches a canvas edit reads the lock', () => {
  it('finds them (the scan itself works)', () => {
    const shotPanel = readFileSync(join(SRC, 'components/cinema-studio/CinemaShotPanel.tsx'), 'utf8');
    expect(gatedUses(shotPanel)).toEqual(expect.arrayContaining(['executeShot']));
  });

  it('each reads useCanvasLock (or gates its drags with refuseCanvasEdit), or names its locked delegates', () => {
    const missing = files(join(SRC, 'components')).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const uses = gatedUses(source);
      if (uses.length === 0) return [];
      const file = relative(SRC, path);
      if (/\buseCanvasLock\(|\brefuseCanvasEdit\(/.test(source)) return [];
      if (DELEGATES[file]) return [];
      return [`${file}: ${uses.join(', ')}`];
    });
    expect(missing).toEqual([]);
  });

  it('each delegate reads the lock and is a rendered surface below', () => {
    for (const delegate of Object.values(DELEGATES).flat()) {
      const path = files(join(SRC, 'components')).find((file) => file.endsWith(`/${delegate}.tsx`));
      expect(path, delegate).toBeDefined();
      expect(readFileSync(path!, 'utf8'), delegate).toMatch(/\buseCanvasLock\(/);
      expect(Object.keys(SURFACES), delegate).toContain(delegate);
    }
  });

  it('the command palette: every command says whether it acts, and the ones that only look are named', () => {
    const LOOKS = /^(action:save|action:fit|view:.*|canvas:.*)$/;
    const commands = buildCommands({
      addNodeAtCenter: vi.fn(), runGraph: vi.fn(), save: vi.fn(), load: vi.fn(), fitView: vi.fn(),
      enterCreateView: vi.fn(), togglePanel: vi.fn(), startAgentQuery: vi.fn(),
      canRun: true, canSave: true, canLoad: true, canvasNodes: [{ id: 'n1', label: 'Hero' }], focusNode: vi.fn(),
    });
    const unsorted = commands.filter((command) => !command.acts && !LOOKS.test(command.id)).map((command) => command.id);
    expect(unsorted).toEqual([]);
    for (const id of ['action:run', 'action:load', 'agent:ask', `node:${Object.keys(NODE_DEFINITIONS)[0]}`]) {
      expect(commands.find((command) => command.id === id)?.acts, id).toBe(true);
    }
  });
});

// ── 2. Rendered ─────────────────────────────────────────────────────────────

type Mode = 'following' | 'offline' | 'offline and following';
const MODES: Mode[] = ['following', 'offline', 'offline and following'];

function enter(mode: Mode) {
  act(() => {
    if (mode !== 'following') noteBackendConnection('offline');
    if (mode !== 'offline') setFollowingSwitch({ projectName: 'beta', agent: 'Codex' });
  });
}

/** A control's name as it reads unlocked: aria-label, its label, its title, its text,
 * its placeholder, else its tag, class and type. */
function nameOf(control: HTMLElement): string {
  const label = (control as HTMLInputElement).labels?.[0]?.textContent?.trim();
  return control.getAttribute('aria-label') ?? (label || null) ?? control.getAttribute('title')
    ?? (control.textContent?.trim() || control.getAttribute('placeholder')
      || `<${control.tagName.toLowerCase()}.${control.className} ${control.getAttribute('type') ?? ''}>`);
}

/** Disabled (itself, a disabled fieldset, aria-disabled) or read-only. */
function isLocked(control: HTMLElement): boolean {
  if (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true') return true;
  return (control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement) && control.readOnly;
}

/** The mark on the control or the fieldset that disables it. */
function marked(control: HTMLElement, attribute: string): boolean {
  return control.hasAttribute(attribute) || Boolean(control.closest(`fieldset[${attribute}]`));
}
function titleOf(control: HTMLElement): string | null {
  return control.getAttribute('title') ?? control.closest('fieldset[title]')?.getAttribute('title') ?? null;
}

interface Surface {
  /** Mounts it unlocked; returns the element its controls are in. */
  mount: () => HTMLElement;
  /** The controls that only look, copy, stop or edit something other than
   * the canvas (by name), with the reason in a comment. */
  looks: RegExp[];
}

const sceneSpec = (): CinemaSceneSpec => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
  shots: [{ id: 'a', prompt: 'Logo', output: { status: 'done', imageUrl: '/a.png' } }, { id: 'b', prompt: 'Two' }] } as never);

function cinemaScene(): CinemaSceneSpec {
  const spec = sceneSpec();
  const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
    data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene: spec }, state: 'idle', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false });
  useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
  return spec;
}

const at = (element: ReactElement) => render(element).container;

const SURFACES: Record<string, Surface> = {
  CinemaShotPanel: {
    mount: () => {
      const spec = cinemaScene();
      return at(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
    },
    looks: [],
  },
  CinemaShotsRail: {
    mount: () => {
      const spec = cinemaScene();
      return at(<CinemaShotsRail cinemaNodeId="n1" scene={spec} selectedShotId="a" onSelect={vi.fn()}
        onAddShot={vi.fn()} onRemoveShot={vi.fn()} onReorder={vi.fn()} />);
    },
    // Selecting a shot only looks.
    looks: [/^Select Shot/],
  },
  CinemaStudioToolbar: {
    mount: () => { cinemaScene(); return at(<CinemaStudioToolbar cinemaNodeId="n1" />); },
    // Back and Run history navigate.
    looks: [/^Back to/, /^Run history$/],
  },
  CommandPalette: {
    mount: () => {
      useGraphStore.setState({ nodes: [], edges: [] });
      const container = at(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
      act(() => { window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT)); });
      return document.querySelector('.command-palette') as HTMLElement ?? container;
    },
    // The search field; Save exports a file; Fit view, the views and the
    // panels only look.
    looks: [/^Search commands and nodes/, /^Save graph/, /^Fit view/, /^Open Creator Studio/, /^Keyboard shortcuts/, /^Toggle /],
  },
  CreateComposer: {
    mount: () => at(<CreateComposer modelDef={NODE_DEFINITIONS['nano-banana'] as never} prompt="Synthetic prompt" params={{}}
      activeCount={0} maxConcurrent={2} quantity={1} onGenerate={vi.fn()} onPromptChange={vi.fn()} onSelectModel={vi.fn()}
      onParamsChange={vi.fn()} onAttach={vi.fn()} onQuantityChange={vi.fn()} onOpenStyles={vi.fn()} />),
    // The Create session's own draft (createDraftStore, in the browser): the
    // prompt, references, model, styles, Enhance and the count.
    looks: [/^Connection settings/, /^Synthetic prompt|<textarea/, /^Attach reference image$/, /^Nano Banana|^Select model/, /^Browse styles$/, /^Enhance/, /^Fewer$/, /^More$/, /<input\. file>/],
  },
  ResultCard: {
    mount: () => {
      const node: Node<NodeData> = { id: 'g1', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'g1', definitionId: 'nano-banana', params: {}, state: 'complete', outputs: { image: { type: 'Image', value: '/api/outputs/a.png' } } } };
      return at(<ResultCard node={node} onOpenInCanvas={vi.fn()} onUseAsInput={vi.fn()} onDelete={vi.fn()} onZoom={vi.fn()} />);
    },
    // Zoom, Download, Open in canvas, Use as input (the draft), Reveal and
    // Save to folder only look or copy.
    looks: [/zoom|View full screen/i, /^Download/, /^Open in canvas$/, /^Use as input$/, /^Reveal in Finder$/, /^Save to folder$|^Saving…$|^Saved!$/],
  },
  CanvasUndoNotice: {
    mount: () => {
      const entry = { id: 'e1', before: { nodes: {}, edges: [] }, after: { nodes: {}, edges: [] } };
      useGraphStore.setState({ undoStack: [entry as never], redoStack: [],
        undoNotice: { id: 1, text: 'Codex changed the canvas.', offer: 'undo', entry: entry as never } as never });
      return at(<CanvasUndoNotice />);
    },
    looks: [/^Dismiss$/],
  },
  CharacterTestPanel: {
    mount: () => at(<CharacterTestPanel characterId="saved-character" thumbnail="/one.png" canTest
      draft={{ name: 'Saved character', subjectType: 'human', referenceViews: ['/1.png', '/2.png', '/3.png'],
        frozenTraitString: 'Traits', seed: 2, consistencyStrength: 0.8 } as never} />),
    // The test prompt is guidance kept in the panel.
    looks: [/^Test prompt \(guidance\)$/],
  },
  ProviderRecoveryStatus: {
    mount: () => {
      useGraphStore.setState({ providerRecoveryWarning: null, uncertainWorldLabsRunId: null, providerRecoveries: [],
        providerStartAmbiguities: [{ runId: 'run-1', nodeId: 'world-1', kind: 'worldlabs-environment',
          message: 'Check Marble first.', durable: true }] as never });
      return at(<ProviderRecoveryStatus />);
    },
    looks: [],
  },
  PinComposer: {
    // Offline only: a follow closes the dialog (round23Store, M-1).
    mount: () => {
      useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
      render(<PinComposer />);
      // The dialog is portaled.
      return document.body;
    },
    // Typing is kept; Cancel only closes.
    looks: [/^Note for agents$/, /^Cancel$/],
  },
  RemotionEditorToolbar: {
    mount: () => {
      remotionNode();
      return at(<RemotionEditorToolbar remotionNodeId="r1" />);
    },
    // REC is a drag mode; Export makes a file.
    looks: [/record keyframes|Recording keyframes/, /Export$/],
  },
  RemotionPropertiesPanel: {
    mount: () => { remotionNode(); return at(<RemotionPropertiesPanel remotionNodeId="r1" />); },
    looks: [],
  },
  EditorTransport: {
    mount: () => {
      const clip = { id: 'c1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, volume: 1, mute: false };
      const node: Node<NodeData> = { id: 'e1', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'Edit', definitionId: 'video-edit', params: { clips: [clip], sourceFps: 30 }, state: 'idle', outputs: {} } };
      useGraphStore.setState({ nodes: [node] });
      useUIStore.setState({ selectedClipId: 'c1' });
      return at(<EditorTransport editNode={node} sourceUrl="/api/outputs/a.mp4" />);
    },
    // Play, the edit points, Trim/Speed/Vol (select and focus) and zoom only
    // look. Render Preview and Export… lock since PR #200's fix round 3
    // (review 3 LOW-4: they start a render on the backend).
    looks: [/^Play|^Pause/, /edit point/i, /^Drag the clip edges to trim$/, /^Adjust playback speed$/, /^Adjust volume \/ mute$/,
      /zoom/i],
  },
};

function remotionNode() {
  const item = { id: 't1', sourceNodeId: 'src-1', componentType: 'TextNode', time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 100, y: 50, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] }, keyframes: {}, props: { text: 'hello' } };
  useGraphStore.setState({ nodes: [{ id: 'r1', type: 'remotionNode', position: { x: 0, y: 0 },
    data: { definitionId: 'remotion-node', label: 'R', params: { manifest: { graph: { nodes: [], edges: [] }, timeline: [item] } },
      state: 'idle', outputs: {} } } as never] });
  useUIStore.setState({ selectedTrackItemId: 't1' });
}

const CONTROLS = 'button, input, select, textarea';

describe('L-3 rendered: every control that acts is locked', () => {
  for (const [name, surface] of Object.entries(SURFACES)) {
    for (const mode of MODES) {
      if (name === 'PinComposer' && mode !== 'offline') continue;
      it(`${name}, ${mode}`, () => {
        const root = surface.mount();
        // Names are read unlocked (a locked control's title is GM's line).
        const names = new Map([...root.querySelectorAll<HTMLElement>(CONTROLS)].map((control) => [control, nameOf(control)]));
        const looks = (control: HTMLElement) => surface.looks.some((re) => re.test(names.get(control) ?? nameOf(control)));
        expect([...names.keys()].filter((control) => !looks(control)).length, `${name} renders controls that act`).toBeGreaterThan(0);
        enter(mode);
        const controls = [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter((control) => !looks(control));
        const wrong = controls.flatMap((control) => {
          const problems: string[] = [];
          if (!isLocked(control)) problems.push('enabled');
          if (mode !== 'offline' && !marked(control, 'data-following-disabled')) problems.push('no following mark');
          if (mode !== 'following' && !marked(control, 'data-offline-disabled')) problems.push('no offline mark');
          if (mode !== 'offline' && titleOf(control) !== WAIT) problems.push(`title ${JSON.stringify(titleOf(control))}`);
          return problems.length ? [`${names.get(control) ?? nameOf(control)}: ${problems.join(', ')}`] : [];
        });
        expect(wrong).toEqual([]);
      });
    }
  }

  it('PinComposer, following: the dialog closes (its text is kept; round23Store)', () => {
    SURFACES.PinComposer.mount();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    enter('following');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('back to normal when the follow ends: the Cinema shot panel acts again', () => {
    const root = SURFACES.CinemaShotPanel.mount();
    enter('following');
    act(() => setFollowingSwitch(null));
    const generate = [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Generate shot')!;
    expect(generate).toBeEnabled();
    expect(generate).not.toHaveAttribute('data-following-disabled');
  });
});

describe('L-3: a locked primary action looks neutral, never orange (GM blocker A)', () => {
  // GM r24 item 2 made this one rule for every reason a button is disabled
  // (styles/disabled-buttons.css); agentPresenceFollowups.ratchet holds it
  // for every accent-filled button. Here: the two GM named are in it.
  it('Cinema\'s Generate shot and Create\'s Generate, while following or offline', () => {
    const shared = readFileSync(join(__dirname, '../src/styles/disabled-buttons.css'), 'utf8');
    for (const selector of ['.cinema-shot-panel__action--primary', '.create-composer__generate']) expect(shared).toContain(selector);
    expect(shared).toMatch(/:is\(:disabled, \[aria-disabled='true'\]\)/);
    expect(shared).not.toMatch(/background:[^;]*--sr-accent/);
  });
});
