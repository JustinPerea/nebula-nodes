import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_COLOR, isUnread, sanitizeNote, surfaceKey, type AgentNote } from './agentNotes';
import {
  aboutLabel,
  authorInitials,
  clockTime,
  cornerRight,
  noteControls,
  noteDone,
  noteLabel,
  noteText,
  offersNotNow,
  roomBelow,
  showLabel,
} from './agentNotesView';

const AGENT = { kind: 'agent' as const, id: 'claude', name: 'Claude', color: '#E8825A' };
const ARGON = { kind: 'reader' as const, id: 'argon', name: 'Gemini 4 Argon', color: '#B4A7FF' };

function note(overrides: Partial<AgentNote> = {}): AgentNote {
  return {
    id: 'an_000000000001',
    author: AGENT,
    source: 'agent',
    about: 'other',
    at: '2026-10-20T12:14:05.000Z',
    text: 'The upscaler is wired to the wrong image.',
    parts: [{ text: 'The upscaler is wired to the wrong image.' }],
    refs: ['n3'],
    actions: [],
    readAt: null,
    dismissedAt: null,
    actedAt: null,
    actedWith: null,
    ...overrides,
  };
}

describe('sanitizeNote', () => {
  it('keeps a well-formed update and drops malformed ones', () => {
    expect(sanitizeNote({ id: 'x' })).toBeNull();
    expect(sanitizeNote(null)).toBeNull();
    const kept = sanitizeNote({ ...note(), extra: 'ignored' });
    expect(kept?.id).toBe('an_000000000001');
    expect(kept?.refs).toEqual(['n3']);
  });

  it('never lets an unsafe colour reach a custom property', () => {
    const kept = sanitizeNote({ ...note(), author: { ...AGENT, color: 'red;} body{display:none' } });
    expect(kept?.author.color).toBe(DEFAULT_AGENT_COLOR);
  });

  it('keeps only actions with a label and a kind, two at most', () => {
    const kept = sanitizeNote({
      ...note({ source: 'nebula' }),
      actions: [
        { label: 'Accept', op: { kind: 'proposal.accept', proposalId: 'p1' } },
        { label: 'Reject', op: { kind: 'proposal.reject', proposalId: 'p1' } },
        { label: 'Third', op: { kind: 'proposal.accept', proposalId: 'p1' } },
        { label: 'No op' },
      ],
    });
    expect(kept?.actions.map((a) => a.label)).toEqual(['Accept', 'Reject']);
  });
});

describe('an asset proposal\'s Update (Q92 a)', () => {
  it('keeps how it ended, and treats it as done', () => {
    const kept = sanitizeNote({
      ...note({ source: 'nebula', about: 'proposal', refs: [] }),
      actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_1', target: 'project', targetId: 'dusk' } }],
      proposal: { id: 'pa_1', kind: 'project', targetId: 'dusk' },
      resolvedAt: '2026-10-20T12:30:00.000Z', outcome: 'Accepted: the cover changed', readAt: '2026-10-20T12:30:00.000Z',
    });
    expect(kept?.outcome).toBe('Accepted: the cover changed');
    expect(kept?.resolvedAt).toBe('2026-10-20T12:30:00.000Z');
    const controls = noteControls(kept!, { showLabel: 'Show on canvas' });
    expect(controls.state).toBe('Accepted: the cover changed');
    expect(controls.buttons).toEqual([]);
    expect(noteLabel(kept!)).toBe('');
    expect(noteLabel({ about: kept!.about, resolvedAt: null })).toBe('waiting for your OK');
  });

  it('offers Review while the proposal is open', () => {
    const open = note({ source: 'nebula', about: 'proposal', refs: [],
      actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_1', target: 'project', targetId: 'dusk' } }] });
    const controls = noteControls(open, { showLabel: 'Show on canvas' });
    expect(controls.state).toBeNull();
    expect(controls.buttons.map((b) => b.label)).toEqual(['Review']);
  });
});

describe('labels and time', () => {
  it('draws the header label from about (Nebula words, never the agent)', () => {
    expect(aboutLabel('sinceLastTurn')).toBe('since its last turn');
    expect(aboutLabel('suggestion')).toBe('Analyze');
    expect(aboutLabel('analyze')).toBe('Analyze · run done');
    expect(aboutLabel('removedLook')).toBe('Restore');
    expect(aboutLabel('changedWords')).toBe('Restore');
    expect(aboutLabel('proposal')).toBe('waiting for your OK');
    expect(aboutLabel('other')).toBe('');
  });

  it('shows the clock time today and adds the date on an earlier day', () => {
    const now = new Date(2026, 9, 20, 18, 0);
    expect(clockTime(new Date(2026, 9, 20, 12, 14).toISOString(), now)).toBe('12:14');
    expect(clockTime(new Date(2026, 9, 20, 9, 5).toISOString(), now)).toBe('09:05');
    expect(clockTime(new Date(2026, 9, 19, 16, 2).toISOString(), now)).toBe('Oct 19, 16:02');
    expect(clockTime('not a date', now)).toBe('');
  });

  it('gives each author a short dot label', () => {
    expect(authorInitials(AGENT)).toBe('C');
    expect(authorInitials({ ...AGENT, name: 'Agent' })).toBe('A');
    expect(authorInitials(ARGON)).toBe('Ar');
  });

  it('draws board numbers from parts, "(removed)" once the image is gone', () => {
    const board = note({
      text: '#12 reads as painterly.',
      parts: [{ ref: 'img12', number: 12 }, { text: ' reads as painterly and ' }, { ref: 'img9', number: null }],
    });
    expect(noteText(board)).toBe('#12 reads as painterly and (removed)');
    expect(noteText(note())).toBe('The upscaler is wired to the wrong image.');
  });
});

describe('unread', () => {
  it('counts an update as unread until it is read or dismissed', () => {
    expect(isUnread(note())).toBe(true);
    expect(isUnread(note({ readAt: '2026-10-20T12:15:00.000Z' }))).toBe(false);
    expect(isUnread(note({ dismissedAt: '2026-10-20T12:15:00.000Z' }))).toBe(false);
  });

  it('keys each surface (canvas by project, board by id)', () => {
    expect(surfaceKey({ kind: 'canvas', projectId: 'p1' })).toBe('canvas:p1');
    expect(surfaceKey({ kind: 'canvas', projectId: null })).toBe('canvas:');
    expect(surfaceKey({ kind: 'board', boardId: 'b7' })).toBe('board:b7');
  });
});

describe('buttons: edit actions first, then Show, two at most', () => {
  it('offers Show on canvas for an agent update with refs', () => {
    const controls = noteControls(note(), { showLabel: showLabel(note(), { surface: 'canvas' }) });
    expect(controls.buttons.map((b) => b.label)).toEqual(['Show on canvas']);
    expect(controls.state).toBeNull();
  });

  it('offers no Show without refs', () => {
    const plain = note({ refs: [] });
    expect(noteControls(plain, { showLabel: 'Show on canvas' }).buttons).toEqual([]);
  });

  it('names the image on a board when there is one, "on board" for more', () => {
    const one = note({ refs: ['img37'] });
    expect(showLabel(one, { surface: 'board', numberFor: () => 37 })).toBe('Show #37');
    expect(showLabel(note({ refs: ['a', 'b'] }), { surface: 'board', numberFor: () => 1 })).toBe('Show on board');
    expect(showLabel(one, { surface: 'board', numberFor: () => null })).toBe('Show on board');
  });

  it('puts edit actions first, and Show takes the second slot only when one is left', () => {
    const suggestion = note({
      source: 'nebula', author: ARGON, about: 'suggestion', refs: ['img12'],
      actions: [
        { label: 'Make frame', op: { kind: 'suggestion.accept', suggestionIds: ['s1'] } },
        { label: 'Not now', op: { kind: 'suggestion.dismiss', suggestionIds: ['s1'] } },
      ],
    });
    const full = noteControls(suggestion, { showLabel: 'Show #12' });
    expect(full.buttons.map((b) => b.label)).toEqual(['Make frame', 'Not now']);
    expect(full.buttons[0]).toMatchObject({ kind: 'action', primary: true });
    expect(offersNotNow(suggestion)).toBe(true);

    const run = note({
      source: 'nebula', author: ARGON, about: 'analyze', refs: ['img37'],
      actions: [{ label: 'Undo the sort', op: { kind: 'run.undo', boardId: 'b1', runId: 'r1' } }],
    });
    expect(noteControls(run, { showLabel: 'Show #37' }).buttons.map((b) => b.label)).toEqual(['Undo the sort', 'Show #37']);
    expect(offersNotNow(run)).toBe(false);
  });

  it("keeps a question Update's Answer after its card is dismissed; only the set's close greys it", () => {
    const asking = note({
      source: 'nebula', about: 'question', refs: [], dismissedAt: '2026-10-24T12:14:10.000Z',
      actions: [{ label: 'Answer', op: { kind: 'question.answer', questionId: 'qs_1' } }],
    });
    expect(noteDone(asking)).toBe(false);
    expect(noteControls(asking, { showLabel: 'Show' })).toEqual({
      state: null, buttons: [{ kind: 'action', label: 'Answer', action: asking.actions[0], primary: false }] });
    const closed = { ...asking, resolvedAt: '2026-10-24T12:15:00.000Z', outcome: 'Dismissed.' };
    expect(noteDone(closed)).toBe(true);
    expect(noteControls(closed, { showLabel: 'Show' }).state).toBe('Dismissed.');
  });

  it('greys a dismissed or acted update: its edit actions give way to its state, Show stays', () => {
    const base = note({
      source: 'nebula', author: ARGON, about: 'suggestion', refs: ['img12'],
      actions: [
        { label: 'Make frame', op: { kind: 'suggestion.accept', suggestionIds: ['s1'] } },
        { label: 'Not now', op: { kind: 'suggestion.dismiss', suggestionIds: ['s1'] } },
      ],
    });
    const dismissed = noteControls({ ...base, dismissedAt: '2026-10-20T12:20:00.000Z' }, { showLabel: 'Show #12' });
    expect(dismissed.state).toBe('Not now');
    expect(dismissed.buttons.map((b) => b.label)).toEqual(['Show #12']);
    expect(offersNotNow({ ...base, dismissedAt: '2026-10-20T12:20:00.000Z' })).toBe(false);

    const states: Array<[string, string]> = [
      ['Make frame', 'Frame made'], ['Add copies', 'Copies added'], ['Undo the move', 'Undone'],
      ['Undo the sort', 'Undone'], ['Restore', 'Restored'], ['Accept', 'Accepted'], ['Reject', 'Rejected'],
    ];
    for (const [label, state] of states) {
      const acted = { ...base, actedAt: '2026-10-20T12:20:00.000Z', actedWith: label };
      expect(noteControls(acted, { showLabel: 'Show #12' }).state).toBe(state);
    }
  });

  it('shows a stale action off with its reason, never as a button', () => {
    const proposal = note({
      source: 'nebula', about: 'proposal', refs: [],
      actions: [{ label: 'Accept', op: { kind: 'proposal.accept', proposalId: 'p9' } }],
    });
    const controls = noteControls(proposal, { showLabel: 'Show on canvas', actionState: () => 'Expired' });
    expect(controls.buttons).toEqual([]);
    expect(controls.state).toBe('Expired');
  });
});

describe('cornerRight: keep clear of the chat panel', () => {
  const viewport = { width: 1440, height: 900 };

  it('sits at the gutter while nothing is in the way', () => {
    expect(cornerRight(null, viewport, { top: 70, height: 300, width: 400 }, 16)).toBe(16);
    // Chat docked lower down, below the box: no move.
    const low = { left: 1084, right: 1424, top: 420, bottom: 860 };
    expect(cornerRight(low, viewport, { top: 70, height: 300, width: 400 }, 16)).toBe(16);
  });

  it('moves just left of the chat when its rect would meet the box', () => {
    const docked = { left: 1084, right: 1424, top: 74, bottom: 860 };
    expect(cornerRight(docked, viewport, { top: 70, height: 300, width: 400 }, 16)).toBe(1440 - 1084 + 8);
  });

  it('ignores a chat panel that sits wholly left of the box', () => {
    const dragged = { left: 200, right: 540, top: 40, bottom: 600 };
    expect(cornerRight(dragged, viewport, { top: 70, height: 300, width: 400 }, 16)).toBe(16);
  });

  it('never pushes the box off the left edge', () => {
    const wide = { left: 300, right: 1424, top: 40, bottom: 860 };
    expect(cornerRight(wide, viewport, { top: 70, height: 300, width: 400 }, 16)).toBe(1440 - 400 - 16);
  });
});

describe('roomBelow: stop above what sits under the list', () => {
  const box = { left: 893, right: 1264, top: 72 };

  it('stops above the proposal bar when they share columns', () => {
    const proposal = { left: 364, right: 916, top: 536, bottom: 642 };
    expect(roomBelow(box, [proposal], 720, 8)).toBe(536 - 8 - 72);
  });

  it('ignores what sits beside it or above its top', () => {
    const beside = { left: 100, right: 880, top: 300, bottom: 400 };
    const above = { left: 900, right: 1200, top: 24, bottom: 64 };
    expect(roomBelow(box, [beside, above], 720, 8)).toBe(720 - 8 - 72);
  });

  it('takes the nearest of several (the Agent log, the launcher)', () => {
    const log = { left: 924, right: 1264, top: 596, bottom: 640 };
    const launcher = { left: 1216, right: 1264, top: 648, bottom: 696 };
    expect(roomBelow(box, [launcher, log], 720, 8)).toBe(596 - 8 - 72);
  });
});
