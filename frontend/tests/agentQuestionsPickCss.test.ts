import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// GM - Design, 2026-10-24: the picked option uses a NEUTRAL ring for every
// agent: "the light ink ring with a faint fill, the same weight as now, just
// not the agent's color. The pick is the person's choice, not the agent's.
// And an orange agent would put orange on a selection." The agent's colour
// stays on the form's left edge and the author dot. jsdom has no layout, so
// this pins the rules; the live check looks at them.
const css = readFileSync(join(__dirname, '../src/components/agent-notes/agentNotes.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('a picked option in the answer form', () => {
  const picked = rule(".agent-questions-form__option[aria-pressed='true']");

  it('rings in the light ink, never the agent colour or the orange accent', () => {
    expect(picked).not.toMatch(/--an-author/);
    expect(picked).not.toMatch(/--sr-accent|255,\s*90,\s*31|#ff5a1f/i);
    expect(picked).toMatch(/border-color:\s*var\(--an-ink\)/);
    expect(picked).toMatch(/box-shadow:\s*0 0 0 1px var\(--an-ink\)/);
  });

  it('keeps a faint fill of the same ink', () => {
    expect(picked).toMatch(/background:\s*color-mix\(in srgb, var\(--an-ink\) \d+%, transparent\)/);
    const percent = Number(/var\(--an-ink\) (\d+)%/.exec(picked)?.[1]);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThanOrEqual(12);
  });

  it('leaves the agent colour on the form\'s left edge', () => {
    expect(rule('.agent-questions-form__head')).toMatch(/inset 4px 0 0 color-mix\(in srgb, var\(--an-author\)/);
  });
});
