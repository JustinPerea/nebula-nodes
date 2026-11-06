import { afterEach, describe, expect, it } from 'vitest';
import { readChipView, visiblePane } from '../src/lib/agentChipChrome';

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
