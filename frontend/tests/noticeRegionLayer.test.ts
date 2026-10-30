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
// Round 2: the region's own rules are in the startup entry, beside the region.
const regionCss = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8');
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
  it('sits above every panel, the Agent log, popovers, the Studios and (GM r25) every dialog\'s backdrop', () => {
    const notice = layer('notice');
    expect(notice).toBeGreaterThan(layer('panel'));
    expect(notice).toBeGreaterThan(layer('panel') + 2); // the floating Inspector
    expect(notice).toBeGreaterThan(layer('agent-log'));
    expect(notice).toBeGreaterThan(layer('settings'));
    expect(notice).toBeGreaterThan(layer('popover'));
    expect(notice).toBeGreaterThan(layer('workspace'));
    // Settings over a Studio sits one above the workspace overlay (the chat panel's layer there).
    expect(notice).toBeGreaterThan(layer('workspace-overlay') + 1);
    // GM r25 (PR #200 fix round 16): notices stay above any dialog's backdrop,
    // the token modals and every raw z-index in the app's sheets alike (the
    // World viewer's backdrop is 20000).
    expect(notice).toBeGreaterThan(layer('modal-control'));
    const sheets = import.meta.glob('../src/**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const raw = Object.values(sheets).flatMap((css) => [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
    expect(Math.max(...raw)).toBeLessThan(notice);
  });

  it('the region is fixed on that layer and takes no pointer events itself', () => {
    const region = rule(regionCss, '.notice-region');
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

  it('the project-switch toast (raw z 60, not a modal) no longer places itself: it is in the stack', () => {
    // Review, 2026-10-23: at a fixed bottom 96px it sat over a notice's
    // buttons; round 2 (GM: "One region, one stack, and nothing else draws
    // toasts") puts it in the region's stack (tests/noticeRegionStack.test.tsx).
    const toast = rule(switchToast, '.project-switch-toast');
    expect(toast).not.toMatch(/position:\s*fixed/);
    expect(toast).not.toMatch(/z-index/);
    expect(toast).not.toMatch(/\bbottom:/);
  });

  it('the proposal bar has no panel of its own: it is in the stack, above the notices', () => {
    // Round 2 (GM: "move the proposal bar into the region, stacked above the notices").
    expect(notices).not.toMatch(/\n\.proposal-bar-panel\s*\{/);
  });
});
