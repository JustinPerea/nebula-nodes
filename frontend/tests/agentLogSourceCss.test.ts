// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Design: the agent log's source name is light ink by default, green on a graph row and light on a
// system row; an agent row sets its own name colour inline. jsdom has no cascade across
// custom properties worth trusting here, so this pins the rules.
const css = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`body.app-slava-restraint ${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('agent log source name colour', () => {
  it('falls back to the light ink, not meta ink', () => {
    expect(rule('.agent-log__source')).toMatch(/color:\s*var\(--agent-log-name-color,\s*var\(--sr-ink-light\)\)/);
  });

  it('keeps a graph row green', () => {
    expect(rule('.agent-log__entry--graph')).toMatch(/--agent-log-name-color:\s*var\(--sr-success\)/);
  });

  it('reads a system row as light ink, name and dot', () => {
    const body = rule('.agent-log__entry--system');
    expect(body).toMatch(/--agent-log-source-color:\s*var\(--sr-ink-light\)/);
    expect(body).not.toMatch(/--agent-log-name-color/);
  });
});
