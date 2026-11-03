/**
 * PR #204 round 18h (GM r38 3d): when a notice that held focus leaves and nothing else can take
 * it, focus goes to the start of the page (the canvas, a screen's <main>) only so it never drops
 * to <body>. That start carries data-focus-start while it holds that focus, so it draws no ring
 * (styles/slava-restraint.css; the rule is pinned in tests/focusRingCss.test.ts); the mark goes
 * with the focus, so a person who Tabs to the canvas later sees its ring.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FOCUS_START_ATTR, moveFocusFromLeave } from '../src/lib/noticeLeave';

afterEach(() => { document.body.innerHTML = ''; });

function leavingNotice(): HTMLElement {
  const slot = document.createElement('div');
  slot.className = 'notice-region__slot';
  const notice = document.createElement('div');
  notice.setAttribute('role', 'status');
  notice.innerHTML = '<span>Saved</span><button type="button" aria-label="Dismiss">×</button>';
  slot.append(notice);
  document.body.append(slot);
  notice.querySelector<HTMLButtonElement>('button')!.focus();
  return notice;
}

describe('the start of the page a leaving notice hands focus to', () => {
  it('the canvas: marked while it holds that focus, unmarked once it goes', () => {
    const canvas = document.createElement('div');
    canvas.className = 'canvas-wrapper';
    canvas.tabIndex = 0;
    const other = document.createElement('button');
    document.body.append(canvas, other);
    const notice = leavingNotice();
    moveFocusFromLeave(notice);
    expect(document.activeElement).toBe(canvas);
    expect(canvas.hasAttribute(FOCUS_START_ATTR)).toBe(true);
    other.focus();
    expect(canvas.hasAttribute(FOCUS_START_ATTR)).toBe(false);
  });

  it('a screen\'s <main>, given tabindex -1 to take it', () => {
    const main = document.createElement('main');
    document.body.append(main);
    const notice = leavingNotice();
    moveFocusFromLeave(notice);
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(main.hasAttribute(FOCUS_START_ATTR)).toBe(true);
  });
});
