import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The same bug as the Inspector's (GM - Design, 2026-10-23: "runs past the
 * bottom edge ... and it overlaps the bottom bar"): the canvas's right-click
 * menu opened at the pointer with no clamp at all, so near the bottom its
 * last items (Delete) ran under the bottom bar or off the window.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));

import { ContextMenu } from '../src/components/ContextMenu';
import { useUIStore } from '../src/store/uiStore';

const MENU = { width: 200, height: 150 };
const BAR = new DOMRect(395, 729, 490, 47);
let previousUi: ReturnType<typeof useUIStore.getState>;
let bar: HTMLElement;

beforeEach(() => {
  previousUi = useUIStore.getState();
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 800);
  bar = document.createElement('div');
  bar.setAttribute('data-bottom-bar', '');
  document.body.append(bar);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-bottom-bar')) return BAR;
    if (this.classList.contains('context-menu')) {
      return new DOMRect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0, MENU.width, MENU.height);
    }
    return new DOMRect();
  });
});

afterEach(() => {
  cleanup();
  bar.remove();
  useUIStore.setState(previousUi, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function menuBox() {
  const menu = document.querySelector<HTMLElement>('.context-menu')!;
  const left = parseFloat(menu.style.left);
  const top = parseFloat(menu.style.top);
  return { left, top, right: left + MENU.width, bottom: top + MENU.height };
}

describe('the right-click menu near the edges', () => {
  it('opened just above the bottom bar, it moves up so Delete is whole and above the bar', () => {
    useUIStore.setState({ contextMenu: { visible: true, position: { x: 600, y: 700 }, nodeId: 'n1', flowPosition: null } });
    render(<ContextMenu />);
    expect(screen.getByRole('button', { name: /Delete/ })).toBeTruthy();
    expect(menuBox().bottom).toBeLessThan(BAR.top);
    expect(menuBox().top).toBeGreaterThanOrEqual(8);
  });

  it('on the empty canvas near the bottom-right corner, it stays inside the window', () => {
    useUIStore.setState({ contextMenu: { visible: true, position: { x: 1270, y: 795 }, nodeId: null, flowPosition: { x: 0, y: 0 } } });
    render(<ContextMenu />);
    expect(menuBox().right).toBeLessThanOrEqual(1280 - 8);
    expect(menuBox().bottom).toBeLessThanOrEqual(800 - 8);
  });

  it('opened on the left while Canvas actions is open in the middle, it stays at the pointer', () => {
    // Review, 2026-10-23: the centred actions panel (485-795) pushes up only what it is under.
    const actions = document.createElement('section');
    actions.setAttribute('data-bottom-bar', 'panel');
    actions.className = 'toolbar__actions-panel';
    document.body.append(actions);
    const spy = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const base = spy.getMockImplementation()!;
    spy.mockImplementation(function (this: HTMLElement) {
      if (this === actions) return new DOMRect(485, 412, 310, 237);
      return base.call(this);
    });
    try {
      useUIStore.setState({ contextMenu: { visible: true, position: { x: 100, y: 400 }, nodeId: 'n1', flowPosition: null } });
      render(<ContextMenu />);
      expect(menuBox().top).toBe(400);
      expect(menuBox().bottom).toBeLessThan(BAR.top);
    } finally {
      actions.remove();
    }
  });

  it('follows a window resize while open', () => {
    useUIStore.setState({ contextMenu: { visible: true, position: { x: 600, y: 500 }, nodeId: 'n1', flowPosition: null } });
    render(<ContextMenu />);
    expect(menuBox().top).toBe(500);
    vi.stubGlobal('innerHeight', 560);
    fireEvent(window, new Event('resize'));
    expect(menuBox().bottom).toBeLessThanOrEqual(560 - 8);
  });
  // GM - Design, 2026-10-23 (answer 1): floating panels stop above the
  // reserved notice band (one notice plus its gap), shown or not.
  it('opened just above the bottom bar, it stops above the reserved notice band', () => {
    const band = document.createElement('div');
    band.setAttribute('data-notice-band', '');
    document.body.append(band);
    const spy = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const base = spy.getMockImplementation()!;
    spy.mockImplementation(function (this: HTMLElement) {
      if (this === band) return new DOMRect(16, 721 - 54, 1248, 54);
      return base.call(this);
    });
    try {
      useUIStore.setState({ contextMenu: { visible: true, position: { x: 600, y: 650 }, nodeId: 'n1', flowPosition: null } });
      render(<ContextMenu />);
      expect(menuBox().bottom).toBeLessThanOrEqual(721 - 54);
    } finally {
      band.remove();
    }
  });
});
