import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BOTTOM_BAR_SWITCH_ATTR, clearBottomBarClearance, publishBottomBarClearance } from '../src/lib/bottomBar';

/**
 * GM - Design, round 7 (the r6-zz-error-cinema.png question): back on the
 * canvas from Cinema Studio, the "Codex changed the canvas" notice sat over
 * the bottom bar, covering Canvas actions and the zoom. The region had
 * sprung (bottom, 420 ms) from where it sits with no bar (24 px up, the
 * bar's own place) to its line above the bar, so for the length of the
 * spring, longer on a busy machine, the notice was on the bar. A bar that
 * comes or goes is a screen switch: the region jumps to its line. Only a bar
 * that grows (its Canvas actions panel) keeps the spring.
 */

const css = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const root = document.documentElement;
const frames = () => new Promise((resolve) => setTimeout(resolve, 80));

function bar(top: number): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('data-bottom-bar', '');
  element.getBoundingClientRect = () => ({ top, bottom: top + 48, left: 400, right: 860, width: 460, height: 48, x: 400, y: top, toJSON: () => ({}) });
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.textContent = '';
  root.style.removeProperty('--bottom-bar-clearance');
  root.removeAttribute(BOTTOM_BAR_SWITCH_ATTR);
});

describe('the notice region on a screen switch', () => {
  it('a bar arriving (back to the canvas) holds the region still for that frame, then gives the spring back', async () => {
    bar(window.innerHeight - 72);
    publishBottomBarClearance();
    expect(root.style.getPropertyValue('--bottom-bar-clearance')).toBe('72px');
    expect(root.hasAttribute(BOTTOM_BAR_SWITCH_ATTR)).toBe(true);
    await frames();
    expect(root.hasAttribute(BOTTOM_BAR_SWITCH_ATTR)).toBe(false);
  });

  it('a bar leaving (into a Studio) jumps too', async () => {
    bar(window.innerHeight - 72);
    publishBottomBarClearance();
    await frames();
    clearBottomBarClearance();
    expect(root.hasAttribute(BOTTOM_BAR_SWITCH_ATTR)).toBe(true);
    await frames();
    expect(root.hasAttribute(BOTTOM_BAR_SWITCH_ATTR)).toBe(false);
  });

  it('the bar growing (Canvas actions opening) keeps the spring', async () => {
    const element = bar(window.innerHeight - 72);
    publishBottomBarClearance();
    await frames();
    element.getBoundingClientRect = () => ({ top: window.innerHeight - 320, bottom: window.innerHeight - 24, left: 400, right: 860,
      width: 460, height: 296, x: 400, y: 0, toJSON: () => ({}) });
    publishBottomBarClearance();
    expect(root.style.getPropertyValue('--bottom-bar-clearance')).toBe('320px');
    expect(root.hasAttribute(BOTTOM_BAR_SWITCH_ATTR)).toBe(false);
  });

  it('the CSS turns the spring off while the root carries the mark', () => {
    const rule = new RegExp(`:root\\[${BOTTOM_BAR_SWITCH_ATTR}\\]\\s+\\.notice-region\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule).toMatch(/transition:\s*none/);
  });
});
