import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

/**
 * The agent's mark on a node and the placeholder outline (Q125 item 3),
 * drawn over the canvas. GM - Design, 2026-10-25: the pill sits just
 * outside the node's top edge, left-aligned, 6 px gap, like a tab; never
 * over the header or the preview. Dot (ring when it named itself), name,
 * status; truncated at the node's width with the full text in a tooltip.
 * Two or more agents: the most recent one's pill, then "+1"; hovering or
 * focusing the chip lists the others, one line each. Below 60% zoom: the
 * dot alone at a fixed screen size. Placeholders: a dashed outline in the
 * agent's colour.
 */

const flow = vi.hoisted(() => ({
  state: {
    transform: [0, 0, 1] as [number, number, number],
    nodeLookup: new Map<string, unknown>(),
  },
  listeners: new Set<() => void>(),
}));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: (fn: () => void) => { flow.listeners.add(fn); return () => flow.listeners.delete(fn); } }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
const rosterApi = vi.hoisted(() => ({ fetchAgentRoster: vi.fn(() => new Promise(() => {})) }));
vi.mock('../src/lib/agentRoster', () => rosterApi);
vi.mock('../src/store/projectStore', () => ({
  useProjectStore: (selector: (state: { activeProject: { id: string } | null }) => unknown) => selector({ activeProject: { id: 'p1' } }),
}));

const { AgentNodeMarkLayer } = await import('../src/components/canvas/AgentNodeMarkLayer');
const { useAgentRosterStore } = await import('../src/components/agent-notes/agentRosterStore');

const CODEX = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: false };
const CLAUDE = { id: 'claude', name: 'Claude Code', color: '#D97757', verified: true };

function node(id: string, x: number, y: number, data: Record<string, unknown> = {}) {
  return { id, data, measured: { width: 240, height: 160 }, internals: { positionAbsolute: { x, y } } };
}

function setRun(agent: typeof CODEX, nodeId: string, secondsAgo: number) {
  useAgentRosterStore.getState().applyRun({
    type: 'agentRun', agent, runId: `r-${agent.id}`, nodeId, model: 'FLUX.2 [pro]', projectId: 'p1',
    change: 'started', secondsAgo,
  }, Date.now());
}

function setStatus(agent: typeof CODEX, nodeId: string, text: string, secondsAgo = 0) {
  useAgentRosterStore.getState().applyStatus({
    type: 'agentStatus', agent, change: 'set', rev: 1,
    status: { text, nodeId, projectId: 'p1', at: 0, secondsAgo },
  });
}

beforeEach(() => {
  useAgentRosterStore.getState().reset();
  flow.state.transform = [0, 0, 1];
  flow.state.nodeLookup = new Map([['n4', node('n4', 100, 50)], ['n7', node('n7', 500, 50)]]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AgentNodeMarkLayer', () => {
  it('draws one pill above the node, left-aligned, with the dot, name and status', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    setRun(CODEX, 'n4', 41);
    const { container } = render(<AgentNodeMarkLayer />);
    const mark = container.querySelector<HTMLElement>('.agent-node-mark')!;
    expect(mark.dataset.node).toBe('n4');
    // At the node's top-left corner; the pill itself sits above it (CSS), so it never covers the header.
    expect(mark.style.transform).toBe('translate(100px, 50px)');
    expect(mark.style.getPropertyValue('--anm-max')).toBe('240px');
    const pill = mark.querySelector<HTMLElement>('.agent-node-mark__pill')!;
    expect(pill.querySelector('.agent-node-mark__dot')?.getAttribute('data-verified')).toBe('false');
    expect(pill.textContent).toContain('Codex');
    expect(pill.textContent).toContain('Running FLUX.2 [pro] · 0:41');
    expect(pill.title).toBe('Codex · Running FLUX.2 [pro] · 0:41');
    // GM, 2026-10-25: "{agent}, {status}", and "unverified" for an agent that named itself.
    expect(pill.getAttribute('aria-label')).toBe('Codex, unverified, Running FLUX.2 [pro] · 0:41');
    expect(pill.style.getPropertyValue('--anm-color')).toBe('#F2C14E');
    expect(mark.querySelector('.agent-node-mark__more')).toBeNull();
    // The clock ticks.
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(pill.textContent).toContain('0:43');
  });

  it('shows a status line on a node the same way, and goes when it clears', () => {
    setStatus(CLAUDE, 'n7', 'Writing the prompts');
    const { container } = render(<AgentNodeMarkLayer />);
    expect(container.querySelector('.agent-node-mark')?.textContent).toContain('Writing the prompts');
    act(() => {
      useAgentRosterStore.getState().applyStatus({ type: 'agentStatus', agent: CLAUDE, change: 'cleared', rev: 2, status: null });
    });
    expect(container.querySelector('.agent-node-mark')).toBeNull();
  });

  it('shows the most recent agent in full and a +1 chip that lists the others on hover or focus', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    setRun(CODEX, 'n4', 30);
    setStatus(CLAUDE, 'n4', 'Checking the crops', 5);
    const { container } = render(<AgentNodeMarkLayer />);
    const marks = container.querySelectorAll('.agent-node-mark');
    expect(marks).toHaveLength(1);
    expect(container.querySelector('.agent-node-mark__pill')?.textContent).toContain('Claude Code');
    const chip = container.querySelector<HTMLButtonElement>('.agent-node-mark__more')!;
    expect(chip.textContent).toBe('+1');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.agent-node-mark__others')).toBeNull();
    act(() => { fireEvent.focus(chip); });
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const others = container.querySelectorAll('.agent-node-mark__other');
    expect(others).toHaveLength(1);
    expect(others[0].textContent).toContain('Codex');
    expect(others[0].textContent).toContain('Running FLUX.2 [pro] · 0:30');
    act(() => { fireEvent.blur(chip); });
    expect(container.querySelector('.agent-node-mark__others')).toBeNull();
    act(() => { fireEvent.mouseEnter(chip); });
    expect(container.querySelector('.agent-node-mark__others')).not.toBeNull();
  });

  it('collapses to the dot at a fixed screen size below 60% zoom, with the words on hover', () => {
    flow.state.transform = [0, 0, 0.5];
    setStatus(CLAUDE, 'n4', 'Checking the crops');
    const { container } = render(<AgentNodeMarkLayer />);
    const mark = container.querySelector<HTMLElement>('.agent-node-mark')!;
    expect(mark.dataset.collapsed).toBe('true');
    // Counter-scaled so it stays the same size on screen.
    expect(mark.style.getPropertyValue('--anm-scale')).toBe('2');
    const pill = mark.querySelector<HTMLElement>('.agent-node-mark__pill')!;
    expect(pill.title).toBe('Claude Code · Checking the crops');
    expect(pill.getAttribute('aria-label')).toBe('Claude Code, Checking the crops');
  });

  it('keeps the +N chip and a focusable dot below 60% zoom, so every agent can be found by keyboard', () => {
    flow.state.transform = [0, 0, 0.4];
    vi.useFakeTimers({ now: 1_000_000 });
    setRun(CODEX, 'n4', 30);
    setStatus(CLAUDE, 'n4', 'Checking the crops', 5);
    const { container } = render(<AgentNodeMarkLayer />);
    const mark = container.querySelector<HTMLElement>('.agent-node-mark')!;
    expect(mark.dataset.collapsed).toBe('true');
    const pill = mark.querySelector<HTMLElement>('.agent-node-mark__pill')!;
    // The dot takes focus, so the name and status come back from the keyboard too.
    expect(pill.tabIndex).toBe(0);
    const chip = mark.querySelector<HTMLButtonElement>('.agent-node-mark__more')!;
    expect(chip.textContent).toBe('+1');
    // WCAG 2.5.3: the name starts with the chip's visible text.
    expect(chip.getAttribute('aria-label')).toBe('+1 more agent. Codex, unverified, Running FLUX.2 [pro] · 0:30.');
    act(() => { fireEvent.focus(chip); });
    expect(container.querySelector('.agent-node-mark__other')?.textContent).toContain('Codex');
  });

  it('keeps the pill a fixed screen size at every zoom, truncated at the node\'s on-screen width', () => {
    // GM, 2026-10-25: "a FIXED screen size at every zoom, like the cursor
    // labels: always 22 px tall, never scaled with the canvas."
    setStatus(CLAUDE, 'n4', 'Checking the crops');
    for (const [zoom, scale, max] of [[1.5, String(1 / 1.5), '360px'], [1, '1', '240px'], [0.6, String(1 / 0.6), '144px']] as const) {
      flow.state.transform = [0, 0, zoom];
      const { container, unmount } = render(<AgentNodeMarkLayer />);
      const mark = container.querySelector<HTMLElement>('.agent-node-mark')!;
      expect(mark.dataset.collapsed).toBeUndefined();
      expect(mark.style.getPropertyValue('--anm-scale')).toBe(scale);
      expect(mark.style.getPropertyValue('--anm-max')).toBe(max);
      unmount();
    }
  });

  // Review 3, finding 8: at 60% and up the pill takes no focus (no tab stop
  // on every node), so the node's own keyboard focus shows its whole text.
  describe("the node's keyboard focus", () => {
    // Review 4, L5: the keyboard is what brings focus there (a key pressed
    // since the last pointer press), not :focus-visible, which a text field
    // clicked with the mouse matches too.
    function focusNode(id: string, keyboard: boolean, field = false) {
      const el = document.createElement('div');
      el.className = 'react-flow__node';
      el.dataset.id = id;
      el.tabIndex = 0;
      const input = document.createElement('input');
      el.appendChild(input);
      document.body.appendChild(el);
      const target = field ? input : el;
      const matches = HTMLElement.prototype.matches;
      vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector: string) {
        // jsdom has no :focus-visible; a browser's matches a text field however it got focus.
        return selector === ':focus-visible' ? (this === input || (keyboard && this === el)) : matches.call(this, selector);
      });
      act(() => {
        if (keyboard) fireEvent.keyDown(document, { key: 'Tab' });
        else fireEvent.pointerDown(target);
        fireEvent.focusIn(target);
      });
      return el;
    }
    afterEach(() => { document.querySelectorAll('.react-flow__node').forEach((el) => el.remove()); vi.restoreAllMocks(); });

    it('shows its pill in full while the node has keyboard focus, and not after', () => {
      setStatus(CLAUDE, 'n4', 'Checking the crops on every still in the hero set');
      const { container } = render(<AgentNodeMarkLayer />);
      const mark = () => container.querySelector<HTMLElement>('.agent-node-mark[data-node="n4"]')!;
      expect(mark().dataset.focused).toBeUndefined();
      const el = focusNode('n4', true);
      expect(mark().dataset.focused).toBe('true');
      act(() => { fireEvent.focusOut(el); });
      expect(mark().dataset.focused).toBeUndefined();
    });

    it("a pointer's focus (a click on the node) changes nothing", () => {
      setStatus(CLAUDE, 'n4', 'Checking the crops');
      const { container } = render(<AgentNodeMarkLayer />);
      focusNode('n4', false);
      expect(container.querySelector<HTMLElement>('.agent-node-mark')!.dataset.focused).toBeUndefined();
    });

    it('a text field in the node clicked with the mouse changes nothing (review 4, L5)', () => {
      setStatus(CLAUDE, 'n4', 'Checking the crops on every still in the hero set');
      const { container } = render(<AgentNodeMarkLayer />);
      focusNode('n4', false, true);
      expect(container.querySelector<HTMLElement>('.agent-node-mark')!.dataset.focused).toBeUndefined();
    });

    it('tabbing into a text field in the node shows the pill in full', () => {
      setStatus(CLAUDE, 'n4', 'Checking the crops on every still in the hero set');
      const { container } = render(<AgentNodeMarkLayer />);
      focusNode('n4', true, true);
      expect(container.querySelector<HTMLElement>('.agent-node-mark')!.dataset.focused).toBe('true');
    });

    it('another node\'s focus leaves this pill as it is', () => {
      setStatus(CLAUDE, 'n4', 'Checking the crops');
      const { container } = render(<AgentNodeMarkLayer />);
      focusNode('n7', true);
      expect(container.querySelector<HTMLElement>('.agent-node-mark')!.dataset.focused).toBeUndefined();
    });

    // Round 8 (review 7, L5 live check): a status now keeps a long URL whole up
    // to the cut, which has no space to wrap at. Below 60% zoom the dot is its
    // own Tab stop: tabbing to it shows the whole status (wrapping past 480
    // px, GM round 5), the same as the node's keyboard focus, not 320 px with "…".
    it('tabbing to the dot below 60% zoom shows the whole status, as the node\'s focus does', () => {
      flow.state.transform = [0, 0, 0.4];
      setStatus(CLAUDE, 'n4', `Reading https://example.com/${'p'.repeat(111)}…`);
      const { container } = render(<AgentNodeMarkLayer />);
      const mark = () => container.querySelector<HTMLElement>('.agent-node-mark[data-node="n4"]')!;
      const pill = mark().querySelector<HTMLElement>('.agent-node-mark__pill')!;
      act(() => {
        fireEvent.keyDown(document, { key: 'Tab' });
        fireEvent.focusIn(pill);
      });
      expect(mark().dataset.focused).toBe('true');
      act(() => { fireEvent.focusOut(pill); });
      expect(mark().dataset.focused).toBeUndefined();
      // A pointer's press on the dot (hover shows its words) changes nothing.
      act(() => {
        fireEvent.pointerDown(pill);
        fireEvent.focusIn(pill);
      });
      expect(mark().dataset.focused).toBeUndefined();
    });
  });

  it('leaves the full-size pill out of the tab order', () => {
    setStatus(CLAUDE, 'n4', 'Checking the crops');
    const { container } = render(<AgentNodeMarkLayer />);
    expect(container.querySelector<HTMLElement>('.agent-node-mark__pill')!.hasAttribute('tabindex')).toBe(false);
  });

  it("outlines each placeholder, dashed, in its agent's colour", () => {
    flow.state.nodeLookup = new Map([
      ['n4', node('n4', 100, 50, { pending: { agent: CODEX, at: 1 } })],
      ['n7', node('n7', 500, 50, { pending: { agent: 'nobody' } })],
    ]);
    const { container } = render(<AgentNodeMarkLayer />);
    const outlines = container.querySelectorAll<HTMLElement>('.agent-placeholder-outline');
    expect(outlines).toHaveLength(1);
    expect(outlines[0].dataset.node).toBe('n4');
    expect(outlines[0].style.transform).toBe('translate(100px, 50px)');
    expect(outlines[0].style.width).toBe('240px');
    expect(outlines[0].style.getPropertyValue('--apo-color')).toBe('#F2C14E');
  });

  it('draws nothing for a node that is not on the canvas', () => {
    setStatus(CLAUDE, 'n99', 'Somewhere');
    const { container } = render(<AgentNodeMarkLayer />);
    expect(container.querySelector('.agent-node-mark')).toBeNull();
  });
});
