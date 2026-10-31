/**
 * PR #204 round 8, GM r10 on the held cards:
 * (1) the permission card shows GM's line on its own row under the buttons; the buttons have no
 *     tooltip and point at the line (aria-describedby); the countdown stays. The question form
 *     does the same.
 * (2) the card's tag says the ACP tool kind in Nebula's words: "execute" is "run".
 * (5) on a held tab, Send and Dismiss are both locked and both take the shared locked look.
 * Review 6 LOW-6 (M3): the card's own guard sends nothing while held, on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
const { PermissionCard } = await import('../src/components/panels/PermissionCard');
const { AgentQuestionsForm } = await import('../src/components/agent-notes/AgentQuestionsForm');
const { useAgentQuestionsStore } = await import('../src/store/agentQuestionsStore');
const { toolKindWord } = await import('../src/lib/acpToolKind');
const session = await import('../src/lib/personSession');
const { HELD_QUESTIONS_LINE } = await import('../src/store/heldAssetProposals');

const part = (extra: Record<string, unknown> = {}) => ({
  kind: 'permission' as const, requestId: 'r-1', title: 'Run npm test', toolKind: 'execute', input: { command: 'npm test' },
  canAllow: true, timeoutSeconds: 120, receivedAt: Date.now(), status: 'pending' as const, ...extra,
});

beforeEach(() => { session.resetPersonSessionForTests(); useAgentQuestionsStore.getState().reset(); });
afterEach(() => { cleanup(); session.notePersonPromoted(); session.resetPersonSessionForTests(); });

describe('GM r10 (1): the permission card on a held tab', () => {
  it('the line is on its own row under the buttons; the buttons point at it, with no tooltip; the countdown stays', () => {
    const onDecision = vi.fn();
    render(<PermissionCard part={part()} agentName="Codex" onDecision={onDecision} />);
    act(() => session.reportPersonRequired());
    const card = screen.getByRole('group', { name: 'Codex asks permission' });
    const line = within(card).getByText(HELD_QUESTIONS_LINE);
    expect(line.tagName).toBe('P');
    const actions = card.querySelector('.permission-card__actions')!;
    // Its own row, after the buttons' row, not inside it.
    expect(actions.contains(line)).toBe(false);
    expect(actions.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of ['Allow once', 'Deny']) {
      const button = within(card).getByRole('button', { name });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toHaveAttribute('title');
      expect(button.getAttribute('aria-describedby')).toBe(line.id);
      expect(button.className).toContain('agent-notes-btn--held');
      // M3: the card's own guard, with no panel behind it.
      fireEvent.click(button);
    }
    expect(onDecision).not.toHaveBeenCalled();
    expect(within(card).getByText(/^No answer in \d+s denies it$/)).toBeTruthy();
  });

  it('connected: no line, no description, and a press decides', () => {
    const onDecision = vi.fn();
    render(<PermissionCard part={part()} agentName="Codex" onDecision={onDecision} />);
    expect(screen.queryByText(HELD_QUESTIONS_LINE)).toBeNull();
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(deny).not.toHaveAttribute('aria-describedby');
    fireEvent.click(deny);
    expect(onDecision).toHaveBeenCalledWith('r-1', 'deny');
  });

  it('the promote takes the line away and the buttons answer', () => {
    const onDecision = vi.fn();
    render(<PermissionCard part={part()} agentName="Codex" onDecision={onDecision} />);
    act(() => session.reportPersonRequired());
    expect(screen.getByText(HELD_QUESTIONS_LINE)).toBeTruthy();
    act(() => session.notePersonPromoted());
    expect(screen.queryByText(HELD_QUESTIONS_LINE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onDecision).toHaveBeenCalledWith('r-1', 'allow');
  });
});

describe('GM r10 (2): the tool kind in Nebula\'s words', () => {
  it('maps every ACP kind through one table', () => {
    expect(Object.fromEntries(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']
      .map((kind) => [kind, toolKindWord(kind)]))).toEqual({
      read: 'read', edit: 'edit', delete: 'delete', move: 'move', search: 'search', execute: 'run', think: 'think',
      fetch: 'fetch', switch_mode: 'switch mode', other: null,
    });
    expect(toolKindWord('some_new_kind')).toBeNull();
    expect(toolKindWord('toString')).toBeNull();
  });

  it('the card shows "run" for execute, and no tag for other', () => {
    const { unmount } = render(<PermissionCard part={part()} agentName="Codex" onDecision={() => {}} />);
    expect(document.querySelector('.permission-card__kind')?.textContent).toBe('run');
    unmount();
    render(<PermissionCard part={part({ toolKind: 'other' })} agentName="Codex" onDecision={() => {}} />);
    expect(document.querySelector('.permission-card__kind')).toBeNull();
  });
});

const SET = { id: 'qs_8', status: 'open', agent: { name: 'Codex', color: '#7aa2ff' }, note: null, projectId: 'p1', nodeIds: [],
  createdAt: 1, closedAt: null, answers: null, update: { id: 'u_q', projectId: 'p1' },
  questions: [{ id: 'q1', text: 'Which mood?', options: ['Warm dusk', 'Cold fog'], multiple: false, allowText: true }] };

describe('GM r10 (1) and (5): the question form on a held tab', () => {
  it('Send and Dismiss are both locked, both take the locked look, and point at the line under them', () => {
    act(() => { useAgentQuestionsStore.getState().opened(SET as never, 'k_q'); });
    render(<AgentQuestionsForm setId="qs_8" onClose={() => {}} />);
    // An answer picked, so Send isn't greyed for having nothing to send: only the hold locks it.
    fireEvent.click(screen.getByRole('button', { name: 'Warm dusk' }));
    act(() => session.reportPersonRequired());
    const foot = document.querySelector('.agent-questions-form__foot')!;
    const line = within(foot as HTMLElement).getByText(HELD_QUESTIONS_LINE);
    const buttons = [...foot.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Dismiss', 'Send']);
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toHaveAttribute('data-held-pending');
      expect(button).not.toHaveAttribute('title');
      expect(button).toBeEnabled();
      expect(button.className).toContain('agent-notes-btn--held');
      expect(button.getAttribute('aria-describedby')).toBe(line.id);
      expect(button.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('the shared locked look covers the held class (one look, filled or ghost)', () => {
    const css = readFileSync(join(__dirname, '../src/styles/disabled-buttons.css'), 'utf8');
    const ghost = css.match(/\.agent-roster__row,\s*\.agent-notes-btn--held\s*\):is\(:disabled, \[aria-disabled='true'\]:not\(\[data-held-pending\]\)\)/g);
    expect(ghost?.length).toBe(2); // the rule and its :hover
  });
});
