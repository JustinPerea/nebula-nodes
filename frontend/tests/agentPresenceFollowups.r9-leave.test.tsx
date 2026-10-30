/**
 * Fix round 9 of PR #200, review 8's leave NITs:
 * - NIT-1: a cancelled leave, or one whose events never come, still ends.
 * - NIT-2: × on a toast never leaves focus on <body> (since round 10, GM r16
 *   answer 2: the next notice's ×; tests/agentPresenceFollowups.r10.test.tsx).
 * - NIT-4 (GM r14): under reduced motion a leaving row fades out over 140 ms
 *   and keeps its space throughout; only after the fade does it go, in one
 *   step with no height transition. A row entering takes its space at once
 *   and its content fades in.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_SLACK_MS, useLeave, useLeavingRows } from '../src/lib/noticeLeave';

// jsdom runs no CSS: stand in for noticeRegion.css, where a marked item runs its -out animation.
let animate = true;
let endTime = 294;
const realGetAnimations = Element.prototype.getAnimations;
let stubs = new WeakMap<Element, EventTarget>();
beforeEach(() => {
  stubs = new WeakMap();
  animate = true;
  endTime = 294;
  Element.prototype.getAnimations = function getAnimations(this: Element) {
    const kind = this.getAttribute('data-leaving');
    if (!animate || !kind) return [];
    const cached = stubs.get(this);
    if (cached) return [cached] as unknown as Animation[];
    const target = new EventTarget();
    const stub = Object.assign(target, {
      animationName: kind === 'row' ? 'notice-row-out' : 'notice-surface-out',
      currentTime: 0,
      playbackRate: 1,
      effect: { getComputedTiming: () => ({ endTime }) },
    });
    stubs.set(this, stub);
    return [stub] as unknown as Animation[];
  };
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  Element.prototype.getAnimations = realGetAnimations;
  vi.useRealTimers();
});

/** React listens for either end name in jsdom; cancel is a native listener. */
const fire = (el: Element, type: string, name: string) => act(() => {
  for (const each of type === 'animationend' ? ['animationend', 'webkitAnimationEnd'] : [type]) {
    const event = new Event(each, { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: name });
    el.dispatchEvent(event);
  }
});

function Probe({ value }: { value: string | null }) {
  const leave = useLeave(value);
  return leave.shown ? <div data-testid="item" {...leave.props}><button type="button">Dismiss</button></div> : null;
}

function Rows({ items }: { items: string[] }) {
  const { rows, rowProps } = useLeavingRows(items, (item) => item);
  return <div>{rows.map(({ key, item, leaving }) => <div key={key} data-testid={`row-${item}`} {...rowProps(key, leaving)}>{item}</div>)}</div>;
}

describe('review 8 NIT-1: a leave always ends', () => {
  it('a cancelled leave animation ends the leave (useLeave)', () => {
    const { rerender } = render(<Probe value="One" />);
    rerender(<Probe value={null} />);
    const item = screen.getByTestId('item');
    expect(item).toHaveAttribute('inert');
    // An entrance being cancelled doesn't count.
    fire(item, 'animationcancel', 'notice-surface-in');
    expect(screen.getByTestId('item')).toBeInTheDocument();
    fire(item, 'animationcancel', 'notice-surface-out');
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('Animation.cancel() from script (its own cancel event, which Chrome fires without animationcancel) ends it too', () => {
    const { rerender } = render(<Probe value="One" />);
    rerender(<Probe value={null} />);
    const item = screen.getByTestId('item');
    act(() => { for (const animation of item.getAnimations()) animation.dispatchEvent(new Event('cancel')); });
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('with no event at all, it ends once its time is up plus the slack, not before', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Probe value="One" />);
    rerender(<Probe value={null} />);
    act(() => { vi.advanceTimersByTime(endTime + LEAVE_SLACK_MS - 5); });
    expect(screen.getByTestId('item')).toHaveAttribute('data-leaving', 'surface');
    act(() => { vi.advanceTimersByTime(10); });
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('a value coming back mid-leave stops that leave\'s fallback, and the next leave has its own', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Probe value="One" />);
    rerender(<Probe value={null} />);
    act(() => { vi.advanceTimersByTime(100); });
    rerender(<Probe value="Two" />);
    act(() => { vi.advanceTimersByTime(300); });
    rerender(<Probe value={null} />);
    // The first leave's timer (due at endTime + slack from its start) would
    // end this second leave early if it were still armed (review 9 NIT-3).
    act(() => { vi.advanceTimersByTime(endTime + LEAVE_SLACK_MS - 400 + 50); });
    expect(screen.getByTestId('item')).toHaveAttribute('data-leaving', 'surface');
    // Its own fallback still ends it.
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('a row: cancel ends it, and so does the timeout', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Rows items={['a', 'b', 'c']} />);
    rerender(<Rows items={['c']} />);
    fire(screen.getByTestId('row-a'), 'animationcancel', 'notice-row-out');
    expect(screen.queryByTestId('row-a')).toBeNull();
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-leaving', 'row');
    act(() => { vi.advanceTimersByTime(endTime + LEAVE_SLACK_MS + 1); });
    expect(screen.queryByTestId('row-b')).toBeNull();
    expect(screen.getByTestId('row-c')).toBeInTheDocument();
  });
});

// Review 8 NIT-2's focus rule is now GM r16 answer 2: tests/agentPresenceFollowups.r10.test.tsx.

describe('GM r14 (review 8 NIT-4): reduced motion keeps a leaving row\'s space until its fade ends', () => {
  const read = (file: string) => postcss.parse(readFileSync(join(__dirname, '..', 'src', 'styles', file), 'utf8'));
  const region = read('noticeRegion.css');
  const keyframes = (name: string) => {
    let found: AtRule | undefined;
    for (const file of ['noticeRegion.css']) read(file).walkAtRules('keyframes', (rule) => { if (rule.params === name) found = rule; });
    return found;
  };
  const props = (rule: AtRule | undefined) => {
    const out = new Set<string>();
    rule?.walkDecls((decl) => { out.add(decl.prop); });
    return [...out];
  };
  const reduced = (root: postcss.Root) => {
    const rules: Rule[] = [];
    root.walkAtRules('media', (media) => {
      if (/prefers-reduced-motion:\s*reduce/.test(media.params)) media.walkRules((rule) => { rules.push(rule); });
    });
    return rules;
  };

  it('a leaving row fades for 140 ms on opacity alone: its height, padding, border and gap stay', () => {
    const rule = reduced(region).find((r) => r.selector.includes("[data-leaving='row']"));
    expect(rule).toBeDefined();
    const animation = rule!.nodes.find((n) => n.type === 'decl' && n.prop === 'animation') as postcss.Declaration;
    expect(animation.value).toMatch(/^notice-fade-out 140ms /);
    expect(props(keyframes('notice-fade-out'))).toEqual(['opacity']);
  });

  it('nothing in the region transitions under reduced motion, so the rows around close up in one step', () => {
    for (const file of ['noticeRegion.css', 'canvasPins.css', 'canvasProposals.css']) {
      const root = read(file);
      const moving: string[] = [];
      root.walkDecls(/^transition/, (decl) => {
        if (/height|top|bottom|margin|padding|transform|all/.test(decl.value)) moving.push(`${(decl.parent as Rule).selector}: ${decl.value}`);
      });
      for (const line of moving) {
        const selector = line.split(':')[0];
        expect(reduced(root).some((rule) => rule.selector.split(',').map((s) => s.trim()).some((s) => selector.includes(s) || s.includes(selector.trim()))
          && rule.nodes.some((n) => n.type === 'decl' && /^transition/.test(n.prop) && n.value === 'none')), `${file} ${line}`).toBe(true);
      }
    }
  });

  it('a row entering takes its space at once: its reduced-motion entrance is opacity only', () => {
    expect(props(keyframes('notice-fade-in'))).toEqual(['opacity']);
    for (const file of ['canvasPins.css', 'canvasProposals.css']) {
      for (const rule of reduced(read(file))) {
        for (const node of rule.nodes) {
          if (node.type === 'decl' && node.prop === 'animation' && /notice-/.test(node.value)) expect(node.value, `${file} ${rule.selector}`).toMatch(/^notice-fade-(in|out) /);
        }
      }
    }
  });

  it('the row stays mounted (its space held) through the fade and goes after it, in one step', () => {
    vi.useFakeTimers();
    endTime = 140;
    const { rerender } = render(<Rows items={['a', 'b', 'c']} />);
    rerender(<Rows items={['a', 'c']} />);
    const row = screen.getByTestId('row-b');
    for (const at of [0, 35, 70, 105, 135]) {
      act(() => { vi.advanceTimersByTime(at === 0 ? 0 : 35); });
      expect(screen.getByTestId('row-b'), `${at} ms`).toBe(row);
      expect(row).toHaveAttribute('data-leaving', 'row');
    }
    fire(row, 'animationend', 'notice-fade-out');
    expect(screen.queryByTestId('row-b')).toBeNull();
    expect(screen.getAllByTestId(/^row-/).map((el) => el.textContent)).toEqual(['a', 'c']);
  });
});
