import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData, PortValue } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { Inspector } from '../../src/components/panels/Inspector';
import { moodboardStatus, parseMoodboardBundle } from '../../src/lib/moodboardBundle';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

// The Preview of a Moodboard bundle since the brief precedence change (#90):
// notes go only on opt-in (`notesSent`), and `leftOut` / `mayClash` say which
// measured colours the brief dropped or flagged, and why.

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

const AVOID = 'Avoid: red, orange or pink flowers';
const DIRECTION = 'Direction: silver tonalist palette';
const MODE_OFF = 'Measured colors are off for this board';

// Entries as services/moodboard_brief.compose writes them (captured from a
// real compose() run on the GM board: Direction "silver tonalist palette,
// blue cornflowers", Avoid "red, orange or pink flowers", pin #d03030).
const BRICK = { hex: '#a6392d', role: 'accent', share: 0.0015, level: 'conflict', reason: AVOID,
  reasons: [AVOID, DIRECTION], foundBy: ['words'], why: 'check' };
const OCHRE = { hex: '#c8b03e', role: 'accent', share: 0.0005, level: 'conflict', reason: DIRECTION,
  reasons: [DIRECTION], foundBy: ['words'], why: 'check' };
const BLUE_REASON = `${DIRECTION}. The Direction allows cornflowers, but this one is more saturated.`;
const BLUE = { hex: '#1c70f2', role: 'palette', share: 0.0232, level: 'warning', reason: BLUE_REASON,
  reasons: [BLUE_REASON], foundBy: ['words'], why: 'check' };
const PINNED_RED = { hex: '#d03030', role: 'pinned', share: null, level: 'conflict', reason: AVOID,
  reasons: [AVOID, DIRECTION], foundBy: ['words'], why: 'check' };

// A bundle from handlers/moodboard.py after #90, default clash mode, notes off.
const BUNDLE = {
  kind: 'nebula_moodboard',
  moodboardId: 'mb-gm',
  name: 'GM Harbor',
  mode: 'look',
  strength: 0.7,
  images: [{ id: 'a', url: '/api/outputs/moodboards/a.png', weight: 1, notes: '', excluded: false }],
  notes: '',
  notesSent: false,
  analysis: { palette: ['#2b2f36', '#8a8f99', '#1c70f2'], accents: [] },
  styleBrief: "Silver tonalist palette, blue cornflowers. Use the Nebula moodboard 'GM Harbor' as look direction.",
  negativePrompt: 'blurry, low-detail artifacts, red, orange or pink flowers',
  avoid: ['red, orange or pink flowers'],
  avoidPrompt: 'Keep these out of the image: red, orange or pink flowers, colors close to #00ff00.',
  direction: 'silver tonalist palette, blue cornflowers',
  pinnedColors: { include: ['#d03030'], exclude: ['#00ff00'] },
  briefOverride: { active: false, stale: false },
  palette: ['#2b2f36', '#8a8f99', '#1c70f2'],
  accents: [],
  leftOut: [BRICK, OCHRE],
  mayClash: [BLUE],
  kept: [],
  pinnedClashes: [PINNED_RED],
  paletteClashes: [],
  clashMode: 'leave-out',
  representativeImages: ['/api/outputs/moodboards/a.png'],
  providerHints: {},
};

// The same board saved by a run before #90: notes always in the bundle, no
// notesSent and no clash lists.
const OLD_BUNDLE = {
  ...BUNDLE,
  notes: 'Wet streets after rain',
  notesSent: undefined, leftOut: undefined, mayClash: undefined, kept: undefined,
  pinnedClashes: undefined, paletteClashes: undefined, clashMode: undefined,
  pinnedColors: { include: [], exclude: ['#ff00ff', '#00ff00'] },
};

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});

afterEach(() => {
  cleanup();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
});

function previewNode(value: unknown): Node<NodeData> {
  return { id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId: 'preview', label: 'Preview', params: {}, state: 'complete',
      outputs: { input: { type: 'Moodboard', value } as PortValue } } };
}

function renderCard(value: unknown) {
  const node = previewNode(value);
  useGraphStore.setState({ nodes: [node], edges: [] });
  render(<ModelNode {...({ id: node.id, data: node.data, selected: false } as NodeProps)} />);
  return screen.getByRole('group', { name: /^Moodboard / });
}

function renderInspector(value: unknown) {
  useGraphStore.setState({ nodes: [previewNode(value)], edges: [] });
  useUIStore.setState({ selectedNodeId: 'n2' });
  render(<Inspector embedded />);
  return screen.getByRole('region', { name: 'Last output' });
}

function statusItems(root: HTMLElement): string[] {
  return Array.from(within(root).getByRole('status').querySelectorAll('.structured-preview__status-item'))
    .map((item) => item.textContent ?? '');
}

function titles(list: HTMLElement): (string | null)[] {
  return within(list).getAllByRole('listitem').map((item) => item.getAttribute('title'));
}

describe('Preview of a Moodboard bundle after brief precedence (#90)', () => {
  it('says notes are off when the board keeps them (sendNotes off, the default), notes or none', () => {
    // The bundle carries notes "" either way, so the switch is all it can name.
    const card = renderCard(BUNDLE);
    expect(statusItems(card)[0]).toBe('Notes off');
  });

  it('says notes were sent when the board opts in', () => {
    const card = renderCard({ ...BUNDLE, notes: 'Quiet harbour light', notesSent: true });
    expect(statusItems(card)[0]).toBe('Notes sent');
  });

  it('says "No notes" when the board sends notes but has none', () => {
    expect(statusItems(renderCard({ ...BUNDLE, notesSent: true }))[0]).toBe('No notes');
  });

  it('with a hand-written brief, says the sent notes travel with the board, not in the brief', () => {
    const card = renderCard({ ...BUNDLE, notes: 'Quiet harbour light', notesSent: true,
      styleBrief: 'My own brief.', briefOverride: { active: true, stale: false } });
    const items = statusItems(card);
    expect(items[0]).toBe('Notes sent, not in the brief');
    expect(items[1]).toBe('Brief written by hand');
    // Off stays off whoever wrote the brief.
    cleanup();
    const off = renderCard({ ...BUNDLE, styleBrief: 'My own brief.', briefOverride: { active: true, stale: false } });
    expect(statusItems(off)[0]).toBe('Notes off');
  });

  it('counts left-out colours and keep-out pins together, then may clash and pinned clashes', () => {
    const card = renderCard(BUNDLE);
    expect(statusItems(card)).toEqual([
      'Notes off', '3 colors left out', '1 may clash', '1 pinned color clashes', 'Avoids 1 thing',
    ]);
  });

  it('counts a keep-out pin that is also in leftOut once', () => {
    const view = parseMoodboardBundle({ ...BUNDLE, pinnedColors: { include: [], exclude: ['#A6392D'] } })!;
    expect(moodboardStatus(view)).toContain('2 colors left out');
  });

  it('keeps reasons off the card: counts only, no Left out or May clash rows', () => {
    const card = renderCard(BUNDLE);
    expect(within(card).queryByRole('list', { name: 'Left out' })).toBeNull();
    expect(within(card).queryByRole('list', { name: 'May clash' })).toBeNull();
    expect(within(card).queryByText(new RegExp(AVOID))).toBeNull();
  });

  it('shows the Inspector a Left out row with each reason, readable without hover', () => {
    const section = renderInspector(BUNDLE);
    const leftOut = within(section).getByRole('list', { name: 'Left out' });
    expect(titles(leftOut)).toEqual([
      `#a6392d accent: ${AVOID} · ${DIRECTION}`,
      `#c8b03e accent: ${DIRECTION}`,
      '#00ff00: Pinned to keep out',
    ]);
    const reasons = within(section).getByRole('list', { name: 'Why these are left out' });
    expect(within(reasons).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `#a6392d accent: ${AVOID} · ${DIRECTION}`,
      `#c8b03e accent: ${DIRECTION}`,
      '#00ff00: Pinned to keep out',
    ]);
    // Swatches use the Studio's swatch look.
    expect(leftOut.querySelector('.moodboard-palette__swatch')).not.toBeNull();
  });

  it('shows the Inspector a May clash row (still sent) and the pinned clashes', () => {
    const section = renderInspector(BUNDLE);
    expect(titles(within(section).getByRole('list', { name: 'May clash' }))).toEqual([`#1c70f2 palette: ${BLUE_REASON}`]);
    expect(within(section).getByRole('list', { name: 'Why these may clash' })).toHaveTextContent(BLUE_REASON);
    expect(titles(within(section).getByRole('list', { name: 'Pinned' }))).toEqual([`#d03030 pinned: ${AVOID} · ${DIRECTION}`]);
  });

  it('calls them flagged in flag mode', () => {
    const card = renderCard({ ...BUNDLE, clashMode: 'flag', leftOut: [], mayClash: [BLUE, BRICK, OCHRE],
      pinnedColors: { include: ['#d03030'], exclude: [] } });
    expect(statusItems(card)).toContain('3 flagged');
    cleanup();
    const section = renderInspector({ ...BUNDLE, clashMode: 'flag', leftOut: [], mayClash: [BLUE, BRICK, OCHRE] });
    expect(within(section).getByRole('list', { name: 'Flagged' })).toBeInTheDocument();
    expect(within(section).queryByRole('list', { name: 'May clash' })).toBeNull();
  });

  it('lists every measured colour as left out in no-measured mode, with the mode reason', () => {
    const off = (hex: string, role: string) => ({ hex, role, share: null, level: 'off', reason: MODE_OFF,
      reasons: [MODE_OFF], foundBy: [], why: 'mode' });
    const value = { ...BUNDLE, clashMode: 'no-measured', palette: [], accents: [], mayClash: [],
      leftOut: [off('#2b2f36', 'palette'), off('#8a8f99', 'palette'),
        { ...BLUE, reason: MODE_OFF, reasons: [MODE_OFF, BLUE_REASON], why: 'mode' },
        { ...BRICK, reason: MODE_OFF, reasons: [MODE_OFF, AVOID, DIRECTION], why: 'mode' },
        { ...OCHRE, reason: MODE_OFF, reasons: [MODE_OFF, DIRECTION], why: 'mode' }] };
    expect(statusItems(renderCard(value))).toContain('6 colors left out');
    cleanup();
    const reasons = within(renderInspector(value)).getByRole('list', { name: 'Why these are left out' });
    expect(within(reasons).getAllByRole('listitem')[0]).toHaveTextContent(`#2b2f36 palette: ${MODE_OFF}`);
  });

  it('lists a reason for every chip the Inspector shows, past a handful', () => {
    const off = (index: number) => ({ hex: `#${(0x101010 * (index + 1)).toString(16).padStart(6, '0')}`,
      role: 'palette', share: null, level: 'off', reason: MODE_OFF, reasons: [MODE_OFF], foundBy: [], why: 'mode' });
    const leftOut = Array.from({ length: 12 }, (_, index) => off(index));
    const section = renderInspector({ ...BUNDLE, clashMode: 'no-measured', palette: [], accents: [], mayClash: [],
      pinnedColors: { include: [], exclude: [] }, leftOut });
    expect(within(within(section).getByRole('list', { name: 'Left out' })).getAllByRole('listitem')).toHaveLength(12);
    const reasons = within(within(section).getByRole('list', { name: 'Why these are left out' })).getAllByRole('listitem');
    expect(reasons.map((item) => item.textContent)).toEqual(leftOut.map((item) => `${item.hex} palette: ${MODE_OFF}`));
    expect(within(section).queryByText(/more$/)).toBeNull();
  });

  it('says when the clash check is off (keep-all)', () => {
    const card = renderCard({ ...BUNDLE, clashMode: 'keep-all', leftOut: [], mayClash: [], pinnedClashes: [],
      pinnedColors: { include: ['#d03030'], exclude: [] } });
    expect(statusItems(card)).toEqual(['Notes off', 'Clash check is off', 'Avoids 1 thing']);
  });

  it('drops odd clash entries and caps long reasons', () => {
    const view = parseMoodboardBundle({ ...BUNDLE, notesSent: 'yes', clashMode: 'whatever',
      leftOut: [{ hex: 'red', reason: 'x' }, 'nope', { hex: '#abc', reason: 'r'.repeat(5000), reasons: 'bad' }],
      mayClash: { hex: '#fff' }, paletteClashes: [{ hex: null, role: 'palette', reason: 'Warm cast' }] })!;
    expect(view.leftOut.map((item) => item.hex)).toEqual(['#abc']);
    expect(view.leftOut[0].reasons[0].length).toBeLessThanOrEqual(301);
    expect(view.mayClash).toEqual([]);
    expect(view.clashMode).toBeNull();
    expect(view.paletteClashes.map((item) => item.reasons)).toEqual([['Warm cast']]);
    // A notesSent that isn't a boolean reads as absent: the old inference.
    expect(view.notesSent).toBeNull();
  });
});

describe('Preview of a Moodboard bundle saved before #90', () => {
  it('renders exactly as before: notes inferred, keep-out pins counted, no clash rows', () => {
    const card = renderCard(OLD_BUNDLE);
    expect(statusItems(card)).toEqual(['Notes sent', '2 colors left out', 'Avoids 1 thing']);
    cleanup();
    const section = renderInspector(OLD_BUNDLE);
    expect(statusItems(section)).toEqual(['Notes sent', '2 colors left out', 'Avoids 1 thing']);
    for (const name of ['Left out', 'May clash', 'Flagged', 'Pinned']) {
      expect(within(section).queryByRole('list', { name })).toBeNull();
    }
    expect(within(section).getAllByRole('list').map((list) => list.getAttribute('aria-label'))).toEqual(['Palette']);
  });
});
