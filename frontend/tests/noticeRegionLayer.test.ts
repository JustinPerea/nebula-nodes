import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM - Design, 2026-10-23: notices go in "one app-level region above every
 * panel (above layer 10) ... A notice with an action never sits under
 * anything, and the region never takes pointer events outside its notices."
 * jsdom has no layout or stacking, so these pin the layer and the rules; the
 * live check looks at the screen.
 */
const tokens = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8');
const notices = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8');
const switchToast = readFileSync(join(__dirname, '../src/components/projects/ProjectSwitchToast.css'), 'utf8');

function layer(name: string): number {
  const match = tokens.match(new RegExp(`--sr-layer-${name}:\\s*(\\d+);`));
  expect(match, `missing --sr-layer-${name}`).not.toBeNull();
  return Number(match![1]);
}

function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('the notice layer', () => {
  it('sits above every panel, the Agent log, popovers and the Studios, below a blocking modal', () => {
    const notice = layer('notice');
    expect(notice).toBeGreaterThan(layer('panel'));
    expect(notice).toBeGreaterThan(layer('panel') + 2); // the floating Inspector
    expect(notice).toBeGreaterThan(layer('agent-log'));
    expect(notice).toBeGreaterThan(layer('settings'));
    expect(notice).toBeGreaterThan(layer('popover'));
    expect(notice).toBeGreaterThan(layer('workspace'));
    // Settings over a Studio sits one above the workspace overlay (the chat panel's layer there).
    expect(notice).toBeGreaterThan(layer('workspace-overlay') + 1);
    expect(notice).toBeLessThan(layer('modal'));
  });

  it('the region is fixed on that layer and takes no pointer events itself', () => {
    const region = rule(notices, '.notice-region');
    expect(region).toMatch(/position:\s*fixed/);
    expect(region).toMatch(/z-index:\s*var\(--sr-layer-notice/);
    expect(region).toMatch(/pointer-events:\s*none/);
    // Just above the bottom bar, read from where the bar really starts.
    expect(region).toMatch(/bottom:[^;]*var\(--bottom-bar-clearance/);
  });

  it('each notice takes pointer events', () => {
    expect(rule(notices, '.canvas-undo-notice')).toMatch(/pointer-events:\s*auto/);
    expect(rule(notices, '.proposal-bar')).toMatch(/pointer-events:\s*auto/);
  });

  it('there is one region: the Studio-only notice spot is gone', () => {
    expect(notices).not.toMatch(/\n\.studio-notice\s*\{/);
  });

  it('the project-switch toast (raw z 60, not a modal) stacks above the notices instead of covering them', () => {
    // Review, 2026-10-23: at a fixed bottom 96px it sat over a notice's buttons.
    const toast = rule(switchToast, '.project-switch-toast');
    expect(toast).not.toMatch(/bottom:\s*96px/);
    expect(toast).toMatch(/bottom:[^;]*var\(--bottom-bar-clearance/);
    expect(toast).toMatch(/bottom:[^;]*var\(--notice-stack-h/);
  });

  it('the proposal bar keeps clear of the notices instead of sharing a panel with them', () => {
    const panel = rule(notices, '.proposal-bar-panel');
    expect(panel).not.toMatch(/\bgap:/);
    expect(panel).toMatch(/margin-bottom:[^;]*var\(--notice-stack-h/);
  });
});
