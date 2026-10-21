import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GM review of p157 (2026-10-21): with Settings and Blind labeling folded
 * into More, "the Settings panel opens straight into 'Linked folders' with a
 * rule above it, so the page has no title anywhere." Each of the two panels
 * now opens with its section's name as a heading, set like the Commons'
 * section titles, at every width (jsdom has no media queries, so the tabs and
 * More are both in the DOM: each path is tried). Under the page's one h1
 * ("Commons") the panel heading is an h2, the panel is named by it, and the
 * panel's own headings sit below it.
 */

const commons = vi.hoisted(() => ({
  status: vi.fn(), collections: vi.fn(), search: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(),
}));
const evaluation = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({
  commonsApi: commons,
  commonsEvaluationApi: evaluation,
  filtersToRequest: () => ({ query: '', filters: {} }),
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');

beforeEach(() => {
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  commons.search.mockResolvedValue({ results: [] });
  commons.folders.mockResolvedValue([]);
  commons.settings.mockResolvedValue({});
  commons.candidates.mockResolvedValue([]);
  evaluation.get.mockResolvedValue(null);
  document.body.classList.add('agent-notes-shown');
});
afterEach(() => {
  cleanup();
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

/** The panel's heading: an h2 with the section's name, set like the section titles, and naming its panel. */
async function expectPanelHeading(name: string) {
  const heading = await screen.findByRole('heading', { name, level: 2 });
  expect(heading.classList.contains('commons-heading')).toBe(true);
  const panel = screen.getByRole('region', { name });
  // The panel's first thing, and the one name it has.
  expect(panel.firstElementChild).toBe(heading);
  expect(panel.getAttribute('aria-labelledby')).toBe(heading.id);
  expect(panel.hasAttribute('aria-label')).toBe(false);
  // Still one h1 on the page: the Commons'.
  expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Commons']);
  return panel;
}

describe('the folded Commons panels open with their name', () => {
  for (const [path, choose] of [['its tab', fromTab], ['More', fromMore]] as const) {
    it(`Settings, opened from ${path}`, async () => {
      await view();
      choose('Settings');
      const panel = await expectPanelHeading('Settings');
      // Its sections are under it.
      expect(await within(panel).findByRole('heading', { name: 'Linked folders', level: 3 })).toBeTruthy();
      expect(within(panel).getByRole('heading', { name: 'Meter', level: 3 })).toBeTruthy();
    });

    it(`Blind labeling, opened from ${path} (its name in full)`, async () => {
      await view();
      choose('Blind labeling');
      const panel = await expectPanelHeading('Blind labeling');
      // Its own title and steps are under it, not a second page title.
      expect(within(panel).getByRole('heading', { name: 'A fresh pair of eyes.', level: 3 })).toBeTruthy();
      expect(within(panel).getByRole('heading', { name: 'Prepare the held-out set', level: 3 })).toBeTruthy();
    });
  }

  it('Blind labeling shows its heading while the held-out set loads', async () => {
    evaluation.get.mockReturnValue(new Promise(() => {}));
    await view();
    fromTab('Blind labeling');
    await expectPanelHeading('Blind labeling');
    expect(screen.getByText('Loading held-out references…')).toBeTruthy();
  });

  it('keeps the More button\'s text "More" with a folded section open', async () => {
    await view();
    fromMore('Blind labeling');
    await expectPanelHeading('Blind labeling');
    const more = screen.getByRole('button', { name: 'More: Blind labeling' });
    expect(more.textContent).toBe('More▾');
  });
});
