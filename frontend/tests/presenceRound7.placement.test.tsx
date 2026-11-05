// PR #204 round 7, GM r8 (2): in Creator Studio the notice region stays at the
// bottom, just above the composer, and a notice never lands on the content of
// the popover the person is using. Styles stops above the region's reserved
// band, as the floating panels do, so the "because" line under a refused Save
// shows beneath the picker, not over its cards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const presets = vi.hoisted(() => ({ fetchPresets: vi.fn(async () => []) }));
vi.mock('../src/lib/createPresets', () => presets);
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

import { PresetLibrary } from '../src/components/create-studio/PresetLibrary';

const H = 900;
const box = (top: number, bottom: number, left = 0, right = 1440) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
function part(attr: string, rect: DOMRect) {
  const el = document.createElement('div');
  el.setAttribute(attr, '');
  el.getBoundingClientRect = () => rect;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => { Object.defineProperty(window, 'innerHeight', { configurable: true, value: H }); });
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('Styles in Creator Studio (GM r8, 2)', () => {
  it('stops above the notice band over the composer, so a notice shows beneath it', async () => {
    // The composer's top at 780; the band (one notice, 46 px, and its 8 px gap) above it.
    part('data-bottom-bar', box(780, 884, 380, 1060));
    const band = part('data-notice-band', box(718, 772, 16, 1424));
    part('data-top-bar', box(0, 56));
    render(<PresetLibrary onApply={() => {}} onSaveCurrent={() => {}} onClose={() => {}} reloadKey={0} />);
    const picker = await screen.findByRole('dialog', { name: 'Styles' });
    // limit = bar top 780 - gap 8 - band 54 = 718; bottom = 900 - 718.
    expect(picker.style.bottom).toBe('182px');
    // Its foot is the band's top: nothing of the picker in the band.
    expect(H - parseFloat(picker.style.bottom)).toBeLessThanOrEqual(band.getBoundingClientRect().top);
    // Its height stays under the header's line (and 60% of the window).
    expect(parseFloat(picker.style.maxHeight)).toBe(540);
  });

  it('follows a taller composer', async () => {
    const bar = part('data-bottom-bar', box(780, 884));
    part('data-notice-band', box(718, 772));
    render(<PresetLibrary onApply={() => {}} onSaveCurrent={() => {}} onClose={() => {}} reloadKey={0} />);
    const picker = await screen.findByRole('dialog', { name: 'Styles' });
    expect(picker.style.bottom).toBe('182px');
    bar.getBoundingClientRect = () => box(700, 884);
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(picker.style.bottom).toBe('262px'));
  });
});
