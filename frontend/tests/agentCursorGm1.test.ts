import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AnchorResolver, CORNER_INSET_PX, LAUNCHER_GAP_PX, cornerPoint, type Box, type ResolverEnv,
} from '../src/lib/agentAnchorResolve';
import { screenSpace } from '../src/lib/agentCursorSpace';
import { HEADER_ICON_X, launcherRestPoint, type AnchorLookup } from '../src/lib/agentCursorMotion';
import { shownAction, useAgentPresenceStore } from '../src/store/agentPresenceStore';
import type { AgentCursorAnchor, AgentPresenceEvent } from '../src/lib/wsClient';

/**
 * PR #243, GM - Design round 1: where a Character's cursor rests (the cover
 * thumbnail, the canvas node's header), a park that would cover another control
 * goes inside its host, and a type or a click at a Character is drawn as a look.
 */

const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
const boxes = new Map<Element, Box>();
const clips = new Map<Element, Box>();
let root: HTMLElement;
let now = 0;
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: (element) => clips.get(element) ?? VIEW,
};
const resolver = () => new AnchorResolver(env, () => (now += 1000));

function put(tag: string, attrs: Record<string, string>, box: Box, parent: Element = root): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  parent.append(el);
  boxes.set(el, box);
  return el;
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
  boxes.clear();
  clips.clear();
  now = 0;
});
afterEach(() => { document.body.innerHTML = ''; });

const character = (itemId: string, part?: string): AgentCursorAnchor => ({ surface: 'character', itemId, ...(part ? { part } : {}) });

describe('ruling 1: a Character rests on its cover thumbnail', () => {
  const PANEL: Box = { left: 60, top: 60, width: 520, height: 700 };
  const THUMB: Box = { left: 76, top: 76, width: 96, height: 96 };
  const NAME: Box = { left: 190, top: 76, width: 300, height: 40 };

  function studio() {
    const panel = put('div', { 'data-agent-anchor': 'character:c1' }, PANEL);
    const thumb = put('div', { 'data-agent-aim': 'character:c1' }, THUMB, panel);
    const name = put('label', { 'data-agent-anchor': 'character:c1:name' }, NAME, panel);
    const view = put('div', { 'data-agent-anchor': 'character:c1/2' }, { left: 76, top: 400, width: 90, height: 90 }, panel);
    return { panel, thumb, name, view };
  }

  it('aims at the thumbnail, the tip in its lower right', () => {
    const { thumb } = studio();
    const result = resolver().resolve(character('c1'));
    expect(result).toMatchObject({ kind: 'anchor', element: thumb });
    if (result.kind !== 'anchor') return;
    expect(result.point).toEqual({ x: THUMB.left + THUMB.width - CORNER_INSET_PX, y: THUMB.top + THUMB.height - CORNER_INSET_PX });
    // Not the panel's standard point (over the Name field).
    expect(result.point).not.toEqual({ x: PANEL.left + PANEL.width / 2, y: PANEL.top + 24 });
  });

  it('a part and a view keep their own anchors', () => {
    const { name, view } = studio();
    expect(resolver().resolve(character('c1', 'name'))).toMatchObject({ kind: 'anchor', element: name });
    expect(resolver().resolve(character('c1/2'))).toMatchObject({ kind: 'anchor', element: view });
  });

  it('a part the panel doesn\'t draw falls back to the panel, not the thumbnail', () => {
    const { panel } = studio();
    expect(resolver().resolve(character('c1', 'seed'))).toMatchObject({ kind: 'anchor', element: panel });
  });

  it('is the Character\'s own: another Character\'s thumbnail is not its aim', () => {
    studio();
    put('div', { 'data-agent-aim': 'character:c2' }, { left: 700, top: 76, width: 96, height: 96 });
    expect(resolver().resolve(character('c1'))).toMatchObject({ kind: 'anchor', point: { x: 166, y: 166 } });
  });

  it('with no thumbnail on screen it is the panel\'s standard point', () => {
    const panel = put('div', { 'data-agent-anchor': 'character:c1' }, PANEL);
    expect(resolver().resolve(character('c1'))).toMatchObject({ kind: 'anchor', element: panel, point: { x: 320, y: 84 } });
  });

  it('a thumbnail scrolled out of its clip is not aimed at', () => {
    const { panel, thumb } = studio();
    clips.set(thumb, { left: 60, top: 300, width: 520, height: 400 });
    expect(resolver().resolve(character('c1'))).toMatchObject({ kind: 'anchor', element: panel });
  });

  it('cornerPoint keeps the tip in a box too small for the inset', () => {
    expect(cornerPoint({ left: 0, top: 0, width: 8, height: 8 })).toEqual({ x: 4, y: 4 });
    expect(cornerPoint({ left: 10, top: 10, width: 100, height: 40 })).toEqual({ x: 104, y: 44 });
  });
});

describe('ruling 4: a park that would cover another control goes inside its host', () => {
  const tabs = (gap: number) => {
    const list = put('div', { role: 'tablist' }, VIEW);
    const moodboards = put('button', { role: 'tab', 'data-agent-launcher': 'moodboard' }, { left: 20, top: 80, width: 90, height: 30 }, list);
    const characters = put('button', { role: 'tab', 'data-agent-launcher': 'character' }, { left: 110 + gap, top: 80, width: 90, height: 30 }, list);
    const styles = put('button', { role: 'tab', 'data-agent-launcher': 'style' }, { left: 200 + 2 * gap, top: 80, width: 90, height: 30 }, list);
    return { moodboards, characters, styles };
  };

  it('a tab with a neighbour 4 px away: the tip is inside the tab, at its lower right', () => {
    const { characters, moodboards } = tabs(4);
    const result = resolver().resolve(character('c9'));
    expect(result).toMatchObject({ kind: 'launcher', step: 'surface', element: characters });
    if (result.kind !== 'launcher') return;
    expect(result.point).toEqual({ x: 114 + 90 - CORNER_INSET_PX, y: 80 + 30 - CORNER_INSET_PX });
    // Inside the Characters tab and clear of the Moodboards tab.
    expect(result.point.x).toBeGreaterThan(114);
    expect(result.point.x).toBeLessThan(114 + 90);
    expect(result.point.x).toBeGreaterThan(20 + 90);
    expect(moodboards).toBeTruthy();
  });

  it('the Moodboards tab, which sat beside on main, goes inside too', () => {
    const { moodboards } = tabs(4);
    expect(resolver().resolve({ surface: 'moodboard', itemId: 'b9' })).toMatchObject({
      kind: 'launcher', element: moodboards, point: { x: 20 + 90 - CORNER_INSET_PX, y: 80 + 30 - CORNER_INSET_PX },
    });
  });

  it('the last tab of a row, with a neighbour only on its left, goes inside as the others do', () => {
    const { styles } = tabs(4);
    expect(resolver().resolve({ surface: 'style', itemId: 's9' })).toMatchObject({
      kind: 'launcher', element: styles, point: { x: 208 + 90 - CORNER_INSET_PX, y: 80 + 30 - CORNER_INSET_PX },
    });
  });

  it('a host with nothing within the gap stays beside', () => {
    tabs(4);
    const alone = put('div', {}, VIEW);
    const last = put('button', { role: 'tab', 'data-agent-launcher': 'style' }, { left: 1000, top: 80, width: 90, height: 30 }, alone);
    // The Styles tab of the first list also matches; the best of equal areas is the first in DOM order, so look at the lone one by itself.
    document.body.replaceChildren(alone);
    expect(resolver().resolve({ surface: 'style', itemId: 's9' })).toMatchObject({
      kind: 'launcher', element: last, point: { x: 1000 + 90 + LAUNCHER_GAP_PX, y: 95 },
    });
  });

  it('a neighbour farther than the gap does not count', () => {
    const { characters } = tabs(14);
    expect(resolver().resolve(character('c9'))).toMatchObject({
      kind: 'launcher', element: characters, point: { x: 110 + 14 + 90 + LAUNCHER_GAP_PX, y: 95 },
    });
  });

  it('the composer\'s Styles button with Enhance 8 px beside it (the real gap): inside the button', () => {
    const row = put('div', {}, VIEW);
    const styles = put('button', { 'data-agent-launcher': 'style' }, { left: 400, top: 700, width: 70, height: 32 }, row);
    put('button', {}, { left: 478, top: 700, width: 100, height: 32 }, row);
    expect(resolver().resolve({ surface: 'style', itemId: 's9' })).toMatchObject({
      kind: 'launcher', element: styles, point: { x: 400 + 70 - CORNER_INSET_PX, y: 700 + 32 - CORNER_INSET_PX },
    });
  });

  it('a control hidden by its clip does not count', () => {
    const row = put('div', {}, VIEW);
    const host = put('button', { 'data-agent-launcher': 'style' }, { left: 400, top: 700, width: 70, height: 32 }, row);
    const hidden = put('button', {}, { left: 474, top: 700, width: 100, height: 32 }, row);
    clips.set(hidden, { left: 0, top: 0, width: 300, height: 900 });
    expect(resolver().resolve({ surface: 'style', itemId: 's9' })).toMatchObject({
      kind: 'launcher', element: host, point: { x: 476, y: 716 },
    });
  });

  it('the rail\'s button stays beside, a control next to it or not', () => {
    const rail = put('button', { 'data-agent-launcher': 'moodboard character style', 'data-rail-item': '' }, { left: 8, top: 400, width: 44, height: 44 });
    put('button', {}, { left: 54, top: 400, width: 44, height: 44 });
    expect(resolver().resolve(character('c9'))).toMatchObject({
      kind: 'launcher', step: 'surface', element: rail, point: { x: 58, y: 422 },
    });
  });

  it('an item\'s own row (step 2) and the canvas button are not moved', () => {
    const row = put('button', { 'data-agent-launcher': 'character:c9' }, { left: 20, top: 300, width: 280, height: 56 });
    put('button', {}, { left: 304, top: 300, width: 80, height: 56 });
    expect(resolver().resolve(character('c9'))).toMatchObject({ kind: 'launcher', step: 'board', element: row, point: { x: 306, y: 328 } });
  });
});

describe('ruling 2: a launcher that is a canvas node rests where the canvas rests', () => {
  function space(launcherRest?: (launcher: Element) => { x: number; y: number } | null) {
    return screenSpace({
      resolver: resolver(), measure: env.measure, pane: () => document.body, canvasMounted: () => true,
      gone: () => false, events: () => () => {}, launcherRest,
    });
  }
  const NODE: Box = { left: 600, top: 300, width: 240, height: 200 };

  it('moves the park\'s tip, and leaves the element and the box (the corner dot) as they were', () => {
    const node = put('div', { 'data-agent-launcher': 'character:c1' }, NODE);
    const seen: Element[] = [];
    const s = space((launcher) => { seen.push(launcher); return { x: 618, y: 344 }; });
    expect(s.resolve(character('c1'))).toEqual({ x: 618, y: 344 });
    expect(seen).toEqual([node]);
    expect(s.resolution(character('c1'))).toMatchObject({ kind: 'launcher', step: 'board', element: node, box: NODE });
    expect(s.launcherOf(character('c1'))).toEqual({ element: node, box: NODE });
  });

  it('without a rest the park is beside the node, as before', () => {
    put('div', { 'data-agent-launcher': 'character:c1' }, NODE);
    expect(space(() => null).resolve(character('c1'))).toEqual({ x: 600 + 240 + LAUNCHER_GAP_PX, y: 400 });
    expect(space().resolve(character('c1'))).toEqual({ x: 600 + 240 + LAUNCHER_GAP_PX, y: 400 });
  });

  it('is asked only for an item\'s own launcher, never a tab or the rail\'s button', () => {
    put('button', { 'data-agent-launcher': 'character' }, { left: 20, top: 80, width: 90, height: 30 });
    let asked = 0;
    expect(space(() => { asked += 1; return { x: 1, y: 1 }; }).resolve(character('c1'))).toEqual({ x: 116, y: 95 });
    expect(asked).toBe(0);
  });
});

describe('ruling 2: the rest on a launcher node is the card\'s own title row, measured', () => {
  const rect = (left: number, top: number, width: number, height: number) => () => new DOMRect(left, top, width, height);
  /** A canvas at zoom `zoom` with node n7 at flow (600, 300), drawn at client (100, 50). */
  function canvas(titleClass: string, zoom = 1, icon = false) {
    const pane = document.createElement('div');
    const wrap = document.createElement('div');
    wrap.className = 'react-flow__node';
    wrap.dataset.id = 'n7';
    wrap.getBoundingClientRect = rect(100, 50, 240 * zoom, 300 * zoom);
    const title = document.createElement('div');
    title.className = titleClass;
    // A Character node's title row: 14 px in and 12 px down from the card, 20 px tall (no category label above it).
    title.getBoundingClientRect = rect(100 + 14 * zoom, 50 + 12 * zoom, 212 * zoom, 20 * zoom);
    if (icon) {
      const mark = document.createElement('span');
      mark.className = 'model-node__type-icon';
      mark.getBoundingClientRect = rect(100 + 16 * zoom, 50 + 14 * zoom, 16 * zoom, 16 * zoom);
      title.append(mark);
    }
    wrap.append(title);
    pane.append(wrap);
    root.append(pane);
    const lookup = new Map([['n7', { internals: { positionAbsolute: { x: 600, y: 300 } }, measured: { width: 240, height: 300 } }]]) as unknown as AnchorLookup;
    return { pane, lookup };
  }

  it('a Character node: the first glyph of its title row, not 44 px down over the thumbnail', () => {
    const { pane, lookup } = canvas('character-node__title');
    // 14 px into the row (its first glyph), on the row's middle: (14 + 14, 12 + 10) from the card's corner.
    expect(launcherRestPoint({ nodeId: 'n7' }, lookup, { dom: pane, zoom: 1 })).toEqual({ x: 600 + 28, y: 300 + 22 });
  });

  it('a Moodboard node reads its own title row the same way, at any zoom', () => {
    const { pane, lookup } = canvas('moodboard-node__title', 2);
    expect(launcherRestPoint({ nodeId: 'n7' }, lookup, { dom: pane, zoom: 2 })).toEqual({ x: 600 + 28, y: 300 + 22 });
  });

  it('a header with an icon: the icon\'s centre, waiting or not', () => {
    const { pane, lookup } = canvas('model-node__header', 1, true);
    expect(launcherRestPoint({ nodeId: 'n7' }, lookup, { dom: pane, zoom: 1 })).toEqual({ x: 600 + 24, y: 300 + 22 });
  });

  it('with nothing to measure it is the fallback: HEADER_ICON_X in, 44 px down', () => {
    const { lookup } = canvas('character-node__title');
    expect(launcherRestPoint({ nodeId: 'n7' }, lookup)).toEqual({ x: 600 + HEADER_ICON_X, y: 300 + 44 });
    expect(launcherRestPoint({ nodeId: 'n7', handle: 'out' }, lookup)).toBeNull();
    expect(launcherRestPoint({ nodeId: 'gone' }, lookup)).toBeNull();
  });
});

describe('ruling 3: a type or a click at a Character is a look', () => {
  const event = (overrides: Partial<AgentPresenceEvent>): AgentPresenceEvent => ({
    type: 'agentPresence', agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
    target: { surface: 'character', itemId: 'c1' }, anchorNames: { character: 'Mara' }, action: 'type', say: '', at: 0, ...overrides,
  } as AgentPresenceEvent);
  const stored = () => Object.values(useAgentPresenceStore.getState().agents)[0].action;
  beforeEach(() => useAgentPresenceStore.getState().clear());

  it.each(['type', 'click'] as const)('%s at the Character, a view or a part is stored as look', (action) => {
    for (const target of [{ surface: 'character', itemId: 'c1' }, { surface: 'character', itemId: 'c1/2' },
      { surface: 'character', itemId: 'c1', part: 'traits' }] as const) {
      useAgentPresenceStore.getState().clear();
      useAgentPresenceStore.getState().apply(event({ action, target }));
      expect(stored(), JSON.stringify(target)).toBe('look');
    }
  });

  it('keeps every other action at a Character, and type and click on a Style, a board and a node', () => {
    for (const action of ['move', 'look', 'think', 'drag', 'run', 'propose', 'wait', 'error'] as const) {
      useAgentPresenceStore.getState().clear();
      useAgentPresenceStore.getState().apply(event({ action }));
      expect(stored()).toBe(action);
    }
    for (const target of [{ surface: 'style', itemId: 's1' }, { surface: 'moodboard', itemId: 'b1' }, { nodeId: 'n1' }, { x: 1, y: 2 }] as const) {
      useAgentPresenceStore.getState().clear();
      useAgentPresenceStore.getState().apply(event({ action: 'type', target: target as AgentCursorAnchor }));
      expect(stored(), JSON.stringify(target)).toBe('type');
    }
  });

  it('shownAction is the one rule', () => {
    expect(shownAction('type', { surface: 'character', itemId: 'c1' })).toBe('look');
    expect(shownAction('click', { surface: 'character', itemId: 'c1' })).toBe('look');
    expect(shownAction('type', { surface: 'style', itemId: 's1' })).toBe('type');
  });

  it('a replayed cursor is shown as a look too', () => {
    useAgentPresenceStore.getState().replay([event({ action: 'click' }) as unknown as Record<string, unknown>] as never, 1000);
    expect(stored()).toBe('look');
  });
});
