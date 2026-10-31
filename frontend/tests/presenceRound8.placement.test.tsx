// PR #204 round 8, review 6 MEDIUM-3 (GM r11 answer 3: "capped like Styles"): Creator Studio's
// model picker, a centred modal, stopped over the notice band, so a notice landed on its list.
// It is now centred in the space above the band (the line Styles and every floating panel stop
// at), and so are the Lightbox and the comparison.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

import { ModelPicker } from '../src/components/create-studio/ModelPicker';
import { Lightbox } from '../src/components/create-studio/Lightbox';
import { noticeClearance } from '../src/hooks/useNoticeClearance';

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
const clearanceOf = (el: HTMLElement) => el.style.getPropertyValue('--notice-clearance');
const css = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');

beforeEach(() => { Object.defineProperty(window, 'innerHeight', { configurable: true, value: H }); });
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('the line a modal stops at', () => {
  it('is the floating panels\' line: above the composer and the band, shown or not', () => {
    part('data-bottom-bar', box(780, 884, 380, 1060));
    part('data-notice-band', box(718, 772, 16, 1424));
    // limit = bar top 780 - gap 8 - band 54 = 718; clearance = 900 - 718.
    expect(noticeClearance(H)).toBe(182);
  });

  it('with no bar and no band, the gutter', () => {
    expect(noticeClearance(H)).toBe(16);
  });
});

describe('review 6 MEDIUM-3: the model picker', () => {
  it('its overlay carries the clearance, and follows a taller composer', async () => {
    const bar = part('data-bottom-bar', box(780, 884, 380, 1060));
    part('data-notice-band', box(718, 772, 16, 1424));
    render(<ModelPicker value={null} onSelect={() => {}} onClose={() => {}} />);
    const overlay = screen.getByRole('dialog', { name: 'Choose a model' }).parentElement!;
    expect(overlay.className).toBe('model-picker-overlay');
    expect(clearanceOf(overlay)).toBe('182px');
    bar.getBoundingClientRect = () => box(700, 884, 380, 1060);
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(clearanceOf(overlay)).toBe('262px'));
  });

  it('its stylesheet centres it above the clearance and caps its height to fit', () => {
    const sheet = css('create-studio.css');
    expect(sheet).toMatch(/\.model-picker-overlay \{[^}]*padding-bottom: max\(16px, var\(--notice-clearance, 16px\)\);/);
    expect(sheet).toMatch(/\.model-picker \{[^}]*max-height: min\(520px, calc\(100dvh - 16px - max\(16px, var\(--notice-clearance, 16px\)\)\)\);/);
  });
});

describe('review 6 MEDIUM-3: the Lightbox and the comparison, checked the same way', () => {
  it('the Lightbox carries the clearance; its media and counter stop above it', () => {
    part('data-bottom-bar', box(780, 884, 380, 1060));
    part('data-notice-band', box(718, 772, 16, 1424));
    render(<Lightbox items={[{ url: '/a.png', kind: 'image' }, { url: '/b.png', kind: 'image' }]} index={0} onClose={() => {}} onIndexChange={() => {}} />);
    expect(clearanceOf(screen.getByRole('dialog', { name: 'Result preview' }))).toBe('182px');
    const sheet = css('create-gallery.css');
    expect(sheet).toMatch(/\.lightbox \{[^}]*--lightbox-pad-bottom: max\(40px, calc\(var\(--notice-clearance, 0px\) \+ 36px\)\);[^}]*padding-bottom: var\(--lightbox-pad-bottom\);/);
    expect(sheet.match(/max-height: min\(92vh, calc\(100vh - 40px - var\(--lightbox-pad-bottom, 40px\)\)\);/g)).toHaveLength(2);
    expect(sheet).toMatch(/\.lightbox__counter \{[^}]*bottom: max\(22px, calc\(var\(--notice-clearance, 0px\) \+ 4px\)\);/);
  });

  it('the comparison\'s overlay carries it, and its panel stops above it', () => {
    const source = readFileSync(join(__dirname, '../src/components/create-studio/ResultComparison.tsx'), 'utf8');
    expect(source).toMatch(/className="result-comparison"\s+style=\{clearance\}/);
    expect(source).toContain('const clearance = useNoticeClearance();');
    const sheet = css('result-comparison.css');
    expect(sheet).toMatch(/\.result-comparison \{[^}]*padding-bottom: max\(20px, var\(--notice-clearance, 20px\)\);/);
    expect(sheet).toMatch(/\.result-comparison__panel \{[^}]*max-height: calc\(100dvh - 20px - max\(20px, var\(--notice-clearance, 20px\)\)\);/);
  });
});
