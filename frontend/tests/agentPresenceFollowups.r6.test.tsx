import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix round 6 of PR #200 (review 6 and GM's r8/r9 answers), the component
 * and style side:
 * - LOW-1 (GM r9 answer 3): a locked Inspector "+ Add", "Extract from
 *   reference" and every "Choose File" get the one disabled treatment (the
 *   shared grey, no pointer, no hover) and the lock's reason, follow first,
 *   then offline ("You can choose a file when Nebula reconnects.").
 * - GM r8: a filled destructive confirm is the red fill (#ff887d) with
 *   near-black ink, hover #ff9a91; never white on the orange.
 * - GM r9 answer 2: motion by kind. A surface in the notice region scales
 *   in on the toasts' spring; a row inside a surface already there expands
 *   into place (its height springs, never its scale); reduced motion is
 *   opacity only.
 * - N-5: a timeline redraw keeps where the person had scrolled.
 * LOW-3 and the CI time are the ratchet's (agentPresenceFollowups.ratchet);
 * N-2, N-3 and N-4 are the backend's (test_agent_presence_followups.py).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));

const timeline = vi.hoisted(() => ({ props: null as null | Record<string, unknown>, mounts: 0, scrolledTo: [] as number[] }));
vi.mock('@xzdarcy/react-timeline-editor', async () => {
  const { forwardRef, useEffect, useImperativeHandle, useLayoutEffect } = await import('react');
  const record = (props: Record<string, unknown>) => { timeline.props = props; };
  return {
    Timeline: forwardRef((props: Record<string, unknown>, ref) => {
      record(props);
      useImperativeHandle(ref, () => ({ setScrollLeft: (left: number) => { timeline.scrolledTo.push(left); } }), []);
      // Like the real grid, a new mount reports where it is (0) as it mounts,
      // before its parent's layout effects run.
      useLayoutEffect(() => { (props.onScroll as (p: { scrollLeft: number }) => void)?.({ scrollLeft: 0 }); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
      useEffect(() => { timeline.mounts += 1; }, []);
      return null;
    }),
  };
});

import { PinComposer } from '../src/components/canvas/PinComposer';
import { Inspector } from '../src/components/panels/Inspector';
import { RemotionTimeline } from '../src/components/video-editor/RemotionTimeline';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { noteKeptLine, type KeptNote } from '../src/lib/canvasPins';
import { publishOpenProject } from '../src/lib/currentProject';
import { setProjectContext } from '../src/lib/projectContext';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch, waitToOpenTooltip } from '../src/lib/canvasFollow';

const SRC = join(__dirname, '../src');
const css = (file: string) => readFileSync(join(SRC, file), 'utf8');
const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const reason = { agent: 'Codex', projectName: 'Second canvas' };
const note = (project: string, text: string): KeptNote =>
  ({ text, project, projectName: `Project ${project}`, following: reason, line: noteKeptLine(reason) });

/** Every rule in a stylesheet: its selectors, its body and whether it sits
 *  under prefers-reduced-motion. */
type Rule = { selectors: string[]; body: string; reduced: boolean };
function rules(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const walk = (chunk: string, reduced: boolean) => {
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf('{', i);
      if (open < 0) return;
      const head = chunk.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < chunk.length && depth) { if (chunk[j] === '{') depth += 1; else if (chunk[j] === '}') depth -= 1; j += 1; }
      const body = chunk.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, reduced || /prefers-reduced-motion:\s*reduce/.test(head));
      else if (!head.startsWith('@keyframes')) {
        out.push({ selectors: head.split(/,(?![^(]*\))/).map((s) => s.trim().replace(/\s+/g, ' ')), body, reduced });
      }
      i = j;
    }
  };
  walk(text, false);
  return out;
}
/** The animation a selector gets (its last rule that sets one). */
function animationOf(file: string, selector: string, reduced: boolean): string | undefined {
  const matching = rules(css(file)).filter((rule) => rule.reduced === reduced && rule.selectors.includes(selector));
  const bodies = matching.map((rule) => /(?:^|;|\s)animation:\s*([^;]+)/.exec(rule.body)?.[1]?.trim()).filter(Boolean);
  return bodies.at(-1);
}
// React listens for whichever animationend name the engine has (jsdom has
// no AnimationEvent, so React picks the prefixed one): send both.
const endAnimation = (el: Element) => act(() => {
  for (const type of ['animationend', 'webkitAnimationEnd']) el.dispatchEvent(new Event(type, { bubbles: true }));
});
const keyframes = (file: string, name: string) => new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css(file))?.[1];

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
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useCanvasPinsStore.setState({ composer: null, composerCanvas: null, draft: '', drafts: {}, kept: [], error: null, errorProject: null } as never);
  publishOpenProject(null);
  setProjectContext(null);
  vi.restoreAllMocks();
});

describe('LOW-1: a locked Inspector picker or Add says why, in the shared grey', () => {
  const select = (definitionId: string, params: Record<string, unknown>) => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Node', definitionId, params, state: 'idle', outputs: {} } }], edges: [], undoNotice: null } as never);
    useUIStore.getState().selectNode('n1');
    render(<Inspector embedded />);
  };
  const labelOf = (text: string) => screen.getByText(text).closest('label') as HTMLLabelElement;

  it('"+ Add" and "Extract from reference": their own titles live; the follow reason following; the offline verb offline', () => {
    select('cinema-color', { palette: ['#ff0000'] });
    const add = () => screen.getByRole('button', { name: 'Add' });
    const extract = () => labelOf('Extract from reference');
    expect(add()).toBeEnabled();
    expect(add()).toHaveAttribute('title', 'Add a swatch');
    expect(extract()).toHaveAttribute('title', 'Extract a palette from an image');
    expect(extract()).not.toHaveAttribute('aria-disabled');

    act(() => setFollowingSwitch(reason));
    expect(add()).toBeDisabled();
    expect(add()).toHaveAttribute('title', waitToOpenTooltip('Second canvas'));
    expect(add()).toHaveAttribute('data-following-disabled');
    expect(extract()).toHaveAttribute('aria-disabled', 'true');
    expect(extract()).toHaveAttribute('title', waitToOpenTooltip('Second canvas'));
    expect(extract()).toHaveAttribute('data-following-disabled');
    expect(extract().querySelector('input')).toBeDisabled();

    act(() => setFollowingSwitch(null));
    act(() => noteBackendConnection('offline'));
    expect(add()).toHaveAttribute('title', 'You can add swatches when Nebula reconnects.');
    expect(add()).toHaveAttribute('data-offline-disabled');
    expect(extract()).toHaveAttribute('title', 'You can extract a palette when Nebula reconnects.');
    expect(extract()).toHaveAttribute('data-offline-disabled');
  });

  it('"Choose File": "You can choose a file when Nebula reconnects." offline, the follow reason following (GM r9 answer 3)', () => {
    select('image-input', { filePath: '' });
    const choose = () => labelOf('Choose File');
    expect(choose()).not.toHaveAttribute('title');
    expect(choose()).not.toHaveAttribute('aria-disabled');
    act(() => noteBackendConnection('offline'));
    expect(choose()).toHaveAttribute('title', 'You can choose a file when Nebula reconnects.');
    expect(choose()).toHaveAttribute('aria-disabled', 'true');
    expect(choose()).toHaveAttribute('data-offline-disabled');
    expect(choose().querySelector('input')).toBeDisabled();
    // Follow comes before offline (GM r9 answer 3: run, then follow, then offline).
    act(() => setFollowingSwitch(reason));
    expect(choose()).toHaveAttribute('title', waitToOpenTooltip('Second canvas'));
  });

  it('the CSS: the picker is in the shared ghost grey, its hover off while locked; the lock mark takes the pointer away', () => {
    const disabled = css('styles/disabled-buttons.css');
    const lists = [...disabled.matchAll(/:is\(([^)]*)\):is\(:disabled, \[aria-disabled='true'\]\)/g)].map((m) => m[1].split(',').map((s) => s.trim()));
    expect(lists.filter((list) => list.includes('.inspector__file-button')).length).toBeGreaterThanOrEqual(2);
    expect(css('styles/slava-restraint.css')).toMatch(/\.inspector__file-button:hover:not\(\[aria-disabled='true'\]\)/);
    expect(css('styles/slava-restraint.css')).not.toMatch(/\.inspector__file-button:hover\s*[,{]/);
    expect(css('App.css')).toMatch(/\[data-offline-disabled\][\s\S]*?cursor:\s*not-allowed\s*!important/);
  });
});

describe('GM r8: a filled destructive confirm is the red fill with near-black ink', () => {
  const confirms: Array<[string, string, string]> = [
    ['styles/project-home.css', 'body.app-slava-restraint .project-home__confirm .project-home__danger', 'body.app-slava-restraint .project-home__confirm .project-home__danger:hover:not(:disabled)'],
    ['styles/prompt-dialog.css', '.prompt-dialog__actions .prompt-dialog__danger', '.prompt-dialog__actions .prompt-dialog__danger:hover:not(:disabled)'],
    ['styles/asset-trash.css', 'body.app-slava-restraint .asset-trash__button--danger', 'body.app-slava-restraint .asset-trash__button--danger:hover:not(:disabled)'],
  ];
  it('home\'s Delete, Delete forever and "Continue without them": #ff887d at rest, #ff9a91 on hover, #1f1f1f ink, no white, no orange', () => {
    for (const [file, rest, hover] of confirms) {
      const all = rules(css(file)).filter((rule) => !rule.reduced);
      const at = all.filter((rule) => rule.selectors.includes(rest)).map((rule) => rule.body).join(';');
      const over = all.filter((rule) => rule.selectors.includes(hover)).map((rule) => rule.body).join(';');
      expect(at, `${file} ${rest}`).toMatch(/background:\s*var\(--sr-danger-fill,\s*#ff887d\)/);
      expect(at, `${file} ${rest}`).toMatch(/color:\s*var\(--sr-on-danger,\s*#1f1f1f\)/);
      expect(over, `${file} ${hover}`).toMatch(/background:\s*var\(--sr-danger-fill-hover,\s*#ff9a91\)/);
      for (const body of [at, over]) {
        expect(body, file).not.toMatch(/#fff\b|#ffffff|var\(--sr-danger[,)]|--sr-accent|brightness/i);
      }
    }
    const tokens = css('styles/disabled-buttons.css');
    expect(tokens).toMatch(/--sr-danger-fill:\s*var\(--sr-danger-ink\)/);
    expect(tokens).toMatch(/--sr-danger-fill-hover:\s*var\(--sr-danger-ink-hover\)/);
    expect(tokens).toMatch(/--sr-on-danger:\s*#1f1f1f/);
  });
  it('disabled, each is in the shared grey fill list', () => {
    const filled = /\/\* Filled buttons[\s\S]*?:is\(([^)]*)\)/.exec(css('styles/disabled-buttons.css'))?.[1] ?? '';
    const listed = filled.split(',').map((s) => s.trim());
    for (const name of ['.project-home__danger', '.prompt-dialog__danger', '.asset-trash__button--danger']) expect(listed).toContain(name);
  });
});

describe('GM r9 answer 2: motion by kind', () => {
  const SURFACE = 'notice-surface-in 420ms var(--notice-spring) both';
  const ROW = 'notice-row-in 420ms var(--notice-spring) both';
  const FADE = 'notice-fade-in 180ms ease-out both';
  // Every surface the notice region holds, with its kind. A new one fails
  // here until it is given one.
  const surfaces: Array<[string, string, 'surface' | 'row', string]> = [
    ['proposal bar (and the run-later notice)', 'styles/canvasProposals.css', 'surface', '.proposal-bar'],
    ['person-required notice', 'App.css', 'surface', '.person-required'],
    ['pin error (its own box)', 'styles/canvasPins.css', 'surface', '.canvas-pin-toast--error'],
    ['kept-notes stack (its first note)', 'styles/canvasPins.css', 'surface', '.canvas-pin-kept-stack'],
    ['a note kept into the showing stack', 'styles/canvasPins.css', 'row', '.canvas-pin-toast--kept[data-entering]'],
    ['the proposal bar\'s inline error line', 'styles/canvasProposals.css', 'row', '.proposal-bar__error'],
  ];
  // The five toasts, scaling on their own keyframes since round 5.
  const toasts: Array<[string, string, string]> = [
    ['components/projects/ProjectSwitchToast.css', '.project-switch-toast', 'project-switch-toast-in'],
    ['styles/asset-trash.css', 'body.app-slava-restraint .asset-trash__toast', 'asset-trash-toast-in'],
    ['styles/canvasProposals.css', '.canvas-undo-notice', 'canvas-undo-notice-in'],
    ['styles/moodboard-board.css', '.moodboard-board-toast', 'moodboard-board-toast-in'],
    ['styles/project-home.css', 'body.app-slava-restraint .project-home__toast', 'project-home-toast-in'],
  ];

  it('each surface has its kind: a surface scales in on the toasts\' spring, a row expands', () => {
    for (const [name, file, kind, selector] of surfaces) {
      expect(animationOf(file, selector, false), name).toBe(kind === 'surface' ? SURFACE : ROW);
    }
    // The review flash keeps the entrance first, so it never restarts it.
    expect(animationOf('styles/canvasProposals.css', ".proposal-bar[data-review='true']", false)).toMatch(new RegExp(`^${SURFACE.replace(/[()]/g, '\\$&')},\\s*proposal-bar-review `));
    // A row's expand clips while it grows and lets its height interpolate to auto.
    for (const selector of ['.canvas-pin-toast--kept[data-entering]', '.proposal-bar__error']) {
      const file = selector.startsWith('.canvas') ? 'styles/canvasPins.css' : 'styles/canvasProposals.css';
      const body = rules(css(file)).filter((rule) => !rule.reduced && rule.selectors.includes(selector)).map((rule) => rule.body).join(';');
      expect(body, selector).toMatch(/overflow:\s*clip/);
      expect(body, selector).toMatch(/interpolate-size:\s*allow-keywords/);
    }
  });

  it('the keyframes: a surface scales and fades, a row springs its height and never its scale', () => {
    const region = 'styles/noticeRegion.css';
    expect(keyframes(region, 'notice-surface-in')).toMatch(/from \{ opacity: 0; transform: scale\(0\.96\); \}/);
    const row = keyframes(region, 'notice-row-in') ?? '';
    expect(row).toMatch(/height:\s*0/);
    expect(row).toMatch(/opacity:\s*0/);
    expect(row).not.toMatch(/scale|translate|transform/);
    expect(keyframes(region, 'notice-fade-in')).toMatch(/^\s*from \{ opacity: 0; \}\s*$/);
    // The same spring as the toasts.
    const spring = /--notice-spring:\s*(linear\([^)]*\))/.exec(css(region))?.[1];
    expect(spring).toBe(/--project-switch-spring:\s*(linear\([^)]*\))/.exec(css('components/projects/ProjectSwitchToast.css'))?.[1]);
    for (const [file, , name] of toasts) expect(keyframes(file, name), name).toMatch(/scale\(0\.9\d\)/);
  });

  it('reduced motion: every surface, row and toast is opacity only', () => {
    for (const [name, file, , selector] of surfaces) expect(animationOf(file, selector, true), name).toBe(FADE);
    for (const [file, selector] of toasts) expect(animationOf(file, selector, true), selector).toBe(FADE);
  });

  it('a note kept while the stack shows is marked to expand until its expand ends; the stack\'s first note and revealed notes are not', () => {
    useCanvasPinsStore.setState({ kept: [note('a', 'First')] } as never);
    const { container } = render(<PinComposer />);
    const row = (project: string) => container.querySelector<HTMLElement>(`.canvas-pin-toast--kept[data-project="${project}"]`);
    // The first note is the stack arriving: the stack scales, the row doesn't expand.
    expect(row('a')).not.toHaveAttribute('data-entering');
    act(() => useCanvasPinsStore.setState({ kept: [note('a', 'First'), note('b', 'Second')] } as never));
    expect(row('b')).toHaveAttribute('data-entering', 'true');
    expect(row('a')).not.toHaveAttribute('data-entering');
    // A re-render mid-spring keeps it.
    act(() => useCanvasPinsStore.setState({ kept: [note('a', 'First, edited'), note('b', 'Second')] } as never));
    expect(row('b')).toHaveAttribute('data-entering', 'true');
    // An expand ending inside it (a child's) doesn't count; its own does.
    endAnimation(row('b')!.querySelector('q')!);
    expect(row('b')).toHaveAttribute('data-entering', 'true');
    endAnimation(row('b')!);
    expect(row('b')).not.toHaveAttribute('data-entering');
    // Rows "Show 1 more" reveals were already kept.
    act(() => useCanvasPinsStore.setState({ kept: [note('a', 'First'), note('b', 'Second'), note('c', 'Third')] } as never));
    endAnimation(row('c')!);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(row('a')).not.toHaveAttribute('data-entering');
    // The open list measures with the expand held, then lets it run.
    expect(container.querySelector('.canvas-pin-kept-list')).not.toHaveAttribute('data-measuring');
    expect(css('styles/canvasPins.css')).toMatch(/\.canvas-pin-kept-list\[data-measuring\] > \.canvas-pin-toast--kept\[data-entering\] \{\s*animation: none;\s*\}/);
  });

  it('the pin error is its own box, marked as one', () => {
    useCanvasPinsStore.setState({ error: "Couldn't save the note.", errorProject: null } as never);
    render(<PinComposer />);
    expect(screen.getByRole('alert')).toHaveClass('canvas-pin-toast', 'canvas-pin-toast--error');
  });
});

describe('N-5: a timeline redraw keeps where the person had scrolled', () => {
  const manifest = { timeline: [{ id: 't1', componentType: 'TextNode', time: { startFrame: 30, durationInFrames: 60 } }] } as never;
  it('the lock starting, a refused drop and the lock ending each draw it again at the same scroll', () => {
    timeline.scrolledTo = [];
    render(<RemotionTimeline remotionNodeId="r1" manifest={manifest} currentFrame={0} onScrub={() => {}} timelineState={{ current: null }} />);
    const mounts = timeline.mounts;
    // Not scrolled yet: a redraw has nothing to restore.
    act(() => setFollowingSwitch(reason));
    expect(timeline.mounts).toBe(mounts + 1);
    expect(timeline.scrolledTo).toEqual([]);
    act(() => (timeline.props?.onScroll as (p: { scrollLeft: number }) => void)({ scrollLeft: 240 }));
    act(() => (timeline.props?.onActionMoveEnd as (p: unknown) => void)({ action: { id: 't1' }, row: {}, start: 4, end: 6 }));
    expect(timeline.mounts).toBe(mounts + 2);
    expect(timeline.scrolledTo).toEqual([240]);
    act(() => setFollowingSwitch(null));
    expect(timeline.mounts).toBe(mounts + 3);
    expect(timeline.scrolledTo).toEqual([240, 240]);
  });
});
