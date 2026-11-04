import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/apiRequest', () => ({ apiRequest }));

import { AgentLog } from './AgentLog';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { receiveRows, receiveSync, usePersonThreadStore } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useGraphStore } from '../../store/graphStore';
import { noteBackendConnection } from '../../lib/backendConnection';
import type { ChannelListener, ThreadRow } from '../../lib/personThread';

/** Round 5e (GM r117): a row's status line changing text moves the row's
 * height on the box's layout spring, never a jump; reduced motion jumps. */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';

function listener(): ChannelListener {
  return {
    listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: { key: KEY, ordinal: 1 },
  };
}

function message(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'm1', kind: 'message', at: Date.now() - 1_000, text: 'Make the sky warmer', state: 'sent', lapsed: true,
    to: { listenerId: 'ch_1', agent: CLAUDE, session: { key: KEY, ordinal: 1 }, sessionKey: KEY }, ...over,
  };
}

const css = readFileSync(join(__dirname, '../../styles/messageBox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rulesFor(source: string, selector: string) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selectors, body]) => ({ selectors: selectors.split(',').map((s) => s.trim()), body }))
    .filter((rule) => rule.selectors.includes(selector));
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

describe('the status line wrapper springs the row’s height (GM r117)', () => {
  it('the wrapper carries the layout spring, 420 ms, on height', () => {
    const rules = rulesFor(css, '.message-box__status-wrap');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((rule) => /transition:\s*height 420ms var\(--agent-log-spring\)/.test(rule.body))).toBe(true);
    expect(rules.some((rule) => /overflow:\s*hidden/.test(rule.body))).toBe(true);
  });

  it('reduced motion has no transition on it', () => {
    const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    const block = [...reduce.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, selectors, body]) => selectors.includes('.message-box__status-wrap') && /transition:\s*none/.test(body));
    expect(block).toBeTruthy();
  });

  it('a lapsed line and the dropped line that replaces it both sit in the wrapper, which holds the measured height', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('message-box__status--dropped') ? 36 : this.classList.contains('message-box__status') ? 18 : 0;
    });
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message()]);
    render(<AgentLog />);
    const lapsed = screen.getByText(/stopped listening\. It’ll get this message/).closest('.message-box__status')!;
    expect(lapsed.parentElement?.className).toBe('message-box__status-wrap');
    expect((lapsed.parentElement as HTMLElement).style.height).toBe('18px');
    act(() => receiveRows('p1', [message({ state: 'dropped', lapsed: false, rev: 5 })]));
    const dropped = document.querySelector('.message-box__status--dropped')!;
    expect(dropped.parentElement?.className).toBe('message-box__status-wrap');
    expect((dropped.parentElement as HTMLElement).style.height).toBe('36px');
  });

  it('a thread read at the bottom stays at the bottom when the last row’s line grows', () => {
    const observed: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observed.push(callback); }
      observe() {}
      disconnect() {}
    });
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message()]);
    render(<AgentLog />);
    const thread = document.querySelector<HTMLElement>('.message-box__thread')!;
    let content = 600;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => content });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 200 });
    // Read at the bottom.
    thread.scrollTop = 400;
    act(() => { thread.dispatchEvent(new Event('scroll')); });
    // The line grows a row's height; the spring resizes the list each frame.
    for (const height of [610, 620, 636]) {
      content = height;
      act(() => { for (const call of observed) call(); });
      expect(thread.scrollTop).toBe(height);
    }
  });
});
