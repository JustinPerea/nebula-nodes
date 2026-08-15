/**
 * Semantic reference roles for image reference ports.
 *
 * A port's `role` is ADVISORY metadata: it never changes port compatibility
 * (Image still connects to Image/Mask/Any). Roles drive UI display (colored
 * badge next to the port label in ModelNode) and handler intelligence (the
 * reference-set node packs connected images into a ReferenceSetBundle tagged
 * with each port's role and weight).
 */

export type ReferenceRoleId =
  | 'style'
  | 'identity'
  | 'composition'
  | 'pose'
  | 'lighting'
  | 'subject'
  | 'background';

export interface ReferenceRoleDefinition {
  /** Human-facing label shown on the role badge. */
  label: string;
  /** Badge/handle color (hex). */
  color: string;
  /** One-line explanation of what the role contributes to generation. */
  description: string;
}

export const REFERENCE_ROLES: Record<ReferenceRoleId, ReferenceRoleDefinition> = {
  style: {
    label: 'Style',
    color: '#e8a87c',
    description: 'Visual aesthetic, look, mood',
  },
  identity: {
    label: 'Identity',
    color: '#c38d9e',
    description: 'Character face/body consistency',
  },
  composition: {
    label: 'Composition',
    color: '#85cdca',
    description: 'Layout, framing, camera angle',
  },
  pose: {
    label: 'Pose',
    color: '#e27d60',
    description: 'Body position, gesture, expression',
  },
  lighting: {
    label: 'Lighting',
    color: '#41b3a3',
    description: 'Illumination, shadows, atmosphere',
  },
  subject: {
    label: 'Subject',
    color: '#fce38a',
    description: 'What to generate: object, person, scene',
  },
  background: {
    label: 'Background',
    color: '#a8d8ea',
    description: 'Environment, setting, context',
  },
};

/** Ordered list of the 7 standard role ids (declaration order). */
export const REFERENCE_ROLE_IDS = Object.keys(REFERENCE_ROLES) as ReferenceRoleId[];

/** Weight contract: ports without an explicit weight behave as 1.0, and the
 *  weight slider clamps to [0, 1] with step 0.05. */
export const REFERENCE_WEIGHT_DEFAULT = 1.0;
export const REFERENCE_WEIGHT_MIN = 0;
export const REFERENCE_WEIGHT_MAX = 1;
export const REFERENCE_WEIGHT_STEP = 0.05;

/** Clamp a weight to [0, 1]. Non-finite input falls back to the default. */
export function clampReferenceWeight(weight: number): number {
  if (!Number.isFinite(weight)) return REFERENCE_WEIGHT_DEFAULT;
  return Math.min(REFERENCE_WEIGHT_MAX, Math.max(REFERENCE_WEIGHT_MIN, weight));
}
