/**
 * A raw provider key as a person reads it (GM, PR #198 r1 item 7, then the
 * 2026-11 copy sweep item 17): the key split into words and set in sentence
 * case. Snake case, camelCase and PascalCase all split, and an acronym stays
 * in capitals: "guidance_scale" gives "Guidance scale", "filePath" gives
 * "File path", "numInferenceSteps" gives "Num inference steps", "input_image"
 * gives "Input image", "imageURL" gives "Image URL". The backend's twin is
 * services/universal_ports.setting_label (and _title); both are held to the
 * same table of cases (tests/pr198Fix1Ui.test.tsx and
 * backend/tests/test_universal_ports.py). Saved nodes can still carry the
 * older Title Case label ("Guidance Scale"), so the screen derives it from
 * the key rather than reading the stored one.
 */
export function universalSettingLabel(key: string): string {
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const words = spaced
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => (/^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase()));
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
