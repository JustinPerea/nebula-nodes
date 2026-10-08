import type { CinemaSceneSpec } from '../types';

export type CinemaPalette = NonNullable<CinemaSceneSpec['palette']>;
export type CinemaLook = NonNullable<CinemaSceneSpec['look']>;

export const CINEMA_LOOK_PRESETS = [
  { id: 'custom', label: 'Custom' },
  { id: 'kodak-portra', label: 'Kodak Portra' },
  { id: 'fuji-400h', label: 'Fuji 400H' },
  { id: 'cinestill-800t', label: 'CineStill 800T' },
  { id: 'bw-tri-x', label: 'B&W Tri-X' },
  { id: 'teal-orange', label: 'Teal & Orange' },
];

export function defaultCinemaPalette(): CinemaPalette {
  return { swatches: [], strength: 0.7, method: 'lab-transfer' };
}

export function defaultCinemaLook(): CinemaLook {
  // Custom's missing fields resolve to zero in cinema/look.py. Defaults are an
  // editor draft only; rendering the controls must not author a grade.
  return { preset: 'custom', grain: 0, halation: 0, vignette: 0, contrast: 0, saturation: 0, temperature: 0 };
}

export function effectiveCinemaPalette(scenePalette: CinemaSceneSpec['palette'], override?: Partial<CinemaPalette>): CinemaPalette {
  return { ...defaultCinemaPalette(), ...scenePalette, ...override };
}

/** Mirrors cinema_scene's merge: a selected named shot preset owns its grade,
 * while a partial override without a preset continues to inherit scene fields. */
export function effectiveCinemaLook(sceneLook: CinemaSceneSpec['look'], override?: CinemaLook): CinemaLook {
  if (override?.preset && override.preset !== 'custom' && CINEMA_LOOK_PRESETS.some((preset) => preset.id === override.preset)) {
    return { ...override };
  }
  return { ...(sceneLook ?? defaultCinemaLook()), ...override };
}

export function cinemaLookLabel(look: CinemaSceneSpec['look']): string {
  if (!look) return 'No film look';
  const name = CINEMA_LOOK_PRESETS.find((preset) => preset.id === look.preset)?.label ?? look.preset ?? 'Custom';
  return `${name}${look.lutId ? ' · LUT' : ''}`;
}

/** Keep inherited fields live by writing only fields actually edited. */
export function patchCinemaPaletteOverride(scenePalette: CinemaSceneSpec['palette'], override: Partial<CinemaPalette> | undefined,
  update: (current: CinemaPalette) => CinemaPalette): Partial<CinemaPalette> {
  const current = effectiveCinemaPalette(scenePalette, override);
  const next = update(current);
  const patch: Partial<CinemaPalette> = { ...override };
  for (const key of Object.keys(next) as Array<keyof CinemaPalette>) {
    if (next[key] !== current[key]) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}

export function patchCinemaLookOverride(sceneLook: CinemaSceneSpec['look'], override: CinemaLook | undefined,
  update: (current: CinemaLook) => CinemaLook): CinemaLook {
  const current = effectiveCinemaLook(sceneLook, override);
  const next = update(current);
  // Preset buttons deliberately replace previous custom fields. Otherwise those
  // explicit floats would flatten the named preset in the renderer.
  if (next.preset && next.preset !== 'custom' && Object.keys(next).length === 1) return next;
  const patch: CinemaLook = { ...override };
  for (const key of Object.keys(next) as Array<keyof CinemaLook>) {
    if (next[key] !== current[key]) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}

export function normalizeCinemaHex(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (!value.startsWith('#')) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}
