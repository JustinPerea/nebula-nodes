import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: {
    connect: vi.fn(),
    subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; },
  },
}));

const { AGENT_LOG_MAX_ENTRIES, useAgentLogStore } = await import('../src/store/agentLogStore');
const { useAgentPresenceStore } = await import('../src/store/agentPresenceStore');
const { useUIStore } = await import('../src/store/uiStore');
const { useGraphStore } = await import('../src/store/graphStore');
const { AgentLog } = await import('../src/components/panels/AgentLog');

function emit(event: unknown) {
  for (const handler of ws.handlers) handler(event);
}

const CLAUDE_CODE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };

function action(say: string, overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent {
  return { type: 'agentPresence', agent: CLAUDE_CODE, target: { nodeId: 'n1' }, action: 'click', say,
    at: Date.UTC(2026, 9, 20, 14, 5, 9), ...overrides };
}

function showLog(chatVisible = true) {
  const panels = useUIStore.getState().panels;
  useUIStore.setState({ agentLogEnabled: true, panels: { ...panels, chat: { ...panels.chat, visible: chatVisible } } });
}

function openLog() {
  render(<AgentLog />);
  fireEvent.click(screen.getByRole('button', { name: /^agent log/i }));
}

beforeEach(() => {
  cleanup();
  useAgentLogStore.getState().clear();
  useAgentPresenceStore.getState().clear();
  useGraphStore.setState({ isExecuting: false });
});

describe('agent log store', () => {
  it('logs each agent action in the words, name and colour its cursor shows', () => {
    emit(action('Added Moodboard'));
    emit(action('Running Krea 2', { agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true } }));
    const entries = useAgentLogStore.getState().entries;
    expect(entries.map((entry) => [entry.agent?.name, entry.agent?.color, entry.message])).toEqual([
      ['Claude Code', '#3FC1A5', 'Added Moodboard'],
      ['Codex', '#5B9DFF', 'Running Krea 2'],
    ]);
    // When: the backend's clock, as the action happened.
    expect(entries[0].ts).toBe(Date.UTC(2026, 9, 20, 14, 5, 9));
    // The same event still drives the cursor.
    expect(useAgentPresenceStore.getState().agents['codex'].say).toBe('Running Krea 2');
  });

  it('lists a moodboard write, which has no target, without drawing a cursor', () => {
    emit(action('Set aside #1 on board Dusk dunes', { target: undefined }));
    expect(useAgentLogStore.getState().entries.map((entry) => entry.message)).toEqual([
      'Set aside #1 on board Dusk dunes',
    ]);
    expect(useAgentPresenceStore.getState().agents).toEqual({});
  });

  it('skips events with nothing to say and cleans an unsafe colour', () => {
    emit(action(''));
    emit(action('   '));
    emit(action('Accepted', { agent: { ...CLAUDE_CODE, color: 'red;}' } }));
    const entries = useAgentLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].agent?.color).toBe('#E8825A');
  });

  it('keeps the chat’s thinking lines', () => {
    window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', { detail: { source: 'claude', message: ' Reading the canvas ' } }));
    const [entry] = useAgentLogStore.getState().entries;
    expect(entry.source).toBe('claude');
    expect(entry.message).toBe('Reading the canvas');
    expect(entry.agent).toBeUndefined();
  });

  it(`keeps the last ${AGENT_LOG_MAX_ENTRIES} entries`, () => {
    for (let index = 0; index < AGENT_LOG_MAX_ENTRIES + 5; index += 1) emit(action(`Set seed ${index}`));
    const entries = useAgentLogStore.getState().entries;
    expect(entries).toHaveLength(AGENT_LOG_MAX_ENTRIES);
    expect(entries[0].message).toBe('Set seed 5');
  });
});

describe('AgentLog panel', () => {
  it('shows actions an MCP agent took while the panel was not mounted, newest first', () => {
    emit(action('Added Moodboard'));
    emit(action('Analyzed board Dusk dunes', { target: undefined, at: Date.UTC(2026, 9, 20, 14, 6, 0) }));
    showLog();
    openLog();

    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.agent-log__msg')?.textContent)).toEqual([
      'Analyzed board Dusk dunes',
      'Added Moodboard',
    ]);
    const source = rows[0].querySelector('.agent-log__source');
    expect(source?.textContent).toBe('Claude Code');
    expect(rows[0].style.getPropertyValue('--agent-log-source-color')).toBe('#3FC1A5');
    expect(rows[0].querySelector('.agent-log__time')?.textContent).toBe(
      new Date(Date.UTC(2026, 9, 20, 14, 6, 0)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    );
    expect(document.querySelector('.agent-log__count')?.textContent).toBe('2 events');
    expect(document.querySelector('.agent-log')?.getAttribute('data-status')).toBe('Claude Code');
  });

  it('logs a run in the cursor’s words, not a "Running graph" placeholder', () => {
    showLog();
    openLog();
    act(() => {
      useGraphStore.setState({ isExecuting: true });
      emit(action('Running Krea 2'));
    });
    expect(screen.getByText('Running Krea 2')).toBeTruthy();
    expect(screen.queryByText(/Running graph/)).toBeNull();
  });

  it('shows with the chat closed too (Q38: no chat-open gate)', () => {
    emit(action('Added Moodboard'));
    showLog(false);
    const { container } = render(<AgentLog />);
    expect(container.querySelector('.agent-log')).not.toBeNull();
    expect(document.querySelector('.agent-log__count')?.textContent).toBe('1 event');
  });
});
