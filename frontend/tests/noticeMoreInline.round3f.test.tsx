import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoticeMoreInline } from '../src/components/NoticeMoreInline';
import { getNoticeMore, setNoticeMore, setNoticeMoreToggle } from '../src/lib/noticeMore';
import { MORE_SLOT_ATTR } from '../src/lib/noticeStackPlace';

/**
 * GM - Design, PR #216 r8 2: "Moved “Hero shot” · Undo · 3 more". The
 * count is a trailing text button after Undo, in the Undo notice's own row,
 * that opens the stack; the keyboard goes name, Undo, "3 more".
 */
function Notice({ id }: { id: string }) {
  return (
    <div data-testid={id} role="status">
      <span className="canvas-undo-notice__text">Moved “Hero shot”</span>
      <button type="button">Undo</button>
      <NoticeMoreInline />
      <button type="button" aria-label="Dismiss">×</button>
    </div>
  );
}

afterEach(() => {
  act(() => setNoticeMore({ host: null, count: 0, expanded: false }));
  setNoticeMoreToggle(() => {});
  cleanup();
});

describe('"3 more" in the Undo notice\'s row', () => {
  it('shows only in the notice the region names, after Undo, a real button with its name', () => {
    render(<><Notice id="a" /><Notice id="b" /></>);
    // Each notice marks that it can carry it.
    expect(document.querySelectorAll(`[${MORE_SLOT_ATTR}]`)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    act(() => setNoticeMore({ host: screen.getByTestId('b'), count: 3, expanded: false }));
    const more = screen.getByRole('button', { name: '3 more notices' });
    expect(more).toHaveTextContent('3 more');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('b').contains(more)).toBe(true);
    expect(screen.getByTestId('a').querySelector('button[aria-expanded]')).toBeNull();
    // Keyboard order: Undo, then "3 more", then the dismiss.
    const order = [...screen.getByTestId('b').querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(order).toEqual(['Undo', '3 more notices', 'Dismiss']);
    // The dot between them is not read.
    expect(screen.getByTestId('b').querySelector('.canvas-undo-notice__more-dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens the stack with the region\'s own toggle, then reads "Show less"', () => {
    const toggle = vi.fn();
    setNoticeMoreToggle(toggle);
    render(<Notice id="a" />);
    act(() => setNoticeMore({ host: screen.getByTestId('a'), count: 3, expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: '3 more notices' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    act(() => setNoticeMore({ host: screen.getByTestId('a'), count: 3, expanded: true }));
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    act(() => setNoticeMore({ host: null, count: 3, expanded: true }));
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
    expect(getNoticeMore()).toEqual({ host: null, count: 0, expanded: false });
  });
});

describe('wired into the canvas notice and the region', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../src', path), 'utf8');
  it('the canvas notice puts it right after its Undo, before the dismiss, only with an Undo', () => {
    const src = read('components/canvas/CanvasUndoNotice.tsx');
    expect(src).toMatch(/className="canvas-undo-notice__action"[\s\S]*?<\/button>\s*\)\}\s*(\{\/\*[^*]*\*\/\}\s*)?\{actionable && <NoticeMoreInline \/>\}[\s\S]*canvas-undo-notice__close/);
  });
  it('the region hands it its toggle and clears it when it goes', () => {
    const src = read('components/NoticeRegion.tsx');
    expect(src).toMatch(/setNoticeMoreToggle\(\(\) => replace\.current\(\)\)/);
    expect(src).toMatch(/setNoticeMore\(\{ host: null/);
  });
  it('the name gives way with an ellipsis so Undo and the count fit on one line', () => {
    const css = read('styles/canvasProposals.css');
    expect(css).toMatch(/\.canvas-undo-notice\[data-notice-more-host\] \.canvas-undo-notice__text \{[^}]*overflow: hidden;[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.canvas-undo-notice__more-button \{[^}]*white-space: nowrap;/);
    // Its one unbroken line never widens it past the region (round 3f, live
    // at 420: 388 px wide in a 340 px column): held to its slot.
    expect(css).toMatch(/\.canvas-undo-notice\[data-notice-more-host\] \{\s*max-width: min\(var\(--notice-max-w, 560px\), 100%\);\s*\}/);
  });
});
