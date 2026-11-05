import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ goToCanvas: vi.fn(async () => {}), onCanvas: vi.fn(() => true) }));
vi.mock('./goToCanvas', () => ({
  goToCanvas: nav.goToCanvas,
  onCanvas: nav.onCanvas,
  whenReady: async (ready: () => boolean) => ready(),
}));

import { openThreadIn } from './threadOpen';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { usePersonThreadStore } from '../store/personThreadStore';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** GM r100.3: the reply's Update ("Claude Code replied in “Coast”.") opens
 * the thread of the message it answered, in that message's project. */

let header: HTMLElement | null = null;

/** The whole line, never a prefix of it ("Try again." only where it helps). */
const exactly = (line: string) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

function project(id: string) {
  return { id, name: id } as never;
}

beforeEach(() => {
  header = document.createElement('div');
  header.className = 'agent-log__header';
  header.tabIndex = -1;
  document.body.appendChild(header);
  useUIStore.setState({ agentLogOpen: false });
  nav.goToCanvas.mockClear();
});

afterEach(() => {
  header?.remove();
  vi.restoreAllMocks();
});

describe('openThreadIn', () => {
  it('opens the other project, goes to its canvas and opens the Agent log', async () => {
    const open = vi.fn(async (id: string) => { useProjectStore.setState({ activeProject: project(id) }); });
    useProjectStore.setState({ activeProject: project('p1'), open } as never);
    await openThreadIn('p2');
    expect(open).toHaveBeenCalledWith('p2');
    expect(nav.goToCanvas).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().agentLogOpen).toBe(true);
  });

  it('the open project: no reopening, the log still opens', async () => {
    const open = vi.fn();
    useProjectStore.setState({ activeProject: project('p1'), open } as never);
    await openThreadIn('p1');
    expect(open).not.toHaveBeenCalled();
    expect(useUIStore.getState().agentLogOpen).toBe(true);
  });

  it('says why when it can’t, in the because form, with Try again only where it helps (GM r108 string 6)', async () => {
    useProjectStore.setState({ activeProject: project('p1'), open: vi.fn(async () => {}),
      projects: [{ id: 'p2', name: 'Coast' }], trash: [{ id: 'p3', name: 'Old' }] } as never);
    await expect(openThreadIn(undefined)).rejects.toThrow(exactly('Nebula couldn’t open this thread because this Update doesn’t say which project it’s in.'));
    await expect(openThreadIn('p2')).rejects.toThrow(exactly('Nebula couldn’t open “Coast” because it didn’t finish loading. Try again.'));
    await expect(openThreadIn('p3')).rejects.toThrow(exactly('Nebula couldn’t open this thread because its project is in Recently deleted. Restore the project to open it.'));
    await expect(openThreadIn('p9')).rejects.toThrow(exactly('Nebula couldn’t open this thread because its project was deleted for good.'));
    header?.remove();
    header = null;
    await expect(openThreadIn('p1')).rejects.toThrow(exactly('Nebula couldn’t open the Agent log because the canvas didn’t finish loading. Try again.'));
    expect(useUIStore.getState().agentLogOpen).toBe(false);
  });
});

describe('GM r108 D2: Open focuses the reply’s row, its ring inside the log’s scroll area', () => {
  function thread(ids: string[]) {
    const scroller = document.createElement('div');
    scroller.className = 'agent-log__body message-box__thread';
    const list = document.createElement('ol');
    for (const id of ids) {
      const item = document.createElement('li');
      item.className = 'message-box__item';
      item.dataset.rowId = id;
      list.appendChild(item);
    }
    scroller.appendChild(list);
    document.body.appendChild(scroller);
    return scroller;
  }

  it('focus goes to the reply row, never the header; the row is reachable only while focused', async () => {
    useProjectStore.setState({ activeProject: project('p1'), open: vi.fn() } as never);
    const box = thread(['m1', 'r1']);
    await openThreadIn('p1', 'r1');
    const row = box.querySelector<HTMLElement>('[data-row-id="r1"]')!;
    expect(document.activeElement).toBe(row);
    expect(document.activeElement).not.toBe(header);
    expect(row.hasAttribute('data-focus-target')).toBe(true);
    row.blur();
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(row.hasAttribute('data-focus-target')).toBe(false);
    box.remove();
  });

  it('a reply no longer in its loaded thread: “it was deleted”, no Try again', async () => {
    useProjectStore.setState({ activeProject: project('p1'), open: vi.fn() } as never);
    usePersonThreadStore.setState({ projectId: 'p1', rows: [] });
    await expect(openThreadIn('p1', 'r-gone')).rejects.toThrow(exactly('Nebula couldn’t open this thread because it was deleted.'));
  });

  it('a focused log row’s ring is drawn inside the row, so the scroll area never clips it and the header never covers it', () => {
    const css = readFileSync(join(__dirname, '../styles/messageBox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, selectors]) => selectors.split(',').some((one) => one.trim() === '.message-box__item[data-focus-target]:focus'));
    expect(rule).toBeDefined();
    const body = rule![2];
    const width = Number(/outline:[^;]*?(\d+)px/.exec(body)?.[1]);
    const offset = Number(/outline-offset:\s*(-?\d+)px/.exec(body)?.[1]);
    expect(width).toBeGreaterThan(0);
    // Inside the row: an offset at least as far in as the ring is wide.
    expect(offset).toBeLessThanOrEqual(-width);
    // Room for the ring that changes no layout: padding given back by margins.
    expect(css).toMatch(/\.message-box__item\[data-focus-target\]\s*\{\s*padding: 4px 6px;\s*margin: -4px -6px 8px;/);
    // Brought in clear of the scroll fade at the thread's top and bottom.
    expect(css).toMatch(/\.message-box__item\s*\{[^}]*scroll-margin-block:/);
    // Nothing else rings the header after Open (round 5's clipped ring).
    expect(readFileSync(join(__dirname, 'threadOpen.ts'), 'utf8')).toMatch(/focusRow\(row\)/);
  });
});

describe('GM r108 string 6: every line an Updates action shows uses curly apostrophes', () => {
  // The files whose thrown lines an Update's action shows in the corner.
  const files = ['lib/threadOpen.ts', 'lib/canvasProposalReview.ts', 'lib/assetProposalReview.ts', 'lib/goToCanvas.ts',
    'components/agent-notes/AgentNotesCorner.tsx'];

  it('no straight apostrophe in a word, in any writtenLine of theirs', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      for (const match of source.matchAll(/writtenLine\(([^;]*?)\)\s*[;)]/g)) {
        if (/\w'\w/.test(match[1]) || /"[^"]*\w'\w[^"]*"/.test(match[1])) offenders.push(`${file}: ${match[1]}`);
      }
      for (const match of source.matchAll(/threadOpenLine\(([^;]*?)\)\)/g)) {
        if (/\w'\w/.test(match[1])) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(readdirSync(join(__dirname, '..', 'components/agent-notes')).length).toBeGreaterThan(0);
  });
});
