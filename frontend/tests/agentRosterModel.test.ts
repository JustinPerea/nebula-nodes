/**
 * The Agents panel's rows (Q125 item 2), derived from what the stores already
 * hold: status lines (the roster store), cursors (agentPresenceStore and the
 * roster read), open question sets and proposals (their own stores). GM -
 * Design's copy, 2026-10-25, verbatim.
 */
import { describe, expect, it } from 'vitest';
import { needsYouCount } from '../src/components/agent-notes/agentNeedsYou';
import {
  agoLine,
  buildRosterRows,
  countLine,
  type RosterCursor,
  type RosterInput,
  type RosterStatus,
} from '../src/components/agent-notes/agentRosterModel';
import type { QuestionSetView } from '../src/lib/agentQuestions';
import type { ProposalView } from '../src/lib/wsClient';
import type { AssetProposalView } from '../src/lib/assetProposals';

const NOW = 1_800_000_000_000;
const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };
const CODEX = { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true };
const GEMINI = { id: 'ext:gemini', name: 'Gemini', color: '#F2C14E', verified: false };

const LABELS: Record<string, string> = { n4: 'Hero shots', n7: 'Upscale' };

function input(overrides: Partial<RosterInput> = {}): RosterInput {
  return {
    projectId: 'p1', now: NOW, statuses: [], cursors: [], questions: [], canvasProposals: [], assetProposals: [],
    nodeLabel: (id) => LABELS[id] ?? null, ...overrides,
  };
}

function status(agent = CODEX, overrides: Partial<RosterStatus> = {}): RosterStatus {
  return { agent, text: 'Rendering three hero crops', nodeId: 'n4', projectId: 'p1', at: NOW - 30_000, ...overrides };
}

function cursor(agent = CODEX, overrides: Partial<RosterCursor> = {}): RosterCursor {
  return { agent, nodeId: 'n4', did: { verb: 'Moved', nodeId: 'n4', label: 'Old name' }, projectId: 'p1',
    at: NOW - 120_000 + 1_000, ...overrides };
}

function questions(agent = CLAUDE, overrides: Partial<QuestionSetView> = {}): QuestionSetView {
  return {
    id: 'qs_1', status: 'open', agent, note: null, projectId: 'p1', nodeIds: [], createdAt: NOW - 90_000,
    closedAt: null, answers: null, update: { id: 'u_q', projectId: 'p1' },
    questions: [{ id: 'q1', text: 'Which crop?', options: [], multiple: false, allowText: true }],
    ...overrides,
  } as QuestionSetView;
}

function proposal(agent = CLAUDE, overrides: Partial<ProposalView> = {}): ProposalView {
  return { id: 'p_1', status: 'open', agent, note: 'n', projectId: 'p1', createdAt: NOW - 60_000,
    expiresAt: NOW + 600_000, nodes: [], edges: [], params: [], run: [], references: [],
    ...overrides } as unknown as ProposalView;
}

function asset(agent = CLAUDE, overrides: Partial<AssetProposalView> = {}): AssetProposalView {
  return { id: 'pa_1', status: 'open', agent, note: 'n', kind: 'moodboard',
    target: { kind: 'moodboard', id: 'b1', name: 'Dusk' }, createdAt: NOW - 30_000, expiresAt: NOW + 600_000,
    update: { id: 'u_a', projectId: 'p1' }, ...overrides } as unknown as AssetProposalView;
}

describe("GM's count line and time", () => {
  it('counts questions and proposals', () => {
    expect(countLine({ questions: 1, proposals: 0 })).toBe('1 question');
    expect(countLine({ questions: 2, proposals: 0 })).toBe('2 questions');
    expect(countLine({ questions: 0, proposals: 1 })).toBe('1 proposal');
    expect(countLine({ questions: 0, proposals: 2 })).toBe('2 proposals');
    expect(countLine({ questions: 1, proposals: 1 })).toBe('1 question, 1 proposal');
  });

  it('says just now under a minute, then minutes', () => {
    expect(agoLine(59_000)).toBe('just now');
    expect(agoLine(60_000)).toBe('1 min ago');
    expect(agoLine(150_000)).toBe('2 min ago');
  });
});

describe('the rows', () => {
  it('puts agents with open questions or proposals in Needs you, longest wait first, and everyone else in Working', () => {
    const rows = buildRosterRows(input({
      statuses: [status(CODEX), status(CLAUDE, { text: 'Also working' })],
      questions: [questions(CLAUDE)],
      canvasProposals: [proposal(GEMINI, { createdAt: NOW - 200_000 }), proposal(CLAUDE, { id: 'p_2' })],
      assetProposals: [asset(CLAUDE)],
    }));
    expect(rows.map((row) => [row.agent.name, row.group])).toEqual([
      ['Gemini', 'needsYou'], ['Claude Code', 'needsYou'], ['Codex', 'working'],
    ]);
    const claude = rows[1];
    expect(claude.counts).toEqual({ questions: 1, proposals: 2 });
    expect(claude.countLine).toBe('1 question, 2 proposals');
    // Needs you even while it has a status; the status shows on its own line.
    expect(claude.line).toBe('Also working');
  });

  it('counts only the open project', () => {
    const rows = buildRosterRows(input({
      statuses: [status(CODEX, { projectId: 'p2' })],
      cursors: [cursor(GEMINI, { projectId: 'p2' })],
      questions: [questions(CLAUDE, { projectId: 'p2' })],
      canvasProposals: [proposal(CLAUDE, { projectId: 'p2' })],
      assetProposals: [asset(CLAUDE, { update: { id: 'u', projectId: 'p2' } })],
    }));
    expect(rows).toEqual([]);
  });

  it('leaves out closed sets and proposals', () => {
    const rows = buildRosterRows(input({
      questions: [questions(CLAUDE, { status: 'answered' })],
      canvasProposals: [proposal(CLAUDE, { status: 'accepted' } as Partial<ProposalView>)],
    }));
    expect(rows).toEqual([]);
  });

  it("a Working row shows its status, flies to the status node, and says GM's tooltip and name", () => {
    const [row] = buildRosterRows(input({ statuses: [status(CODEX)], cursors: [cursor(CODEX, { nodeId: 'n7' })] }));
    expect(row.line).toBe('Rendering three hero crops');
    expect(row.statusText).toBe('Rendering three hero crops');
    expect(row.flyTo).toBe('n4');
    expect(row.tooltip).toBe('Show on canvas');
    expect(row.ariaLabel).toBe('Codex, Rendering three hero crops. Show on canvas');
  });

  it("with no status: the last action on the node's label in curly quotes, a dot, the time", () => {
    const [row] = buildRosterRows(input({ cursors: [cursor(CODEX, { at: NOW - 125_000 + 10_000 })] }));
    expect(row.line).toBe('Moved “Hero shots” · 1 min ago');
    expect(row.statusText).toBeNull();
    const [fresh] = buildRosterRows(input({ cursors: [cursor(CODEX, { at: NOW - 5_000 })] }));
    expect(fresh.line).toBe('Moved “Hero shots” · just now');
  });

  it("names a deleted node by the name it had, a node with no label by its type, and flies to the cursor's node", () => {
    const [gone] = buildRosterRows(input({
      cursors: [cursor(CODEX, { nodeId: 'n7', did: { verb: 'Removed', nodeId: null, label: 'Hero shots' }, at: NOW - 5_000 })],
    }));
    expect(gone.line).toBe('Removed “Hero shots” · just now');
    expect(gone.flyTo).toBe('n7');
    const [typed] = buildRosterRows(input({
      cursors: [cursor(CODEX, { nodeId: 'n7', did: { verb: 'Ran', nodeId: 'n7', label: 'Upscale' }, at: NOW - 5_000 })],
      nodeLabel: (id) => (id === 'n7' ? 'Upscale' : null),
    }));
    expect(typed.line).toBe('Ran “Upscale” · just now');
  });

  it('a Working row with no place on the canvas is not a button and has no tooltip', () => {
    const [row] = buildRosterRows(input({ statuses: [status(CODEX, { nodeId: null })] }));
    expect(row.flyTo).toBeNull();
    expect(row.tooltip).toBeNull();
    expect(row.ariaLabel).toBeNull();
    // A node that left the canvas is no place either.
    const [stale] = buildRosterRows(input({ statuses: [status(CODEX, { nodeId: 'n99' })] }));
    expect(stale.flyTo).toBeNull();
  });

  it('a cursor past two minutes is gone', () => {
    expect(buildRosterRows(input({ cursors: [cursor(CODEX, { at: NOW - 121_000 })] }))).toEqual([]);
  });

  it("Needs you rows: GM's tooltips, oldest first for Open next, and the count line in the name", () => {
    const [both] = buildRosterRows(input({ questions: [questions(CLAUDE)], canvasProposals: [proposal(CLAUDE)] }));
    expect(both.tooltip).toBe('Open next');
    expect(both.next).toEqual({ kind: 'questions', setId: 'qs_1', createdAt: NOW - 90_000 });
    expect(both.ariaLabel).toBe('Claude Code, unverified, 1 question, 1 proposal. Open next');
    const [older] = buildRosterRows(input({
      questions: [questions(CLAUDE)], canvasProposals: [proposal(CLAUDE, { createdAt: NOW - 100_000 })],
    }));
    expect(older.next).toEqual({ kind: 'proposal', proposalId: 'p_1', target: 'canvas', targetId: null,
      createdAt: NOW - 100_000 });
    const [onlyQuestions] = buildRosterRows(input({ questions: [questions(CLAUDE)] }));
    expect(onlyQuestions.tooltip).toBe('Open questions');
    const [onlyProposal] = buildRosterRows(input({ assetProposals: [asset(CODEX)] }));
    expect(onlyProposal.tooltip).toBe('Open proposal');
    expect(onlyProposal.ariaLabel).toBe('Codex, 1 proposal. Open proposal');
    expect(onlyProposal.next).toEqual({ kind: 'proposal', proposalId: 'pa_1', target: 'moodboard', targetId: 'b1',
      createdAt: NOW - 30_000 });
  });

  it("after a restart, no status: GM's waiting lines (the answer line when it has both)", () => {
    const [answer] = buildRosterRows(input({ questions: [questions(CLAUDE)], canvasProposals: [proposal(CLAUDE)] }));
    expect(answer.line).toBe('Waiting for your answer.');
    const [ok] = buildRosterRows(input({ canvasProposals: [proposal(CLAUDE)] }));
    expect(ok.line).toBe('Waiting for your OK.');
  });

  it('counts the questions in each set, as the Update under it does (review)', () => {
    const two = [
      { id: 'q1', text: 'Which crop?', options: [], multiple: false, allowText: true },
      { id: 'q2', text: 'Anything to avoid?', options: [], multiple: false, allowText: true },
    ] as QuestionSetView['questions'];
    const [row] = buildRosterRows(input({ questions: [questions(CLAUDE, { questions: two })] }));
    expect(row.counts).toEqual({ questions: 2, proposals: 0 });
    expect(row.countLine).toBe('2 questions');
    expect(row.ariaLabel).toBe('Claude Code, unverified, 2 questions. Open questions');
    // Two sets of one and two questions: three questions, opened oldest set first.
    const [both] = buildRosterRows(input({
      questions: [questions(CLAUDE), questions(CLAUDE, { id: 'qs_2', questions: two, createdAt: NOW - 10_000 })],
    }));
    expect(both.countLine).toBe('3 questions');
    expect(both.next).toEqual({ kind: 'questions', setId: 'qs_1', createdAt: NOW - 90_000 });
  });

  it('an asset proposal with no Update counts in the open project, as the roster read does (review)', () => {
    const board = asset(CODEX, { update: null });
    const cover = asset(GEMINI, { id: 'pa_2', kind: 'project', target: { kind: 'project', id: 'p9', name: 'Other' },
      update: null } as Partial<AssetProposalView>);
    const rows = buildRosterRows(input({ assetProposals: [board, cover] }));
    expect(rows.map((row) => [row.agent.name, row.countLine])).toEqual([['Codex', '1 proposal'], ['Gemini', '1 proposal']]);
    // One whose Update went to another project stays there.
    expect(buildRosterRows(input({ assetProposals: [asset(CODEX, { update: { id: 'u', projectId: 'p2' } })] })))
      .toEqual([]);
  });

  it('Needs you: the longest wait first even when the waits are milliseconds apart (review)', () => {
    const rows = buildRosterRows(input({
      questions: [questions(CLAUDE, { createdAt: NOW - 60_000 + 30 })],
      canvasProposals: [proposal(GEMINI, { createdAt: NOW - 60_000 })],
    }));
    expect(rows.map((row) => row.agent.name)).toEqual(['Gemini', 'Claude Code']);
  });

  it('an unverified Working agent says so after its name', () => {
    const [row] = buildRosterRows(input({ statuses: [status(GEMINI)] }));
    expect(row.ariaLabel).toBe('Gemini, unverified, Rendering three hero crops. Show on canvas');
  });

  it('Working: most recent activity first', () => {
    const rows = buildRosterRows(input({
      statuses: [status(CODEX, { at: NOW - 50_000 }), status(GEMINI, { at: NOW - 10_000 })],
      cursors: [cursor(CODEX, { at: NOW - 1_000 })],
    }));
    expect(rows.map((row) => row.agent.name)).toEqual(['Codex', 'Gemini']);
  });
});

// GM - Design's review of PR #193.
describe("GM's review: Needs-you lines, the action's own time, the chip's count", () => {
  it('a Needs-you row never shows a pointer action, live cursor or not: its status, else the waiting line', () => {
    const looked = cursor(CLAUDE, { at: NOW - 2_000, did: { verb: 'Looked at', nodeId: 'n4', label: 'Hero shots' } });
    const [answer] = buildRosterRows(input({ questions: [questions(CLAUDE)], cursors: [looked] }));
    expect(answer.line).toBe('Waiting for your answer.');
    const [ok] = buildRosterRows(input({ canvasProposals: [proposal(CLAUDE)], cursors: [looked] }));
    expect(ok.line).toBe('Waiting for your OK.');
    const [both] = buildRosterRows(input({
      questions: [questions(CLAUDE)], canvasProposals: [proposal(CLAUDE)], cursors: [looked],
    }));
    expect(both.line).toBe('Waiting for your answer.');
    const [said] = buildRosterRows(input({
      questions: [questions(CLAUDE)], cursors: [looked], statuses: [status(CLAUDE, { text: 'Blocked on the crop' })],
    }));
    expect(said.line).toBe('Blocked on the crop');
  });

  it("the action line says when the action happened, not when the cursor last moved", () => {
    const [row] = buildRosterRows(input({ cursors: [cursor(CODEX, {
      at: NOW - 2_000, did: { verb: 'Renamed', nodeId: 'n4', label: 'Old', at: NOW - 95_000 },
    })] }));
    expect(row.line).toBe('Renamed “Hero shots” · 1 min ago');
  });

  it('a Working agent with no status and no action: just the name, a button only when its cursor is on a node', () => {
    const [spot] = buildRosterRows(input({ cursors: [cursor(CODEX, { nodeId: null, did: null, at: NOW - 1_000 })] }));
    expect(spot.group).toBe('working');
    expect(spot.line).toBe('');
    expect(spot.tooltip).toBeNull();
    expect(spot.ariaLabel).toBeNull();
    const [onNode] = buildRosterRows(input({ cursors: [cursor(CODEX, { nodeId: 'n7', did: null, at: NOW - 1_000 })] }));
    expect(onNode.line).toBe('');
    expect(onNode.ariaLabel).toBe('Codex. Show on canvas');
  });

  it("the chip's count is the panel's Needs-you group, agent for agent", () => {
    const mixed = input({
      statuses: [status(CODEX)],
      questions: [questions(CLAUDE), questions(GEMINI, { id: 'qs_2', projectId: 'p2' }),
        questions(CODEX, { id: 'qs_3', status: 'answered' })],
      canvasProposals: [proposal(GEMINI, { id: 'p_9' }), proposal(CLAUDE, { id: 'p_2' })],
      assetProposals: [asset(CODEX, { update: null }), asset(GEMINI, { id: 'pa_2', update: { id: 'u', projectId: 'p2' } })],
    });
    const rows = buildRosterRows(mixed);
    const group = rows.filter((row) => row.group === 'needsYou').length;
    expect(group).toBe(3);
    expect(needsYouCount(mixed)).toBe(group);
    expect(needsYouCount(input())).toBe(0);
  });
});
