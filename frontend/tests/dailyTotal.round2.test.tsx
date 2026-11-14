import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * PR #212 round 2, GM - Design's review (2026-10-31), built verbatim:
 * the usage line on its own line with the meter right under it in the text
 * column, the new help, and the "Same as chats" select under its help. The
 * waiting band on the node card is in dailyTotal.review1.test.tsx (GM moved
 * the tag inside the card, replacing the overlay).
 */

const { DailyTotalRow } = await import('../src/components/panels/settings/DailyTotalRow');

const css = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');
/** One rule's declarations, by its exact selector. */
function rule(file: string, selector: string): string {
  const source = css(file);
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0);
  return source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at));
}

afterEach(cleanup);

describe('Settings: the Daily total row, GM round 2', () => {
  const row = (spentUsd: number | null, dailyTotalUsd?: number | null) => render(
    <DailyTotalRow limits={{ sessionUsd: null, models: {}, ...(dailyTotalUsd === undefined ? {} : { dailyTotalUsd }) }}
      spentUsd={spentUsd} disabled={false} onChange={() => {}} />);

  it('has the new help, without "Counts the last 24 hours."', () => {
    const { container } = row(0);
    expect(container.querySelector('#settings-agent-daily-help')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Agent chats, agents outside Nebula, scripts and tabs not opened from your link all count toward it. '
      + 'Your own runs don’t.');
    expect(container.textContent).not.toContain('Counts the last 24 hours');
  });

  it('gives the usage line its own line under the help, and the meter right under it in the text column', () => {
    const { container } = row(3.4);
    const text = container.querySelector('.settings-pref__text')!;
    const help = container.querySelector('#settings-agent-daily-help')!;
    const usage = screen.getByTestId('settings-agent-daily-spent');
    const meter = container.querySelector<HTMLElement>('[role="meter"]')!;
    // Not inside the help paragraph: its own line, the help's next sibling.
    expect(help.contains(usage)).toBe(false);
    expect(help.nextElementSibling).toBe(usage);
    expect(usage.textContent).toBe('$3.40 of $5 used in the last 24 hours.');
    // The meter: directly under the usage line, inside the text column (its width), not across the row.
    expect(usage.nextElementSibling).toBe(meter);
    expect(meter.parentElement).toBe(text);
    expect(meter.closest('.settings-pref')!.lastElementChild).not.toBe(meter);
  });

  it('draws a 2 px neutral meter on a track in the row\'s border tone, 8 px under the line', () => {
    const meter = rule('settings.css', 'body.app-slava-restraint .settings-daily__meter');
    expect(meter).toMatch(/height:\s*2px/);
    expect(meter).toMatch(/background:\s*var\(--sr-edge\)/);
    // 7 px plus the text column's 1 px row gap.
    expect(meter).toMatch(/margin-top:\s*7px/);
    expect(rule('settings.css', 'body.app-slava-restraint .settings-pref__text')).toMatch(/gap:\s*1px/);
    expect(meter).not.toMatch(/grid-column/);
    expect(rule('settings.css', 'body.app-slava-restraint .settings-daily__meter-fill')).toMatch(
      /background:\s*var\(--sr-ink-light\)/);
    // The usage line keeps the weight it had inside the help.
    const usage = rule('settings.css', 'body.app-slava-restraint .settings-daily__usage');
    expect(usage).toMatch(/font-size:\s*var\(--sr-type-label\)/);
    expect(usage).not.toMatch(/font-weight/);
  });

  it('puts a select that would be cut off under its help, at its own width', () => {
    expect(rule('settings.css', 'body.app-slava-restraint .settings-pref--stacked')).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule('settings.css', 'body.app-slava-restraint .settings__select--fits')).toMatch(/max-width:\s*100%/);
    // The width cap it lifts comes first, so the later rule wins.
    const source = css('settings.css');
    expect(source.indexOf('.settings__select--fits {')).toBeGreaterThan(source.indexOf('.settings__select--compact {'));
  });
});

