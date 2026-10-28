import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvaluationBatch } from '../src/lib/commonsEvaluationTypes';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

/**
 * PR #198 fix round 1, GM's rulings (gm-pr198-r1.md) and review 1's lows:
 * - (4) Commons: a reference's image or the batch replaced in another window
 *   gets its own line.
 * - (5) One banner rule: under the topmost header of whatever screen shows.
 *   The canvas keeps its place; every studio's banner goes under its own
 *   header, measured from that header.
 * - (6) The price chip: "$0" only ever means free; sub-cent is "<$0.01".
 * - (7) A universal node's settings: sentence case; the Agent log never
 *   drops an agent's action (MCP-SETUP.md's promise).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));
const api = vi.hoisted(() => ({ get: vi.fn(), prepare: vi.fn(), image: vi.fn(), accents: vi.fn(), labels: vi.fn(), seal: vi.fn() }));
vi.mock('../src/lib/commonsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/commonsApi')>(),
  commonsEvaluationApi: api,
}));

import { BackendConnectionStatus } from '../src/components/BackendConnectionStatus';
import {
  BATCH_REPLACED_ELSEWHERE, CommonsEvaluation, IMAGE_REPLACED_ELSEWHERE, LABELS_CHANGED_ELSEWHERE,
} from '../src/components/commons/CommonsEvaluation';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { runChipLabel, runChipTitle, type RunScopeSummary } from '../src/lib/runScope';
import { proposalEstimateLabel } from '../src/lib/canvasProposals';
import { formatSpentUsd } from '../src/lib/pricing';
import { universalSettingLabel } from '../src/lib/universalSettingLabel';
import { agentActionEntry } from '../src/store/agentLogStore';

const css = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const source = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8');
const rule = (text: string, selector: string) => {
  for (const match of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (match[1].split(',').map((part) => part.trim()).includes(selector)) return match[2];
  }
  return '';
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetBackendConnectionForTests();
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GM (4): Commons, a replaced image or batch gets its own line', () => {
  const batch = (revision: number, { image = 'image-a', manifest = 'manifest-1' } = {}): EvaluationBatch => ({
    revision, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: manifest, sealed: null, seal_hash: null,
    closed: null, close_hash: null, fields: { type_style: ['none'] }, axes: ['quiet_loud'], roles: ['accent'],
    keywords: ['geometric_type'], excluded_count: 0, assisted_reviews: 0,
    items: [{ position: 0, image_sha256: image, width: 40, height: 32, accent_locked: true, labels: null,
      palette: [{ index: 0, hex: '#ff0000', share: 1 }] }] });

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

  it('the two lines, verbatim', () => {
    expect(IMAGE_REPLACED_ELSEWHERE).toBe("You replaced this reference's image in another window while Nebula was offline, so your changes here weren't saved.");
    expect(BATCH_REPLACED_ELSEWHERE).toBe("You replaced this batch in another window while Nebula was offline, so your changes here weren't saved.");
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

  it('another image at the same position: the image line', async () => {
    await draftThenReconnectTo(batch(5, { image: 'image-b' }));
    expect(await screen.findByText(IMAGE_REPLACED_ELSEWHERE)).toHaveAttribute('role', 'status');
    expect(screen.queryByText(LABELS_CHANGED_ELSEWHERE)).toBeNull();
  });

  it('another batch (a new manifest): the batch line, even when the image matches too', async () => {
    await draftThenReconnectTo(batch(5, { manifest: 'manifest-2' }));
    expect(await screen.findByText(BATCH_REPLACED_ELSEWHERE)).toHaveAttribute('role', 'status');
    expect(screen.queryByText(IMAGE_REPLACED_ELSEWHERE)).toBeNull();
  });
});

describe('GM (5): the banner sits right under the topmost header of whatever screen shows', () => {
  const STUDIOS: [string, string][] = [
    ['cinema-studio/CinemaStudioView.tsx', 'Cinema'],
    ['character-studio/CharacterStudioToolbar.tsx', 'Character'],
    ['moodboard-studio/MoodboardStudioView.tsx', 'Moodboard'],
    ['create-studio/CreateView.tsx', 'Creator Studio'],
    ['video-editor/RemotionEditorView.tsx', 'Composition'],
    ['editor/EditorView.tsx', 'Video editor'],
    ['commons/CommonsView.tsx', 'Commons'],
  ];

  it('every studio\'s topmost header is the WorkspaceHeader', () => {
    for (const [file, title] of STUDIOS) {
      expect(source(`components/${file}`), file).toMatch(new RegExp(`<WorkspaceHeader title="${title}"`));
    }
  });

  it('App: the canvas keeps its place, home its own, every other screen is a studio', () => {
    expect(source('App.tsx')).toMatch(/placement=\{isHome \? 'home' : isCanvas \? 'workspace' : 'studio'\}/);
  });

  it('a studio shows no floating banner: its row under the header has it (GM, PR #198 r2; pr198Fix2Ui)', () => {
    noteBackendConnection('offline');
    render(<BackendConnectionStatus placement="studio" />);
    expect(document.querySelector('.backend-connection')).toBeNull();
    expect(rule(css('App.css'), ".backend-connection[data-placement='studio']")).toBe('');
    expect(rule(css('App.css'), ".backend-connection[data-placement='editor']")).toBe('');
  });
});

describe('GM (6): the price chip, "$0" only ever means free', () => {
  const summary = (cost: Partial<NonNullable<RunScopeSummary['cost']>>): RunScopeSummary => ({ total: 1, paid: ['GPT Image 2.5'],
    cost: { low: 0.067, high: 0.067, lines: [{ name: 'GPT Image 2.5', low: 0.067, high: 0.067, runs: [1, 1] }],
      unpriced: [], plan: [], plus: [], awaitingInput: [], ...cost } });

  it('"$0 + unpriced": the known part really is $0 (GM, PR #198 r6 and r7 item 3)', () => {
    const zero = summary({ low: 0, high: 0, unpriced: ['Kling'] });
    expect(runChipLabel(zero)).toBe('$0 + unpriced');
    expect(runChipTitle(zero)).toBe('The priced part of this run is free.');
  });

  it('a range from $0: "Up to $0.43" (GM, PR #198 r6 item 2), with or without " + unpriced"', () => {
    expect(runChipLabel(summary({ low: 0, high: 0.43, unpriced: ['Kling'] }))).toBe('Up to $0.43 + unpriced');
    expect(runChipTitle(summary({ low: 0, high: 0.43, unpriced: ['Kling'] })))
      .toBe('The priced part of this run costs up to $0.43.');
    expect(runChipLabel(summary({ low: 0, high: 0.43 }))).toBe('Up to $0.43');
    expect(runChipTitle(summary({ low: 0, high: 0.43 }))).toBe('Up to $0.43.');
  });

  it('a non-zero amount under a cent is never "$0" or a sub-cent figure: "<$0.01"', () => {
    // GM r4 (fix round 4): a range from under a cent is "Up to $Y" on the chip too.
    expect(runChipLabel(summary({ low: 0.0047, high: 0.43, unpriced: ['Kling'] }))).toBe('Up to $0.43 + unpriced');
    expect(runChipLabel(summary({ low: 0.0047, high: 0.0047 }))).toBe('<$0.01');
    expect(runChipLabel(summary({ low: 0.0047, high: 0.0047, unpriced: ['Kling'] }))).toBe('<$0.01 + unpriced');
    expect(runChipLabel(summary({ low: 0.0001, high: 0.0049 }))).toBe('<$0.01');
    for (const shape of [summary({ low: 0.0047, high: 0.43, unpriced: ['Kling'] }), summary({ low: 0.0047, high: 0.0047 }),
      summary({ low: 0.0047, high: 0.0047, unpriced: ['Kling'] })]) {
      // GM, PR #198 r2 ask 1: "under $0.01" on its own; r3 item 6: a range
      // from under a cent is "Up to $Y.".
      expect(runChipTitle(shape)).toMatch(/[Uu]nder \$0\.01|^Up to \$0\.43|costs up to \$0\.43/);
      expect(runChipTitle(shape)).not.toMatch(/\$0(?![.\d])/);
    }
  });

  it('the proposal card\'s chip follows the same rule', () => {
    const view = (low: number, high: number, open = false) => ({ run: ['n1'], cost: { estimate: { low, high, open } } }) as never;
    expect(proposalEstimateLabel(view(0.0047, 0.43, true))).toBe('Up to $0.43 + unpriced');
    expect(proposalEstimateLabel(view(0.0047, 0.0047))).toBe('<$0.01');
    // GM r4: chips never show sub-cent precision.
    expect(proposalEstimateLabel(view(0.067, 0.067))).toBe('~$0.07');
    expect(proposalEstimateLabel(view(0, 0.43, true))).toBe('Up to $0.43 + unpriced');
  });

  it('what was spent, to the cent: a non-zero amount under half a cent is "<$0.01", never "$0.00"', () => {
    expect(formatSpentUsd(0)).toBe('$0.00');
    expect(formatSpentUsd(0.003)).toBe('<$0.01');
    expect(formatSpentUsd(0.006)).toBe('$0.01');
    expect(formatSpentUsd(3.4)).toBe('$3.40');
    for (const file of ['components/panels/settings/AgentSpendSection.tsx', 'components/panels/settings/ConnectedApps.tsx']) {
      expect(source(file), file).not.toMatch(/toFixed\(2\)\}? in the last 24 h|\$\$\{[^}]*spentUsd\.toFixed/);
    }
  });

  it('r18\'s forms above a cent, with every range in the range form (GM, PR #198 r2 ask 2)', () => {
    expect(runChipTitle(summary({}))).toBe('Estimated cost');
    expect(runChipTitle(summary({ unpriced: ['Kling'] }))).toBe('The priced part of this run costs about $0.07.');
    expect(runChipTitle(summary({ low: 0.05, high: 0.43, unpriced: ['Kling'] })))
      .toBe('The priced part of this run costs between $0.05 and $0.43.');
    expect(runChipTitle(summary({ low: 0.05, high: 0.43 }))).toBe('Between $0.05 and $0.43.');
  });
});

describe('GM (7): a universal node\'s settings, and the Agent log', () => {
  it('a provider setting\'s label is its key in sentence case', () => {
    expect(universalSettingLabel('guidance_scale')).toBe('Guidance scale');
    expect(universalSettingLabel('seed')).toBe('Seed');
    expect(universalSettingLabel('num_inference_steps')).toBe('Num inference steps');
  });

  it('the Inspector shows a universal node\'s settings by that label, not the stored Title Case', () => {
    expect(source('components/panels/Inspector.tsx'))
      .toMatch(/dynamicParams\.map\(\(param\) => renderParamSection\(\{ \.\.\.param, label: universalSettingLabel\(param\.key\) \}, 'dynamic'\)\)/);
  });

  const agent = { id: 'cx', name: 'Codex', color: '#336699', verified: true };
  const event = (extra: Partial<AgentPresenceEvent>): AgentPresenceEvent => ({ type: 'agentPresence', agent,
    action: 'click', say: '', at: 1000, target: { nodeId: 'n1' }, ...extra } as AgentPresenceEvent);

  it('an action with no bubble still has its log line', () => {
    expect(agentActionEntry(event({ say: '', log: 'Changed a setting on “Hero still”' }))?.message)
      .toBe('Changed a setting on “Hero still”');
    expect(agentActionEntry(event({ say: 'Set “Guidance scale”', log: 'Set “Guidance scale”' }))?.message)
      .toBe('Set “Guidance scale”');
  });

  it('a bare cursor move (nothing said, nothing to log) is still not an entry', () => {
    expect(agentActionEntry(event({ action: 'move', say: '' }))).toBeNull();
  });
});
