import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewBatch } from '../src/lib/commonsReviewTypes';

/**
 * One heading pattern for the Commons' three sections (GM - Design, second
 * review of PR #157, 2026-10-21): "The page h1 stays 'Commons' in the header.
 * The section name is the h2, set as the eyebrow line. Merge it with the
 * existing eyebrow: 'Blind labeling · C1 / C2 human ground truth'. The
 * section's own display line stays big but isn't a heading level above that
 * ... So Agent review gets a visible 'Agent review' eyebrow like the others,
 * and 'Does this read right?' stops being an h1. Settings has no display
 * line, so set its h2 one step above the subsection titles."
 *
 * The display line is a styled p (not in the outline): under each section's
 * h2 the outline goes straight to the steps (h3) and their parts (h4). jsdom
 * has no media queries, so the tabs and More are both in the DOM: each path
 * a section can be opened from is tried (Agent review never folds).
 */

const commons = vi.hoisted(() => ({
  status: vi.fn(), collections: vi.fn(), search: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(),
}));
const evaluation = vi.hoisted(() => ({ get: vi.fn(), image: vi.fn(), close: vi.fn() }));
const review = vi.hoisted(() => ({ get: vi.fn(), propose: vi.fn(), accept: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: commons,
  commonsEvaluationApi: evaluation,
  commonsReviewApi: review,
  filtersToRequest: () => ({ query: '', filters: {} }),
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');

/** One graded reference, so Agent review shows its whole form. */
const reviewBatch = (): ReviewBatch => ({ mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'fixture',
  state: 'open', batch_revision: 7, closed_at: null, close_hash: null,
  model: 'fixture-model', fields: { type_style: ['none', 'serif'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'], call_budget: 0, attempts: 1,
  items: [{ position: 0, image_sha256: 'fixture', width: 40, height: 32, status: 'ready', revision: 1,
    palette: [{ index: 0, hex: '#ff0000', share: 1 }], reviewed_labels: null, reviewer: null, reviewed_at: null, error: null,
    proposal: { model: 'fixture-model', prompt_version: 'fixture-prompt',
      labels: { tags: { type_style: 'none' }, axes: { quiet_loud: 0.25 }, palette_roles: { '0': 'accent' }, keywords: [], no_keywords: true, flagged: false },
      fields: { summary: { value: 'An agent proposal', why: 'A visible feature' }, composition_notes: { value: 'Open space', why: 'A margin' },
        type_style: { value: 'none', why: 'No text is visible.' }, axes: { quiet_loud: { value: 0.25, why: 'A bright focal point.' } } } } }] });

beforeEach(() => {
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  commons.search.mockResolvedValue({ results: [] });
  commons.folders.mockResolvedValue([]);
  commons.settings.mockResolvedValue({});
  commons.candidates.mockResolvedValue([]);
  evaluation.get.mockResolvedValue(null);
  evaluation.image.mockResolvedValue(new Blob(['fixture']));
  review.get.mockResolvedValue(reviewBatch());
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  document.body.classList.add('agent-notes-shown');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.classList.remove('agent-notes-shown');
});

async function view() {
  render(<CommonsView />);
  await screen.findByRole('tablist', { name: 'Commons sections' });
}

function fromTab(name: string) {
  fireEvent.click(within(screen.getByRole('tablist', { name: 'Commons sections' })).getByRole('tab', { name }));
}

function fromMore(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /^More/ }));
  fireEvent.click(within(screen.getByRole('menu', { name: 'More Commons sections' })).getByRole('menuitemradio', { name }));
}

const level = (heading: HTMLElement) => Number(heading.tagName.slice(1));
const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * The section's h2 (named just the section), the region it names, one h1 on
 * the page, and every other heading in the section below the h2 with no level
 * skipped.
 */
async function expectSection(name: string) {
  const heading = await screen.findByRole('heading', { name, level: 2 });
  const region = screen.getByRole('region', { name });
  expect(region.contains(heading)).toBe(true);
  expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
  expect(region.hasAttribute('aria-label')).toBe(false);
  expect(screen.getAllByRole('heading', { level: 1 }).map(text)).toEqual(['Commons']);
  const headings = within(region).getAllByRole('heading');
  expect(headings[0]).toBe(heading);
  let previous = 2;
  for (const h of headings.slice(1)) {
    expect(level(h), `"${text(h)}" sits below the section's h2`).toBeGreaterThanOrEqual(3);
    expect(level(h), `"${text(h)}" skips a level`).toBeLessThanOrEqual(previous + 1);
    previous = level(h);
  }
  return { heading, region, headings };
}

/** The eyebrow line: the h2 inside it, merged with the section's descriptor. */
function expectEyebrow(heading: HTMLElement, line: string) {
  const eyebrow = heading.closest('.commons-eyebrow');
  expect(eyebrow, 'the h2 is set as the eyebrow line').not.toBeNull();
  expect(text(eyebrow!)).toBe(line);
  expect(eyebrow!.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(1);
  // The line is shown in capitals (CSS), and Chromium names a heading from the
  // transformed text ("BLIND LABELING", live check): the h2 carries its name as written.
  expect(heading.getAttribute('aria-label')).toBe(text(heading));
}

/** The display line: still there, a styled p, not a heading. */
function expectDisplayLine(region: HTMLElement, line: string) {
  const display = within(region).getByText(line);
  expect(display.tagName).toBe('P');
  expect(display.classList.contains('evaluation-title')).toBe(true);
  expect(within(region).queryByRole('heading', { name: line })).toBeNull();
}

describe('one heading pattern for the Commons sections (GM review, round 2)', () => {
  for (const [path, choose] of [['its tab (1440)', fromTab], ['More (1280)', fromMore]] as const) {
    it(`Blind labeling, opened from ${path}: its name is the h2 on the eyebrow line`, async () => {
      await view();
      choose('Blind labeling');
      const { heading, region, headings } = await expectSection('Blind labeling');
      expectEyebrow(heading, 'Blind labeling · C1 / C2 human ground truth');
      expectDisplayLine(region, 'A fresh pair of eyes.');
      expect(headings.slice(1).map((h) => [text(h), level(h)])).toEqual([['Prepare the held-out set', 3]]);
    });

    it(`Settings, opened from ${path}: an h2 one step above its section titles`, async () => {
      await view();
      choose('Settings');
      const { heading, region } = await expectSection('Settings');
      // No display line and no eyebrow descriptor: the h2 is the panel's title, first in it.
      expect(heading.closest('.commons-eyebrow')).toBeNull();
      expect(region.firstElementChild).toBe(heading);
      expect(heading.classList.contains('commons-panel-title')).toBe(true);
      expect(await within(region).findByRole('heading', { name: 'Linked folders', level: 3 })).toBeTruthy();
      expect(within(region).getByRole('heading', { name: 'Meter', level: 3 })).toBeTruthy();
    });
  }

  it('Agent review, opened from its tab (it never folds): a visible "Agent review" eyebrow, and no second h1', async () => {
    await view();
    fromTab('Agent review');
    await screen.findByText('An agent proposal');
    const { heading, region, headings } = await expectSection('Agent review');
    expectEyebrow(heading, 'Agent review · agent grades · your judgment');
    expectDisplayLine(region, 'Does this read right?');
    expect(headings.slice(1).map((h) => [text(h), level(h)])).toEqual([
      ['Reference 01', 3], ['An agent proposal', 3], ['Structure', 4], ['Character', 4], ['Color roles', 4], ['Keywords', 4],
    ]);
  });

  it('Blind labeling and Agent review show their heading while loading', async () => {
    evaluation.get.mockReturnValue(new Promise(() => {}));
    review.get.mockReturnValue(new Promise(() => {}));
    await view();
    fromTab('Blind labeling');
    expectEyebrow((await expectSection('Blind labeling')).heading, 'Blind labeling · C1 / C2 human ground truth');
    expect(screen.getByText('Loading held-out references…')).toBeTruthy();
    fromTab('Agent review');
    expectEyebrow((await expectSection('Agent review')).heading, 'Agent review · agent grades · your judgment');
    expect(screen.getByText('Loading agent reviews…')).toBeTruthy();
  });

  it('keeps the More button\'s text "More" with a folded section open', async () => {
    await view();
    fromMore('Blind labeling');
    await expectSection('Blind labeling');
    const more = screen.getByRole('button', { name: 'More: Blind labeling' });
    expect(more.textContent).toBe('More▾');
  });
});
