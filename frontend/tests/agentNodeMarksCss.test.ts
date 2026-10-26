import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The agent's mark below 60% zoom (Q125 item 3; GM - Design, 2026-10-25:
 * "Low zoom: never hide it. Below 60% zoom, collapse to the dot alone at a
 * fixed screen size, so you can still find agents from the overview. The
 * name and status come back on hover."). The other agents' "+N" chip stays
 * (hidden, it would take them out of reach for hover, keyboard and screen
 * readers), and the words come back on keyboard focus as on hover.
 */
const css = readFileSync(join(__dirname, '../src/components/canvas/agentNodeMarks.css'), 'utf8');
/** A selector list split at its top-level commas (not those inside :is(...)). */
function selectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += char;
  }
  return [...parts, current.trim()];
}
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map(([, selector, body]) => ({ selectors: selectorList(selector), body }));

describe('the mark below 60% zoom', () => {
  it('never hides the +N chip', () => {
    const hiding = rules.filter((rule) => /display:\s*none/.test(rule.body))
      .flatMap((rule) => rule.selectors)
      .filter((selector) => selector.includes('agent-node-mark__more'));
    expect(hiding).toEqual([]);
  });

  it('hides the words only in the dot, never in the list of the others', () => {
    const hiding = rules.filter((rule) => /display:\s*none/.test(rule.body)).flatMap((rule) => rule.selectors)
      .filter((selector) => /__name|__status/.test(selector));
    expect(hiding.length).toBeGreaterThan(0);
    for (const selector of hiding) expect(selector).toMatch(/\.agent-node-mark__pill \.agent-node-mark__(name|status)$/);
  });

  it('brings the name and status back on keyboard focus as on hover', () => {
    const collapsed = rules.flatMap((rule) => rule.selectors)
      .filter((selector) => selector.startsWith(".agent-node-mark[data-collapsed='true'] .agent-node-mark__pill:"));
    expect(collapsed.length).toBeGreaterThan(0);
    for (const selector of collapsed) expect(selector).toMatch(/focus-visible/);
  });

  it('gives the focused dot a visible focus ring', () => {
    const focused = rules.find((rule) => rule.selectors.some((selector) =>
      selector.includes('.agent-node-mark__pill') && selector.includes(':focus-visible') && !selector.includes('__name')
      && !selector.includes('__status')) && /outline:/.test(rule.body));
    expect(focused).toBeDefined();
  });
});

describe('the pill at every zoom (GM - Design, 2026-10-25)', () => {
  const body = (selector: string) => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join('\n');

  it('counter-scales the row and the others\' list at every zoom, not only below 60%', () => {
    // "a FIXED screen size at every zoom ... always 22 px tall, never scaled with the canvas"
    expect(body('.agent-node-mark__row')).toMatch(/(^|[;\s])scale:\s*var\(--anm-scale/);
    expect(body('.agent-node-mark__others')).toMatch(/(^|[;\s])scale:\s*var\(--anm-scale/);
    // The 6 px gap is on screen too.
    expect(body('.agent-node-mark__row')).toMatch(/bottom:\s*calc\(6px \* var\(--anm-scale/);
  });

  it('never scales through `transform`, which the entrance keyframes replace while they run', () => {
    const scaling = rules.filter((rule) => /transform:\s*scale\(var\(--anm-scale/.test(rule.body));
    expect(scaling).toEqual([]);
  });
});

// Review 3, finding 8: the node's keyboard focus shows the pill's whole text
// (AgentNodeMarkLayer sets data-focused), so a sighted keyboard user can read
// a truncated status without a tab stop on every pill.
describe("the pill while its node has keyboard focus", () => {
  const body = (selector: string) => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join('\n');

  it('lifts the truncation at the node\'s width', () => {
    expect(body(".agent-node-mark[data-focused='true'] .agent-node-mark__row")).toMatch(/max-width:/);
    expect(body(".agent-node-mark[data-focused='true'] .agent-node-mark__status")).toMatch(/text-overflow:\s*clip/);
  });

  it('brings the words back on the low-zoom dot too', () => {
    const shown = rules.filter((rule) => /display:\s*inline/.test(rule.body)).flatMap((rule) => rule.selectors);
    expect(shown.some((selector) => selector.includes("[data-focused='true']") && selector.includes('__name'))).toBe(true);
    expect(shown.some((selector) => selector.includes("[data-focused='true']") && selector.includes('__status'))).toBe(true);
  });
});

// GM - Design, round 5 (2026-10-25), item 2: "Past 480 px, WRAP onto more
// lines instead of truncating (keyboard users have no other way to read the rest)."
describe('the focused pill past 480 px', () => {
  const body = (selector: string) => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join('\n');

  it('wraps its status onto more lines instead of cutting it', () => {
    const status = body(".agent-node-mark[data-focused='true'] .agent-node-mark__status");
    expect(status).toMatch(/white-space:\s*normal/);
    expect(status).not.toMatch(/text-overflow:\s*ellipsis/);
  });

  it('lets the pill grow taller than 22 px, up from the node, at most 480 px wide', () => {
    const pill = body(".agent-node-mark[data-focused='true'] .agent-node-mark__pill");
    expect(pill).toMatch(/height:\s*auto/);
    expect(pill).toMatch(/min-height:\s*22px/);
    expect(pill).toMatch(/white-space:\s*normal/);
    expect(body(".agent-node-mark[data-focused='true'] .agent-node-mark__row")).toMatch(/max-width:\s*max\(var\(--anm-max\),\s*480px\)/);
  });
});
