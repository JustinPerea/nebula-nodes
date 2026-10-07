/** The app has one supported appearance: Slava Restraint. */
export type SkinId = 'slava-restraint';
export const DEFAULT_SKIN: SkinId = 'slava-restraint';

const SKIN_STORAGE_KEY = 'nebula:skin';
const LEGACY_HERMES_TONE_KEY = 'nebula:hermes-tone';
const LEGACY_BODY_CLASSES = [
  'app-hermes',
  'app-slava-wayfinding',
  'tone-verdant',
  'tone-obsidian',
  'chat-bloom-active',
  'app-skin-switching-slava',
];

/** Normalize preferences saved by versions that offered alternate themes. */
export function loadSkin(): SkinId {
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, DEFAULT_SKIN);
    window.localStorage.removeItem(LEGACY_HERMES_TONE_KEY);
  } catch {
    // The supported appearance also works when storage is unavailable.
  }
  return DEFAULT_SKIN;
}

/** Clear obsolete theme/transition classes before the app's first paint. */
export function applySkinBodyClass(): void {
  document.body.classList.remove(...LEGACY_BODY_CLASSES);
  document.body.classList.add('app-slava-restraint');
}
