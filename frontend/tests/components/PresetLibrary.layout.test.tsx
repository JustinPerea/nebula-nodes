import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Create's Styles grid drew its cards on top of each other once the popover
// was shorter than its rows (several saved Styles; live check of #130). The
// grid is a flex item that shrinks to the popover's max-height, and its auto
// rows then took their base size from each card's minimum height. A card
// that clips with `overflow: hidden` is a scroll container, so that minimum
// is 0 instead of its 4:3 height: the rows shrank to about 40 px and stretched
// to fill the box, while each card still drew its full ~117 px. jsdom has no
// layout, so this renders the real component with the real stylesheet and
// pins the rules that keep rows as tall as their cards; the live check
// measures every card's box at 1024, 1280 and 1440 wide.

const presets = vi.hoisted(() => ({ fetchPresets: vi.fn() }));
vi.mock('../../src/lib/createPresets', () => presets);
vi.mock('../../src/lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

import { PresetLibrary } from '../../src/components/create-studio/PresetLibrary';

const css = readFileSync(join(__dirname, '../../src/styles/create-gallery.css'), 'utf8');
const style = (id: string, name: string, thumbnail = '') => ({ id, name, category: 'My Styles', prompt: name, params: {}, modelId: null,
  refImages: [], thumbnail, version: 1, scope: 'global', projectId: null, createdAt: '', updatedAt: '' });

let sheet: HTMLStyleElement;
beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.appendChild(sheet);
  document.body.classList.add('app-slava-restraint');
  presets.fetchPresets.mockReset().mockImplementation(async (scope: string) => scope === 'global' ? [
    style('s1', 'Noir', '/api/outputs/seed/sq.png'),
    style('s2', 'A very long style name that keeps going well past the width of one card so it wraps onto several lines'),
    style('s3', 'Supercalifragilisticexpialidocious_without_any_spaces_at_all', '/api/outputs/seed/tall.png'),
  ] : []);
});
afterEach(() => {
  cleanup();
  sheet.remove();
  document.body.classList.remove('app-slava-restraint');
});

describe("Create's Styles grid", () => {
  it('sizes every row to its cards, so a short popover scrolls instead of stacking cards', async () => {
    render(<PresetLibrary onApply={() => {}} onSaveCurrent={() => {}} onClose={() => {}} reloadKey={0} />);
    await screen.findByText('Noir');
    const grid = document.querySelector('.preset-library__grid')!;
    const rows = getComputedStyle(grid);
    expect(rows.getPropertyValue('display')).toBe('grid');
    // A row is as tall as its tallest card's whole box (never its minimum),
    // and rows don't stretch to fill a taller popover.
    expect(rows.getPropertyValue('grid-auto-rows')).toBe('max-content');
    expect(rows.getPropertyValue('align-content')).toBe('start');
    expect(rows.getPropertyValue('overflow-y')).toBe('auto');
  });

  it('lets a card grow for a long name instead of clipping it, with the thumbnail still clipped to the corners', async () => {
    render(<PresetLibrary onApply={() => {}} onSaveCurrent={() => {}} onClose={() => {}} reloadKey={0} />);
    await screen.findByText('Noir');
    const cards = [...document.querySelectorAll('.preset-card')];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      const box = getComputedStyle(card);
      expect(box.getPropertyValue('aspect-ratio')).toBe('4 / 3');
      // `clip` keeps the rounded corners but, unlike `hidden`, doesn't make
      // the card a scroll container, so its 4:3 box grows to fit its text.
      expect(box.getPropertyValue('overflow')).toBe('clip');
      expect(box.getPropertyValue('height')).not.toMatch(/px$/);
      expect(box.getPropertyValue('max-height')).toMatch(/^(none|)$/);
      // A name or category with no spaces wraps inside the card instead of running out of it.
      for (const part of ['.preset-card__name', '.preset-card__category']) {
        expect(getComputedStyle(card.querySelector(part)!).getPropertyValue('overflow-wrap')).toBe('anywhere');
      }
    }
    // Thumbnails stay out of the flow, so a late-loading image can't change a card's height.
    for (const img of document.querySelectorAll('.preset-card__thumb')) {
      expect(getComputedStyle(img).getPropertyValue('position')).toBe('absolute');
    }
  });
});
