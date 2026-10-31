import { describe, expect, it } from 'vitest';
import { agentClearedLine, handoffFailedLine, type CutOffSave } from '../src/lib/savingCutOff';
import { CREATE_WHILE_FOLLOWING_HEADING, createWhileFollowingLine, followingReason, runWhileFollowingLine } from '../src/lib/canvasFollow';
import { FailureNotice, failureMessage } from '../src/lib/errorCopy';
import { deleteServerErrorLine } from '../src/lib/deleteCopy';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Round 21 of PR #195: review 20's L-8 and GM's round 21 lines, verbatim.
 * - L-8: a cut-off save names its node by id, so two nodes with the same
 *   title count as two.
 * - GM (LOCKED): the failed handoff's line, with non-breaking spaces inside
 *   the quoted project names.
 * - GM (LOCKED): a delete answered with a 500.
 * - GM derived: the run lines while following, and G1's Create line.
 */
const NBSP = ' ';

describe('L-8: cut-off saves count by node id', () => {
  const twin = (nodeId: string): CutOffSave => ({ nodeId, node: 'Text Input', setting: 'Text' });

  it('two nodes with the same title and setting are two changes', () => {
    expect(agentClearedLine([twin('n1'), twin('n2')], 'Codex'))
      .toBe('Codex cleared the canvas while you were editing 2 settings. Those changes weren’t saved.');
    expect(handoffFailedLine([twin('n1'), twin('n2')], 'Glass', 'Codex', 'Glass (recovered)'))
      .toBe(`Couldn’t save 2 changes in “Glass” when Codex switched projects. Your edits were saved as a copy, “Glass${NBSP}(recovered)”.`);
  });

  it('the same node and setting twice is one change', () => {
    expect(agentClearedLine([twin('n1'), twin('n1')], 'Codex'))
      .toBe('Codex cleared the canvas while you were editing “Text” for “Text Input”. That change wasn’t saved.');
  });
});

describe('GM (LOCKED): the failed handoff line keeps quoted project names whole', () => {
  it('non-breaking spaces inside the quoted names only', () => {
    expect(handoffFailedLine([{ nodeId: 'n1', node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', 'Claude Code',
      'Glass campaign (recovered 2)'))
      .toBe(`Couldn’t save “Text” for “Hero prompt” in “Glass${NBSP}campaign” when Claude Code switched projects. `
        + `Your edits were saved as a copy, “Glass${NBSP}campaign${NBSP}(recovered${NBSP}2)”.`);
  });

  it('an unknown agent and an unnamed change', () => {
    expect(handoffFailedLine([], 'Glass campaign', null, 'Glass campaign (recovered)'))
      .toBe(`Couldn’t save your last change in “Glass${NBSP}campaign” when an agent switched projects. `
        + `Your edits were saved as a copy, “Glass${NBSP}campaign${NBSP}(recovered)”.`);
  });
});

describe('GM (LOCKED): a delete answered with a 500', () => {
  it('one node', () => {
    expect(deleteServerErrorLine(['Hero prompt'])).toBe(
      "Couldn't delete “Hero prompt”. Nebula ran into an error, so it's back on the canvas. Try again, and if it keeps happening, restart Nebula.");
  });
  it('two and three nodes are named; four and more are counted', () => {
    expect(deleteServerErrorLine(['A', 'B'])).toBe(
      "Couldn't delete “A” and “B”. Nebula ran into an error, so they're back on the canvas. Try again, and if it keeps happening, restart Nebula.");
    expect(deleteServerErrorLine(['A', 'B', 'C'])).toBe(
      "Couldn't delete “A”, “B” and “C”. Nebula ran into an error, so they're back on the canvas. Try again, and if it keeps happening, restart Nebula.");
    expect(deleteServerErrorLine(['A', 'B', 'C', 'D'])).toBe(
      "Couldn't delete 4 nodes. Nebula ran into an error, so they're back on the canvas. Try again, and if it keeps happening, restart Nebula.");
  });
});

describe('GM derived: runs and Create while following', () => {
  it('a whole-canvas run, one node, several nodes, an unknown agent', () => {
    expect(runWhileFollowingLine(null, 'Codex', 'Second canvas')).toBe("Couldn’t run the canvas. Codex is opening “Second canvas”.");
    expect(runWhileFollowingLine('Hero', 'Codex', 'Second canvas')).toBe("Couldn’t run “Hero”. Codex is opening “Second canvas”.");
    expect(runWhileFollowingLine(null, 'Codex', 'Second canvas', 3)).toBe("Couldn’t run 3 nodes. Codex is opening “Second canvas”.");
    expect(runWhileFollowingLine(null, null, 'Second canvas', 2)).toBe("Couldn’t run 2 nodes. An agent is opening “Second canvas”.");
  });

  it('G1: Create says it in its own error style, never "Nebula is opening another project." bare', () => {
    expect(createWhileFollowingLine({ agent: 'Codex', projectName: 'Second canvas' }))
      .toBe("Couldn't start the generation. Codex is opening “Second canvas”.");
    expect(createWhileFollowingLine({ agent: null, projectName: 'Second canvas' }))
      .toBe("Couldn't start the generation. An agent is opening “Second canvas”.");
    expect(createWhileFollowingLine(null)).toBe("Couldn't start the generation. Another project is opening.");
  });

  it("G1: Create's own error style shows that same line (the store rejects with a FailureNotice under Create's heading)", () => {
    const following = { agent: 'Codex', projectName: 'Second canvas' };
    const refusal = new FailureNotice(CREATE_WHILE_FOLLOWING_HEADING, followingReason(following));
    expect(failureMessage(refusal, CREATE_WHILE_FOLLOWING_HEADING)).toBe(createWhileFollowingLine(following));
  });
});

describe('GM round 21: the cursor pill\'s hairline', () => {
  it('1px, white at about 12%, inset so the pill keeps its height', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    const rule = /\.agent-cursor__say\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/box-shadow:\s*inset 0 0 0 1px rgb\(255 255 255 \/ 0\.12\)/);
    expect(rule).not.toMatch(/\bborder:/);
  });
});
