/**
 * Skin registry for the app shell.
 *
 * A skin is a CSS-only reskin of the app, activated by adding a body class.
 * Each skin's CSS lives in its own file under styles/, scoped under the body
 * class so it can't leak into other skins or the unskinned default.
 *
 * Manual selection lives in Settings. The chat panel may temporarily request
 * Hermes when the user enters Daedalus mode, then restore the previous skin
 * when they return to Claude.
 *
 * Default: Slava Restraint. Persistence: localStorage key `nebula:skin`.
 * Migration: existing users with `nebula:hermes-tone` set are auto-promoted
 * to skin=hermes on first load so their environment doesn't change underneath
 * them.
 */

export type SkinId =
  | 'default'
  | 'hermes'
  | 'slava-restraint'
  | 'slava-wayfinding';

export interface SkinDef {
  id: SkinId;
  label: string;
  /** One-line description shown under each option in the picker. */
  description: string;
  /** Body class that activates the skin's CSS. null = no class (the default). */
  bodyClass: string | null;
  /** Reference / inspiration source for the picker's tooltip. Optional. */
  reference?: string;
}

export const SKINS: SkinDef[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Unskinned base — flat dark chrome.',
    bodyClass: null,
  },
  {
    id: 'hermes',
    label: 'Hermes',
    description: 'The original Daedalus character skin — top-rule + eyebrow editorial.',
    bodyClass: 'app-hermes',
  },
  {
    id: 'slava-restraint',
    label: 'Slava — Restraint',
    description: 'Glassy monochrome · single accent · dot-matrix wordmark only.',
    bodyClass: 'app-slava-restraint',
    reference: 'Nothing OS Concept + MIX №1 · Slava Kornilov / Geex Arts',
  },
  {
    id: 'slava-wayfinding',
    label: 'Slava — Wayfinding',
    description: 'Subway-bullet category system · "Change to" metadata footers.',
    bodyClass: 'app-slava-wayfinding',
    reference: 'NYC Music OS · Slava Kornilov / Geex Arts',
  },
];

export const DEFAULT_SKIN: SkinId = 'slava-restraint';

const SKIN_STORAGE_KEY = 'nebula:skin';
const LEGACY_HERMES_TONE_KEY = 'nebula:hermes-tone';
const SLAVA_SWITCH_CLASS = 'app-skin-switching-slava';
const SLAVA_SWITCH_DURATION_MS = 220;

let slavaSwitchTimeout: number | undefined;

interface ApplySkinBodyClassOptions {
  animate?: boolean;
}

export function loadSkin(): SkinId {
  try {
    const v = window.localStorage.getItem(SKIN_STORAGE_KEY);
    if (v && SKINS.some((s) => s.id === v)) return v as SkinId;
    // Migration: pre-registry users with a Hermes tone saved → migrate
    // to skin=hermes so their environment doesn't reset on this update.
    if (window.localStorage.getItem(LEGACY_HERMES_TONE_KEY)) return 'hermes';
  } catch {
    // localStorage may be unavailable in some environments; fall through.
  }
  return DEFAULT_SKIN;
}

export function persistSkin(id: SkinId): void {
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    // best effort; the in-memory state still updates.
  }
}

/**
 * Apply a skin's body class, removing any other registered skin classes first.
 * Idempotent: safe to call repeatedly with the same id.
 */
export function applySkinBodyClass(id: SkinId, options: ApplySkinBodyClassOptions = {}): void {
  const body = document.body;
  const previousSkin = SKINS.find((s) => s.bodyClass && body.classList.contains(s.bodyClass))?.id ?? 'default';
  const shouldAnimate =
    options.animate !== false &&
    previousSkin !== id &&
    (previousSkin === 'slava-restraint' || id === 'slava-restraint');

  if (shouldAnimate) {
    if (slavaSwitchTimeout) window.clearTimeout(slavaSwitchTimeout);
    body.classList.remove(SLAVA_SWITCH_CLASS);
    void body.offsetWidth;
    body.classList.add(SLAVA_SWITCH_CLASS);
    slavaSwitchTimeout = window.setTimeout(() => {
      body.classList.remove(SLAVA_SWITCH_CLASS);
      slavaSwitchTimeout = undefined;
    }, SLAVA_SWITCH_DURATION_MS + 40);
  }

  for (const s of SKINS) {
    if (s.bodyClass) body.classList.remove(s.bodyClass);
  }
  const def = SKINS.find((s) => s.id === id);
  if (def?.bodyClass) body.classList.add(def.bodyClass);
}
