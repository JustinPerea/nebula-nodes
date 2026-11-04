import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/apiRequest', () => ({ apiRequest }));

import { AgentLog } from './AgentLog';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { receiveRows, receiveSync, usePersonThreadStore } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useGraphStore } from '../../store/graphStore';
import { noteBackendConnection } from '../../lib/backendConnection';

/** GM r100.2 on #225 (the person's own send scrolls to the sent row) and
 * review 3's live LOW-1 (the first resize drag tracks the pointer). */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';
const SESSION = { key: KEY, ordinal: 1 };

function reduced(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: on && query.includes('reduce'), media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** The thread scrolled up, as the person reads further back. */
function scrollUp(): HTMLElement {
  const thread = document.querySelector<HTMLElement>('.message-box__thread')!;
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 200 });
  thread.scrollTop = 100;
  act(() => { fireEvent.scroll(thread); });
  return thread;
}

function send(clientId: string) {
  act(() => usePersonThreadStore.setState({
    pending: { clientId, text: 'Warmer', to: 'ch_1', nodeIds: [], startedAt: Date.now() },
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true });
  useAgentLogStore.getState().clear();
  usePersonThreadStore.getState().reset();
  useAgentQuestionsStore.getState().reset();
  useGraphStore.setState({ nodes: [], edges: [] });
  apiRequest.mockReset();
  act(() => noteBackendConnection('online'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('r100.2: the person’s own send brings the thread to the sent row', () => {
  it('from far up, under reduced motion a jump; no pill for their own row', () => {
    reduced(true);
    const at = Date.now() - 50_000;
    receiveSync('p1', [{ id: 'm0', kind: 'message', at, text: 'hi', state: 'accepted' }]);
    render(<AgentLog />);
    const thread = scrollUp();
    // An agent row while they read back still raises the pill.
    act(() => receiveRows('p1', [{ id: 'r1', kind: 'reply', at: at + 1_000, text: 'Done.', agent: CLAUDE,
      session: SESSION, sessionKey: KEY }]));
    expect(screen.getByRole('button', { name: 'New reply' })).toBeTruthy();
    send('c-1');
    // At the bottom at once (a browser clamps scrollTop to 800 here; jsdom doesn't).
    expect(thread.scrollTop).toBeGreaterThanOrEqual(800);
    expect(document.querySelector('.message-box__pill')).toBeNull();
  });

  it('on the spring otherwise: frame by frame, and the person’s wheel ends it where it is', () => {
    reduced(false);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    receiveSync('p1', [{ id: 'm0', kind: 'message', at: Date.now() - 50_000, text: 'hi', state: 'accepted' }]);
    render(<AgentLog />);
    const thread = scrollUp();
    frames.splice(0);
    send('c-2');
    expect(thread.scrollTop).toBe(100);
    act(() => { frames.shift()?.(0); frames.shift()?.(40); });
    const moving = thread.scrollTop;
    expect(moving).toBeGreaterThan(100);
    expect(moving).toBeLessThan(800);
    // The spring's own scroll events are not the person scrolling up.
    act(() => { fireEvent.scroll(thread); });
    act(() => { fireEvent.wheel(thread); });
    act(() => { for (const frame of frames.splice(0)) frame(5_000); });
    expect(thread.scrollTop).toBe(moving);
  });
});

describe('r100.2: the spring’s own scroll events never unpin the thread', () => {
  it('a scroll event mid-spring, then the landing: an agent row after it shows with no pill', () => {
    reduced(false);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const at = Date.now() - 50_000;
    receiveSync('p1', [{ id: 'm0', kind: 'message', at, text: 'hi', state: 'accepted' }]);
    render(<AgentLog />);
    const thread = scrollUp();
    frames.splice(0);
    send('c-4');
    act(() => { frames.shift()?.(0); frames.shift()?.(40); });
    act(() => { fireEvent.scroll(thread); });
    let now = 40;
    act(() => { while (frames.length > 0 && now < 5_000) { now += 16; frames.shift()!(now); } });
    act(() => receiveRows('p1', [{ id: 'r9', kind: 'reply', at: at + 3_000, text: 'Done.', agent: CLAUDE,
      session: SESSION, sessionKey: KEY }]));
    expect(document.querySelector('.message-box__pill')).toBeNull();
  });
});

describe('review 3 live LOW-1: the first drag tracks the pointer past half the viewport', () => {
  it('the press marks the log as resizing, and resizing lifts the 50vh cap like a sized log', () => {
    render(<AgentLog />);
    const log = document.querySelector<HTMLElement>('.agent-log')!;
    expect(log.hasAttribute('data-sized')).toBe(false);
    const handle = document.querySelector<HTMLElement>('.agent-log__resize')!;
    fireEvent.pointerDown(handle, { button: 0, clientY: 500, pointerId: 1 });
    expect(log.hasAttribute('data-resizing')).toBe(true);

    const css = readFileSync(join(__dirname, '../../styles/messageBox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
      selectors: selectors.split(',').map((selector) => selector.trim()),
      body,
    }));
    const sized = '.agent-log.agent-log--messaging.agent-log--open[data-sized]';
    const resizing = '.agent-log.agent-log--messaging.agent-log--open[data-resizing]';
    const sizedRules = rules.filter((rule) => rule.selectors.some((s) => s.startsWith(sized)) && /max-height/.test(rule.body));
    expect(sizedRules.length).toBeGreaterThan(0);
    for (const rule of sizedRules) {
      for (const selector of rule.selectors.filter((s) => s.startsWith(sized))) {
        expect(rule.selectors).toContain(selector.replace(sized, resizing));
      }
    }
  });
});

describe('r100.2: after a reduced-motion jump the thread is the person’s again', () => {
  it('scrolling up after the jump still raises the pill for an agent row', () => {
    reduced(true);
    const at = Date.now() - 50_000;
    receiveSync('p1', [{ id: 'm0', kind: 'message', at, text: 'hi', state: 'accepted' }]);
    render(<AgentLog />);
    scrollUp();
    send('c-3');
    scrollUp();
    act(() => receiveRows('p1', [{ id: 'r2', kind: 'reply', at: at + 2_000, text: 'Done.', agent: CLAUDE,
      session: SESSION, sessionKey: KEY }]));
    expect(screen.getByRole('button', { name: 'New reply' })).toBeTruthy();
  });
});
