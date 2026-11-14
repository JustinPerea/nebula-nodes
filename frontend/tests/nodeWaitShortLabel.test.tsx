import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NodeWaitSwap } from '../src/components/nodes/NodeWaitSwap';
import { WAITING_FOR_OK } from '../src/lib/canvasProposals';
import { titleCharsShown, waitLabelIsShort, WAIT_HYSTERESIS_PX, WAIT_MIN_TITLE_CHARS, WAIT_SHORT_LABEL } from '../src/lib/nodeWaitLabel';
import type { NodeWait } from '../src/lib/nodeWait';

/**
 * GM - Design, PR #212 round 6, ruling 2: "When the full label would cut the
 * title to fewer than 8 characters, ellipsis included, the label shortens to
 * 'Waiting'. The accessible description and tooltip keep 'Waiting for your OK'."
 *
 * jsdom has no layout, so the geometry is simulated from the DOM: every glyph
 * is CHAR px wide, the header is WIDTH layout px, and the page is zoomed by
 * ZOOM (rects scale, offsetWidth does not), as React Flow's transform does.
 */
const CHAR = 6;
const text = (s: string) => Array.from(s).length * CHAR;
let width = 200;
let zoom = 1;

const wait: NodeWait = { proposalId: 'p1', count: 1, color: '#c7f36b', reason: 'This would pass the $5 daily total.' };

function lay(el: Element): { left: number; width: number } {
  const header = el.closest('.cinema-scene-node__title')!;
  const swap = header.querySelector<HTMLElement>('.node-wait-swap')!;
  if (el === header) return { left: 0, width };
  const shortNow = swap.dataset.short === 'true';
  const cell = Math.max(0, text(shortNow ? WAIT_SHORT_LABEL : WAITING_FOR_OK));
  if (el === swap) return { left: width - cell, width: cell };
  if (el.classList.contains('node-wait-swap__rest')) return { left: width - cell, width: 0 };
  // The title takes what is left, up to its own text.
  const name = header.querySelector('.cinema-scene-node__name')!;
  return { left: 0, width: Math.min(text(name.textContent ?? ''), width - cell) };
}

beforeEach(() => {
  width = 200; zoom = 1;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    { font: '', measureText: (s: string) => ({ width: text(s) }) } as unknown as CanvasRenderingContext2D);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.closest('.cinema-scene-node__title')) return new DOMRect();
    const { left, width: w } = lay(this);
    return new DOMRect(left * zoom, 0, w * zoom, 20);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.closest('.cinema-scene-node__title') ? lay(this).width : 0;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (title = '⛭ Cinema Scene') => (
  <div className="cinema-scene-node__title">
    <span className="cinema-scene-node__name">{title}</span>
    <NodeWaitSwap nodeId="s1" wait={wait} />
  </div>
);
const swapOf = (c: HTMLElement) => c.querySelector<HTMLElement>('.node-wait-swap')!;

describe('titleCharsShown: how much of the title shows, the ellipsis counted', () => {
  it('counts every character the line keeps plus the ellipsis, and says Infinity when it all fits', () => {
    expect(titleCharsShown('⛭ Cinema Scene', 84, text)).toBe(Infinity);
    expect(titleCharsShown('⛭ Cinema Scene', 83, text)).toBe(13);   // 12 kept + the ellipsis
    expect(titleCharsShown('⛭ Cinema Scene', 42, text)).toBe(7);    // "⛭ Cine…": the case in shot 3
    expect(titleCharsShown('A very long title', 36, text)).toBe(6); // "A ver…": the case in shot 2c
    expect(titleCharsShown('A very long title', 3, text)).toBe(0);
  });
  it('takes the title\'s own code points: an emoji or a glyph is one character', () => {
    expect(titleCharsShown('🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂', 6 * 5, text)).toBe(5);
  });
});

describe('waitLabelIsShort: fewer than 8 characters, ellipsis included', () => {
  const title = '⛭ Cinema Scene';
  it('keeps the full label while 8 characters show, and shortens at 7', () => {
    expect(WAIT_MIN_TITLE_CHARS).toBe(8);
    expect(waitLabelIsShort(title, 8 * CHAR, text, false)).toBe(false);
    expect(waitLabelIsShort(title, 8 * CHAR - 0.1, text, false)).toBe(true);
    expect(waitLabelIsShort(title, 7 * CHAR, text, false)).toBe(true);
  });
  it('keeps the full label for a title that fits whole, however short it is', () => {
    expect(waitLabelIsShort('Clip', 2 * CHAR, text, false)).toBe(true);   // 4 characters cannot show in 2 glyphs
    expect(waitLabelIsShort('Clip', 4 * CHAR, text, false)).toBe(false);
    expect(waitLabelIsShort('', 0, text, false)).toBe(false);
  });
  it('needs WAIT_HYSTERESIS_PX more room to come back to the full label than to leave it', () => {
    const edge = 8 * CHAR;
    expect(waitLabelIsShort(title, edge, text, true)).toBe(true);
    expect(waitLabelIsShort(title, edge + WAIT_HYSTERESIS_PX - 0.1, text, true)).toBe(true);
    expect(waitLabelIsShort(title, edge + WAIT_HYSTERESIS_PX, text, true)).toBe(false);
  });
});

describe('the label in a header, measured from its rendered title', () => {
  it('shows the full label when the title keeps 8 characters or more, and the short one when it would not', () => {
    // Full label 114 px; 8 characters of the title need 48 px.
    width = 114 + 8 * CHAR;
    const { container, rerender } = render(row());
    expect(swapOf(container).dataset.short).toBe('false');
    width -= 1;
    rerender(row());
    expect(swapOf(container).dataset.short).toBe('true');
  });

  it('gives the title its whole name once the label is short (200 px: 99 px of room for "⛭ Cinema Scene" at 6 px a glyph)', () => {
    width = 150;
    const { container, rerender } = render(row());
    rerender(row());
    expect(swapOf(container).dataset.short).toBe('true');
    const name = container.querySelector<HTMLElement>('.cinema-scene-node__name')!;
    // With "Waiting" beside it the name fits whole; with the full label it would show 6 characters.
    expect(lay(name).width).toBe(text('⛭ Cinema Scene'));
    expect(titleCharsShown('⛭ Cinema Scene', width - text(WAITING_FOR_OK), text)).toBe(6);
  });

  it('decides the same at every zoom: the rects scale, the layout does not', () => {
    for (const z of [0.25, 0.5, 1, 1.5, 4]) {
      for (const [w, expected] of [[114 + 8 * CHAR, 'false'], [114 + 8 * CHAR - 1, 'true']] as const) {
        zoom = z; width = w;
        const { container, rerender } = render(row());
        rerender(row());
        expect(swapOf(container).dataset.short, `zoom ${z}, ${w} px`).toBe(expected);
        cleanup();
      }
    }
  });

  it('does not flicker at the threshold: sweeping the width up and down changes the label once each way, and each width settles', () => {
    const { container, rerender } = render(row());
    const settle = () => {
      const seen: string[] = [];
      for (let i = 0; i < 4; i++) { rerender(row()); seen.push(swapOf(container).dataset.short!); }
      expect(new Set(seen.slice(1)).size, `width ${width}`).toBe(1);   // the answer holds
      return seen[seen.length - 1];
    };
    const edge = 114 + 8 * CHAR;
    const up: string[] = [];
    for (width = edge - 20; width <= edge + 20; width += 1) up.push(settle());
    const down: string[] = [];
    for (width = edge + 20; width >= edge - 20; width -= 1) down.push(settle());
    const flips = (list: string[]) => list.filter((v, i) => i > 0 && v !== list[i - 1]).length;
    expect(flips(up)).toBe(1);
    expect(flips(down)).toBe(1);
    // Going down it leaves at edge - 1 (the first width that cuts the title to 7); going up it
    // comes back at edge + WAIT_HYSTERESIS_PX, a band of WAIT_HYSTERESIS_PX + 1 px that holds either state.
    const backUp = edge - 20 + up.indexOf('false');
    const leaveDown = edge + 20 - down.indexOf('true');
    expect(backUp).toBe(edge + WAIT_HYSTERESIS_PX);
    expect(leaveDown).toBe(edge - 1);
  });

  it('keeps the tooltip, the accessible name and the description in the full words, short label or not', () => {
    width = 150;
    const { container, rerender } = render(row());
    rerender(row());
    const label = container.querySelector<HTMLElement>('.node-wait-swap__label')!;
    expect(swapOf(container).dataset.short).toBe('true');
    const short = label.querySelector<HTMLElement>('.node-wait-swap__short')!;
    const full = label.querySelector<HTMLElement>('.node-wait-swap__full')!;
    expect(short.textContent).toBe('Waiting');
    expect(short.getAttribute('title')).toBe('Waiting for your OK');
    expect(short.getAttribute('aria-hidden')).toBe('true');
    expect(full.textContent).toBe('Waiting for your OK');
    expect(full.hasAttribute('aria-hidden')).toBe(false);
    expect(label.getAttribute('role')).toBe('status');
    expect(container.querySelector('.node-wait-swap__reason')!.textContent).toBe(`A proposal is waiting for your OK. ${wait.reason}`);
  });

  it('keeps the full label when the header has no title it can measure', () => {
    const { container } = render(<div className="cinema-scene-node__title"><NodeWaitSwap nodeId="s1" wait={wait} /></div>);
    expect(swapOf(container).dataset.short).toBe('false');
  });
});

describe('the swap uses the springs, and happens at once under reduced motion', () => {
  const css = readFileSync(join(__dirname, '../src/styles/node-wait.css'), 'utf8');
  it('crossfades the two words on SOFT out and POP in, with no stock easing', () => {
    expect(css).toMatch(/\.node-wait-swap\[data-short='true'\] \.node-wait-swap__short \{[^}]*transition:\s*opacity var\(--spring-pop-ms\) var\(--spring-pop\)/);
    expect(css).toMatch(/\.node-wait-swap:not\(\[data-short='true'\]\) \.node-wait-swap__full \{[^}]*transition:\s*opacity var\(--spring-pop-ms\) var\(--spring-pop\)/);
    expect(css).toMatch(/\.node-wait-swap__short \{[^}]*transition:\s*opacity var\(--spring-soft-ms\) var\(--spring-soft\)/);
    expect(css).not.toMatch(/ease-in-out|ease-out|ease-in|\bease\b/);
  });
  it('takes the word not shown out of the layout, so the cell is as wide as the one shown', () => {
    expect(css).toMatch(/\.node-wait-swap\[data-short='true'\] \.node-wait-swap__full,\s*\.node-wait-swap:not\(\[data-short='true'\]\) \.node-wait-swap__short \{[^}]*position:\s*absolute/);
  });
  it('changes at once under reduced motion', () => {
    const media = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const selector of ['.node-wait-swap__full', '.node-wait-swap__short', ".node-wait-swap[data-short] .node-wait-swap__full", ".node-wait-swap[data-short] .node-wait-swap__short"]) {
      expect(media).toContain(selector);
    }
    expect(media).toMatch(/transition:\s*none/);
  });
});
