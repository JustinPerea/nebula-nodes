import { describe, expect, it } from 'vitest';
import {
  SPRING_POP,
  SPRING_SOFT,
  springCssVars,
  springEase,
  springFromStiffness,
  springLinear,
} from './springs';

describe('springEase (the mockup sampler)', () => {
  it('times the mockup POP spring (response 0.42 s, damping 0.85) to where it settles', () => {
    const pop = springEase(SPRING_POP);
    // GM's index.html: springEase({ response: 0.42, dampingFraction: 0.85 }).
    expect(pop.duration).toBeGreaterThan(0.57);
    expect(pop.duration).toBeLessThan(0.6);
    expect(pop.ease(0)).toBeCloseTo(0, 6);
    expect(pop.ease(1)).toBeCloseTo(1, 6);
  });

  it('overshoots a little when underdamped and never when critically damped', () => {
    const peak = (ease: (p: number) => number) => Math.max(...Array.from({ length: 201 }, (_, i) => ease(i / 200)));
    expect(peak(springEase(SPRING_POP).ease)).toBeGreaterThan(1.002);
    expect(peak(springEase(SPRING_POP).ease)).toBeLessThan(1.02);
    expect(peak(springEase(SPRING_SOFT).ease)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('converts stiffness and damping (PR6 tokens) to response and damping fraction', () => {
    const spec = springFromStiffness(380, 34);
    expect(spec.response).toBeCloseTo((2 * Math.PI) / Math.sqrt(380), 6);
    expect(spec.dampingFraction).toBeCloseTo(34 / (2 * Math.sqrt(380)), 6);
  });
});

describe('springLinear (CSS linear() curves)', () => {
  it('samples the spring as a CSS linear() easing that starts at 0 and ends at 1', () => {
    const curve = springLinear(SPRING_POP);
    expect(curve.durationMs).toBe(Math.round(springEase(SPRING_POP).duration * 1000));
    expect(curve.easing.startsWith('linear(0,')).toBe(true);
    expect(curve.easing.endsWith(', 1)')).toBe(true);
    const points = curve.easing.slice('linear('.length, -1).split(',').map((v) => Number(v.trim()));
    expect(points.length).toBeGreaterThanOrEqual(24);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(Math.max(...points)).toBeGreaterThan(1);
  });

  it('hands components the tokens as custom properties', () => {
    const vars = springCssVars();
    expect(vars['--spring-pop-ms']).toBe(`${springLinear(SPRING_POP).durationMs}ms`);
    expect(vars['--spring-pop']).toBe(springLinear(SPRING_POP).easing);
    expect(vars['--spring-soft-ms']).toBe(`${springLinear(SPRING_SOFT).durationMs}ms`);
    expect(vars['--spring-soft']).toBe(springLinear(SPRING_SOFT).easing);
  });
});
