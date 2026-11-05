import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * GM r108 c and d on #225: a reply's Update keeps its visible "Open"; the
 * button's accessible name starts with it and says whose reply and where:
 * "Open Claude Code’s reply in “Coast”". An unnamed project reads “Untitled”.
 */

const { sanitizeNote } = await import('../src/lib/agentNotes');
const { AgentNoteCard } = await import('../src/components/agent-notes/AgentNoteCard');
const { useProjectStore } = await import('../src/store/projectStore');
const { threadOpenLabel } = await import('../src/lib/agentNotesView');

afterEach(cleanup);

// The corner's adapter names it from the project list (AgentNotesCorner's actionLabel); the same lookup here.
const adapter = { keptWith: 'kept with this project', showLabel: () => null, show: () => {}, runAction: () => {}, actionState: () => null,
  actionLabel: (note: { author: { name: string } }, action: { label: string; op: Record<string, unknown> }) => (action.op.kind === 'thread.open'
    ? threadOpenLabel(action.label, note.author.name, useProjectStore.getState().projects.find((p) => p.id === action.op.projectId)?.name)
    : undefined) };
const hold = { onMouseEnter: () => {}, onMouseLeave: () => {}, onFocus: () => {}, onBlur: () => {} };

function replied(projectId: string) {
  return sanitizeNote({
    id: 'note_1', author: { kind: 'agent', id: 'app:claude1', name: 'Claude Code', color: '#E8825A', verified: true },
    source: 'nebula', about: 'other', at: '2026-11-04T10:00:00Z', text: 'Claude Code replied in “Coast”.', refs: [],
    actions: [{ label: 'Open', op: { kind: 'thread.open', projectId, replyId: 'pt_r1' } }],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
  })!;
}

function card(projectId: string) {
  return render(<AgentNoteCard note={replied(projectId)} adapter={adapter as never} leaving={false} cardRef={() => {}}
    hold={hold} onRead={() => {}} onDismiss={() => {}} onAction={() => {}} onShow={() => {}} />);
}

describe('GM r108 c: Open on a reply’s Update', () => {
  it('reads “Open”, and is named “Open Claude Code’s reply in “Coast””', () => {
    useProjectStore.setState({ projects: [{ id: 'p2', name: 'Coast' }] as never });
    card('p2');
    const button = screen.getByRole('button', { name: 'Open Claude Code’s reply in “Coast”' });
    expect(button.textContent).toBe('Open');
  });

  it('an unnamed project reads “Untitled” (GM r108 d)', () => {
    useProjectStore.setState({ projects: [{ id: 'p2', name: '  ' }] as never });
    card('p2');
    expect(screen.getByRole('button', { name: 'Open Claude Code’s reply in “Untitled”' })).toBeTruthy();
    expect(threadOpenLabel('Open', 'Codex', null)).toBe('Open Codex’s reply in “Untitled”');
  });
});
