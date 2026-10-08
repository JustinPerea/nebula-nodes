import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

export type OnboardingTarget = 'nodes' | 'settings' | 'create' | 'history' | 'chat' | 'help';
export interface OnboardingTourStep {
  target: OnboardingTarget;
  selector: string;
  title: string;
  body: string;
}

const catalogCount = Object.keys(NODE_DEFINITIONS).length;
export const ONBOARDING_HELP_SELECTOR = '[data-onboarding-target="help"]';

/** A tour describes the current controls; moving between steps takes no action
 * in the graph, provider settings or a saved recipe. */
export const ONBOARDING_TOUR: readonly OnboardingTourStep[] = [
  {
    target: 'nodes', selector: '[data-onboarding-target="nodes"]', title: 'Find a model',
    body: `Browse ${catalogCount} nodes by task, model or provider. Try “animate a logo”, then add a model to the canvas. Adding never generates.`,
  },
  {
    target: 'settings', selector: '[data-onboarding-target="settings"]', title: 'Connect a provider',
    body: 'Browse models before connecting. Open Settings for the provider shown with your model. Check connections checks saved credentials without generating.',
  },
  {
    target: 'create', selector: '[data-onboarding-target="create"]', title: 'Create from a prompt',
    body: 'Choose a model, write a prompt and attach a reference image. Your draft stays when you return to Canvas. Choose Generate when you want to start a run.',
  },
  {
    target: 'history', selector: '[data-onboarding-target="history"]', title: 'Keep your earlier runs',
    body: 'Inspect saved recipes and earlier results in Run History. Explicitly rerun a recipe when you want a new result; browsing keeps earlier runs intact.',
  },
  {
    target: 'chat', selector: '[data-onboarding-target="chat"]', title: 'Build with the agent',
    body: 'Ask the agent to build a connected graph from your idea. Review its nodes, inputs and provider connections before running it.',
  },
];

export interface OnboardingSize { width: number; height: number }
export interface OnboardingRect extends OnboardingSize { left: number; top: number }
export interface OnboardingPlacement extends OnboardingRect {
  side: 'right' | 'left' | 'below' | 'above' | 'center';
  highlight: OnboardingRect | null;
}

export const ONBOARDING_GAP = 12;

function positiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function visibleTarget(target: OnboardingRect | null, viewport: OnboardingSize): OnboardingRect | null {
  if (!target || ![target.left, target.top, target.width, target.height].every(Number.isFinite)
    || target.width <= 0 || target.height <= 0) return null;
  const left = Math.max(0, target.left);
  const top = Math.max(0, target.top);
  const right = Math.min(viewport.width, target.left + target.width);
  const bottom = Math.min(viewport.height, target.top + target.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/** Use actual measured tooltip dimensions. Prefer the side of narrow rail
 * controls, then below/above; clamp the other axis and center when no side fits.
 * Dimensions are bounded for compact viewports so the overlay can constrain its
 * content rather than position a large card outside the visible screen. */
export function placeOnboardingTooltip(
  target: OnboardingRect | null,
  tooltip: OnboardingSize,
  viewport: OnboardingSize,
): OnboardingPlacement {
  const screen = { width: positiveDimension(viewport.width), height: positiveDimension(viewport.height) };
  const insetX = Math.min(ONBOARDING_GAP, screen.width / 2);
  const insetY = Math.min(ONBOARDING_GAP, screen.height / 2);
  const width = Math.min(positiveDimension(tooltip.width), Math.max(0, screen.width - insetX * 2));
  const height = Math.min(positiveDimension(tooltip.height), Math.max(0, screen.height - insetY * 2));
  const maxLeft = screen.width - insetX - width;
  const maxTop = screen.height - insetY - height;
  const highlight = visibleTarget(target, screen);
  const position = (left: number, top: number, side: OnboardingPlacement['side']): OnboardingPlacement => ({
    left: clamp(left, insetX, maxLeft), top: clamp(top, insetY, maxTop), width, height, side, highlight,
  });
  if (highlight) {
    const right = highlight.left + highlight.width;
    const bottom = highlight.top + highlight.height;
    const centerLeft = highlight.left + highlight.width / 2 - width / 2;
    const centerTop = highlight.top + highlight.height / 2 - height / 2;
    if (right + ONBOARDING_GAP + width <= screen.width - insetX) {
      return position(right + ONBOARDING_GAP, centerTop, 'right');
    }
    if (highlight.left - ONBOARDING_GAP - width >= insetX) {
      return position(highlight.left - ONBOARDING_GAP - width, centerTop, 'left');
    }
    if (bottom + ONBOARDING_GAP + height <= screen.height - insetY) {
      return position(centerLeft, bottom + ONBOARDING_GAP, 'below');
    }
    if (highlight.top - ONBOARDING_GAP - height >= insetY) {
      return position(centerLeft, highlight.top - ONBOARDING_GAP - height, 'above');
    }
  }
  return position((screen.width - width) / 2, (screen.height - height) / 2, 'center');
}
