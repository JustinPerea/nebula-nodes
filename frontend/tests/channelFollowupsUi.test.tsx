import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { EvaluationBatch } from '../src/lib/commonsEvaluationTypes';
import type { NodeData } from '../src/types';

/**
 * The follow-up to PR #114, GM's r18 rulings and review 17 L3:
 * - G4: Stop's icon gets a 16px slot like Run's; the dots stay 14px, centred.
 * - The video editor offline: the banner sits right under the editor header;
 *   Trim, Speed, Cut and Vol get the disabled style; Render Preview's disabled
 *   state is neutral, like Export's; Play, scrub and the timecode stay usable.
 * - Home: a card's rename, cover and delete icons, disabled offline, get the
 *   disabled style.
 * - The price chip's prefixes get GM's tooltips.
 * - Commons: the accents line says "changed"; a draft carried over a
 *   reconnect must be for the same image in the same batch (L3).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
    useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
      selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
  };
});
const api = vi.hoisted(() => ({ get: vi.fn(), prepare: vi.fn(), image: vi.fn(), accents: vi.fn(), labels: vi.fn(), seal: vi.fn() }));
vi.mock('../src/lib/commonsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/commonsApi')>(),
  commonsEvaluationApi: api,
}));

import { BackendConnectionStatus } from '../src/components/BackendConnectionStatus';
import { EditorTransport } from '../src/components/editor/EditorTransport';
import { ProjectHome } from '../src/components/projects/ProjectHome';
import {
  ACCENTS_CHANGED_ELSEWHERE, BATCH_REPLACED_ELSEWHERE, CommonsEvaluation, IMAGE_REPLACED_ELSEWHERE, LABELS_CHANGED_ELSEWHERE,
} from '../src/components/commons/CommonsEvaluation';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { runChipLabel, runChipTitle, type RunScopeSummary } from '../src/lib/runScope';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const css = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The body of the rule whose selector list includes `selector` exactly. */
const rule = (source: string, selector: string) => {
  for (const match of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (match[1].split(',').map((part) => part.trim()).includes(selector)) return match[2];
  }
  return '';
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetBackendConnectionForTests();
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('G4: Stop\'s icon slot is Run\'s 16px, so the label doesn\'t shift when the button swaps', () => {
  it('the slot is 16px and the 14px dots sit centred in it', () => {
    const styles = css('styles/slava-restraint.css');
    expect(rule(styles, 'body.app-slava-restraint .toolbar__icon-slot')).toMatch(/width:\s*16px/);
    expect(rule(styles, 'body.app-slava-restraint .toolbar__icon-slot')).toMatch(/height:\s*16px/);
    const dots = rule(styles, 'body.app-slava-restraint .toolbar__button--executing .toolbar__icon-slot::before');
    // The 19px matrix scaled 0.7368 is 14px: (16 - 14) / 2 on each side.
    expect(dots).toMatch(/left:\s*1px/);
    expect(dots).toMatch(/top:\s*1px/);
    expect(dots).toMatch(/scale\(0\.7368\)/);
  });
});

describe('the video editor offline', () => {
  const clip = { id: 'c1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, volume: 1, mute: false };
  const editNode = { id: 'e1', type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId: 'video-edit', label: 'Edit', params: { clips: [clip], sourceFps: 30 }, state: 'idle', outputs: {} } } as unknown as Node<NodeData>;

  it('the banner sits right under the editor header, not at the canvas\'s place', () => {
    // GM, PR #198 r1 item 5: the editor is a studio like the others; the
    // banner is 8px under its header's published bottom (61px, so 69px).
    noteBackendConnection('offline');
    render(<BackendConnectionStatus placement="studio" />);
    expect(document.querySelector('.backend-connection')).toHaveAttribute('data-placement', 'studio');
    expect(rule(css('App.css'), ".backend-connection[data-placement='studio']"))
      .toMatch(/top:\s*calc\(var\(--workspace-header-bottom,\s*61px\)\s*\+\s*8px\)/);
    const app = readFileSync(join(__dirname, '../src/App.tsx'), 'utf8');
    expect(app).toMatch(/placement=\{isHome \? 'home' : isCanvas \? 'workspace' : 'studio'\}/);
  });

  it('Trim, Speed, Cut and Vol, Render Preview and Export are disabled with the offline mark; Play and the edit points stay', () => {
    noteBackendConnection('offline');
    render(<EditorTransport editNode={editNode} sourceUrl="/api/outputs/v.mp4" />);
    for (const name of ['Trim', 'Speed', 'Cut', 'Vol', 'Render Preview', 'Export…']) {
      const button = screen.getByText(name).closest('button')!;
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('data-offline-disabled');
    }
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous edit point' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next edit point' })).toBeEnabled();
  });

  it('a selected clip\'s speed, volume and mute are disabled offline too', () => {
    useUIStore.setState({ selectedClipId: 'c1' });
    noteBackendConnection('offline');
    render(<EditorTransport editNode={editNode} sourceUrl="/api/outputs/v.mp4" />);
    for (const range of document.querySelectorAll('.editor-transport__range')) expect(range).toBeDisabled();
    for (const preset of document.querySelectorAll('.editor-transport__preset')) expect(preset).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mute clip' })).toBeDisabled();
  });

  it('online, they are enabled', () => {
    render(<EditorTransport editNode={editNode} sourceUrl="/api/outputs/v.mp4" />);
    for (const name of ['Trim', 'Speed', 'Cut', 'Vol', 'Render Preview', 'Export…']) {
      expect(screen.getByText(name).closest('button'), name).toBeEnabled();
    }
  });

  it('the tools have a disabled style; Render Preview and Export are neutral when disabled', () => {
    const styles = css('styles/slava-restraint.css');
    expect(rule(styles, 'body.app-slava-restraint .editor-transport__tool:disabled')).toMatch(/opacity:\s*var\(--sr-disabled-opacity\)/);
    for (const selector of ['body.app-slava-restraint .editor-transport__btn--render:disabled',
      'body.app-slava-restraint .editor-transport__btn--export:disabled']) {
      const body = rule(styles, selector);
      expect(body, selector).toMatch(/border-color:\s*var\(--sr-edge\)/);
      expect(body, selector).toMatch(/background:\s*var\(--sr-surface-control\)/);
      expect(body, selector).not.toMatch(/accent/);
    }
  });
});

describe('Home: a card\'s icons disabled offline get the disabled style', () => {
  const project = { id: 'p1', name: 'Glass', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-09T12:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null };
  const props = { projects: [project], loading: false, busy: false, error: null, onCreate: vi.fn(), onOpen: vi.fn(),
    onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), loadCoverChoices: vi.fn(async () => []), onPinCover: vi.fn() };

  it('rename, cover and delete are disabled with the offline mark', () => {
    noteBackendConnection('offline');
    render(<ProjectHome {...props} />);
    for (const name of ['Rename Glass', 'Delete Glass', 'Choose a cover for Glass']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('data-offline-disabled');
    }
  });

  it('online, they carry no mark', () => {
    render(<ProjectHome {...props} />);
    expect(screen.getByRole('button', { name: 'Rename Glass' })).not.toHaveAttribute('data-offline-disabled');
  });

  it('the icons have a disabled style', () => {
    expect(rule(css('styles/project-home.css'), 'body.app-slava-restraint .project-home__rename:disabled'))
      .toMatch(/opacity:\s*var\(--sr-disabled-opacity\)/);
  });
});

describe('the price chip\'s tooltips (GM)', () => {
  const summary = (cost: Partial<NonNullable<RunScopeSummary['cost']>>): RunScopeSummary => ({ total: 1, paid: ['GPT Image 2.5'],
    cost: { low: 0.067, high: 0.067, lines: [{ name: 'GPT Image 2.5', low: 0.067, high: 0.067, runs: [1, 1] }],
      unpriced: [], plan: [], plus: [], awaitingInput: [], ...cost } });

  it('"~$X": "Estimated cost"', () => {
    expect(runChipLabel(summary({}))).toBe('~$0.067');
    expect(runChipTitle(summary({}))).toBe('Estimated cost');
  });

  it('"$X+": "At least $X. Some costs aren\'t known yet."', () => {
    expect(runChipLabel(summary({ unpriced: ['Kling'] }))).toBe('$0.067+');
    expect(runChipTitle(summary({ unpriced: ['Kling'] }))).toBe("At least $0.067. Some costs aren't known yet.");
    expect(runChipTitle(summary({ plus: ['input images'] }))).toBe("At least $0.067. Some costs aren't known yet.");
    // A range with a "+": the least it can be is the low end.
    expect(runChipTitle(summary({ low: 0.05, high: 0.43, unpriced: ['Kling'] }))).toBe("At least $0.05. Some costs aren't known yet.");
  });

  it('no tooltip for a plain range or "N paid"', () => {
    expect(runChipTitle(summary({ low: 0.05, high: 0.43 }))).toBeUndefined();
    expect(runChipTitle({ total: 1, paid: ['X'] })).toBeUndefined();
  });

  it('both Run chips carry it', () => {
    for (const file of ['components/panels/Toolbar.tsx', 'components/SelectionToolbar.tsx']) {
      expect(readFileSync(join(__dirname, '../src', file), 'utf8'), file).toMatch(/title=\{runChipTitle\(runScope\)\}/);
    }
  });
});

describe('Commons label drafts (GM line; review 17 L3)', () => {
  const batch = (revision: number, { locked = true, image = 'image-a', manifest = 'manifest-1' } = {}): EvaluationBatch => ({
    revision, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: manifest, sealed: null, seal_hash: null,
    closed: null, close_hash: null, fields: { type_style: ['none'] }, axes: ['quiet_loud'], roles: ['accent'],
    keywords: ['geometric_type'], excluded_count: 0, assisted_reviews: 0,
    items: [{ position: 0, image_sha256: image, width: 40, height: 32, accent_locked: locked, labels: null,
      ...(locked ? { palette: [{ index: 0, hex: '#ff0000', share: 1 }] } : {}) }] });

  beforeEach(() => {
    api.image.mockResolvedValue(new Blob(['fixture']));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('Image', class {
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
  });

  it('the accents line says "changed"', () => {
    expect(ACCENTS_CHANGED_ELSEWHERE).toBe("You changed this reference's accents in another window while Nebula was offline, so your changes here weren't saved.");
  });

  async function draftThenReconnectTo(fresh: EvaluationBatch) {
    api.get.mockResolvedValueOnce(batch(4));
    render(<CommonsEvaluation />);
    await screen.findByText('Set neutral');
    fireEvent.click(screen.getByText('Set neutral'));
    act(() => noteBackendConnection('offline'));
    api.get.mockResolvedValueOnce(fresh);
    act(() => noteBackendConnection('online'));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  }

  it('another image at the same position (same unlabeled state): the draft is dropped, with the line', async () => {
    await draftThenReconnectTo(batch(5, { image: 'image-b' }));
    // GM, PR #198 r1 item 4: its own line (tests/pr198Fix1Ui.test.tsx).
    expect(await screen.findByText(IMAGE_REPLACED_ELSEWHERE)).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).not.toBe('0');
  });

  it('another batch (a new manifest): the draft is dropped, with the line', async () => {
    await draftThenReconnectTo(batch(5, { manifest: 'manifest-2' }));
    expect(await screen.findByText(BATCH_REPLACED_ELSEWHERE)).toHaveAttribute('role', 'status');
  });

  it('the same image in the same batch: the draft survives', async () => {
    await draftThenReconnectTo(batch(5));
    await waitFor(() => expect(screen.getByText('Save labels')).toBeEnabled());
    expect(screen.getByLabelText('quiet loud').getAttribute('aria-valuetext')).toBe('0');
    expect(screen.queryByText(LABELS_CHANGED_ELSEWHERE)).toBeNull();
  });
});
