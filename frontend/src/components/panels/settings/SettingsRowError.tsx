import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { LineText } from '../../LineText';

/**
 * A Settings row's line for its last failed write. A line that lost nothing
 * (another Nebula was saving the settings, so the change waits) is neutral,
 * colour too: the row's muted text and a polite status, not the error colour
 * and an alert (GM, PR #203 r39). `id` is the write's key or field name;
 * `message` may be the row's own line instead (a folder picker's), which is
 * never neutral.
 */
export function SettingsRowError({ id, message }: { id: string; message?: string | null }) {
  const neutral = useSettingsDraftStore((s) => Boolean(s.neutral[id]) && s.errors[id] === message);
  if (!message) return null;
  return neutral
    ? <p className="settings-row__error settings-row__error--neutral" role="status"><LineText text={message} /></p>
    : <p className="settings-row__error" role="alert"><LineText text={message} /></p>;
}
