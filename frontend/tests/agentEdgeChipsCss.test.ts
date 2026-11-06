import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** PR #233 slice 9: the chip stylesheet's pointer-events ratchet (the plan's). */
const css = readFileSync(resolve(__dirname, '../src/styles/agentEdgeChips.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector list with the pointer-events value its block sets. */
const blocks = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.trim(), body,
}));

describe('agentEdgeChips.css', () => {
  it('only .agent-edge-chip takes pointer events', () => {
    const taking = blocks.filter((b) => /pointer-events:\s*(?!none)\S/.test(b.body));
    expect(taking.map((b) => b.selector)).toEqual(['.agent-edge-chip']);
    expect(taking[0].body).toMatch(/pointer-events:\s*auto/);
  });

  it('the box they sit in and the "+N" count are click-through', () => {
    for (const name of ['.agent-edge-chips', '.agent-edge-count']) {
      expect(blocks.find((b) => b.selector === name)?.body).toMatch(/pointer-events:\s*none/);
    }
  });

  it('sits with the screen layer: above the docks, below modals', () => {
    expect(blocks.find((b) => b.selector === '.agent-edge-chips')?.body)
      .toMatch(/z-index:\s*calc\(var\(--sr-layer-modal, 60\) - 1\)/);
  });

  it('slides in on the sampled spring and stands still under reduced motion; no ease words', () => {
    expect(css).not.toMatch(/\bease(?:-in|-out|-in-out)?\b|cubic-bezier\(|steps\(/);
    expect(blocks.find((b) => b.selector === '.agent-edge-chip')?.body).toMatch(/animation:\s*agent-edge-chip-in var\(--agent-cursor-chip\)/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/animation:\s*none/);
  });
});
