import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvaluationBatch } from '../src/lib/commonsEvaluationTypes';
import type { ReviewBatch } from '../src/lib/commonsReviewTypes';
import { CommonsRequestError } from '../src/lib/commonsRequestError';

/**
 * The real Blind labeling and Agent review panels inside the real Commons
 * (commons-leave): their drafts survive moving to another section and back,
 * "Unsaved" shows beside each panel's Save, and the leave popover's Save and
 * leave / Discard and leave run each panel's own save and discard. Agent
 * review's grading is a run of one call per reference driven by the panel
 * (backend commons/review.py: no job keeps going without it), so leaving
 * stops it; Stop and leave stops asking for the next grade.
 */

const commons = vi.hoisted(() => ({
  status: vi.fn(), collections: vi.fn(), search: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(),
}));
const evaluation = vi.hoisted(() => ({ get: vi.fn(), prepare: vi.fn(), image: vi.fn(), accents: vi.fn(), labels: vi.fn(), seal: vi.fn(), close: vi.fn() }));
const review = vi.hoisted(() => ({ get: vi.fn(), propose: vi.fn(), accept: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: commons,
  commonsEvaluationApi: evaluation,
  commonsReviewApi: review,
  filtersToRequest: () => ({ query: '', filters: {} }),
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');
const { commonsUnsaved } = await import('../src/lib/commonsUnsaved');

function evaluationBatch(): EvaluationBatch {
  return { revision: 3, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: 'fixture', sealed: null, seal_hash: null,
    closed: null, close_hash: null,
    fields: { type_style: ['none', 'humanist_sans'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'], excluded_count: 0, assisted_reviews: 0,
    items: [{ position: 0, image_sha256: 'fixture-image', width: 40, height: 32, accent_locked: true, labels: null,
      palette: [{ index: 0, hex: '#ff0000', share: 1 }] }] } as EvaluationBatch;
}

function reviewBatch(status: 'ready' | 'pending' = 'ready'): ReviewBatch {
  const proposal = { model: 'fixture-model', prompt_version: 'fixture-prompt',
    labels: { tags: { type_style: 'none' }, axes: { quiet_loud: 0.25 }, palette_roles: { '0': 'accent' }, keywords: [], no_keywords: true, flagged: false },
    fields: { summary: { value: 'An agent proposal', why: 'A visible feature' }, composition_notes: { value: 'Open space', why: 'A margin' },
      type_style: { value: 'none', why: 'No text is visible.' }, axes: { quiet_loud: { value: 0.25, why: 'A bright focal point.' } } } };
  const item = (position: number, state: 'ready' | 'pending') => ({ position, image_sha256: 'fixture', width: 40, height: 32, status: state, revision: 1,
    palette: [{ index: 0, hex: '#ff0000', share: 1 }], reviewed_labels: null, reviewer: null, reviewed_at: null, error: null,
    proposal: state === 'ready' ? proposal : null });
  return { mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'fixture',
    state: 'open', batch_revision: 7, closed_at: null, close_hash: null,
    model: 'fixture-model', fields: { type_style: ['none', 'serif'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'],
    call_budget: 5, attempts: status === 'ready' ? 1 : 0,
    items: status === 'ready' ? [item(0, 'ready')] : [item(0, 'pending'), item(1, 'pending'), item(2, 'pending')] } as unknown as ReviewBatch;
}

const tabs = () => screen.getByRole('tablist', { name: 'Commons sections' });
const popover = () => screen.getByRole('alertdialog');

async function openBlindLabeling() {
  await screen.findByRole('tablist', { name: 'Commons sections' });
  fireEvent.click(within(tabs()).getByRole('tab', { name: /^Blind labeling/ }));
  await screen.findByText('Describe the visual language.');
}

/** A label the person sets and doesn't save. */
function setTypeStyle() {
  fireEvent.change(screen.getByLabelText('type style'), { target: { value: 'humanist_sans' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  commons.search.mockResolvedValue({ results: [] });
  commons.folders.mockResolvedValue([]);
  commons.settings.mockResolvedValue({});
  commons.candidates.mockResolvedValue([]);
  evaluation.get.mockResolvedValue(evaluationBatch());
  evaluation.image.mockResolvedValue(new Blob(['fixture']));
  review.get.mockResolvedValue(reviewBatch());
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Blind labeling keeps its draft across sections', () => {
  it('a label set and not saved is still there after Inbox, Settings and back, and still unsaved', async () => {
    render(<CommonsView />);
    await openBlindLabeling();
    setTypeStyle();
    await waitFor(() => expect(commonsUnsaved()).toBe(true));

    fireEvent.click(within(tabs()).getByRole('tab', { name: 'Inbox' }));
    expect(screen.getByText('Describe the visual language.')).not.toBeVisible();
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'Settings' }));
    expect(commonsUnsaved()).toBe(true);
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Blind labeling/ }));
    expect(screen.getByText('Describe the visual language.')).toBeVisible();
    expect((screen.getByLabelText('type style') as HTMLSelectElement).value).toBe('humanist_sans');
    // The panel didn't reload its batch over the draft.
    expect(evaluation.get).toHaveBeenCalledTimes(1);
  });

  it('shows "Unsaved" beside Save labels while the draft is unsaved, and on the tab from another section', async () => {
    render(<CommonsView />);
    await openBlindLabeling();
    const save = screen.getByRole('button', { name: 'Save labels' });
    expect(save.parentElement!.querySelector('.commons-unsaved')).toBeNull();
    setTypeStyle();
    const marker = save.parentElement!.querySelector('.commons-unsaved');
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent('Unsaved');
    expect(marker!.previousElementSibling).toBe(save);

    fireEvent.click(within(tabs()).getByRole('tab', { name: 'All' }));
    expect(within(tabs()).getByRole('tab', { name: /^Blind labeling/ })).toHaveAccessibleName(/Unsaved/);
  });

  it('Save and leave runs Save labels with the draft, then leaves', async () => {
    const saved = evaluationBatch();
    saved.revision = 4;
    saved.items[0].labels = { tags: { type_style: 'humanist_sans' }, axes: {}, palette_roles: {}, keywords: [], no_keywords: false, flagged: false };
    evaluation.labels.mockResolvedValue(saved);
    render(<CommonsView />);
    await openBlindLabeling();
    setTypeStyle();
    await waitFor(() => expect(commonsUnsaved()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    expect(evaluation.labels).toHaveBeenCalledTimes(1);
    expect(evaluation.labels.mock.calls[0][0]).toBe(0);
    expect(evaluation.labels.mock.calls[0][1]).toBe(3);
    expect(evaluation.labels.mock.calls[0][2].tags).toEqual({ type_style: 'humanist_sans' });
  });

  it('a failed Save labels in the popover keeps the person and the draft, with the reason', async () => {
    evaluation.labels.mockRejectedValue(new CommonsRequestError('Labels changed in another window. Reload before saving.', 409));
    render(<CommonsView />);
    await openBlindLabeling();
    setTypeStyle();
    await waitFor(() => expect(commonsUnsaved()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(popover()).toHaveTextContent("Couldn't save your labels."));
    expect(popover()).toHaveTextContent('Labels changed in another window. Reload before saving.');
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect((screen.getByLabelText('type style') as HTMLSelectElement).value).toBe('humanist_sans');
  });

  it('Discard and leave drops the draft (nothing saved), then leaves', async () => {
    render(<CommonsView />);
    await openBlindLabeling();
    setTypeStyle();
    await waitFor(() => expect(commonsUnsaved()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Discard and leave' }));
    await waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    expect(evaluation.labels).not.toHaveBeenCalled();
  });
});

describe('Agent review', () => {
  async function openAgentReview() {
    await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Agent review/ }));
  }

  it('keeps an edited grade across sections and shows "Unsaved" beside its save', async () => {
    render(<CommonsView />);
    await openAgentReview();
    fireEvent.click(await screen.findByText('Edit grades'));
    fireEvent.change(screen.getByLabelText('type style'), { target: { value: 'serif' } });
    const saves = screen.getAllByRole('button', { name: 'Save corrections & next' });
    for (const save of saves) expect(save.nextElementSibling).toHaveClass('commons-unsaved');
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'All' }));
    expect(within(tabs()).getByRole('tab', { name: /^Agent review/ })).toHaveAccessibleName(/Unsaved/);
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Agent review/ }));
    expect((screen.getByLabelText('type style') as HTMLSelectElement).value).toBe('serif');
  });

  it('Save and leave saves the corrections through Agent review\'s own save, then leaves', async () => {
    review.accept.mockResolvedValue(reviewBatch());
    render(<CommonsView />);
    await openAgentReview();
    fireEvent.click(await screen.findByText('Edit grades'));
    fireEvent.change(screen.getByLabelText('type style'), { target: { value: 'serif' } });
    await waitFor(() => expect(commonsUnsaved()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    expect(review.accept).toHaveBeenCalledTimes(1);
    expect(review.accept.mock.calls[0][2].tags).toEqual({ type_style: 'serif' });
  });

  it('a running grading asks "Agent review is still running."; Stop and leave asks for no further grade', async () => {
    review.get.mockResolvedValue(reviewBatch('pending'));
    let finish: (value: ReviewBatch) => void = () => {};
    review.propose.mockImplementation(() => new Promise<ReviewBatch>((resolve) => { finish = resolve; }));
    render(<CommonsView />);
    await openAgentReview();
    fireEvent.click(await screen.findByText('Generate remaining grades'));
    await waitFor(() => expect(review.propose).toHaveBeenCalledTimes(1));
    // Moving to another section keeps it running.
    fireEvent.click(within(tabs()).getByRole('tab', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    expect(popover()).toHaveTextContent('Agent review is still running.');
    fireEvent.click(within(popover()).getByRole('button', { name: 'Stop and leave' }));
    await waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    const after = reviewBatch('pending');
    after.items[0].status = 'ready';
    finish(after);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(review.propose).toHaveBeenCalledTimes(1);
  });
});

// Review: Prepare (a folder scan that can take minutes) isn't a label save,
// so a leave doesn't wait for it, and the backend's scan doesn't stop when
// the person leaves. The scan outlives the panel: a Blind labeling opened
// meanwhile shows it still running (no second scan), and its batch or its
// error reaches the person when they come back.
describe('Preparing the held-out set outlives the panel', () => {
  async function startScan() {
    await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Blind labeling/ }));
    await screen.findByText('Prepare the held-out set');
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/fixture/refs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare 15 held-out references' }));
    await waitFor(() => expect(evaluation.prepare).toHaveBeenCalledTimes(1));
  }
  async function comeBack() {
    useUIStore.setState({ viewMode: 'commons' });
    render(<CommonsView />);
    await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Blind labeling/ }));
    await screen.findByText('Prepare the held-out set');
  }

  it('a leave mid-scan goes at once; a scan that fails meanwhile shows its reason when the person comes back', async () => {
    evaluation.get.mockResolvedValue(null);
    let fail: (error: Error) => void = () => {};
    evaluation.prepare.mockImplementation(() => new Promise<EvaluationBatch>((_resolve, reject) => { fail = reject; }));
    const first = render(<CommonsView />);
    await startScan();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    first.unmount();
    fail(new Error('iCloud download failed: fixture'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await comeBack();
    expect(await screen.findByText('iCloud download failed: fixture')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Prepare 15 held-out references' })).toBeEnabled();
    expect(evaluation.prepare).toHaveBeenCalledTimes(1);
  });

  it('a Commons opened mid-scan shows the scan still running, starts no second one, and shows its batch', async () => {
    evaluation.get.mockResolvedValue(null);
    let finish: (batch: EvaluationBatch) => void = () => {};
    evaluation.prepare.mockImplementation(() => new Promise<EvaluationBatch>((resolve) => { finish = resolve; }));
    const first = render(<CommonsView />);
    await startScan();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    await waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    first.unmount();

    await comeBack();
    const scanning = await screen.findByRole('button', { name: 'Downloading and scanning…' });
    expect(scanning).toBeDisabled();
    expect((screen.getByLabelText('Folder path') as HTMLInputElement).value).toBe('/fixture/refs');
    finish(evaluationBatch());
    expect(await screen.findByText('Describe the visual language.')).toBeTruthy();
    expect(evaluation.prepare).toHaveBeenCalledTimes(1);
  });
});
