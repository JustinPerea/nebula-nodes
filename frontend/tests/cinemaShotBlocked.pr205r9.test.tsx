import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CinemaSceneSpec, NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));

import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { CinemaStudioToolbar } from '../src/components/cinema-studio/CinemaStudioToolbar';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { resetDeletedSceneEditsForTests, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCinemaUploadStore, type CinemaReferenceUpload } from '../src/store/cinemaUploadStore';

// GM PR #205 r18: the Cinema shot panel while a shot is blocked. Generate N
// says it is refused as Generate shot does, the Variations stepper (it only
// sets the count) stays live, and the status line never says "Ready to
// generate" while a lock line says otherwise.

const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();
const REMOVE_ONLY = 'You can generate after you remove “ref.png”.';

function scene(status?: 'done' | 'running' | 'error'): CinemaSceneSpec {
  const spec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
    shots: [{ id: 'b', prompt: 'Two', ...(status ? { output: { status, imageUrl: '/b.png' } } : {}) }] } as never as CinemaSceneSpec;
  const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
    data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene: spec }, state: 'idle', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false, activeRuns: [] } as never);
  useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
  return spec;
}
const blocked = (): CinemaReferenceUpload => ({ id: 'u1', attempt: 'x', nodeId: 'n1', shotId: 'b', name: 'ref.png',
  status: 'error', error: 'Upload was interrupted. Remove it, then attach the image again.', canRetry: false });
const panel = (spec: CinemaSceneSpec) => render(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')]
  .find((item) => item.textContent?.trim() === text) as HTMLButtonElement;
const label = (root: HTMLElement, name: string) => root.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;
const heading = (root: HTMLElement) => root.querySelector('.cinema-shot-panel__heading')?.textContent;

beforeEach(() => { resetCanvasFollowForTests(); resetBackendConnectionForTests(); });
afterEach(() => {
  cleanup();
  act(() => { resetCanvasFollowForTests(); resetBackendConnectionForTests(); });
  resetDeletedSceneEditsForTests();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  useCinemaUploadStore.setState({ uploads: [] });
});

describe('GM PR #205 r18 item 1: Generate N while the shot is blocked', () => {
  it('aria-disabled and the same description as Generate shot', () => {
    const spec = scene();
    useCinemaUploadStore.setState({ uploads: [blocked()] });
    const { container } = panel(spec);
    const generateN = button(container, 'Generate 2');
    expect(generateN).toBeDisabled();
    expect(generateN).toHaveAttribute('aria-disabled', 'true');
    expect(generateN).toHaveAccessibleDescription(REMOVE_ONLY);
    expect(generateN.getAttribute('aria-describedby')).toBe(button(container, 'Generate shot').getAttribute('aria-describedby'));
  });
  it('control: not blocked, no aria-disabled', () => {
    const { container } = panel(scene());
    expect(button(container, 'Generate 2')).not.toHaveAttribute('aria-disabled');
    expect(button(container, 'Generate 2')).toBeEnabled();
  });
});

describe('GM PR #205 r18 item 2: the Variations stepper stays live while the shot is blocked', () => {
  it('a blocked shot: − and + set the count within 1 and 4; Generate N follows it, still refused', () => {
    const spec = scene();
    useCinemaUploadStore.setState({ uploads: [blocked()] });
    const { container } = panel(spec);
    const more = label(container, 'More variations');
    const fewer = label(container, 'Fewer variations');
    expect(more).toBeEnabled();
    expect(fewer).toBeEnabled();
    fireEvent.click(more); fireEvent.click(more);
    expect(button(container, 'Generate 4')).toHaveAttribute('aria-disabled', 'true');
    expect(more).toBeDisabled();
    for (let i = 0; i < 3; i++) fireEvent.click(fewer);
    expect(button(container, 'Generate 1')).toBeDisabled();
    expect(fewer).toBeDisabled();
  });
  it('a running shot leaves it live too', () => {
    const spec = scene('running');
    const { container } = panel(spec);
    expect(label(container, 'More variations')).toBeEnabled();
  });
  it('control: offline and following still lock it', () => {
    const spec = scene();
    const { container } = panel(spec);
    act(() => noteBackendConnection('offline'));
    expect(label(container, 'More variations')).toBeDisabled();
    act(() => resetBackendConnectionForTests());
    act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
    expect(label(container, 'More variations')).toBeDisabled();
  });
});

describe('GM PR #205 r18 item 3: no "Ready to generate" while a lock line shows', () => {
  it('blocked by an upload: no status line; removing it brings "Ready to generate" back', () => {
    const spec = scene();
    useCinemaUploadStore.setState({ uploads: [blocked()] });
    const { container } = panel(spec);
    expect(heading(container)).toBe('Shot 1');
    expect(container.textContent).toContain(REMOVE_ONLY);
    act(() => useCinemaUploadStore.setState({ uploads: [] }));
    expect(heading(container)).toBe('Shot 1Ready to generate');
  });
  it('blocked by another run (the shared-inputs line): no status line', () => {
    const spec = scene();
    useGraphStore.setState({ isShotAdmissionBlocked: () => true } as never);
    const { container } = panel(spec);
    expect(heading(container)).toBe('Shot 1');
  });
  it.each([
    ['done', 'Generated'],
    ['running', 'Generating…'],
    ['error', 'Generation failed'],
  ] as const)('the shot\'s own state shows under a lock line: %s', (status, text) => {
    const spec = scene(status);
    useCinemaUploadStore.setState({ uploads: [blocked()] });
    const { container } = panel(spec);
    expect(heading(container)).toBe(`Shot 1${text}`);
  });
});

describe('review 8 item 17 (GM default): Generate all\'s line for failed shared uploads says "generate all"', () => {
  const shared = (name: string, canRetry: boolean): CinemaReferenceUpload => ({ id: `s-${name}`, attempt: 'x', nodeId: 'n1', name,
    status: 'error', error: 'Upload failed.', canRetry });
  const generateAll = (root: HTMLElement) => button(root, 'Generate all');
  it.each([
    ['try again', [shared('ref.png', true)], 'You can generate all after you try “ref.png” again or remove it.'],
    ['remove only', [shared('ref.png', false)], 'You can generate all after you remove “ref.png”.'],
    ['both', [shared('a.png', true), shared('ref.png', false)],
      'You can generate all after you try “a.png” again or remove it, and remove “ref.png”.'],
  ])('%s', (_label, uploads, line) => {
    scene();
    useCinemaUploadStore.setState({ uploads });
    const { container } = render(<CinemaStudioToolbar cinemaNodeId="n1" />);
    expect(generateAll(container)).toBeDisabled();
    expect(generateAll(container)).toHaveAttribute('title', line);
  });
  it('control: the shot panel keeps "You can generate after …"', () => {
    const spec = scene();
    useCinemaUploadStore.setState({ uploads: [shared('ref.png', false)] });
    const { container } = panel(spec);
    expect(container.textContent).toContain('You can generate after you remove “ref.png”.');
  });
});
