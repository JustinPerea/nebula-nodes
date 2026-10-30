/**
 * A universal node's provider setting as the Inspector and the agent's
 * cursor name it (GM, PR #198 r1 item 7): its key in sentence case,
 * "guidance_scale" → "Guidance scale". The backend's twin is
 * services/universal_ports.setting_label, which labels a Replicate model's
 * inputs when the picker reads its schema. Saved nodes can still carry the
 * older Title Case label ("Guidance Scale"), so the screen derives it from
 * the key rather than reading the stored one.
 */
export function universalSettingLabel(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
