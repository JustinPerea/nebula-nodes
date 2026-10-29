import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PR #198 fix round 22 (GM r32), rendered:
 * - Answers 1 and 3: the run-lock line is a state line in the state slot,
 *   with no × and no [Try again] (it clears when the run ends).
 * - Answers 2 and 3: the "other" line is a stop line with [Try again] (one
 *   try) and no ×.
 * - GM r33 answer 2 (replacing round 22's single opacity): every notice
 *   button held or disabled by the canvas lock (following, offline) reads
 *   the one disabled token set, by kind (a filled button's grey fill, a
 *   ghost or × button's grey label), with no whole-control opacity; a
 *   ratchet catches new literal disabled opacities in the files the PR
 *   touches.
 */
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async () => new Response('{}', { status: 200 }),
}));

import { NoticeRegion } from '../src/components/NoticeRegion';
import { SceneUnsavedMark } from '../src/components/nodes/SceneUnsavedMark';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useGraphStore } from '../src/store/graphStore';

const LAZY = { timeout: 10_000 };
const initial = useGraphStore.getState();
afterEach(() => {
  cleanup();
  act(() => { resetCanvasFollowForTests(); setFollowingSwitch(null); resetBackendConnectionForTests(); });
  useGraphStore.setState(initial, true);
});

const scene = (id: string, label: string, x: number) => ({ id, type: 'cinemaSceneNode', position: { x, y: 0 },
  data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } });
const RUN_ONE = 'Your changes to “Opening” are kept. Nebula will save them when the run finishes.';
const RUN_TWO = 'Your changes to “Opening” and “Ref scene” are kept. Nebula will save them when the run finishes.';
const REASON = 'Try again, or reload if it keeps happening.';
const OTHER_ONE = `Nebula couldn’t save your changes to “Opening”. ${REASON}`;
const lineOf = (text: string) => screen.getByText(text).closest('[data-scene-stop]') as HTMLElement;
const base = { stoppedScenes: {}, sceneTries: {}, scenePopover: null, undoNotice: null, messageNotice: null, sceneClashes: {} };

describe('GM r32: the run-lock and "other" lines are state lines with no ×', () => {
  it('the run-lock line, one scene and merged: in the state slot, no ×, no [Try again]', async () => {
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0)], sceneStops: { n1: { cause: 'run-lock' } } } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(RUN_ONE, {}, LAZY);
    const line = lineOf(RUN_ONE);
    expect(line.parentElement?.getAttribute('data-notice-slot')).toBe('scene-stop');
    expect(line.querySelectorAll('button')).toHaveLength(0);
    act(() => { useGraphStore.setState({ nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)],
      sceneStops: { n1: { cause: 'run-lock' }, n2: { cause: 'run-lock' } } } as never); });
    expect(screen.queryByText(RUN_ONE)).toBeNull();
    expect(lineOf(RUN_TWO).querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelectorAll('[data-scene-stop]')).toHaveLength(1);
    expect(document.querySelector('[aria-label="Dismiss"]')).toBeNull();
  });

  it('the "other" line: GM’s wording, [Try again] (one try for each scene it names), no ×', async () => {
    const retry = vi.fn();
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0)], stoppedScenes: { n1: true },
      sceneStops: { n1: { cause: 'other', reason: REASON, line: OTHER_ONE } }, retrySceneSave: retry } as never);
    render(<NoticeRegion screen="canvas" />);
    await screen.findByText(OTHER_ONE, {}, LAZY);
    const line = lineOf(OTHER_ONE);
    expect(line.parentElement?.getAttribute('data-notice-slot')).toBe('scene-stop');
    expect([...line.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again']);
    expect(document.querySelector('[aria-label="Dismiss"]')).toBeNull();
    fireEvent.click(line.querySelector('button')!);
    expect(retry).toHaveBeenCalledWith('n1');
  });
});

/** The declarations of every rule in `css` that lists `selector` (comments out). */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
function declsFor(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(',').map((part) => part.trim().replace(/\s+/g, ' ')).includes(selector)) continue;
    for (const decl of match[2].split(';')) {
      const at = decl.indexOf(':');
      if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
  }
  return out;
}
const PROPOSALS = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8');
const SKIN = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8');
const P = 'body.app-slava-restraint .canvas-undo-notice';
const FILLED = { 'border-color': 'var(--disabled-fill)', background: 'var(--disabled-fill)', color: 'var(--disabled-fill-label)' };
const GHOST = { background: 'transparent', color: 'var(--disabled-label)' };
/** The disabled look a notice button of this kind takes, for `state` (`:disabled` or the held look). */
const lookFor = (kind: '__action' | '__action--quiet' | '__close', state: ':disabled' | "[aria-disabled='true'][data-held-look]") => ({
  ...declsFor(PROPOSALS, `${P}${kind === '__action--quiet' ? '__action' : kind}${state}`),
  ...(kind === '__action--quiet' ? declsFor(PROPOSALS, `${P}__action--quiet${state}`) : {}),
});

describe('GM r33: notice buttons read the one disabled token set', () => {
  it('the tokens: one definition each, in the shared stylesheet', () => {
    const tokens = declsFor(SKIN, 'body.app-slava-restraint');
    expect(tokens['--sr-ink-light']).toBe('rgba(255, 255, 255, 0.55)');
    expect(tokens['--disabled-label']).toBe('var(--sr-ink-light)');
    expect(tokens['--disabled-fill']).toMatch(/^rgb\(255 255 255 \/ 0\.\d+\)$/);
    expect(tokens['--disabled-fill-label']).toMatch(/^rgb\(17 17 17 \/ 0\.\d+\)$/);
    expect(tokens['--disabled-opacity']).toBe('0.45');
    expect(tokens['--disabled-filter']).toBe('grayscale(1)');
  });

  it('filled, ghost and × buttons, held or locked: their own look, no whole-control opacity, hover the same, no pointer', () => {
    for (const state of [':disabled', "[aria-disabled='true'][data-held-look]"] as const) {
      expect(declsFor(PROPOSALS, `${P} button${state}`), state).toEqual({ opacity: '1', cursor: 'default' });
      expect(lookFor('__action', state), state).toEqual(FILLED);
      // A ghost button: no fill, its enabled edge (never brighter), the label grey.
      expect(lookFor('__action--quiet', state), state).toEqual({ ...FILLED, 'border-color': 'rgb(255 255 255 / 0.28)', ...GHOST });
      expect(declsFor(PROPOSALS, '.canvas-undo-notice__action--quiet')['border-color']).toBe('rgb(255 255 255 / 0.28)');
      expect(lookFor('__close', state), state).toEqual(GHOST);
      for (const kind of ['__action', '__action--quiet', '__close']) {
        expect(declsFor(PROPOSALS, `${P}${kind}${state}:hover`), `${kind}${state}:hover`).toEqual(declsFor(PROPOSALS, `${P}${kind}${state}`));
      }
    }
    // aria-disabled alone (the first ~150 ms) has no look of its own; hover leaves it as it is.
    expect(declsFor(PROPOSALS, `${P} button[aria-disabled='true']`)).toEqual({});
    expect(declsFor(PROPOSALS, `${P}__action[aria-disabled='true']:hover`)).toEqual({ background: 'rgb(255 255 255 / 0.9)' });
  });

  it.each<'following' | 'offline'>(['following', 'offline'])('%s: every lock-state notice button is truly disabled and takes its kind’s look', async (lock) => {
    const step = { id: 'u1', label: 'Delete', before: { nodes: {}, edges: {} }, after: { nodes: {}, edges: {} } };
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)],
      stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'other', reason: REASON, line: OTHER_ONE } },
      sceneClashes: { n2: { id: 81, line: 'Codex changed “Ref scene” while you were editing it.', agent: 'Codex' } },
      undoStack: [step], undoNotice: { id: 5, text: 'Deleted the node.', offer: 'undo', entry: step } } as never);
    act(() => { if (lock === 'following') setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }); else noteBackendConnection('offline'); });
    render(<><NoticeRegion screen="canvas" /><SceneUnsavedMark nodeId="n1" line={OTHER_ONE} stopped /></>);
    await screen.findByText(OTHER_ONE, {}, LAZY);
    const seen: string[] = [];
    const reads = (button: HTMLButtonElement | null, where: string) => {
      expect(button, where).not.toBeNull();
      expect(button!.disabled, where).toBe(true);
      expect(button!.matches(`${P} button:disabled`.replace('body.app-slava-restraint ', '')), where).toBe(true);
      const kind = button!.classList.contains('canvas-undo-notice__action--quiet') ? 'ghost' : 'filled';
      expect(button!.classList.contains('canvas-undo-notice__action'), where).toBe(true);
      seen.push(`${where}: ${button!.textContent} (${kind})`);
    };
    reads(lineOf(OTHER_ONE).querySelector('button'), 'stop line');
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-scene-clash="n2"] button')) reads(button, 'clash prompt');
    reads(screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement, 'canvas notice');
    // The popover leaves its scene out of the line while it is open (GM r28).
    fireEvent.click(screen.getByRole('button', { name: 'Unsaved' }));
    reads(document.querySelector('[data-scene-unsaved-popover="n1"] button'), 'popover');
    expect(seen).toEqual(['stop line: Try again (filled)', 'clash prompt: Keep mine (filled)', 'clash prompt: Use Codex’s (ghost)',
      'canvas notice: Undo (filled)', 'popover: Try again (filled)']);
  });
});

/**
 * GM r33's ratchet: no new literal disabled opacity (a number, or a number
 * as a var() fallback, in a rule for a disabled, locked or held control) in
 * the style files PR #198 touches. KNOWN is what was already there; the
 * pressed-state sweep moves them to the tokens and deletes them here. The
 * notice rules in canvasProposals.css have none.
 */
const TOUCHED = ['App.css', 'components/editor/EditorView.css', 'styles/asset-trash.css', 'styles/canvasProposals.css',
  'styles/cinema-node.css', 'styles/cinema-studio.css', 'styles/commons.css', 'styles/layouts.css', 'styles/moodboard-board.css',
  'styles/node-card-boundary.css', 'styles/noticeRegion.css', 'styles/project-home.css', 'styles/settings.css',
  'styles/slava-restraint.css', 'styles/workspace-header.css'];
const KNOWN = [
  'App.css | [data-offline-disabled], [data-following-disabled] | 0.6',
  'App.css | .provider-recovery-status button:disabled | 0.62',
  'styles/canvasProposals.css | .proposal-bar__button:disabled | 0.5',
  'styles/cinema-studio.css | body.app-slava-restraint .cinema-studio-toolbar__action:disabled | var(--sr-disabled-opacity, 0.5)',
  'styles/cinema-studio.css | body.app-slava-restraint .cinema-shots-rail__move:disabled | var(--sr-disabled-opacity, 0.5)',
  'styles/cinema-studio.css | body.app-slava-restraint .cinema-shots-rail__remove:disabled | var(--sr-disabled-opacity-strong, 0.45)',
  'styles/cinema-studio.css | body.app-slava-restraint .cinema-shot-panel__stepper-btn:disabled | var(--sr-disabled-opacity, 0.5)',
  'styles/cinema-studio.css | body.app-slava-restraint .cinema-shot-panel__action:disabled | var(--sr-disabled-opacity, 0.5)',
  'styles/project-home.css | body.app-slava-restraint .project-home__error button:disabled | 0.55',
  'styles/project-home.css | body.app-slava-restraint .project-home__notice-restore:disabled | 0.55',
];
/** Every literal disabled opacity in `text` (file `rel`). */
function literalDisabledOpacities(rel: string, text: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    const plain = selector.replace(/:not\([^)]*\)/g, '');
    if (!/:disabled|\[disabled\]|aria-disabled|-disabled\]|data-held-look|is-disabled|\.disabled\b/.test(plain)) continue;
    for (const decl of match[2].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0 || decl.slice(0, at).trim() !== 'opacity') continue;
      const value = decl.slice(at + 1).trim();
      const literal = /^[\d.]+$/.test(value) && Number(value) !== 1 && Number(value) !== 0;
      if (literal || /var\(--[\w-]+,\s*[\d.]+\s*\)/.test(value)) found.push(`${rel} | ${selector} | ${value}`);
    }
  }
  return found;
}

describe('GM r33: a ratchet on literal disabled opacities', () => {
  it('the files this PR touches add none; the known ones are the sweep’s list', () => {
    const found = TOUCHED.flatMap((rel) => literalDisabledOpacities(rel, readFileSync(join(__dirname, '../src', rel), 'utf8')));
    expect(found.filter((line) => !KNOWN.includes(line)), 'new literal disabled opacities').toEqual([]);
    expect(KNOWN.filter((line) => !found.includes(line)), 'gone: delete them from KNOWN').toEqual([]);
  });

  it('it catches one: a literal, and a literal as a var() fallback', () => {
    expect(literalDisabledOpacities('x.css', '.a:disabled { opacity: 0.6; } .b[aria-disabled="true"] { opacity: var(--t, 0.48) }'
      + ' .c:hover:not(:disabled) { opacity: 0.5 } .d:disabled { opacity: var(--disabled-opacity) }')).toEqual([
      'x.css | .a:disabled | 0.6', 'x.css | .b[aria-disabled="true"] | var(--t, 0.48)']);
  });

  it('no notice rule writes 0.6 or 0.48', () => {
    const notice = [...stripComments(PROPOSALS).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('.canvas-undo-notice'));
    expect(notice.filter((m) => /0?\.(6|48)\b(?!\d)/.test(m[2].replace(/\/\s*0\.\d+/g, ''))).map((m) => m[1].trim())).toEqual([]);
  });
});
