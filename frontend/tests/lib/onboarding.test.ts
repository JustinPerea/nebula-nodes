import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { ONBOARDING_TOUR, placeOnboardingTooltip } from '../../src/lib/onboarding';

describe('current onboarding steps', () => {
  it('covers current Nodes, Settings, Create, History and Chat controls once with a live catalog count', () => {
    expect(ONBOARDING_TOUR.map((step) => step.target)).toEqual(['nodes', 'settings', 'create', 'history', 'chat']);
    for (const step of ONBOARDING_TOUR) expect(step.selector).toBe(`[data-onboarding-target="${step.target}"]`);
    expect(ONBOARDING_TOUR[0].body).toContain(`${Object.keys(NODE_DEFINITIONS).length} nodes`);
    expect(ONBOARDING_TOUR[0].body).toContain('animate a logo');
    expect(ONBOARDING_TOUR[1].body).toContain('without generating');
    expect(ONBOARDING_TOUR[2].body).toContain('reference image');
    expect(ONBOARDING_TOUR[2].body).toContain('Choose Generate');
    expect(ONBOARDING_TOUR[3].body).toContain('Explicitly rerun');
    expect(ONBOARDING_TOUR[4].body).toContain('Review its nodes');
  });
});

describe('measured onboarding placement', () => {
  const viewport = { width: 800, height: 600 };
  const tooltip = { width: 280, height: 180 };

  it('prefers right of the narrow rail and clamps the vertical position', () => {
    expect(placeOnboardingTooltip({ left: 16, top: 16, width: 44, height: 44 }, tooltip, viewport)).toMatchObject({
      left: 72, top: 12, width: 280, height: 180, side: 'right',
    });
    expect(placeOnboardingTooltip({ left: 16, top: 530, width: 44, height: 44 }, tooltip, viewport)).toMatchObject({
      left: 72, top: 408, side: 'right',
    });
  });

  it('uses left when the right cannot fit', () => {
    expect(placeOnboardingTooltip({ left: 720, top: 260, width: 44, height: 44 }, tooltip, viewport)).toMatchObject({
      left: 428, top: 192, side: 'left',
    });
  });

  it('uses below or above when neither side can fit the measured width', () => {
    const wideTooltip = { width: 430, height: 180 };
    expect(placeOnboardingTooltip({ left: 378, top: 70, width: 44, height: 44 }, wideTooltip, viewport)).toMatchObject({
      left: 185, top: 126, side: 'below',
    });
    expect(placeOnboardingTooltip({ left: 378, top: 430, width: 44, height: 44 }, wideTooltip, viewport)).toMatchObject({
      left: 185, top: 238, side: 'above',
    });
  });

  it('positions from actual tooltip height instead of a fixed estimate', () => {
    const target = { left: 378, top: 430, width: 44, height: 44 };
    const small = placeOnboardingTooltip(target, { width: 430, height: 100 }, viewport);
    const tall = placeOnboardingTooltip(target, { width: 430, height: 300 }, viewport);
    expect(small).toMatchObject({ side: 'below', top: 486 });
    expect(tall).toMatchObject({ side: 'above', top: 118 });
  });

  it('centers for missing, zero-sized or completely offscreen targets without a stale highlight', () => {
    for (const target of [null, { left: 30, top: 30, width: 0, height: 44 },
      { left: -100, top: 20, width: 44, height: 44 }, { left: 30, top: 610, width: 44, height: 44 }]) {
      expect(placeOnboardingTooltip(target, tooltip, viewport)).toEqual({
        left: 260, top: 210, width: 280, height: 180, side: 'center', highlight: null,
      });
    }
  });

  it('clips partially visible highlights to the actual viewport before positioning', () => {
    const result = placeOnboardingTooltip({ left: -14, top: 570, width: 44, height: 44 }, tooltip, viewport);
    expect(result.highlight).toEqual({ left: 0, top: 570, width: 30, height: 30 });
    expect(result).toMatchObject({ left: 42, top: 408, side: 'right' });
    const opposite = placeOnboardingTooltip({ left: 770, top: -22, width: 44, height: 44 }, tooltip, viewport);
    expect(opposite.highlight).toEqual({ left: 770, top: 0, width: 30, height: 22 });
    expect(opposite).toMatchObject({ left: 478, top: 12, side: 'left' });
  });

  it.each([{ width: 320, height: 240 }, { width: 600, height: 380 }])('bounds a large card inside compact viewport $width×$height', (screen) => {
    const result = placeOnboardingTooltip({ left: 14, top: screen.height - 60, width: 44, height: 44 },
      { width: 420, height: 400 }, screen);
    expect(result.left).toBeGreaterThanOrEqual(12);
    expect(result.top).toBeGreaterThanOrEqual(12);
    expect(result.left + result.width).toBeLessThanOrEqual(screen.width - 12);
    expect(result.top + result.height).toBeLessThanOrEqual(screen.height - 12);
  });

  it('centers when a visible target leaves no fitting adjacent position', () => {
    const result = placeOnboardingTooltip({ left: 0, top: 0, width: 800, height: 600 }, tooltip, viewport);
    expect(result).toMatchObject({ left: 260, top: 210, side: 'center', highlight: { left: 0, top: 0, width: 800, height: 600 } });
  });

  it('handles invalid geometry without emitting non-finite CSS positions', () => {
    const result = placeOnboardingTooltip({ left: NaN, top: 0, width: 44, height: 44 },
      { width: Infinity, height: -10 }, { width: NaN, height: 240 });
    expect(result).toEqual({ left: 0, top: 120, width: 0, height: 0, side: 'center', highlight: null });
  });
});
