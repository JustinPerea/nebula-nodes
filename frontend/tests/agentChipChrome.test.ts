import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CANVAS_CHROME_SELECTORS, TRANSIENT_SELECTORS, readChipView, visiblePane } from '../src/lib/agentChipChrome';
import { planChips } from '../src/lib/agentEdgeChips';

/** PR #233 slice 9: what the chips read of the page: docks narrow the pane, floating panels are obstacles. */
const PANE = { left: 0, top: 0, width: 1000, height: 600 };
const put = (className: string, box: { left: number; top: number; width: number; height: number }) => {
  const el = document.createElement('div');
  el.className = className;
  el.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) }) as DOMRect;
  document.body.append(el);
  return el;
};
afterEach(() => { document.body.replaceChildren(); });

describe('readChipView', () => {
  it('a dock on the left takes the left of the pane; one on the right takes the right', () => {
    expect(visiblePane(PANE, [{ left: 0, top: 0, width: 300, height: 600 }])).toEqual({ left: 300, top: 0, width: 700, height: 600 });
    expect(visiblePane(PANE, [{ left: 700, top: 0, width: 300, height: 600 }])).toEqual({ left: 0, top: 0, width: 700, height: 600 });
  });

  it('reads the open docks by their class names', () => {
    put('workspace-dock-panel', { left: 0, top: 0, width: 300, height: 600 });
    expect(readChipView(PANE).view.left).toBe(300);
  });

  it('reads the Inspector, the Agent log and Updates as obstacles, and skips one that is leaving', () => {
    put('node-inspector-popover', { left: 600, top: 50, width: 300, height: 200 });
    put('agent-log', { left: 20, top: 300, width: 200, height: 200 });
    put('agent-notes-panel', { left: 400, top: 400, width: 100, height: 100 });
    put('agent-log panel--exiting', { left: 0, top: 0, width: 50, height: 50 });
    const ids = readChipView(PANE).obstacles.map((o) => o.id.replace(/\d+$/, '')).sort();
    expect(ids).toEqual(['agent-log', 'inspector', 'updates']);
  });
});

describe('the canvas chrome chips stand clear of', () => {
  const attr = (name: string, box: { left: number; top: number; width: number; height: number }) => {
    const el = put('', box);
    el.setAttribute(name, '');
    return el;
  };

  it('reads the top bar, the bottom bar, the rail, Updates, the Agent log, the chat button and the undo toast', () => {
    attr('data-top-bar', { left: 300, top: 24, width: 400, height: 40 });
    attr('data-bottom-bar', { left: 300, top: 640, width: 400, height: 48 });
    put('workspace-rail__shell', { left: 5, top: 250, width: 40, height: 200 });
    put('agent-notes-chip', { left: 880, top: 24, width: 110, height: 36 });
    put('agent-log', { left: 700, top: 400, width: 280, height: 180 });
    put('panel-launcher panel-launcher--chat', { left: 940, top: 640, width: 40, height: 40 });
    put('canvas-undo-notice', { left: 300, top: 590, width: 300, height: 36 });
    expect(readChipView(PANE).chrome).toHaveLength(7);
  });

  it('skips a box that is not on screen (no size) or is leaving', () => {
    attr('data-top-bar', { left: 0, top: 0, width: 0, height: 0 });
    put('agent-log panel--exiting', { left: 0, top: 0, width: 50, height: 50 });
    expect(readChipView(PANE).chrome).toHaveLength(0);
  });

  it('every selector still names something the app renders', () => {
    const known = ['CanvasTabs.tsx', 'panels/Toolbar.tsx', 'WorkspaceRail.tsx', 'agent-notes/AgentNotesCorner.tsx',
      'panels/AgentLog.tsx', 'panels/MessageBox.tsx', 'panels/NodeInspectorPopover.tsx', 'agent-notes/AgentNotesList.tsx', 'agent-notes/AgentNoteCard.tsx', 'ChatLauncher.tsx', 'canvas/CanvasLateNotice.tsx', 'ContextMenu.tsx', 'ConnectionPopup.tsx', 'asset-move/AssetMoveMenu.tsx']
      .map((file) => readFileSync(resolve(process.cwd(), 'src/components', file), 'utf8')).join('\n');
    const names = CANVAS_CHROME_SELECTORS.flatMap((selector) => selector.split(',').map((part) => part.trim()))
      .filter((part) => part.startsWith('.')).map((part) => part.slice(1));
    for (const name of names) expect(known, name).toContain(name);
  });
});

describe('open menus and popovers (final review of PR #233, finding 5)', () => {
  const MENU = { left: 960, top: 250, width: 180, height: 220 }; // a right-click near the pane's right edge, over its inset
  const view = { left: 0, top: 0, width: 1000, height: 600 };
  const cursors = [{ key: 'a', label: 'Claude', color: '#E8825A', tip: { x: 4000, y: 350 }, activeAt: 1 }];
  const overlap = (a: { left: number; top: number; width: number; height: number }, b: typeof a) =>
    a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

  it.each(['context-menu', 'connection-popup', 'asset-move__menu'])('reads an open .%s as chrome', (name) => {
    put(name, MENU);
    expect(readChipView(PANE).chrome).toHaveLength(1);
  });

  it('reads any role="menu" as chrome', () => {
    const el = put('', MENU);
    el.setAttribute('role', 'menu');
    expect(readChipView(PANE).chrome).toHaveLength(1);
  });

  it('a chip is kept off a context menu open at the pane edge', () => {
    put('context-menu', MENU);
    const read = readChipView({ ...view, width: 1100 });
    const { chips, counts } = planChips({ ...read, cursors });
    expect(chips.length + counts.length).toBeGreaterThan(0);
    for (const chip of chips) expect(overlap(chip.box, MENU)).toBe(false);
    // Without the menu the chip would be on that spot: the menu is what moved it.
    document.body.replaceChildren();
    const bare = planChips({ ...readChipView({ ...view, width: 1100 }), cursors });
    expect(overlap(bare.chips[0].box, MENU)).toBe(true);
  });

  it('lists the transient selectors among the chrome', () => {
    for (const selector of TRANSIENT_SELECTORS) expect(CANVAS_CHROME_SELECTORS).toContain(selector);
  });
});

describe('the layer order: no chip over a menu', () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), 'src/styles', file), 'utf8');
  const tokens = new Map([...read('slava-restraint.css').matchAll(/(--sr-layer-[\w-]+)\s*:\s*(\d+)\s*;/g)].map((m) => [m[1], Number(m[2])]));
  const z = (name: string) => tokens.get(name) as number;

  it('chips are above the docks and below transient menus, modals and notices', () => {
    expect(z('--sr-layer-edge-chips')).toBeGreaterThan(z('--sr-layer-workspace-overlay'));
    expect(z('--sr-layer-edge-chips')).toBeLessThan(z('--sr-layer-transient'));
    expect(z('--sr-layer-transient')).toBeLessThan(z('--sr-layer-modal'));
    expect(z('--sr-layer-modal')).toBeLessThan(z('--sr-layer-notice'));
  });

  it('the chips\' box uses the chips token, and every transient layer uses the transient one', () => {
    expect(read('agentEdgeChips.css')).toMatch(/\.agent-edge-chips \{[^}]*z-index:\s*var\(--sr-layer-edge-chips/);
    expect(read('slava-restraint.css')).toMatch(/\.context-menu,\s*body\.app-slava-restraint \.connection-popup \{[^}]*z-index:\s*var\(--sr-layer-transient\)/);
    expect(read('panels.css')).toMatch(/body:not\(\.app-slava-restraint\) \.context-menu \{\s*z-index:\s*var\(--sr-layer-transient/);
    expect(read('panels.css')).toMatch(/body:not\(\.app-slava-restraint\) \.connection-popup \{\s*z-index:\s*var\(--sr-layer-transient/);
    expect(read('asset-move.css')).toMatch(/z-index:\s*var\(--sr-layer-transient/);
    expect(read('canvas-toolbar.css')).toMatch(/toolbar--actions-open \{\s*z-index:\s*var\(--sr-layer-transient/);
  });
});
