import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix round 5 of PR #200 (review 5 and GM's r6/r7 answers), the component
 * and style side:
 * - LOW-1: the open kept list is sized to whole notes and snaps to their
 *   tops, so no note is ever cut at its top edge; a toast enters inside its
 *   own slot (a scale, never a slide up through the list), the same for
 *   every toast in the notice region.
 * - LOW-2: the swatch × offline says "You can remove swatches when Nebula
 *   reconnects."; the Inspector palette × takes the lock (its tooltip gives
 *   the follow reason while following).
 * - N-1: × moves focus to the next note, the previous one if it was the
 *   last, and back to where focus came from once none is left.
 * - N-2: Send note offline says "You can send notes when Nebula reconnects."
 * - N-4: every Delete hovers red (#ff887d, then #ff9a91), never orange.
 * - N-5: a timeline drop refused while locked goes back where it was (the
 *   timeline had written the drop into its rows in place).
 * LOW-3 is the ratchet's (agentPresenceFollowups.ratchet); LOW-4 and N-3
 * are the backend's (test_agent_presence_followups.py).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));

const timeline = vi.hoisted(() => ({ props: null as null | Record<string, unknown>, mounts: 0 }));
vi.mock('@xzdarcy/react-timeline-editor', async () => {
  const { useEffect } = await import('react');
  return {
    // Each block keeps where it was dragged in its own state: only a new
    // mount draws it where the rows say.
    Timeline: (props: Record<string, unknown>) => { timeline.props = props; useEffect(() => { timeline.mounts += 1; }, []); return null; },
  };
});

import { PinComposer } from '../src/components/canvas/PinComposer';
import { CinemaPaletteControls } from '../src/components/cinema-studio/CinemaArtDirectionControls';
import { Inspector } from '../src/components/panels/Inspector';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { useUIStore } from '../src/store/uiStore';
import { noteKeptLine, type KeptNote } from '../src/lib/canvasPins';
import { publishOpenProject } from '../src/lib/currentProject';
import { setProjectContext } from '../src/lib/projectContext';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch, waitToOpenTooltip } from '../src/lib/canvasFollow';
import { defaultCinemaLook } from '../src/lib/cinemaArtDirection';
import { RemotionTimeline } from '../src/components/video-editor/RemotionTimeline';

const SRC = join(__dirname, '../src');
const css = (file: string) => readFileSync(join(SRC, file), 'utf8');
const initialProject = useProjectStore.getState();
const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const reason = { agent: 'Codex', projectName: 'Second canvas' };
const note = (project: string, text: string): KeptNote =>
  ({ text, project, projectName: `Project ${project}`, following: reason, line: noteKeptLine(reason) });

beforeEach(() => {
  resetCanvasFollowForTests();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'home', revision: 'rev-home' });
  publishOpenProject({ id: 'home', name: 'Home' });
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  act(() => { resetCanvasFollowForTests(); resetBackendConnectionForTests(); });
  useProjectStore.setState(initialProject, true);
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useCanvasPinsStore.setState({ composer: null, composerCanvas: null, draft: '', drafts: {}, kept: [], error: null, errorProject: null } as never);
  publishOpenProject(null);
  setProjectContext(null);
  vi.restoreAllMocks();
});

describe('LOW-1: the open kept list never cuts a note at its top', () => {
  // jsdom lays nothing out: each row is 50px tall, one under the other.
  const ROW = 50;
  let restore: Array<() => void> = [];
  beforeEach(() => {
    const scrolled = new WeakMap<Element, number>();
    const define = (name: string, descriptor: PropertyDescriptor) => {
      const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
        ?? Object.getOwnPropertyDescriptor(Element.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
      restore.push(() => { if (before) Object.defineProperty(HTMLElement.prototype, name, before); else delete (HTMLElement.prototype as never)[name]; });
    };
    define('offsetHeight', { get() { return (this as HTMLElement).classList.contains('canvas-pin-toast--kept') ? ROW : 0; } });
    define('offsetTop', { get() {
      const el = this as HTMLElement;
      return el.classList.contains('canvas-pin-toast--kept') && el.parentElement ? [...el.parentElement.children].indexOf(el) * ROW : 0;
    } });
    define('scrollTop', { get() { return scrolled.get(this as Element) ?? 0; }, set(value: number) { scrolled.set(this as Element, value); } });
  });
  afterEach(() => { for (const undo of restore.reverse()) undo(); restore = []; });

  it('nine notes at 768px: the list is the newest six whole notes tall and rests on a note\'s top', () => {
    useCanvasPinsStore.setState({ kept: Array.from({ length: 9 }, (_, i) => note(`p${i}`, `Note ${i}`)) } as never);
    const { container } = render(<PinComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 7 more' }));
    const list = container.querySelector<HTMLElement>('.canvas-pin-kept-list')!;
    // The cap is min(40vh, 360px) = 307.2px at 768px: six 50px notes fit, a seventh would be cut.
    expect(window.innerHeight).toBe(768);
    expect(list.style.getPropertyValue('--kept-list-h')).toBe('300px');
    expect(list.scrollTop).toBe(3 * ROW);
    expect(list.scrollTop % ROW).toBe(0);
  });

  it('the CSS: the list takes that height and snaps each note to its top', () => {
    const style = css('styles/canvasPins.css');
    const list = /\.canvas-pin-kept-stack\[data-open\] \.canvas-pin-kept-list \{([^}]*)\}/.exec(style)?.[1] ?? '';
    expect(list).toMatch(/height:\s*var\(--kept-list-h, auto\)/);
    expect(list).toMatch(/scroll-snap-type:\s*y mandatory/);
    expect(list).toMatch(/max-height:\s*min\(40vh, 360px\)/);
    const row = /\.canvas-pin-kept-stack\[data-open\] \.canvas-pin-kept-list > \* \{([^}]*)\}/.exec(style)?.[1] ?? '';
    expect(row).toMatch(/scroll-snap-align:\s*start/);
    expect(row).toMatch(/flex:\s*none/);
  });

  it('every notice-region toast enters inside its own slot: a scale, never a slide (GM r7: the same motion app-wide)', () => {
    const entrances: Array<[string, string]> = [
      ['components/projects/ProjectSwitchToast.css', 'project-switch-toast-in'],
      ['styles/asset-trash.css', 'asset-trash-toast-in'],
      ['styles/canvasProposals.css', 'canvas-undo-notice-in'],
      ['styles/moodboard-board.css', 'moodboard-board-toast-in'],
      ['styles/project-home.css', 'project-home-toast-in'],
    ];
    for (const [file, name] of entrances) {
      const body = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css(file))?.[1];
      expect(body, `${file} ${name}`).toBeDefined();
      expect(body, `${file} ${name}`).not.toMatch(/translate/);
      expect(body, `${file} ${name}`).toMatch(/from \{[^}]*scale\(0\.9\d\)/);
    }
  });
});

describe('N-1: × in the kept notes moves focus, never to <body>', () => {
  it('to the next note, the previous one when it was the last, then back to where focus came from', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Canvas';
    document.body.append(opener);
    useCanvasPinsStore.setState({ kept: [note('a', 'A'), note('b', 'B'), note('c', 'C')] } as never);
    render(<PinComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    const dismissOf = (text: string) => within(screen.getByText(text).closest('.canvas-pin-toast--kept') as HTMLElement)
      .getByRole('button', { name: 'Dismiss' });
    opener.focus();
    act(() => dismissOf('A').focus());
    // The first note's × goes to the next note's.
    fireEvent.click(dismissOf('A'));
    expect(document.activeElement).toBe(dismissOf('B'));
    // The last note's × goes to the one before it.
    act(() => dismissOf('C').focus());
    fireEvent.click(dismissOf('C'));
    expect(document.activeElement).toBe(dismissOf('B'));
    // The last one left: back to what had focus before the notes.
    fireEvent.click(dismissOf('B'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('with nothing to go back to, the canvas takes focus', () => {
    const canvas = document.createElement('div');
    canvas.className = 'canvas-wrapper';
    canvas.tabIndex = -1;
    document.body.append(canvas);
    useCanvasPinsStore.setState({ kept: [note('a', 'A')] } as never);
    render(<PinComposer />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    expect(document.activeElement).toBe(canvas);
  });
});

describe('N-2: Send note offline gives its reason', () => {
  it('"You can send notes when Nebula reconnects."', () => {
    useCanvasPinsStore.setState({ composer: { position: { x: 0, y: 0 } }, draft: 'warmer' } as never);
    render(<PinComposer />);
    act(() => noteBackendConnection('offline'));
    const send = screen.getByRole('button', { name: 'Send note' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', 'You can send notes when Nebula reconnects.');
  });
});

describe('LOW-2: a swatch × gives its own reason, offline and following', () => {
  const palette = { swatches: ['#ff0000', '#00ff00'], strength: 0.5, method: 'lab-transfer' } as never;
  const remove = () => screen.getByRole('button', { name: 'Remove palette swatch 1' });

  it('the Cinema swatch ×: "Remove swatch" live, the offline verb offline, the follow reason following', () => {
    render(<CinemaPaletteControls value={palette} onChange={() => {}} labelPrefix="Palette" />);
    expect(remove()).toHaveAttribute('title', 'Remove swatch');
    expect(remove()).toBeEnabled();
    act(() => noteBackendConnection('offline'));
    expect(remove()).toBeDisabled();
    expect(remove()).toHaveAttribute('title', 'You can remove swatches when Nebula reconnects.');
    expect(screen.getByRole('button', { name: 'Add palette swatch' })).toHaveAttribute('title', 'You can add swatches when Nebula reconnects.');
    act(() => noteBackendConnection('online'));
    act(() => setFollowingSwitch(reason));
    expect(remove()).toBeDisabled();
    expect(remove()).toHaveAttribute('title', waitToOpenTooltip('Second canvas'));
    void defaultCinemaLook;
  });

  it('the Inspector palette ×: locked with the shared grey, the follow reason following, the offline verb offline', () => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: ['#ff0000', '#00ff00'] }, state: 'idle', outputs: {} } }],
    edges: [], undoNotice: null } as never);
    useUIStore.getState().selectNode('n1');
    render(<Inspector embedded />);
    const button = () => screen.getByRole('button', { name: 'Remove swatch 1' });
    expect(button()).toBeEnabled();
    expect(button()).toHaveAttribute('title', 'Remove swatch');
    act(() => setFollowingSwitch(reason));
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('title', waitToOpenTooltip('Second canvas'));
    act(() => setFollowingSwitch(null));
    act(() => noteBackendConnection('offline'));
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('title', 'You can remove swatches when Nebula reconnects.');
    // The shared grey covers it (styles/disabled-buttons.css, the ghost list).
    const ghost = /:is\(([^)]*)\):is\(:disabled, \[aria-disabled='true'\]\),/.exec(css('styles/disabled-buttons.css'))?.[1] ?? '';
    expect(ghost.split(',').map((item) => item.trim())).toContain('.inspector__palette-remove');
  });

  it('the swatch × keeps its dark bubble locked; only the × goes grey (GM r7 answer 1)', () => {
    const rule = /\.cinema-shared-controls__swatch-remove:is\(:disabled, ?\[aria-disabled='true'\]\)[^{]*\{([^}]*)\}/.exec(css('styles/disabled-buttons.css'))?.[1] ?? '';
    expect(rule).toMatch(/background:\s*rgba\(0, ?0, ?0, ?0?\.7\)/);
  });
});

describe('N-4: every Delete hovers red, never orange', () => {
  const RED = /--sr-danger-ink\b/;
  const hovers: Array<[string, RegExp]> = [
    ['styles/slava-restraint.css', /\.context-menu__item--danger:hover[^{]*\{([^}]*)\}/],
    ['styles/slava-restraint.css', /\.inspector__action-button--danger:hover[^{]*\{([^}]*)\}/],
    ['styles/project-home.css', /\.project-home__delete:hover[^{]*\{([^}]*)\}/],
    ['styles/cinema-studio.css', /\.cinema-shots-rail__remove:hover[^{]*\{([^}]*)\}/],
    ['styles/remotion-editor.css', /\.remotion-properties-panel__keyframe-delete:hover[^{]*\{([^}]*)\}/],
    ['styles/canvasPins.css', /\.canvas-pin__delete:focus-visible[^{]*\{([^}]*)\}/],
  ];
  it('the context menu, the Inspector, project home, a shot\'s ×, a keyframe\'s and a pin\'s Delete: #ff887d on hover, no accent, no --sr-danger orange', () => {
    for (const [file, pattern] of hovers) {
      const body = pattern.exec(css(file))?.[1];
      expect(body, `${file} ${pattern}`).toBeDefined();
      expect(body, `${file} ${pattern}`).toMatch(RED);
      expect(body, `${file} ${pattern}`).not.toMatch(/--sr-accent|--sr-danger\)|--sr-danger,|#f06e1e|orange/i);
    }
    // The toolbar and dialog Delete rest red and hover lighter.
    expect(/\.selection-toolbar__button--danger:hover[^{]*\{([^}]*)\}/.exec(css('styles/canvas.css'))?.[1]).toMatch(/--sr-danger-ink-hover/);
    expect(/\.prompt-dialog__destructive:hover[^{]*\{([^}]*)\}/.exec(css('styles/prompt-dialog.css'))?.[1]).toMatch(/--sr-danger-ink-hover/);
    const tokens = css('styles/disabled-buttons.css');
    expect(tokens).toMatch(/--sr-danger-ink:\s*#ff887d/i);
    expect(tokens).toMatch(/--sr-danger-ink-hover:\s*#ff9a91/i);
  });
});

describe('N-5: a timeline drop refused while locked goes back where it was', () => {
  type Row = { id: string; actions: Array<{ id: string; start: number; end: number }> };
  const manifest = { timeline: [{ id: 't1', componentType: 'TextNode', time: { startFrame: 30, durationInFrames: 60 } }] } as never;
  const rows = () => timeline.props?.editorData as Row[];

  it('the store keeps it, and the timeline gets fresh rows at the saved time', () => {
    const update = vi.fn();
    useGraphStore.setState({ updateTrackItemTime: update } as never);
    render(<RemotionTimeline remotionNodeId="r1" manifest={manifest} currentFrame={0} onScrub={() => {}} timelineState={{ current: null }} />);
    const before = rows();
    const mounts = timeline.mounts;
    expect(before[0].actions[0].start).toBe(1);
    act(() => setFollowingSwitch(reason));
    expect(timeline.props?.disableDrag).toBe(true);
    // The lock starting draws it again: a drag under way is dropped by the
    // timeline without an end (live), and its block goes back.
    expect(timeline.mounts).toBe(mounts + 1);
    // A drag under way when the lock started: the timeline writes the drop
    // into its rows, then reports the end.
    const action = before[0].actions[0];
    act(() => {
      action.start = 4; action.end = 6;
      (timeline.props?.onActionMoveEnd as (p: unknown) => void)({ action, row: before[0], start: 4, end: 6 });
    });
    expect(update).not.toHaveBeenCalled();
    expect(rows()).not.toBe(before);
    expect(rows()[0].actions[0]).toMatchObject({ start: 1, end: 3 });
    expect(timeline.mounts).toBe(mounts + 2);
    act(() => {
      const again = rows()[0].actions[0];
      again.start = 0; again.end = 5;
      (timeline.props?.onActionResizeEnd as (p: unknown) => void)({ action: again, row: rows()[0], start: 0, end: 5, dir: 'left' });
    });
    expect(update).not.toHaveBeenCalled();
    expect(rows()[0].actions[0]).toMatchObject({ start: 1, end: 3 });
    // Unlocked, a drop is saved.
    act(() => setFollowingSwitch(null));
    act(() => (timeline.props?.onActionMoveEnd as (p: unknown) => void)({ action: rows()[0].actions[0], row: rows()[0], start: 2, end: 4 }));
    expect(update).toHaveBeenCalledWith('r1', 't1', { startFrame: 60 });
    // The lock's start, two refused drops and the lock's end: four redraws; a saved drop adds none.
    expect(timeline.mounts).toBe(mounts + 4);
  });
});
