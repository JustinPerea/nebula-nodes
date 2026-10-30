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
    // Review 21 NIT-6: wait for the merged line before reading the single one gone.
    await screen.findByText(RUN_TWO, {}, LAZY);
    expect(screen.queryByText(RUN_ONE)).toBeNull();
    expect(lineOf(RUN_TWO).querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelectorAll('[data-scene-stop]')).toHaveLength(1);
    expect(document.querySelector('[aria-label="Dismiss"]')).toBeNull();
  });

  it('the "other" line: GM’s wording, [Try again] (one try for each scene it names), no ×', async () => {
    const retry = vi.fn();
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0)], stoppedScenes: { n1: true },
      sceneStops: { n1: { cause: 'other', reason: REASON, nebula: true, line: OTHER_ONE } }, retrySceneSave: retry } as never);
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
const SHARED_CSS = readFileSync(join(__dirname, '../src/styles/disabled-buttons.css'), 'utf8');
/** PR #198 round 25 (GM r37 option c): the notice's buttons take the app's
 * one shared rule (disabled-buttons.css) on GM r33's tokens. A held button
 * is in it once its first ~150 ms pass (useHeldLook's data-held-pending). */
const STATES = ":is(:disabled, [aria-disabled='true']:not([data-held-pending]))";
const FILLED = { background: 'var(--disabled-fill, rgb(255 255 255 / 0.42))', 'border-color': 'var(--disabled-fill, rgb(255 255 255 / 0.42))',
  color: 'var(--disabled-fill-label, rgb(17 17 17 / 0.62))' };
/** The quiet choice held: a ghost that keeps its own enabled edge (GM r33,
 * "its enabled edge, never brighter"; live clashsend21). */
const QUIET = { background: 'transparent', 'border-color': 'rgb(255 255 255 / 0.28)', color: 'var(--disabled-label, rgba(255, 255, 255, 0.55))' };
/** The shared rules for `className` in the disabled states, in file order,
 * each with its declarations (all !important) and whether hover is listed. */
function sharedRulesFor(className: string): Array<{ decls: Record<string, string>; hover: boolean }> {
  const out: Array<{ decls: Record<string, string>; hover: boolean }> = [];
  for (const match of stripComments(SHARED_CSS).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, ' ');
    if (!new RegExp(`\\.${className}[,)\\s]`).test(selector) || !selector.includes(STATES)) continue;
    const decls: Record<string, string> = {};
    for (const decl of match[2].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const value = decl.slice(at + 1).trim();
      expect(value, value).toMatch(/!important$/);
      decls[decl.slice(0, at).trim()] = value.replace(/\s*!important$/, '');
    }
    out.push({ decls, hover: selector.includes(`${STATES}:hover`) });
  }
  return out;
}
/** The look a class ends with: its shared rules, the later winning (all !important, equal specificity). */
const sharedLook = (...classes: string[]) => Object.assign({}, ...classes.flatMap((name) => sharedRulesFor(name)).map((rule) => rule.decls));
const pick = (decls: Record<string, string>, keys: string[]) => Object.fromEntries(keys.map((key) => [key, decls[key]]));

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

  it('filled, ghost and × buttons, held or locked: one look from the shared rule, no whole-control opacity, hover the same, no pointer', () => {
    // GM r37 option c: the filled actions (Try again, Keep mine, Undo, Redo,
    // Open copy, Save paused) the grey fill with its dark label; the quiet
    // choice a ghost (after the filled rule, so it stays unfilled).
    const filled = sharedRulesFor('canvas-undo-notice__action');
    expect(filled).toHaveLength(1);
    expect(filled[0].hover).toBe(true);
    expect(pick(filled[0].decls, ['background', 'border-color', 'color'])).toEqual(FILLED);
    expect(filled[0].decls).toMatchObject({ opacity: '1', 'box-shadow': 'none' });
    const quiet = sharedRulesFor('canvas-undo-notice__action--quiet');
    expect(quiet).toHaveLength(1);
    expect(quiet[0].hover).toBe(true);
    expect(pick(sharedLook('canvas-undo-notice__action', 'canvas-undo-notice__action--quiet'), ['background', 'border-color', 'color'])).toEqual(QUIET);
    expect(SHARED_CSS.indexOf(':is(.canvas-undo-notice__action--quiet)')).toBeGreaterThan(SHARED_CSS.indexOf('  .canvas-undo-notice__action,'));
    // The ×, not one of the shared rule's buttons: its grey label, no fill, hover the same.
    for (const state of [':disabled', "[aria-disabled='true'][data-held-look]"] as const) {
      expect(declsFor(PROPOSALS, `${P} button${state}`), state).toEqual({ opacity: '1', cursor: 'default' });
      expect(declsFor(PROPOSALS, `${P}__close${state}`), state).toEqual({ background: 'transparent', color: 'var(--disabled-label)' });
      expect(declsFor(PROPOSALS, `${P}__close${state}:hover`)).toEqual(declsFor(PROPOSALS, `${P}__close${state}`));
    }
    // No notice rule of its own for the actions' disabled look any more.
    const own = [...stripComments(PROPOSALS).matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(','))
      .map((one) => one.replace(/:not\([^)]*\)/g, '').trim()).filter((one) => /__action/.test(one) && /:disabled|data-held-look/.test(one));
    expect(own).toEqual([]);
    expect(stripComments(PROPOSALS)).not.toMatch(/!important/);
    // The first ~150 ms held: no look of its own; hover leaves it as it is.
    expect(declsFor(PROPOSALS, `${P} button[aria-disabled='true']`)).toEqual({});
    expect(declsFor(PROPOSALS, `${P}__action[aria-disabled='true']:hover`)).toEqual({ background: 'rgb(255 255 255 / 0.9)' });
    expect(declsFor(PROPOSALS, `${P}__action--quiet[aria-disabled='true']:hover`)).toEqual({ background: 'transparent' });
  });

  it.each<'following' | 'offline'>(['following', 'offline'])('%s: every lock-state notice button is truly disabled and takes its kind’s look', async (lock) => {
    const step = { id: 'u1', label: 'Delete', before: { nodes: {}, edges: {} }, after: { nodes: {}, edges: {} } };
    useGraphStore.setState({ ...base, nodes: [scene('n1', 'Opening', 0), scene('n2', 'Ref scene', 300)],
      stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'other', reason: REASON, nebula: true, line: OTHER_ONE } },
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
  // PR #199: the kept canvas's controls share the lock's look.
  'App.css | [data-offline-disabled], [data-following-disabled], [data-kept-disabled] | 0.6',
  'App.css | .provider-recovery-status button:disabled | 0.62',
  'styles/canvasProposals.css | .proposal-bar__button:disabled | 0.5',
  'styles/cinema-studio.css | body.app-slava-restraint .cinema-studio-toolbar__action:disabled | var(--sr-disabled-opacity, 0.5)',
  'styles/cinema-studio.css | body.app-slava-restraint .cinema-shots-rail__move:disabled | var(--sr-disabled-opacity, 0.5)',
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
