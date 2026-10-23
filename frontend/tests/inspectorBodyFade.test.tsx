import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/**
 * GM - Design, 2026-10-23 ("One more, visible in both shots"): "when the
 * Inspector is clamped shorter, its body cuts the State value in half above
 * the foot row, so 'idle' is barely visible. Let the body scroll, with a
 * 12-16 px fade at its bottom edge so the cut reads as scrollable instead of
 * broken. The foot row stays fixed."
 *
 * The body is a ScrollFade (its cue shows only while there is more below, and
 * goes at the end). Its cue was the app's general 28 px, which covered a
 * whole field; the Inspector's body uses a 12 px one, and keyboard focus
 * scrolls a field clear of it (scroll-padding). jsdom has no layout, so the
 * live check scrolls the real body.
 */

vi.mock('../src/components/panels/Inspector', () => ({
  Inspector: () => <><label>Text<textarea defaultValue="a lighthouse at dusk" /></label><label>State<input defaultValue="idle" /></label></>,
}));

import { NodeInspectorPopover } from '../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../src/store/uiStore';

const css = (path: string) => readFileSync(join(__dirname, '../src/styles', path), 'utf8');

/** The px a length resolves to, through the spacing tokens. */
function px(value: string): number {
  const tokens = css('slava-restraint.css');
  const token = /var\((--sr-space-\d+)[,)]/.exec(value);
  if (token) {
    const match = new RegExp(`${token[1]}:\\s*(\\d+)px`).exec(tokens);
    return Number(match?.[1]);
  }
  return parseFloat(value);
}

afterEach(() => cleanup());

describe("the clamped Inspector's body", () => {
  it('fades 12-16 px at its bottom edge, not the general 28 px', () => {
    const fade = css('scroll-fade.css');
    // The cue reads its size from the viewport, 28 px unless the viewport says otherwise.
    expect(fade).toMatch(/calc\(100% - var\(--scroll-fade-size, 28px\)\)/);
    const panels = css('panels.css');
    const body = /\.node-inspector-popover__body\s*\{([^}]*)\}/.exec(panels)?.[1] ?? '';
    const size = /--scroll-fade-size:\s*([^;]+);/.exec(body)?.[1];
    expect(size, 'the Inspector body sets its own fade').toBeDefined();
    expect(px(size!)).toBeGreaterThanOrEqual(12);
    expect(px(size!)).toBeLessThanOrEqual(16);
    // Focus moving into the hidden part scrolls the field clear of the fade.
    expect(body).toMatch(/scroll-padding-bottom:\s*var\(--scroll-fade-size\)/);
    // It scrolls; the foot row is outside it.
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it('is the scrolling viewport, with the foot row after it, outside it', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const previous = useUIStore.getState();
    try {
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().selectNode('n1');
      useUIStore.getState().setInspectorVisible(true);
      render(<NodeInspectorPopover />);
      // One layout frame: the pinned Inspector measures its place.
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      const body = document.querySelector('.node-inspector-popover__body')!;
      const foot = document.querySelector('.node-inspector-popover__foot')!;
      expect(body).toHaveClass('panel-scroll-fade');
      expect(foot.parentElement).toBe(body.parentElement);
      expect(body.contains(foot)).toBe(false);
    } finally {
      useUIStore.setState(previous, true);
      vi.unstubAllGlobals();
    }
  });
});
