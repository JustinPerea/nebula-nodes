import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * GM review of Q107 a (2026-10-21): with the Updates chip in the Commons
 * header, the toolbar wrapped to two rows at 1280 even with the compact chip.
 * Its two least-used sections, Blind labeling and Settings, fold into a More
 * menu while the chip shows below 1440 px (commons.css; jsdom has no media
 * queries, so both the tabs and More are in the DOM here). More is the app's
 * toolbar menu (AssetMoveMenu's): arrow keys, Home and End move, Escape or
 * Tab closes and returns focus, a press outside closes.
 */

const commons = vi.hoisted(() => ({ status: vi.fn(), collections: vi.fn(), search: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsApi: commons, filtersToRequest: () => ({ query: '', filters: {} }) }));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => <div role="region" aria-label="Blind labeling section" /> }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => <div role="region" aria-label="Settings section" /> }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');

beforeEach(() => {
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {} });
  commons.search.mockResolvedValue({ results: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.classList.remove('agent-notes-shown');
});

/**
 * A window whose width can cross the fold's breakpoint: matchMedia for the
 * Commons fold query, with `cross(narrow)` firing its change event the way a
 * resize does. jsdom has no CSS, so the swap itself (and the browser moving
 * focus to <body> off a control that stops rendering) is simulated by blur().
 */
function windowAt(narrow: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    get matches() { return narrow; }, media: '(max-width: 1439px)', onchange: null,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: (fn: () => void) => listeners.add(fn), removeListener: (fn: () => void) => listeners.delete(fn),
    dispatchEvent: () => true,
  };
  vi.stubGlobal('matchMedia', (query: string) => (query === '(max-width: 1439px)' ? mql : { ...mql, matches: false, media: query }));
  document.body.classList.add('agent-notes-shown');
  return { cross(next: boolean) { narrow = next; act(() => { for (const fn of [...listeners]) fn(); }); } };
}

async function choose(trigger: HTMLElement, name: string) {
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole('menu', { name: 'More Commons sections' })).getByRole('menuitemradio', { name }));
  await screen.findByRole('region', { name: `${name} section` });
}

async function more() {
  render(<CommonsView />);
  await screen.findByRole('tablist', { name: 'Commons sections' });
  return screen.getByRole('button', { name: /^More/ });
}

it('marks Blind labeling and Settings as the tabs that fold, and keeps More outside the tablist', async () => {
  const trigger = await more();
  const tabs = within(screen.getByRole('tablist', { name: 'Commons sections' })).getAllByRole('tab');
  expect(tabs.map((tab) => tab.textContent)).toEqual(['All', 'Inbox', 'Agent review', 'Blind labeling', 'Settings']);
  expect(tabs.filter((tab) => tab.classList.contains('commons-tab--overflow')).map((tab) => tab.textContent))
    .toEqual(['Blind labeling', 'Settings']);
  expect(trigger.classList.contains('commons-tabs__more')).toBe(true);
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.closest('[role="tablist"]')).toBeNull();
});

it('opens the folded sections as a radio menu; choosing one opens that section and returns focus to More', async () => {
  const trigger = await more();
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: 'More Commons sections' });
  const items = within(menu).getAllByRole('menuitemradio');
  expect(items.map((item) => [item.textContent, item.getAttribute('aria-checked')]))
    .toEqual([['Blind labeling', 'false'], ['Settings', 'false']]);
  await vi.waitFor(() => expect(document.activeElement).toBe(items[0]));
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.click(items[1]);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('region', { name: 'Settings section' })).toBeTruthy();
  // More stands in for the hidden tab: it shows as the active one and names it.
  expect(trigger.classList.contains('commons-tab--active')).toBe(true);
  expect(trigger.getAttribute('aria-label')).toBe('More: Settings');
  fireEvent.click(trigger);
  expect(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Settings' }).getAttribute('aria-checked')).toBe('true');
});

it('closes on Escape and returns focus to More, leaving the section as it was', async () => {
  const trigger = await more();
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: 'More Commons sections' });
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
  expect(trigger.classList.contains('commons-tab--active')).toBe(false);
  expect(trigger.getAttribute('aria-label')).toBe('More');
});

// Review of the fold (2026-10-21): with Blind labeling open below 1440 the
// tablist had no selected tab (display:none took the open one out of the
// tree). It stays in the tablist, hidden on screen (commons.css), and out of
// the Tab order only while it folds, so Tab never lands on something unseen.
it('keeps the open folded section as the tablist\'s one selected tab, out of the Tab order only while it folds', async () => {
  const win = windowAt(true);
  const trigger = await more();
  await choose(trigger, 'Blind labeling');
  const tablist = screen.getByRole('tablist', { name: 'Commons sections' });
  const selected = within(tablist).getAllByRole('tab').filter((tab) => tab.getAttribute('aria-selected') === 'true');
  expect(selected.map((tab) => tab.textContent)).toEqual(['Blind labeling']);
  expect(selected[0].tabIndex).toBe(-1);
  // The other tabs keep their place in the Tab order.
  expect(screen.getByRole('tab', { name: 'All' }).tabIndex).toBe(0);
  // Wide enough for all five tabs: the tab is back in the Tab order.
  win.cross(false);
  expect(screen.getByRole('tab', { name: 'Blind labeling' }).tabIndex).toBe(0);
});

it('never takes a tab out of the Tab order while the chip is not showing', async () => {
  windowAt(true);
  document.body.classList.remove('agent-notes-shown');
  const trigger = await more();
  await choose(trigger, 'Settings');
  expect(screen.getByRole('tab', { name: 'Settings' }).tabIndex).toBe(0);
});

// Review of the fold: crossing 1440 while More (or a folded tab) had focus
// hid the focused control, and focus fell to <body>. It moves to the
// counterpart that is now on screen, whichever order the browser sends the
// blur and the media change in.
it('moves focus from More to the open folded tab when the window widens past the fold', async () => {
  const win = windowAt(true);
  const trigger = await more();
  await choose(trigger, 'Settings');
  expect(document.activeElement).toBe(trigger);
  trigger.blur(); // the browser's focus fixup as More stops rendering
  win.cross(false);
  await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Settings' })));
});

it('moves focus from More to the first folded tab when no folded section is open', async () => {
  const win = windowAt(true);
  const trigger = await more();
  trigger.focus();
  win.cross(false); // the change first, then the blur
  trigger.blur();
  await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Blind labeling' })));
});

it('moves focus from a folded tab to More when the window narrows below the fold', async () => {
  const win = windowAt(false);
  const trigger = await more();
  const tab = screen.getByRole('tab', { name: 'Blind labeling' });
  tab.focus();
  win.cross(true);
  tab.blur();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('leaves focus alone when it is somewhere else as the window crosses the fold', async () => {
  const win = windowAt(true);
  await more();
  const add = screen.getByRole('button', { name: 'Add' });
  add.focus();
  win.cross(false);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(document.activeElement).toBe(add);
});
