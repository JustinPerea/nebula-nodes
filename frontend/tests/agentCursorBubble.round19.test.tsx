import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

// The layer draws in React Flow's viewport: here the portal renders in place,
// and no node is drawn (the cursor waits for its anchor, the bubble shows).
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  useStore: (select: (state: { transform: [number, number, number] }) => unknown) => select({ transform: [0, 0, 1] }),
  useStoreApi: () => ({ getState: () => ({ nodeLookup: new Map() }), subscribe: () => () => {} }),
}));

import { AgentCursorLayer } from '../src/components/canvas/AgentCursorLayer';
import { AGENT_SAY_FADE_MS, AGENT_SAY_MS, useAgentPresenceStore } from '../src/store/agentPresenceStore';

/**
 * GM - Design, round 19 (verbatim): "the agent cursor's speech bubble fades
 * out about 3 s after the agent's last event". A spring-tuned fade, the
 * bubble mounted through it, then removed; under prefers-reduced-motion the
 * removal is instant. Each new event resets the timer and cancels a fade in
 * progress.
 */

const event = (say: string): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false },
  target: { nodeId: 'n1' },
  action: 'click',
  say,
  at: 0,
});
const bubble = () => document.querySelector('.agent-cursor__say');
const leaving = () => bubble()?.classList.contains('agent-cursor__say--leaving') === true;
const send = (say: string) => act(() => { useAgentPresenceStore.getState().apply(event(say)); });
const realMatchMedia = window.matchMedia;
const reduceMotion = (on: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: on && query.includes('reduce'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null,
    dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  useAgentPresenceStore.getState().clear();
  reduceMotion(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
  useAgentPresenceStore.getState().clear();
});

describe('the agent cursor bubble fades about 3 s after the last event', () => {
  it('is about 3 s, with a fade under half a second', () => {
    expect(AGENT_SAY_MS).toBe(3_000);
    expect(AGENT_SAY_FADE_MS).toBeGreaterThan(0);
    expect(AGENT_SAY_FADE_MS).toBeLessThanOrEqual(500);
  });

  it('present before 3 s, fading (still mounted) after, gone once the fade ends', () => {
    render(<AgentCursorLayer />);
    send('Added Text Input');
    expect(bubble()?.textContent).toBe('Added Text Input');
    act(() => { vi.advanceTimersByTime(AGENT_SAY_MS - 1); });
    expect(bubble()).not.toBeNull();
    expect(leaving()).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(bubble()).not.toBeNull();
    expect(leaving()).toBe(true);
    act(() => { vi.advanceTimersByTime(AGENT_SAY_FADE_MS); });
    expect(bubble()).toBeNull();
  });

  it('a new event resets the timer and cancels a fade in progress', () => {
    render(<AgentCursorLayer />);
    send('Added Text Input');
    act(() => { vi.advanceTimersByTime(AGENT_SAY_MS + AGENT_SAY_FADE_MS / 2); });
    expect(leaving()).toBe(true);
    send('Connected the prompt');
    expect(bubble()?.textContent).toBe('Connected the prompt');
    expect(leaving()).toBe(false);
    // The old fade's end never removes the new bubble.
    act(() => { vi.advanceTimersByTime(AGENT_SAY_FADE_MS); });
    expect(bubble()).not.toBeNull();
    expect(leaving()).toBe(false);
    act(() => { vi.advanceTimersByTime(AGENT_SAY_MS - AGENT_SAY_FADE_MS - 1); });
    expect(leaving()).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(leaving()).toBe(true);
  });

  it('under prefers-reduced-motion the bubble goes at once, with no fade', () => {
    reduceMotion(true);
    render(<AgentCursorLayer />);
    send('Added Text Input');
    act(() => { vi.advanceTimersByTime(AGENT_SAY_MS - 1); });
    expect(bubble()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(bubble()).toBeNull();
  });

  it('the fade runs on a spring linear() easing, never a stock curve, and reduced motion drops it', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    const rule = /\.agent-cursor__say--leaving\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/animation:\s*agent-cursor-say-out\s+var\(--agent-cursor-say-fade\)/);
    expect(css).toMatch(/--agent-cursor-say-fade:\s*\d+ms linear\(0,/);
    expect(css).toMatch(new RegExp(`--agent-cursor-say-fade:\\s*${AGENT_SAY_FADE_MS}ms `));
    expect(rule).not.toMatch(/ease-in-out|ease-out|ease-in\b/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.agent-cursor__say--leaving[^{]*\{[^}]*animation:\s*none/);
  });
});
