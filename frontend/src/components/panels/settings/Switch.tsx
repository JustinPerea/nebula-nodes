import { useId } from 'react';
import { useHeldLook } from '../../../hooks/useHeldLook';

/**
 * Settings' switch: a real checkbox with role="switch".
 *
 * GM, PR #205 r1 answer 6: a switch saving its own change follows the held
 * rule (useHeldLook). The caller shows the person's new position at once
 * (`checked` is the value being saved) and passes `saving`; the switch keeps
 * its enabled look for the first 150 ms (data-held-pending), so a quick save
 * never flashes grey, and if the save is still out after that it takes the
 * locked look (data-held-look, styles/disabled-buttons.css) with the thumb
 * where the person put it. While held it is aria-disabled (it keeps its
 * focus) and a press changes nothing. `disabled` stays a lock of its own
 * (not this switch's save): the locked look at once.
 */
export function SettingsSwitch({ checked, saving = false, disabled, onChange, ...aria }: {
  checked: boolean;
  saving?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  const held = useHeldLook(saving && !disabled);
  return (
    <input
      type="checkbox"
      role="switch"
      className="settings-switch"
      checked={checked}
      disabled={disabled}
      {...aria}
      {...held}
      onChange={(event) => { if (!saving) onChange(event.target.checked); }}
    />
  );
}

/** A labelled on/off row. The whole row is the hit target; the switch is a real checkbox. */
export function SwitchRow({ title, description, checked, disabled, saving, nested, onChange }: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  /** This switch's own change is being saved (GM PR #205 r1: the held rule). */
  saving?: boolean;
  nested?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = useId();
  return (
    <label className={`settings-pref${nested ? ' settings-pref--nested' : ''}`}>
      <span className="settings-pref__text">
        <span className="settings-pref__title">{title}</span>
        {description && <span className="settings-pref__description" id={descriptionId}>{description}</span>}
      </span>
      <SettingsSwitch checked={checked} disabled={disabled} saving={saving}
        aria-describedby={description ? descriptionId : undefined} onChange={onChange} />
    </label>
  );
}
