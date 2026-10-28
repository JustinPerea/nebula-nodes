import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 2 (review 2 and GM's round-2 rulings):
 * - Banner: on every screen but the canvas it is a row of the layout under
 *   the top header, opening on the panel spring after the offline delay.
 * - Gating: the paid and saving actions are disabled offline, neutral, with
 *   one shared helper.
 * - M2: a scene without `base` opens; a studio that can't render shows a
 *   contained line with Back to canvas instead of blanking the app.
 * - A shot that is rendering can't be removed (GM: block it).
 * - A screen's own load-failure notice hides while offline.
 * - The Agent log's time stays on one line.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));

import { OFFLINE_LINE } from '../src/components/BackendConnectionStatus';
import { WorkspaceHeader } from '../src/components/WorkspaceHeader';
import { STUDIO_BANNER_DELAY_MS } from '../src/components/StudioOfflineRow';
import { StudioBoundary } from '../src/components/StudioBoundary';
import { studioBoundaryLine } from '../src/lib/studioBoundary';
import { CinemaShotsRail } from '../src/components/cinema-studio/CinemaShotsRail';
import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { CinemaStudioToolbar } from '../src/components/cinema-studio/CinemaStudioToolbar';
import { CinemaSharedControls } from '../src/components/cinema-studio/CinemaSharedControls';
import { RemotionEditorToolbar } from '../src/components/video-editor/RemotionEditorToolbar';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { normalizeCinemaScene } from '../src/lib/cinemaScene';
import { useOfflineHiddenNotice } from '../src/hooks/useOfflineHiddenNotice';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { CinemaSceneSpec } from '../src/types';

const source = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8');
const css = (file: string) => source(file).replace(/\/\*[\s\S]*?\*\//g, '');

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetBackendConnectionForTests();
  useGraphStore.setState({ activeRuns: [] } as never);
});

// -- the banner row --------------------------------------------------------------

describe('GM: the banner is a row of each studio\'s layout, under its top header', () => {
  it('a brief drop doesn\'t open it; past the offline delay it opens and pushes content down; it closes on reconnect', () => {
    vi.useFakeTimers();
    render(<WorkspaceHeader title="Cinema" />);
    act(() => noteBackendConnection('offline'));
    act(() => { vi.advanceTimersByTime(STUDIO_BANNER_DELAY_MS - 100); });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => noteBackendConnection('online'));
    act(() => { vi.advanceTimersByTime(STUDIO_BANNER_DELAY_MS); });
    expect(screen.queryByRole('status')).toBeNull();

    act(() => noteBackendConnection('offline'));
    act(() => { vi.advanceTimersByTime(STUDIO_BANNER_DELAY_MS); });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toBe(OFFLINE_LINE);
    const row = banner.closest('.studio-offline-row')!;
    expect(row.getAttribute('data-open')).toBe('true');
    // The row sits right after the header, in the layout (not fixed).
    expect(row.previousElementSibling?.tagName).toBe('HEADER');
    act(() => noteBackendConnection('online'));
    expect(row.getAttribute('data-open')).toBe('false');
  });

  it('the canvas\'s header has no row (the canvas keeps the floating banner)', () => {
    vi.useFakeTimers();
    render(<WorkspaceHeader title="Canvas" offlineRow={false} />);
    act(() => noteBackendConnection('offline'));
    act(() => { vi.advanceTimersByTime(STUDIO_BANNER_DELAY_MS * 2); });
    expect(document.querySelector('.studio-offline-row')).toBeNull();
    expect(source('components/CanvasTabs.tsx')).toMatch(/offlineRow=\{false\}/);
  });

  it('the row opens and closes on the panel spring, 8px above and below, centred; no stock easing', () => {
    const rules = css('App.css');
    expect(rules).toMatch(/\.studio-offline-row\s*\{[^}]*transition:\s*grid-template-rows var\(--workspace-dock-spring/);
    expect(rules).not.toMatch(/\.studio-offline-row[^{]*\{[^}]*ease-in-out/);
    expect(rules).toMatch(/\.studio-offline-row__pad\s*\{[^}]*padding:\s*8px 0/);
    expect(rules).toMatch(/\.studio-offline-row__pad\s*\{[^}]*justify-content:\s*center/);
  });

  it('every studio\'s grid has the row; the floating studio offset is gone', () => {
    const header = css('styles/workspace-header.css');
    for (const view of ['cinema-studio-view', 'remotion-editor-view', 'character-studio-view', 'moodboard-studio-view',
      'commons-view', 'create-view']) {
      expect(header, view).toMatch(new RegExp(`\\.${view}\\.${view}[^{]*\\{[^}]*grid-template-areas:[^}]*offline`));
    }
    expect(css('App.css')).not.toMatch(/workspace-header-bottom/);
    expect(source('components/WorkspaceHeader.tsx')).not.toMatch(/usePublishedHeaderBottom/);
    expect(source('App.tsx')).toMatch(/placement=\{isHome \? 'home' : isCanvas \? 'workspace' : 'studio'\}/);
  });
});

// -- gating -------------------------------------------------------------------------

const SCENE: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
  shots: [{ id: 's1', prompt: 'a', output: { status: 'idle' } }, { id: 's2', prompt: 'b', output: { status: 'idle' } }] };

describe('GM: Cinema, Create and Remotion actions are disabled offline, neutral, through one helper', () => {
  const offline = () => act(() => noteBackendConnection('offline'));
  const gated = (button: HTMLElement) => {
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-offline-disabled');
    expect(button).toHaveAttribute('data-offline-neutral');
  };

  it('Cinema: Generate shot, Generate 2, Generate all and Add shot', () => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene: SCENE }, state: 'idle', outputs: {} } }] } as never);
    offline();
    render(<>
      <CinemaStudioToolbar cinemaNodeId="n1" />
      <CinemaShotsRail cinemaNodeId="n1" scene={SCENE} selectedShotId="s1" onSelect={() => {}} onAddShot={() => {}}
        onRemoveShot={() => {}} onReorder={() => {}} />
      <CinemaShotPanel cinemaNodeId="n1" scene={SCENE} shot={SCENE.shots[0]} onChangeShot={() => {}} />
    </>);
    gated(screen.getByRole('button', { name: 'Generate shot' }));
    gated(screen.getByRole('button', { name: 'Generate 2' }));
    gated(screen.getByRole('button', { name: 'Generate all' }));
    gated(screen.getByRole('button', { name: '+ Add shot' }));
  });

  it('Remotion: every add, REC and Export (its edits save into the project)', () => {
    useGraphStore.setState({ nodes: [] } as never);
    offline();
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    for (const name of ['+ Text', '+ SVG', '+ Image', '+ Video', '+ Iso Block', '+ Lottie', '● REC', 'Export']) {
      gated(screen.getByRole('button', { name }));
    }
  });

  // Merged with #195: where a control also takes the canvas lock it uses
  // canvasLock's lockedAction, which applies the same offline title and
  // neutral mark (offlineReason, OFFLINE_NEUTRAL) on top of the lock.
  it('one helper: Cinema, Create and Remotion use offlineAction or lockedAction; neutral is one rule', () => {
    for (const file of ['components/cinema-studio/CinemaShotPanel.tsx', 'components/cinema-studio/CinemaShotsRail.tsx',
      'components/cinema-studio/CinemaStudioToolbar.tsx', 'components/create-studio/CreateComposer.tsx',
      'components/video-editor/RemotionEditorToolbar.tsx']) {
      expect(source(file), file).toMatch(/\b(?:offlineAction|lockedAction)\(/);
    }
    expect(css('App.css')).toMatch(/\[data-offline-neutral\][^{]*\{[^}]*background:\s*var\(--sr-surface-control\)/);
  });
});

// -- a shot that is rendering ----------------------------------------------------------

describe('GM: a shot that is rendering can\'t be removed', () => {
  const rail = () => render(<CinemaShotsRail cinemaNodeId="n1" scene={SCENE} selectedShotId="s1" onSelect={() => {}}
    onAddShot={() => {}} onRemoveShot={() => {}} onReorder={() => {}} />);

  it('with a stop control on the shot: "Stop the run first."', () => {
    useGraphStore.setState({ activeRuns: [{ id: 'r1', kind: 'cinema-shot', nodeId: 'n1', shotId: 's2', nodeIds: ['n1'], status: 'running' }] } as never);
    rail();
    const remove = screen.getByRole('button', { name: 'Remove Shot 2' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'Stop the run first.');
    expect(screen.getByRole('button', { name: 'Remove Shot 1' })).toBeEnabled();
  });

  it('a whole-scene run has Stop scene: "Stop the run first." for every shot', () => {
    useGraphStore.setState({ activeRuns: [{ id: 'r1', kind: 'graph', nodeIds: ['n1'], status: 'running' }] } as never);
    rail();
    for (const name of ['Remove Shot 1', 'Remove Shot 2']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('title', 'Stop the run first.');
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('rendering with no Stop here (the run still starting): "Wait for “Shot 2” to finish."', () => {
    const scene = { ...SCENE, shots: [SCENE.shots[0], { ...SCENE.shots[1], output: { status: 'running' as const } }] };
    render(<CinemaShotsRail cinemaNodeId="n1" scene={scene} selectedShotId="s1" onSelect={() => {}}
      onAddShot={() => {}} onRemoveShot={() => {}} onReorder={() => {}} />);
    expect(screen.getByRole('button', { name: 'Remove Shot 2' })).toHaveAttribute('title', 'Wait for “Shot 2” to finish.');
    expect(screen.getByRole('button', { name: 'Remove Shot 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Shot 1' })).toBeEnabled();
  });
});

// -- M2 -------------------------------------------------------------------------------

describe('M2: a scene without base opens; a studio that can\'t render is contained', () => {
  it('the scene settings read through the defaults', () => {
    const bare = normalizeCinemaScene({ shots: [{ id: 's1', prompt: 'x' }] });
    expect(bare).toMatchObject({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9' });
    render(<CinemaSharedControls cinemaNodeId="n1" scene={{ shots: [] } as unknown as CinemaSceneSpec} onChange={() => {}} />);
    expect(screen.getAllByText('Seedream 4.5').length).toBeGreaterThan(0);
  });

  it('GM\'s line, Back to canvas, and the Agent log line', () => {
    const logged: string[] = [];
    const listen = (event: Event) => logged.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('nebula:agent-log-entry', listen);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn();
    useUIStore.setState({ exitCinemaEditor: exit } as never);
    const Boom = () => { throw new TypeError("Cannot read properties of undefined (reading 'model')"); };
    render(<StudioBoundary studio="cinema-editor" node={{ id: 'n4', label: 'Opening' }} problem={() => ({ field: 'scene.base', state: 'missing' })}><Boom /></StudioBoundary>);
    window.removeEventListener('nebula:agent-log-entry', listen);
    expect(screen.getByRole('alert').textContent).toContain(
      "Couldn't open “Opening”. Some of its data is missing or damaged, so Nebula can't show it.");
    fireEvent.click(screen.getByRole('button', { name: 'Back to canvas' }));
    expect(exit).toHaveBeenCalled();
    // GM r8: a studio's line names the studio.
    expect(logged).toEqual(['Couldn\'t open “Opening” in Cinema, node n4. scene.base is missing.']);
  });

  it('with no label, the studio\'s noun', () => {
    expect(studioBoundaryLine('cinema-editor', null, true)).toBe("Couldn't open this scene. Some of its data is missing or damaged, so Nebula can't show it.");
    expect(studioBoundaryLine('editor', null, true)).toBe("Couldn't open this clip. Some of its data is missing or damaged, so Nebula can't show it.");
    expect(studioBoundaryLine('remotion-editor', null, true)).toBe("Couldn't open this shot list. Some of its data is missing or damaged, so Nebula can't show it.");
  });

  it('App puts every studio inside the boundary', () => {
    expect(source('App.tsx')).toMatch(/<StudioBoundary/);
  });
});

// -- load-failure notices offline -----------------------------------------------------

describe('GM: a screen\'s own load-failure notice hides while offline', () => {
  function Probe({ notice, onReconnect }: { notice: string | null; onReconnect?: () => void }) {
    const shown = useOfflineHiddenNotice(notice, onReconnect);
    return <p>{shown ?? 'none'}</p>;
  }

  it('hidden offline, back on reconnect, and the screen gets to check again', () => {
    const retry = vi.fn();
    render(<Probe notice="Character not found — it may have been deleted for good." onReconnect={retry} />);
    expect(screen.getByText(/Character not found/)).toBeTruthy();
    act(() => noteBackendConnection('offline'));
    expect(screen.getByText('none')).toBeTruthy();
    act(() => noteBackendConnection('online'));
    expect(screen.getByText(/Character not found/)).toBeTruthy();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Character, Moodboard and Commons use it', () => {
    for (const file of ['components/character-studio/CharacterStudioView.tsx', 'components/moodboard-studio/MoodboardStudioView.tsx',
      'components/commons/CommonsView.tsx']) {
      expect(source(file), file).toMatch(/useOfflineHiddenNotice\(/);
    }
  });
});

// -- the Agent log's time ---------------------------------------------------------------

describe('GM: the Agent log\'s time never wraps', () => {
  it('nowrap, in a column as wide as the time', () => {
    const rules = css('styles/slava-restraint.css');
    expect(rules).toMatch(/body\.app-slava-restraint \.agent-log__time\s*\{[^}]*white-space:\s*nowrap/);
    expect(rules).toMatch(/body\.app-slava-restraint \.agent-log__entry\s*\{[^}]*grid-template-columns:\s*8px max-content/);
  });
});

describe('M2: the Agent log names the field the studio couldn\'t read', () => {
  it('a broken shot before a missing base (the base is filled in)', async () => {
    const { cinemaSceneProblem } = await import('../src/lib/studioBoundary');
    // GM r6 item 4 (fix round 5): each with whether it is missing or damaged.
    expect(cinemaSceneProblem({ scene: { shots: [null] } })).toEqual({ field: 'scene.shots[0]', state: 'damaged' });
    expect(cinemaSceneProblem({ scene: { shots: 's1' } })).toEqual({ field: 'scene.shots', state: 'damaged' });
    expect(cinemaSceneProblem({ scene: { shots: [] } })).toEqual({ field: 'scene.base', state: 'missing' });
    expect(cinemaSceneProblem({})).toEqual({ field: 'scene', state: 'missing' });
    expect(cinemaSceneProblem({ scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [] } })).toBeNull();
  });
});
