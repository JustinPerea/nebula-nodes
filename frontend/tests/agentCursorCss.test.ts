import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GM - Design's agent cursor spec, §3: "Springs only. Every stock easing in
 * agentCursor.css becomes springLinear samples." The cursor's position, lean
 * and opacity are JS springs; what CSS still animates names a sampled spring.
 */
const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const reducedAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
const main = css.slice(0, reducedAt);
const reduced = css.slice(reducedAt);
const declarations = (property: string) => [...main.matchAll(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());

describe('agentCursor.css runs on springs only', () => {
  it('has no stock easing', () => {
    expect(css).not.toMatch(/\bease(?:-in|-out|-in-out)?\b/);
    expect(css).not.toMatch(/cubic-bezier\(/);
    expect(css).not.toMatch(/steps\(/);
  });

  it('every transition and animation takes its timing from an --agent-cursor-… spring', () => {
    const timed = [...declarations('transition'), ...declarations('animation')];
    expect(timed.length).toBeGreaterThan(0);
    for (const value of timed) {
      for (const part of value.split(/,(?![^(]*\))/)) {
        expect(part, value).toMatch(/var\(--agent-cursor-[a-z-]+\)/);
      }
    }
  });

  it('the springs it names are defined: say-fade here, soft and ring by the layer', () => {
    expect(css).toMatch(/--agent-cursor-say-fade:\s*\d+ms linear\(0,/);
    const layer = readFileSync(resolve(__dirname, '../src/components/canvas/AgentCursorLayer.tsx'), 'utf8');
    for (const name of new Set([...main.matchAll(/var\((--agent-cursor-[a-z-]+)\)/g)].map((m) => m[1]))) {
      if (name === '--agent-cursor-say-fade') continue;
      expect(layer, name).toContain(`'${name}'`);
    }
  });

  it('reduced motion turns off every animation and transition', () => {
    const animated = new Set<string>();
    for (const match of main.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/(?:^|[;\s])(?:animation|transition):/.test(match[2])) {
        for (const selector of match[1].split(',')) animated.add(selector.trim());
      }
    }
    expect(animated.size).toBeGreaterThan(0);
    for (const selector of animated) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(reduced, selector).toMatch(new RegExp(`${escaped}\\s*[,{][^}]*?(?:animation|transition):\\s*none`));
    }
  });

  it('opacity is no longer a CSS fade: the layer springs it', () => {
    const cursorRule = /(?:^|\n)\.agent-cursor\s*\{([^}]*)\}/.exec(main)?.[1] ?? '';
    expect(cursorRule).not.toMatch(/transition/);
    expect(main).not.toMatch(/agent-cursor--idle/);
  });
});
