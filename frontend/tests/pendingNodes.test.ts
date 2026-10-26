import { describe, expect, it } from 'vitest';
import { cleanPending, pendingIncludedLine, pendingSkipLine, placeholderLine, runSkips, skipSummaryOf } from '../src/lib/pendingNodes';

// Placeholders (Q125 item 3). GM - Design, 2026-10-25, verbatim:
// "A line in the preview area: “Codex is setting this up.”"
// "Run skip line. One node: “Skipped 1 node Codex is still setting up.”
//  Several: “Skipped 3 nodes the agents are still setting up.” (count downstream too; round 12)"

const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: false }, at: 1 };

describe('cleanPending', () => {
  it('keeps a well-formed flag', () => {
    expect(cleanPending(codex)).toEqual(codex);
  });

  it('drops anything else, so a malformed flag draws a normal node', () => {
    for (const raw of [undefined, null, true, 'Codex', { agent: 'Codex' },
      { agent: { id: 'x', name: 'X', color: 'red' } }, { agent: { id: '', name: 'X', color: '#112233' } }]) {
      expect(cleanPending(raw)).toBeNull();
    }
  });
});

describe('the copy', () => {
  it("says whose placeholder it is in the preview", () => {
    expect(placeholderLine('Codex')).toBe('Codex is setting this up.');
  });

  it('says how many nodes Run skipped, naming the agent for one', () => {
    expect(pendingSkipLine({ count: 1, agents: ['Codex'] })).toBe('Skipped 1 node Codex is still setting up.');
    expect(pendingSkipLine({ count: 3, agents: ['Codex', 'Claude Code'] })).toBe('Skipped 3 nodes the agents are still setting up.');
    // GM, 2026-10-25: name the agent when every skipped node is one agent's.
    expect(pendingSkipLine({ count: 3, agents: ['Codex'] })).toBe('Skipped 3 nodes Codex is still setting up.');
    expect(pendingSkipLine(null)).toBeNull();
    expect(pendingSkipLine({ count: 0, agents: [] })).toBeNull();
  });
});

describe('the cost line before the person runs placeholders (GM - Design, 2026-10-25)', () => {
  it('says how many nodes the run includes that an agent is still setting up', () => {
    expect(pendingIncludedLine({ count: 2, agents: ['Codex'] })).toBe('Includes 2 nodes Codex is still setting up.');
    expect(pendingIncludedLine({ count: 1, agents: ['Codex'] })).toBe('Includes 1 node Codex is still setting up.');
    expect(pendingIncludedLine({ count: 3, agents: ['Codex', 'Claude Code'] })).toBe('Includes 3 nodes the agents are still setting up.');
    expect(pendingIncludedLine(null)).toBeNull();
  });
});

describe('runSkips (the backend pending_nodes.run_skips, mirrored for the cost shown before Run)', () => {
  const claude = { agent: { id: 'claude', name: 'Claude Code', color: '#D97757', verified: true }, at: 1 };
  const flags: Record<string, unknown> = { p: codex, q: claude };
  const pendingOf = (id: string) => cleanPending(flags[id]);
  // p (Codex) -> a -> b; q (Claude Code) -> c; free stands alone.
  const edges = [{ source: 'p', target: 'a' }, { source: 'a', target: 'b' }, { source: 'q', target: 'c' }];

  it('skips each placeholder in scope and everything downstream of it, counted toward its agent', () => {
    const skips = runSkips(['p', 'a', 'b', 'free'], edges, pendingOf);
    expect([...skips.keys()].sort()).toEqual(['a', 'b', 'p']);
    expect(skips.get('b')).toEqual({ agent: codex.agent, root: 'p' });
    expect(skipSummaryOf(skips)).toEqual({ count: 3, agents: ['Codex'] });
  });

  it('names every agent when the skips come from more than one', () => {
    const skips = runSkips(['p', 'a', 'b', 'q', 'c'], edges, pendingOf);
    expect(skipSummaryOf(skips)).toEqual({ count: 5, agents: ['Codex', 'Claude Code'] });
  });

  it('counts the placeholders a run makes ready as normal, and only follows wires inside the scope', () => {
    expect(runSkips(['p', 'a', 'b'], edges, pendingOf, ['p']).size).toBe(0);
    expect([...runSkips(['a', 'b'], edges, pendingOf).keys()]).toEqual([]);
    expect(skipSummaryOf(new Map())).toBeNull();
  });
});
