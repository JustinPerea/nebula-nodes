import { afterEach, describe, expect, it } from 'vitest';
import { keepNoticesBelowTopBars, NOTICE_CROWDED_ATTR, NOTICE_ROOM_VAR } from '../src/lib/bottomBar';

/**
 * GM r9 item 2 of PR #203: the notice stack (the proposal bar first in it)
 * and the top bars (the canvas tabs with the following bar, the selection
 * toolbar's line) never overlap. The region measures its room, from its
 * bottom line up to the top bars' line plus the gap, and the stack scrolls
 * past it instead of growing into them. jsdom has no layout, so the boxes
 * are given; the live check measures the real ones.
 */

const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;

function setup({ regionBottom, topBarBottom, content }: { regionBottom: number; topBarBottom: number | null; content: number }) {
  document.body.innerHTML = `
    <div class="canvas-tabs-wrap" data-top-bar=""></div>
    <div class="notice-region" data-notice-region=""><div class="notice-region__stack">
      <div class="notice-region__slot" data-notice-slot="proposal"></div></div></div>`;
  const region = document.querySelector<HTMLElement>('.notice-region')!;
  const stack = region.querySelector<HTMLElement>('.notice-region__stack')!;
  const top = document.querySelector<HTMLElement>('[data-top-bar]')!;
  if (topBarBottom === null) top.remove();
  else top.getBoundingClientRect = () => rect(24, topBarBottom);
  region.getBoundingClientRect = () => rect(regionBottom - 100, regionBottom);
  let height = content;
  Object.defineProperty(stack, 'scrollHeight', { configurable: true, get: () => height });
  return { region, stack, grow: (next: number) => { height = next; } };
}

let stop = () => {};
afterEach(() => {
  stop();
  document.body.innerHTML = '';
});

describe('the notice stack keeps below the top bars (GM r9 item 2)', () => {
  it('its room runs from its bottom line to the top bars\' line plus the 8 px gap', () => {
    const { region } = setup({ regionBottom: 820, topBarBottom: 92, content: 300 });
    stop = keepNoticesBelowTopBars(region);
    expect(region.style.getPropertyValue(NOTICE_ROOM_VAR)).toBe(`${820 - (92 + 8)}px`);
    expect(region.hasAttribute(NOTICE_CROWDED_ATTR)).toBe(false);
  });

  it('notices taller than the room mark it crowded (the stack scrolls), and fitting again clears it', () => {
    const { region, grow } = setup({ regionBottom: 820, topBarBottom: 92, content: 300 });
    stop = keepNoticesBelowTopBars(region);
    grow(900);
    window.dispatchEvent(new Event('resize'));
    expect(region.hasAttribute(NOTICE_CROWDED_ATTR)).toBe(true);
    grow(400);
    window.dispatchEvent(new Event('resize'));
    expect(region.hasAttribute(NOTICE_CROWDED_ATTR)).toBe(false);
  });

  it('a notice added to a slot is measured (the stack\'s own box stops at the cap)', async () => {
    const { region, grow } = setup({ regionBottom: 820, topBarBottom: 92, content: 300 });
    stop = keepNoticesBelowTopBars(region);
    grow(900);
    region.querySelector('[data-notice-slot]')!.append(document.createElement('div'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(region.hasAttribute(NOTICE_CROWDED_ATTR)).toBe(true);
  });

  it('with no top bar on screen, the window gutter is the line', () => {
    const { region } = setup({ regionBottom: 820, topBarBottom: null, content: 300 });
    stop = keepNoticesBelowTopBars(region);
    expect(region.style.getPropertyValue(NOTICE_ROOM_VAR)).toBe(`${820 - 16}px`);
  });

  it('stopping clears what it wrote', () => {
    const { region, grow } = setup({ regionBottom: 820, topBarBottom: 92, content: 900 });
    grow(900);
    const end = keepNoticesBelowTopBars(region);
    expect(region.hasAttribute(NOTICE_CROWDED_ATTR)).toBe(true);
    end();
    expect(region.style.getPropertyValue(NOTICE_ROOM_VAR)).toBe('');
    expect(region.hasAttribute(NOTICE_CROWDED_ATTR)).toBe(false);
  });
});
