import { describe, expect, it } from 'vitest';
import { agentClearedLine, handoffFailedLine, type CutOffSave } from '../src/lib/savingCutOff';
import { CREATE_WHILE_FOLLOWING_HEADING, createWhileFollowingLine, followingReason, runWhileFollowingLine } from '../src/lib/canvasFollow';
import { FailureNotice, failureMessage } from '../src/lib/errorCopy';
import { deleteServerErrorLine } from '../src/lib/deleteCopy';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PR #195: the design lines, verbatim.
 * - a cut-off save names its node by id, so two nodes with the same
 *   title count as two.
 * - Design: the failed handoff's line, with non-breaking spaces inside
 *   the quoted project names.
 * - Design: a delete answered with a 500.
 * - Design: the run lines while following, and the Create line.
 */
const NBSP = ' ';

describe('cut-off saves count by node id', () => {
  const twin = (nodeId: string): CutOffSave => ({ nodeId, node: 'Text Input', setting: 'Text' });

  it('two nodes with the same title and setting are two changes', () => {
    expect(agentClearedLine([twin('n1'), twin('n2')], 'Codex'))
      .toBe('Codex cleared the canvas while you were editing 2 settings. Those changes weren’t saved.');
    expect(handoffFailedLine([twin('n1'), twin('n2')], 'Glass', 'Codex', 'Glass (recovered)'))
      .toBe(`Nebula couldn’t save 2 changes in “Glass” when Codex switched projects. Your edits were saved as a copy, “Glass${NBSP}(recovered)”.`);
  });

  it('the same node and setting twice is one change', () => {
    expect(agentClearedLine([twin('n1'), twin('n1')], 'Codex'))
      .toBe('Codex cleared the canvas while you were editing “Text” for “Text Input”. That change wasn’t saved.');
  });
});

describe('the failed handoff line keeps quoted project names whole', () => {
  it('non-breaking spaces inside the quoted names only', () => {
    expect(handoffFailedLine([{ nodeId: 'n1', node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', 'Claude Code',
      'Glass campaign (recovered 2)'))
      .toBe(`Nebula couldn’t save “Text” for “Hero prompt” in “Glass${NBSP}campaign” when Claude Code switched projects. `
        + `Your edits were saved as a copy, “Glass${NBSP}campaign${NBSP}(recovered${NBSP}2)”.`);
  });

  it('an unknown agent and an unnamed change', () => {
    expect(handoffFailedLine([], 'Glass campaign', null, 'Glass campaign (recovered)'))
      .toBe(`Nebula couldn’t save your last change in “Glass${NBSP}campaign” when an agent switched projects. `
        + `Your edits were saved as a copy, “Glass${NBSP}campaign${NBSP}(recovered)”.`);
  });
});

describe('a delete answered with a 500', () => {
  it('one node', () => {
    expect(deleteServerErrorLine(['Hero prompt'])).toBe(
      "Nebula couldn’t delete “Hero prompt” because the server hit an error, so it’s back on the canvas. Try again, and if it keeps happening, restart Nebula.");
  });
  it('two and three nodes are named; four and more are counted', () => {
    expect(deleteServerErrorLine(['A', 'B'])).toBe(
      "Nebula couldn’t delete “A” and “B” because the server hit an error, so they’re back on the canvas. Try again, and if it keeps happening, restart Nebula.");
    expect(deleteServerErrorLine(['A', 'B', 'C'])).toBe(
      "Nebula couldn’t delete “A”, “B” and “C” because the server hit an error, so they’re back on the canvas. Try again, and if it keeps happening, restart Nebula.");
    expect(deleteServerErrorLine(['A', 'B', 'C', 'D'])).toBe(
      "Nebula couldn’t delete 4 nodes because the server hit an error, so they’re back on the canvas. Try again, and if it keeps happening, restart Nebula.");
  });
});

describe('the run lines and Create line while following', () => {
  it('a whole-canvas run, one node, several nodes, an unknown agent', () => {
    expect(runWhileFollowingLine(null, 'Codex', 'Second canvas')).toBe("Nebula couldn’t run the canvas because Codex is opening “Second canvas”.");
    expect(runWhileFollowingLine('Hero', 'Codex', 'Second canvas')).toBe("Nebula couldn’t run “Hero” because Codex is opening “Second canvas”.");
    expect(runWhileFollowingLine(null, 'Codex', 'Second canvas', 3)).toBe("Nebula couldn’t run 3 nodes because Codex is opening “Second canvas”.");
    expect(runWhileFollowingLine(null, null, 'Second canvas', 2)).toBe("Nebula couldn’t run 2 nodes because an agent is opening “Second canvas”.");
  });

  it('Create says it in its own error style, never "Nebula is opening another project." bare', () => {
    expect(createWhileFollowingLine({ agent: 'Codex', projectName: 'Second canvas' }))
      .toBe("Nebula couldn’t start the generation because Codex is opening “Second canvas”.");
    expect(createWhileFollowingLine({ agent: null, projectName: 'Second canvas' }))
      .toBe("Nebula couldn’t start the generation because an agent is opening “Second canvas”.");
    expect(createWhileFollowingLine(null)).toBe("Nebula couldn’t start the generation because another project is opening.");
  });

  it("Create's own error style shows that same line (the store rejects with a FailureNotice under Create's heading)", () => {
    const following = { agent: 'Codex', projectName: 'Second canvas' };
    const refusal = new FailureNotice(CREATE_WHILE_FOLLOWING_HEADING, followingReason(following));
    expect(failureMessage(refusal, CREATE_WHILE_FOLLOWING_HEADING)).toBe(createWhileFollowingLine(following));
  });
});

describe('the cursor pill\'s hairline', () => {
  it('1px, white at about 12%, inset so the pill keeps its height', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    const rule = /\.agent-cursor__say\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/box-shadow:\s*inset 0 0 0 1px rgb\(255 255 255 \/ 0\.12\)/);
    expect(rule).not.toMatch(/\bborder:/);
  });
});
