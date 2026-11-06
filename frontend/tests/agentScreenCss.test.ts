import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';

/** Phase 3 slice 5: the screen layer's stylesheet and the names the store keeps. */
const css = readFileSync(resolve(__dirname, '../src/styles/agentCursorAnywhere.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
};

describe('agentCursorAnywhere.css', () => {
  it('is a fixed, click-through box over the window and nothing in it takes a pointer event', () => {
    const layer = rule('.agent-screen-layer');
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/inset:\s*0/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(css).not.toMatch(/pointer-events:\s*(?:auto|all|fill|stroke|visible)/);
  });

  it('sits above the docks (55) and below modals (60) and the notice region (GM 5)', () => {
    expect(rule('.agent-screen-layer')).toMatch(/z-index:\s*calc\(var\(--sr-layer-modal, 60\) - 1\)/);
    const slava = readFileSync(resolve(__dirname, '../src/styles/slava-restraint.css'), 'utf8');
    const layer = (name: string) => Number(new RegExp(`--sr-layer-${name}:\\s*(\\d+)`).exec(slava)![1]);
    expect(layer('modal') - 1).toBeGreaterThan(layer('workspace-overlay'));
    expect(layer('modal') - 1).toBeGreaterThan(layer('workspace'));
    expect(layer('modal') - 1).toBeLessThan(layer('modal'));
    expect(layer('notice')).toBeGreaterThan(layer('modal'));
  });

  it('animates the outline in on a sampled spring, and snaps it under reduced motion', () => {
    expect(rule('.agent-item-outline')).toMatch(/animation:\s*agent-item-outline-in var\(--agent-cursor-soft\)/);
    expect(css).not.toMatch(/\bease(?:-in|-out|-in-out)?\b|cubic-bezier\(|steps\(/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.agent-item-outline\s*\{[^}]*animation:\s*none/);
  });

  it('the edge park\'s chevron is a 6 px mark in the agent colour, never a control, on the soft spring and still under reduced motion', () => {
    const chevron = rule('.agent-cursor__park-chevron');
    expect(chevron).toMatch(/width:\s*6px/);
    expect(chevron).toMatch(/height:\s*6px/);
    expect(chevron).toMatch(/stroke:\s*var\(--agent-color\)/);
    expect(chevron).toMatch(/pointer-events:\s*none/);
    expect(chevron).toMatch(/animation:[^;]*var\(--agent-cursor-soft\)/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.agent-cursor__park-chevron\s*\{[^}]*animation:\s*none/);
  });

  it('draws propose dashed and type solid', () => {
    expect(rule('.agent-item-outline')).toMatch(/border:\s*1\.5px solid var\(--agent-color\)/);
    expect(rule('.agent-item-outline[data-kind="dashed"]')).toMatch(/border-style:\s*dashed/);
  });
});

describe('the store keeps what a surface target is called', () => {
  const event = (over: Record<string, unknown>) => ({
    type: 'agentPresence', agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
    target: { surface: 'moodboard', itemId: 'b1/i3', part: 'note' }, action: 'type', say: '', at: 0, ...over,
  }) as never;

  it('stores anchorNames beside a surface target, cleaned', () => {
    useAgentPresenceStore.getState().clear();
    useAgentPresenceStore.getState().apply(event({ anchorNames: { board: 'Desert light', image: 3, part: 'Note', junk: 1 } }));
    expect(Object.values(useAgentPresenceStore.getState().agents)[0].anchorNames).toEqual({ board: 'Desert light', image: 3, part: 'Note' });
  });

  it('drops names with no board, and names beside a canvas target', () => {
    useAgentPresenceStore.getState().clear();
    useAgentPresenceStore.getState().apply(event({ anchorNames: { image: 3 } }));
    expect(Object.values(useAgentPresenceStore.getState().agents)[0].anchorNames).toBeUndefined();
    useAgentPresenceStore.getState().clear();
    useAgentPresenceStore.getState().apply(event({ target: { nodeId: 'n1' }, anchorNames: { board: 'Desert light' } }));
    expect(Object.values(useAgentPresenceStore.getState().agents)[0].anchorNames).toBeUndefined();
    useAgentPresenceStore.getState().clear();
  });

  it('the launcher dots are click-through marks that fade on the soft spring and stay still under reduced motion', () => {
    for (const name of ['.agent-launcher-dot', '.agent-launcher-dot__more']) expect(rule(name)).toMatch(/pointer-events:\s*none/);
    expect(rule('.agent-launcher-dot__more')).toMatch(/transition:[^;]*var\(--agent-cursor-soft\)/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.agent-launcher-dot,\s*\.agent-launcher-dot__more\s*\{[^}]*animation:\s*none/);
  });
});
