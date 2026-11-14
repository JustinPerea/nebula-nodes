import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentAnchor, agentLauncher, surfaceAnchor } from '../src/lib/agentAnchors';
import { AnchorResolver, LAUNCHER_GAP_PX, anchorValues, type Box, type ResolverEnv } from '../src/lib/agentAnchorResolve';
import { AGENT_SURFACES, AGENT_SURFACE_NAMES, surfaceNamesOf } from '../src/lib/agentSurfaces';
import { itemIsGone } from '../src/lib/agentSurfaceGone';
import { AGENT_SURFACE_PART_LABELS, CS_SAY_EXAMPLES, SURFACE_SAY_EXAMPLES, surfaceSay } from '../src/lib/agentCursorSays';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import type { AgentCursorAnchor, AgentPresenceEvent } from '../src/lib/wsClient';

/** The Characters and Styles surfaces of the agent cursor: the protocol's
 *  validation, the attribute grammar, the resolver chain over fake rects, the
 *  default lines word for word, and the labels pinned to the Studio's text. */

const SRC = resolve(__dirname, '../src');
const AGENT = { id: 'claude', name: 'Claude', color: '#E8825A', verified: true };
const event = (target: unknown, extra: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent =>
  ({ type: 'agentPresence', agent: AGENT, action: 'look', say: '', at: 1, target, ...extra }) as AgentPresenceEvent;
const stored = () => useAgentPresenceStore.getState().agents.claude;

beforeEach(() => useAgentPresenceStore.setState({ agents: {} }));

describe('the protocol', () => {
  it('holds the three surfaces in one table', () => {
    expect(AGENT_SURFACE_NAMES).toEqual(['moodboard', 'character', 'style']);
    expect(Object.keys(AGENT_SURFACES.character.parts)).toEqual(['name', 'subject-type', 'views', 'traits', 'seed']);
    expect(Object.keys(AGENT_SURFACES.style.parts)).toEqual(['name', 'category', 'prompt', 'settings', 'model', 'references', 'thumbnail']);
    expect(AGENT_SURFACES.style.sub).toBeNull();
  });

  it('accepts a character, a view of it and a control, and a style', () => {
    for (const target of [
      { surface: 'character', itemId: 'ab12' },
      { surface: 'character', itemId: 'ab12/2' },
      { surface: 'character', itemId: 'ab12', part: 'traits' },
      { surface: 'style', itemId: 'cd34' },
      { surface: 'style', itemId: 'cd34', part: 'prompt' },
      { surface: 'moodboard', itemId: 'b1/i1', part: 'note' },
    ]) {
      useAgentPresenceStore.setState({ agents: {} });
      useAgentPresenceStore.getState().apply(event(target), 1000);
      expect(stored()?.target, JSON.stringify(target)).toEqual(target);
    }
  });

  it('refuses an unknown surface, a bad id, a view that is not a position and a sub-item of a style', () => {
    for (const bad of [
      { surface: 'characters', itemId: 'ab12' },
      { surface: 'palette', itemId: 'ab12' },
      { surface: 'character' },
      { surface: 'character', itemId: 'a b' },
      { surface: 'character', itemId: 'ab12/' },
      { surface: 'character', itemId: 'ab12/0' },
      { surface: 'character', itemId: 'ab12/two' },
      { surface: 'character', itemId: 'ab12/1/2' },
      { surface: 'style', itemId: 'cd34/1' },
      { surface: 'style', itemId: 'cd34', part: 7 },
    ]) {
      useAgentPresenceStore.getState().apply(event(bad), 1000);
      expect(useAgentPresenceStore.getState().agents, JSON.stringify(bad)).toEqual({});
    }
  });

  it('cleans the names: each surface keeps its own keys only', () => {
    const apply = (target: unknown, anchorNames: unknown) => {
      useAgentPresenceStore.setState({ agents: {} });
      useAgentPresenceStore.getState().apply(event(target, { anchorNames } as Partial<AgentPresenceEvent>), 1000);
      return stored()?.anchorNames;
    };
    expect(apply({ surface: 'character', itemId: 'c1/2' }, { character: 'Mara', view: 2, part: 'Seed', board: 'x', image: 4 }))
      .toEqual({ character: 'Mara', view: 2, part: 'Seed' });
    expect(apply({ surface: 'style', itemId: 's1' }, { style: 'Dusk grain', part: 'prompt', view: 3 }))
      .toEqual({ style: 'Dusk grain', part: 'prompt' });
    expect(apply({ surface: 'moodboard', itemId: 'b1/i1' }, { board: 'Desert light', image: 12, character: 'x' }))
      .toEqual({ board: 'Desert light', image: 12 });
    // The name under another surface's key, or none, is no names at all.
    expect(apply({ surface: 'character', itemId: 'c1' }, { board: 'Mara' })).toBeUndefined();
    expect(apply({ surface: 'style', itemId: 's1' }, { style: '' })).toBeUndefined();
  });

  it('reads the names of any surface the same way', () => {
    expect(surfaceNamesOf('character', { character: 'Mara', view: 2, part: 'Seed' })).toEqual({ name: 'Mara', sub: 2, part: 'Seed' });
    expect(surfaceNamesOf('style', { style: 'Dusk grain', part: 'prompt' })).toEqual({ name: 'Dusk grain', sub: null, part: 'prompt' });
    expect(surfaceNamesOf('moodboard', { board: 'B', image: 3 })).toEqual({ name: 'B', sub: 3, part: null });
  });
});

describe('the attribute grammar', () => {
  it('builds <surface>:<item>[/<sub>][:<part>]', () => {
    expect(surfaceAnchor('character', 'ab12')).toBe('character:ab12');
    expect(surfaceAnchor('character', 'ab12', '2')).toBe('character:ab12/2');
    expect(surfaceAnchor('character', 'ab12', null, 'traits')).toBe('character:ab12:traits');
    expect(surfaceAnchor('style', 'cd34')).toBe('style:cd34');
    expect(agentAnchor('b1', 'i2', 'note')).toBe('moodboard:b1/i2:note');
  });

  it('builds none for an id the selector could not hold', () => {
    for (const bad of ['', 'a b', 'a"b', 'a]b', 'x'.repeat(65)]) {
      expect(surfaceAnchor('character', bad), bad).toBeUndefined();
      // An empty sub or part is none, not a bad one.
      if (bad === '') continue;
      expect(surfaceAnchor('character', 'ab', bad), bad).toBeUndefined();
      expect(surfaceAnchor('style', 'ab', null, bad), bad).toBeUndefined();
    }
    expect(surfaceAnchor('a b', 'ab')).toBeUndefined();
    expect(surfaceAnchor('character', null)).toBeUndefined();
  });

  it('builds launchers: a surface, an item, the canvas, and several surfaces in space-separated tokens', () => {
    expect(agentLauncher('character')).toBe('character');
    expect(agentLauncher('style', 'cd34')).toBe('style:cd34');
    expect(agentLauncher('canvas')).toBe('canvas');
    expect(agentLauncher(['moodboard', 'character', 'style'])).toBe('moodboard character style');
    expect(agentLauncher('character', 'a b')).toBeUndefined();
    expect(agentLauncher(['moodboard', 'a b'])).toBeUndefined();
    expect(agentLauncher([])).toBeUndefined();
  });

  it('tries the part, then the item; a view takes no part; a style has no part in the DOM', () => {
    expect(anchorValues({ surface: 'character', itemId: 'c1', part: 'traits' })).toEqual(['character:c1:traits', 'character:c1']);
    expect(anchorValues({ surface: 'character', itemId: 'c1/2' })).toEqual(['character:c1/2']);
    expect(anchorValues({ surface: 'style', itemId: 's1', part: 'prompt' })).toEqual(['style:s1:prompt', 'style:s1']);
    expect(anchorValues({ surface: 'style', itemId: 's1' })).toEqual(['style:s1']);
  });
});

describe('the resolver chain', () => {
  const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
  const boxes = new Map<Element, Box>();
  const clips = new Map<Element, Box>();
  const root = document.createElement('div');
  const env: ResolverEnv = {
    query: (selector) => Array.from(root.querySelectorAll(selector)),
    measure: (element) => boxes.get(element) ?? null,
    clip: (element) => clips.get(element) ?? VIEW,
  };
  const put = (attrs: Record<string, string | undefined>, box: Box, clip: Box = VIEW, inRail = false): Element => {
    const element = document.createElement('div');
    for (const [name, value] of Object.entries(attrs)) if (value !== undefined) element.setAttribute(name, value);
    if (inRail) element.setAttribute('data-rail-item', '');
    root.append(element);
    boxes.set(element, box);
    clips.set(element, clip);
    return element;
  };
  const anchor = (surface: 'character' | 'style', itemId: string, part?: string): AgentCursorAnchor =>
    ({ surface, itemId, ...(part ? { part } : {}) });
  const resolver = () => new AnchorResolver(env, () => 0);
  const RAIL_BUTTON = { 'data-agent-launcher': 'moodboard character style' };

  beforeEach(() => {
    root.replaceChildren();
    document.body.replaceChildren(root);
    boxes.clear();
    clips.clear();
  });

  it('a character row: aims at it, a control and a view at their own elements', () => {
    const row = put({ 'data-agent-anchor': 'character:c1', 'data-agent-launcher': 'character:c1' }, { left: 20, top: 200, width: 280, height: 56 });
    const studio = put({ 'data-agent-anchor': 'character:c1' }, { left: 400, top: 100, width: 600, height: 700 });
    const traits = put({ 'data-agent-anchor': 'character:c1:traits' }, { left: 420, top: 600, width: 500, height: 120 });
    const view = put({ 'data-agent-anchor': 'character:c1/2' }, { left: 520, top: 300, width: 100, height: 100 });
    const r = resolver();
    // Two elements carry the character (dock row, Studio panel): the larger visible one is the Studio's.
    expect(r.resolve(anchor('character', 'c1'))).toMatchObject({ kind: 'anchor', element: studio });
    expect(r.resolve(anchor('character', 'c1', 'traits'))).toMatchObject({ kind: 'anchor', element: traits });
    expect(r.resolve(anchor('character', 'c1/2'))).toMatchObject({ kind: 'anchor', element: view });
    expect(row.isConnected).toBe(true);
  });

  it('a part nothing draws falls back to the character; a view takes the character\'s row when the Studio is closed', () => {
    const row = put({ 'data-agent-anchor': 'character:c1', 'data-agent-launcher': 'character:c1' }, { left: 20, top: 200, width: 280, height: 56 });
    const r = resolver();
    expect(r.resolve(anchor('character', 'c1', 'seed'))).toMatchObject({ kind: 'anchor', element: row });
    // A view isn't drawn: no exact anchor, so the character's own launcher (its row).
    expect(r.resolve(anchor('character', 'c1/2'))).toMatchObject({
      kind: 'launcher', step: 'board', element: row, point: { x: 300 + LAUNCHER_GAP_PX, y: 228 },
    });
  });

  it('a culled or absent row falls back to the Characters tab, then to the rail', () => {
    const tab = put({ 'data-agent-launcher': 'character' }, { left: 30, top: 80, width: 90, height: 30 });
    const rail = put(RAIL_BUTTON, { left: 0, top: 300, width: 48, height: 48 }, VIEW, true);
    const hiddenRow = put({ 'data-agent-anchor': 'character:c1', 'data-agent-launcher': 'character:c1' },
      { left: 20, top: 900, width: 280, height: 56 }, { left: 0, top: 0, width: 400, height: 500 });
    const r = resolver();
    // The row is scrolled out of the dock: its edge, and when it's not drawn at all, the tab.
    expect(r.resolve(anchor('character', 'c1'))).toMatchObject({ kind: 'edge' });
    hiddenRow.remove();
    r.invalidate();
    expect(r.resolve(anchor('character', 'c1'))).toMatchObject({ kind: 'launcher', step: 'surface', element: tab });
    // The dock closed: the rail's one button, the launcher for every surface.
    tab.remove();
    r.invalidate();
    expect(r.resolve(anchor('character', 'c1'))).toMatchObject({ kind: 'launcher', step: 'surface', element: rail });
    expect(r.resolve(anchor('style', 's1'))).toMatchObject({ kind: 'launcher', step: 'surface', element: rail });
    expect(r.resolve({ surface: 'moodboard', itemId: 'b1' })).toMatchObject({ kind: 'launcher', step: 'surface', element: rail });
    // Nothing at all: nothing resolves.
    rail.remove();
    r.invalidate();
    expect(r.resolve(anchor('character', 'c1')).kind).toBe('none');
  });

  it('the dock\'s tab beats the rail button, and each tab serves only its own surface', () => {
    const charactersTab = put({ 'data-agent-launcher': 'character' }, { left: 30, top: 80, width: 90, height: 30 });
    const stylesTab = put({ 'data-agent-launcher': 'style' }, { left: 230, top: 80, width: 90, height: 30 });
    put(RAIL_BUTTON, { left: 0, top: 300, width: 48, height: 48 }, VIEW, true);
    const r = resolver();
    expect(r.resolve(anchor('character', 'c1'))).toMatchObject({ element: charactersTab });
    expect(r.resolve(anchor('style', 's1'))).toMatchObject({ element: stylesTab });
  });

  it('a character node on the canvas is the item\'s launcher, and wants half of it in view', () => {
    const node = put({ 'data-agent-launcher': 'character:c1' }, { left: 600, top: 300, width: 200, height: 160 });
    expect(resolver().resolve(anchor('character', 'c1/3'))).toMatchObject({ kind: 'launcher', step: 'board', element: node });
    boxes.set(node, { left: 600, top: 850, width: 200, height: 160 }); // 50 of 160 px in view
    expect(resolver().resolve(anchor('character', 'c1/3')).kind).toBe('none');
  });

  it('a style row, a card in the popover and the composer\'s button', () => {
    const row = put({ 'data-agent-anchor': 'style:s1', 'data-agent-launcher': 'style:s1' }, { left: 20, top: 300, width: 280, height: 56 });
    const card = put({ 'data-agent-anchor': 'style:s1' }, { left: 700, top: 500, width: 160, height: 180 });
    const button = put({ 'data-agent-launcher': 'style' }, { left: 900, top: 800, width: 70, height: 30 });
    const r = resolver();
    // The default line's part never chooses an element: the part falls back to the style.
    expect(r.resolve(anchor('style', 's1', 'prompt'))).toMatchObject({ kind: 'anchor', element: card });
    card.remove();
    r.invalidate();
    expect(r.resolve(anchor('style', 's1', 'prompt'))).toMatchObject({ kind: 'anchor', element: row });
    // The dock and the popover both closed: the composer's Styles button is the surface launcher.
    row.remove();
    r.invalidate();
    expect(r.resolve(anchor('style', 's1'))).toMatchObject({
      kind: 'launcher', step: 'surface', element: button, point: { x: 970 + LAUNCHER_GAP_PX, y: 815 },
    });
  });

  it('a removed view is gone: it holds its spot, as the caller says', () => {
    put({ 'data-agent-anchor': 'character:c1', 'data-agent-launcher': 'character:c1' }, { left: 20, top: 200, width: 280, height: 56 });
    expect(resolver().resolve(anchor('character', 'c1/4'), { gone: true })).toEqual({ kind: 'gone' });
    expect(resolver().resolve(anchor('character', 'c1/4'), { gone: false }).kind).toBe('launcher');
  });
});

describe('a removed view is gone (lib/agentSurfaceGone.ts)', () => {
  const open = { board: null, character: { characterId: 'c1', viewCount: 3 } };
  const view = (itemId: string): AgentCursorAnchor => ({ surface: 'character', itemId });

  it('only while that Character is open in the Studio and the position is past its views', () => {
    expect(itemIsGone(view('c1/4'), open)).toBe(true);
    expect(itemIsGone(view('c1/3'), open)).toBe(false);
    expect(itemIsGone(view('c1/1'), open)).toBe(false);
    // A closed Studio or another Character's is no removal, and the character itself is never "gone" here.
    expect(itemIsGone(view('c1/4'), { board: null, character: null })).toBe(false);
    expect(itemIsGone(view('c2/4'), open)).toBe(false);
    expect(itemIsGone(view('c1'), open)).toBe(false);
    expect(itemIsGone({ surface: 'style', itemId: 's1' }, open)).toBe(false);
    expect(itemIsGone({ nodeId: 'n1' }, open)).toBe(false);
  });

  it('keeps a board\'s image rule as it was', () => {
    const board = { board: { boardId: 'b1', imageIds: ['i1'] }, character: null };
    expect(itemIsGone({ surface: 'moodboard', itemId: 'b1/i2' }, board)).toBe(true);
    expect(itemIsGone({ surface: 'moodboard', itemId: 'b1/i1' }, board)).toBe(false);
    expect(itemIsGone({ surface: 'moodboard', itemId: 'b2/i2' }, board)).toBe(false);
    expect(itemIsGone({ surface: 'moodboard', itemId: 'b1' }, board)).toBe(false);
  });
});

describe('the default lines (GM - Design), word for word', () => {
  it('Characters', () => {
    expect(CS_SAY_EXAMPLES.filter((e) => e.when.includes('character') || e.when.includes('view')).map(({ action, line }) => `${action}: ${line}`)).toEqual([
      'look: Looking at “Mara”',
      'look: Looking at view 2 of “Mara”',
      'look: Looking at the cover of “Mara”',
      'look: Looking at “Frozen trait string” on “Mara”',
    ]);
  });

  it('Styles', () => {
    expect(CS_SAY_EXAMPLES.filter((e) => e.when.includes('style')).map(({ action, line }) => `${action}: ${line}`)).toEqual([
      'look: Looking at “Dusk grain”',
      'type: Renaming “Dusk grain”',
      'type: Writing the prompt for “Dusk grain”',
      'type: Changing the category of “Dusk grain”',
      'type: Changing the settings of “Dusk grain”',
      'type: Changing the model of “Dusk grain”',
      'type: Changing the references of “Dusk grain”',
      'type: Changing the thumbnail of “Dusk grain”',
      'type: Changing “Dusk grain”',
    ]);
  });

  it('each Character control says the Studio\'s own label in curly quotes', () => {
    const line = (part: string) => surfaceSay('look', { surface: 'character', character: 'Mara', part });
    expect(line('name')).toBe('Looking at “Name” on “Mara”');
    expect(line('subject-type')).toBe('Looking at “Subject type” on “Mara”');
    expect(line('views')).toBe('Looking at “Reference views” on “Mara”');
    expect(line('traits')).toBe('Looking at “Frozen trait string” on “Mara”');
    expect(line('seed')).toBe('Looking at “Seed” on “Mara”');
    // A control that isn't pointable (the dropped `consistency`) reads as the character.
    expect(line('consistency')).toBe('Looking at “Mara”');
  });

  it('a style\'s write with no part, several parts or one it does not know is the plain line; its click has none', () => {
    expect(surfaceSay('type', { surface: 'style', style: 'Dusk grain', part: 'whatever' })).toBe('Changing “Dusk grain”');
    // A part that names something every object has reads as an unknown part (review of PR #243).
    for (const part of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(surfaceSay('type', { surface: 'style', style: 'Dusk grain', part })).toBe('Changing “Dusk grain”');
      expect(surfaceSay('look', { surface: 'character', character: 'Mara', part })).toBe('Looking at “Mara”');
    }
    expect(surfaceSay('click', { surface: 'style', style: 'Dusk grain' })).toBeNull();
    expect(surfaceSay('look', { surface: 'style', style: 'Dusk grain', part: 'prompt' })).toBe('Looking at “Dusk grain”');
  });

  it('an agent cannot write a Character yet: type and click have no line', () => {
    for (const action of ['type', 'click'] as const) {
      expect(surfaceSay(action, { surface: 'character', character: 'Mara', part: 'traits' })).toBeNull();
    }
  });

  it('say nothing for an action with no line of its own, or an item with no name', () => {
    for (const action of ['move', 'think', 'drag', 'run', 'propose', 'wait', 'error'] as const) {
      expect(surfaceSay(action, { surface: 'character', character: 'Mara' })).toBeNull();
      expect(surfaceSay(action, { surface: 'style', style: 'Dusk grain' })).toBeNull();
    }
    expect(surfaceSay('look', { surface: 'character', character: null })).toBeNull();
    expect(surfaceSay('look', { surface: 'style', style: null })).toBeNull();
  });

  it('name a view with no number yet without inventing one', () => {
    expect(surfaceSay('look', { surface: 'character', character: 'Mara', hasView: true })).toBe('Looking at a view of “Mara”');
  });

  it('cut a long name in the middle so the line fits', () => {
    const long = 'A very long name '.repeat(14);
    for (const line of [
      surfaceSay('look', { surface: 'character', character: long, view: 2, hasView: true }),
      surfaceSay('look', { surface: 'character', character: long, part: 'traits' }),
      surfaceSay('type', { surface: 'style', style: long, part: 'prompt' }),
    ]) {
      expect(Array.from(line as string).length).toBeLessThanOrEqual(140);
      expect(line).toContain('…');
    }
  });

  it('leave the moodboard lines as they were', () => {
    expect(SURFACE_SAY_EXAMPLES).toHaveLength(10);
    expect(surfaceSay('look', { board: 'Desert light', hasImage: true, image: 12 })).toBe('Looking at image 12 on “Desert light”');
  });
});

describe('the part labels are the Character Studio\'s visible text', () => {
  const panel = readFileSync(resolve(SRC, 'components/character-studio/CharacterDefinitionPanel.tsx'), 'utf8');
  const labels = AGENT_SURFACES.character.parts;

  it('Name, Subject type, Frozen trait string and Seed are field labels there', () => {
    for (const part of ['name', 'subject-type', 'traits', 'seed']) {
      expect(panel, part).toContain(`<span className="character-def__label">${labels[part]}</span>`);
    }
  });

  it('Reference views starts the section\'s label', () => {
    expect(panel).toContain(`${labels.views} (`);
  });

  it('each control\'s anchor sits on its own part id in the panel', () => {
    for (const part of Object.keys(labels)) expect(panel, part).toContain(`anchor('${part}')`);
    expect(panel).not.toContain("anchor('consistency");
  });

  it('keeps the moodboard labels the backend pins', () => {
    expect(AGENT_SURFACE_PART_LABELS.name).toBe('Name');
    expect(AGENT_SURFACES.moodboard.parts.name).toBe(AGENT_SURFACE_PART_LABELS.name);
  });
});
