import { useId } from 'react';
import type { LockProps } from '../../PersonLock';

/** A labelled on/off row. The whole row is the hit target; the switch is a real checkbox. */
export function SwitchRow({ title, description, checked, disabled, nested, onChange, lock }: {
  /** A person-only setting's lock (components/PersonLock): aria-disabled and its line. */
  lock?: LockProps;
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
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
      <input
        type="checkbox"
        role="switch"
        className="settings-switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={[description ? descriptionId : undefined, lock?.['aria-describedby']].filter(Boolean).join(' ') || undefined}
        aria-disabled={lock?.['aria-disabled']}
        data-held-pending={lock?.['data-held-pending']}
        data-person-lock={lock?.['data-person-lock']}
        onChange={(event) => { if (!lock?.['aria-disabled']) onChange(event.target.checked); }}
      />
    </label>
  );
}
