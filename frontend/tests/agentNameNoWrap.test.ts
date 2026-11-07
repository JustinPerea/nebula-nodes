import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM, PR #203 r11 item 6: an agent's name never wraps ("Claude Code" stays
 * on one line beside "proposes" and the pager), through one shared style,
 * styles/agent-name.css. jsdom lays nothing out, so this pins the rule and
 * every place an agent's name is drawn carrying it; the 1280 px shot of the
 * bar shows it on screen.
 */
const root = resolve(__dirname, '../src');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('agent names never wrap (GM, PR #203 r11 item 6)', () => {
  it('the shared rule: no wrap, never shrunk, a very long name ends in an ellipsis', () => {
    const css = read('styles/agent-name.css');
    const rule = css.match(/\.agent-name\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/flex-shrink:\s*0/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(read('App.tsx')).toMatch(/import '\.\/styles\/agent-name\.css';/);
  });

  it('the proposal bar\'s name never wraps: it takes what is left of the line and truncates (main\'s #216 head)', () => {
    const css = read('styles/canvasProposals.css');
    const rule = css.match(/\n\.proposal-bar__agent \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(read('components/canvas/ProposalBar.tsx')).toMatch(/className="proposal-bar__agent" title=\{current\.view\.agent\.name\}/);
  });

  // Each place a name is drawn, and the expression it draws.
  const sites: Array<[string, string]> = [
    // Not here: the proposal bar's head and the cursor's tag shrink their names by main's own
    // mechanism (the test above; agentCursor.css), and the deferred-run notice no longer names the agent.
    ['components/canvas/ProposalLayer.tsx', 'agentName'],
    ['components/canvas/AgentNodeMarkLayer.tsx', 'first.agent.name'],
    ['components/canvas/AgentNodeMarkLayer.tsx', 'mark.agent.name'],
    ['components/canvas/PinLayer.tsx', 'pin.reply.agent.name'],
    ['components/agent-notes/AgentRoster.tsx', 'row.agent.name'],
    ['components/agent-notes/AgentNotesList.tsx', 'note.author.name'],
    ['components/agent-notes/AgentNoteCard.tsx', 'note.author.name'],
    ['components/agent-notes/AgentQuestionsForm.tsx', 'view.agent.name'],
    ['components/proposals/AssetProposalStrip.tsx', 'view.agent.name'],
    ['components/proposals/AssetProposalStrip.tsx', 'held.agentName'],
    ['components/panels/PermissionCard.tsx', 'agentName'],
    ['components/panels/settings/AgentSpendSection.tsx', 'agent.name'],
  ];
  for (const [file, expression] of sites) {
    // GM, PR #203 r14 item 5: a name cut at 16em keeps the full name in its
    // title (on hover) and aria-label (read out), at every place it is drawn.
    it(`${file}: {${expression}} sits in a span with the agent-name class, its full name in title and aria-label`, () => {
      const escaped = expression.replace(/\./g, '\\.');
      const drawn = new RegExp(`<span className="[^"]*\\bagent-name\\b[^"]*" title=\\{${escaped}\\} `
        + `aria-label=\\{${escaped}\\}>\\{${escaped}\\}</span>`);
      expect(read(file)).toMatch(drawn);
    });
  }

  it('no other place draws the agent-name class without its full name', () => {
    const files = Object.keys(import.meta.glob('../src/**/*.tsx', { eager: false }));
    const bare = files.flatMap((file) => {
      const text = readFileSync(resolve(__dirname, file), 'utf8');
      return [...text.matchAll(/<span className="[^"]*\bagent-name\b[^"]*"([^>]*)>/g)]
        .filter((match) => !/title=\{/.test(match[1]) || !/aria-label=\{/.test(match[1]))
        .map(() => file);
    });
    expect(bare).toEqual([]);
    const drawn = files.reduce((count, file) => count
      + (readFileSync(resolve(__dirname, file), 'utf8').match(/\bagent-name\b"/g) ?? []).length, 0);
    expect(drawn).toBe(sites.length);
  });
});
