// Design: badges are labels and read in sentence case; no dropdown option shows a stored word.
// The lint (scripts/check-enum-labels.mjs) catches the shape; this renders every value of each
// set and checks the words themselves, which is what catches a lower-case value in a label map.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReviewBatch } from '../src/lib/commonsReviewTypes';
import type { EvaluationBatch } from '../src/lib/commonsEvaluationTypes';
import {
  DEVICE_STATE_LABELS, ENUMS, FIDELITY_STATUS_LABELS, MADE_BY_SENTENCES, MEDIA_LABELS, PALETTE_ROLE_LABELS,
  REGION_STATUS_LABELS, ROLES, ROLE_LABELS, SIGHTING_STATE_LABELS, SOURCE_KIND_LABELS,
  ENUM_VALUE_LABELS, deviceStateLabel, sourceKindLabel,
  type AnalysisState, type AssetDetail, type SearchRow,
} from '../src/lib/commonsTypes';
import { STATE_LABELS } from '../src/lib/commonsFormat';

const api = vi.hoisted(() => ({ asset: vi.fn(), review: vi.fn(), evaluation: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: (): (() => void) => () => {} },
}));
vi.mock('../src/lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: { asset: (id: string) => api.asset(id), blob: () => new Promise(() => {}) },
  commonsReviewApi: { get: () => api.review(), image: () => Promise.resolve(new Blob(['x'])) },
  commonsEvaluationApi: { get: () => api.evaluation(), image: () => Promise.resolve(new Blob(['x'])) },
}));

const { CommonsGrid } = await import('../src/components/commons/CommonsGrid');
const { CommonsDetail } = await import('../src/components/commons/CommonsDetail');
const { CommonsReview } = await import('../src/components/commons/CommonsReview');
const { CommonsEvaluation } = await import('../src/components/commons/CommonsEvaluation');

const STATES = Object.keys(STATE_LABELS) as AnalysisState[];
const startsCapital = (text: string) => /^[A-Z0-9]/.test(text);

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Every badge text under a node (the fixtures carry no brand badge: a brand's own name is not a label). */
function badgeTexts(root: ParentNode): string[] {
  return [...root.querySelectorAll('.commons-badge, .commons-source')].map((node) => node.textContent ?? '');
}

const row = (id: string, over: Partial<SearchRow>): SearchRow => ({
  id, membership_id: `mem_${id}`, collection_id: 'c', collection: 'Open refs', summary: `Reference ${id}`,
  role: 'neutral', media: 'image', made_by: 'unknown', analysis_state: 'ready', in_inbox: false, comment_count: 0,
  matched: [], score: 1, blob_key: `${id}.png`, also_in: [], ...over,
});

it('the grid: every analysis state, role, the inbox, proposal and video badges start upper case', () => {
  const rows = [
    ...STATES.flatMap((state) => [undefined, 'transparent', 'unavailable'].map((kind, i) =>
      row(`s_${state}_${i}`, { analysis_state: state, last_error_kind: kind }))),
    ...ROLES.map((role) => row(`r_${role}`, { role })),
    row('extras', { in_inbox: true, media: 'video', comment_count: 3 }),
  ];
  const { container } = render(<CommonsGrid rows={rows} selectedId={null} loading={false} emptyHint=""
    onOpen={() => {}} onDropFiles={() => {}} proposed={new Set(['extras'])} />);
  const texts = badgeTexts(container);
  expect(texts).toEqual(expect.arrayContaining(['Held', 'Queued', 'Analyzing', 'Failed', 'Not analyzed', 'Attract', 'Avoid', 'Evidence', 'Inbox', 'Proposal', 'Video']));
  expect(texts.filter((t) => !startsCapital(t))).toEqual([]);
});

function detail(over: (d: AssetDetail) => void): AssetDetail {
  const value: AssetDetail = {
    asset: { id: 'ast_1', media: 'image', width: 24, height: 24, made_by: 'ai', analysis_state: 'ready', last_error: null, measurements: null },
    effective: { fields: { summary: { value: 'A poster' } }, sources: {}, corrected_paths: [], analysis: null },
    corrections: [], regions: [],
    memberships: [{ id: 'mem_1', collection: 'c', collection_name: 'Open refs', brand: null, role: 'neutral', why: null,
      actor: 'human:justin', in_inbox: 1, sightings: [], comments: [] }],
    borrowings: [], blob_url: '/x.png',
  };
  over(value);
  return value;
}

async function renderDetail(value: AssetDetail) {
  api.asset.mockResolvedValue(value);
  const view = render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
  await screen.findByText('A poster');
  return view;
}

it('the detail: sighting kinds and states, regions, fidelity, quarantine, sources and the inbox start upper case', async () => {
  const kinds = Object.keys(SOURCE_KIND_LABELS).concat('something');
  const sightingStates = ['missing_from_folder', 'archived', 'superseded'] as const;
  const fidelity = [...Object.keys(FIDELITY_STATUS_LABELS), 'later'];
  const { container } = await renderDetail(detail((d) => {
    d.quarantined = true;
    d.effective.sources = { 'summary.value': 'model:vision-1', 'subject.value': 'corrected', 'composition_notes.value': 'code' };
    d.effective.fields.subject = { value: 'A subject' };
    d.effective.fields.composition_notes = { value: 'Open space' };
    d.memberships[0].sightings = kinds.map((kind, i) => ({
      id: `s${i}`, source_kind: kind, url: null, page_url: null, page_title: null, original_name: `f${i}.png`, source_date: null,
      state: sightingStates[i % 3] }));
    d.regions = (Object.keys(REGION_STATUS_LABELS) as Array<keyof typeof REGION_STATUS_LABELS>).map((status, i) => ({
      id: `reg_${i}`, box: [0.1, 0.1, 0.3, 0.2], label: `region ${i}`, note: null, status, actor: 'model:x' }));
    d.borrowings = fidelity.map((status, i) => ({
      id: `b${i}`, attribute: 'palette', value: null, used_in: { kind: 'node', ref: `n${i}` }, why: '', actor: 'human:justin',
      fidelity: status === 'pending' ? null : { status }, created_at: '2026-11-20' }));
  }));
  const texts = badgeTexts(container);
  expect(texts).toEqual(expect.arrayContaining(['File', 'Folder', 'Web', 'Moodboard', 'Missing', 'Archived', 'Superseded',
    'Proposed', 'Confirmed', 'Pending', 'Passed', 'Failed', 'Unverifiable', 'Quarantined', 'Inbox', 'Ready',
    'Corrected', 'Code', 'Model: vision-1', 'Something', 'Later']));
  expect(texts.filter((t) => !startsCapital(t))).toEqual([]);
});

it.each(STATES)('the detail badge for the %s state starts upper case', async (state) => {
  const { container } = await renderDetail(detail((d) => { d.asset.analysis_state = state; }));
  expect(badgeTexts(container).filter((t) => !startsCapital(t))).toEqual([]);
});

it('the detail line names media and maker in words', async () => {
  const { container } = await renderDetail(detail(() => {}));
  expect(container.querySelector('.commons-detail__bar .commons-meta')?.textContent).toBe('Image · 24×24 · Made by AI');
  cleanup();
  const human = await renderDetail(detail((d) => { d.asset.made_by = 'human'; d.asset.media = 'video'; }));
  expect(human.container.querySelector('.commons-detail__bar .commons-meta')?.textContent).toBe('Video · 24×24 · Made by a person');
  cleanup();
  const unknown = await renderDetail(detail((d) => { d.asset.made_by = 'unknown'; }));
  expect(unknown.container.querySelector('.commons-detail__bar .commons-meta')?.textContent).toContain('Maker unknown');
  expect(Object.values(MADE_BY_SENTENCES)).toEqual(['Made by a person', 'Made by AI', 'Maker unknown']);
  expect(Object.values(MEDIA_LABELS)).toEqual(['Image', 'Video']);
});

it('the label maps all start upper case, and a value this app does not know reads capitalised', () => {
  const all = [
    ...Object.values(ROLE_LABELS), ...Object.values(PALETTE_ROLE_LABELS), ...Object.values(SOURCE_KIND_LABELS),
    ...Object.values(SIGHTING_STATE_LABELS), ...Object.values(REGION_STATUS_LABELS), ...Object.values(FIDELITY_STATUS_LABELS),
    ...Object.values(DEVICE_STATE_LABELS), ...Object.values(STATE_LABELS),
    ...Object.values(ENUM_VALUE_LABELS).flatMap((map) => Object.values(map)),
  ];
  expect(all.filter((t) => !startsCapital(t))).toEqual([]);
  expect(deviceStateLabel('downloading')).toBe('Downloading');
  expect(deviceStateLabel('download_failed')).toBe('Download failed');
  expect(deviceStateLabel('new_thing')).toBe('New thing');
  expect(sourceKindLabel('url')).toBe('Web');
  expect(sourceKindLabel('thing')).toBe('Thing');
});

/** Every option in a Commons select reads as a word: upper case first, no underscore, or the "—" placeholder. */
function optionProblems(root: ParentNode): string[] {
  return [...root.querySelectorAll('option')].map((o) => o.textContent ?? '')
    .filter((t) => t !== '—' && (!startsCapital(t) || t.includes('_')));
}

it('the detail selects (role and the four enums) show words, not stored values', async () => {
  const { container } = await renderDetail(detail((d) => {
    d.effective.fields.type_style = { value: 'serif' };
  }));
  const options = [...container.querySelectorAll('option')].map((o) => o.textContent);
  expect(options).toEqual(expect.arrayContaining(['Neutral', 'Geometric sans', 'Doesn’t apply', 'Type specimen', 'Motion still']));
  expect(optionProblems(container)).toEqual([]);
});

it('Agent review selects show the detail panel\'s words and keep raw values', async () => {
  const fields = Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, [...v]]));
  const tags = Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, v[0]]));
  const value = { mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'f', state: 'open', batch_revision: 7,
    closed_at: null, close_hash: null, model: 'm', fields, axes: ['quiet_loud'], roles: Object.keys(PALETTE_ROLE_LABELS),
    keywords: [], call_budget: 0, attempts: 1,
    items: [{ position: 0, image_sha256: 'f', width: 40, height: 32, status: 'ready', revision: 1,
      palette: [{ index: 0, hex: '#ff0000', share: 1 }], reviewed_labels: null, reviewer: null, reviewed_at: null, error: null,
      proposal: { model: 'm', prompt_version: 'p',
        labels: { tags, axes: { quiet_loud: 0.25 }, palette_roles: { '0': 'accent' }, keywords: [], no_keywords: true, flagged: false },
        fields: { summary: { value: 'An agent proposal', why: 'w' }, composition_notes: { value: 'Open', why: 'w' },
          ...Object.fromEntries(Object.keys(ENUMS).map((k) => [k, { value: 'x', why: 'w' }])),
          axes: { quiet_loud: { value: 0.25, why: 'w' } } } } }] } as unknown as ReviewBatch;
  api.review.mockResolvedValue(value);
  const { container } = render(<CommonsReview />);
  await screen.findByText('An agent proposal');
  fireEvent.click(screen.getAllByText('Edit grades')[0]);
  const select = screen.getByLabelText('Type style') as HTMLSelectElement;
  expect([...select.options].map((o) => [o.value, o.textContent])).toContainEqual(['geometric_sans', 'Geometric sans']);
  expect([...(screen.getByLabelText('Layout') as HTMLSelectElement).options].map((o) => o.textContent)).toContain('Doesn’t apply');
  expect(optionProblems(container)).toEqual([]);
  expect(container.textContent).not.toMatch(/Not applicable|geometric sans/);
});

it('Blind labeling selects show the detail panel\'s words and keep raw values', async () => {
  const fields = Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, [...v]]));
  const value = { revision: 0, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: 'f', sealed: null, seal_hash: null,
    closed: null, close_hash: null, fields, axes: ['quiet_loud'], roles: Object.keys(PALETTE_ROLE_LABELS), keywords: [],
    excluded_count: 0, assisted_reviews: 0,
    items: [{ position: 0, image_sha256: 'f', width: 40, height: 32, accent_locked: true, labels: null,
      palette: [{ index: 0, hex: '#ff0000', share: 1 }] }] } as unknown as EvaluationBatch;
  api.evaluation.mockResolvedValue(value);
  const { container } = render(<CommonsEvaluation />);
  const select = await screen.findByLabelText('Medium') as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  expect([...select.options].map((o) => [o.value, o.textContent])).toContainEqual(['motion_still', 'Motion still']);
  expect(optionProblems(container).filter((t) => t !== 'Choose one…' && t !== 'Choose a role…')).toEqual([]);
});
