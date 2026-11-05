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
import { springCssVars } from '../src/lib/springs';

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

/**
 * GM r87 (review 2 MEDIUM-1): "A 1 px hairline in the Restraint border token
 * on the top edge of the Run/Duplicate/Delete foot row whenever the body can
 * scroll further down; gone at the end. It comes and goes on an opacity
 * spring, not a timed fade. The fade still works when the cut lands inside a
 * field." When it shows: NodeInspectorContentFit.test.tsx.
 */
describe("the foot row's hairline (GM r87)", () => {
  const restraint = css('slava-restraint.css');
  const bare = restraint.replace(/\/\*[\s\S]*?\*\//g, '');
  const reduced = [...bare.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].map((m) => m[1]).join('\n');
  const outside = bare.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
  const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(([, selector, block]) => ({ selectors: selector.split(',').map((one) => one.trim()), block }));
  const FOOT = 'body.app-slava-restraint .node-inspector-popover__foot';
  const HIDDEN = `${FOOT}::before`;
  // GM r92 Q3, r98: NodeInspectorPopover.tsx decides when it shows (off
  // through the open, held through a height spring) and marks the foot with
  // data-more-below; the CSS only draws that state.
  const SHOWN = 'body.app-slava-restraint .node-inspector-popover__foot[data-more-below]::before';
  const only = (text: string, selector: string) => {
    const found = rules(text).filter((rule) => rule.selectors.includes(selector));
    expect(found, selector).toHaveLength(1);
    return found[0].block;
  };

  it('is a 1 px line in the border token across the foot row\'s top edge, hidden by default', () => {
    expect(only(outside, FOOT)).toMatch(/position:\s*relative/);
    const line = only(outside, HIDDEN);
    expect(line).toMatch(/content:\s*''/);
    expect(line).toMatch(/position:\s*absolute/);
    expect(line).toMatch(/top:\s*0;/);
    expect(line).toMatch(/left:\s*0;/);
    expect(line).toMatch(/right:\s*0;/);
    expect(line).toMatch(/height:\s*1px/);
    // The Restraint border token, the one the panel's own edge uses.
    expect(line).toMatch(/background:\s*var\(--sr-edge\)/);
    expect(only(outside, 'body.app-slava-restraint .node-inspector-popover')).toMatch(/border:\s*1px solid var\(--sr-edge\)/);
    expect(line).toMatch(/opacity:\s*0;/);
    expect(line).toMatch(/pointer-events:\s*none/);
  });

  it('shows only while the foot is marked data-more-below, on the house springs, never a timed fade', () => {
    const shown = only(outside, SHOWN);
    expect(shown).toMatch(/opacity:\s*1;/);
    expect(shown).toMatch(/transition:\s*opacity var\(--spring-pop-ms\) var\(--spring-pop\)/);
    expect(only(outside, HIDDEN)).toMatch(/transition:\s*opacity var\(--spring-soft-ms\) var\(--spring-soft\)/);
    // Nothing else turns it on, and no stock easing runs it.
    const showing = rules(outside).filter((rule) => rule.selectors.some((one) => /node-inspector-popover__foot[^\s]*::before/.test(one))
      && /opacity:\s*1/.test(rule.block));
    expect(showing).toHaveLength(1);
    for (const rule of rules(outside).filter((one) => one.selectors.some((selector) => selector.includes('node-inspector-popover__foot')))) {
      expect(rule.block).not.toMatch(/ease|cubic-bezier|\d+ms/);
    }
  });

  it('draws a held state, never a CSS hide, and shows on the pinned Inspector too (GM r92 Q2, r98)', () => {
    const footRules = rules(bare).filter((rule) => rule.selectors.some((one) => one.includes('node-inspector-popover__foot')));
    expect(footRules.length).toBeGreaterThan(0);
    for (const rule of footRules) {
      // Wherever a body scrolls, the same cue: nothing keeps it off the pinned one.
      expect(rule.selectors.join(','), 'no pinned exception').not.toMatch(/pinned/);
      // GM r98: the open and a running spring hold its state in the
      // component; no rule hides it on the popover's open or spring marks.
      expect(rule.selectors.join(','), 'no hide on the open or the spring').not.toMatch(/data-opening|data-content-resizing|:not\(/);
    }
    const on = footRules.filter((rule) => /opacity:\s*1/.test(rule.block));
    expect(on).toHaveLength(1);
    expect(on[0].selectors).toEqual([SHOWN]);
  });

  it('jumps for reduced motion', () => {
    const off = rules(reduced).filter((rule) => rule.selectors.includes(HIDDEN) && rule.selectors.includes(SHOWN));
    expect(off).toHaveLength(1);
    expect(off[0].block).toMatch(/transition:\s*none/);
  });

  it('keeps the 12 px fade, which still shows when the cut lands inside a field', () => {
    const body = /\.node-inspector-popover__body\s*\{([^}]*)\}/.exec(css('panels.css'))?.[1] ?? '';
    expect(px(/--scroll-fade-size:\s*([^;]+);/.exec(body)?.[1] ?? '')).toBe(12);
    expect(css('scroll-fade.css')).toMatch(/\.panel-scroll-fade\[data-scroll-more="true"\]\s*\{[^}]*mask-image/);
  });

  it('the foot carries the springs it runs on (lib/springs.ts)', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const previous = useUIStore.getState();
    try {
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().selectNode('n1');
      useUIStore.getState().setInspectorVisible(true);
      render(<NodeInspectorPopover />);
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      const foot = document.querySelector<HTMLElement>('.node-inspector-popover__foot')!;
      const springs = springCssVars();
      for (const name of ['--spring-pop', '--spring-pop-ms', '--spring-soft', '--spring-soft-ms'] as const) {
        expect(foot.style.getPropertyValue(name), name).toBe(springs[name]);
      }
      expect(foot.style.getPropertyValue('--spring-pop')).toMatch(/^linear\(0, /);
      // The foot sits right after the scrolling body whose overflow it marks.
      expect(foot.previousElementSibling).toHaveClass('node-inspector-popover__body');
    } finally {
      useUIStore.setState(previous, true);
      vi.unstubAllGlobals();
    }
  });
});
