import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  DAILY_TOTAL_CHOICES, dailyLimit, dailyMeterShown, dailyUsageLine, limitUsd, parseDailyAmount,
} from '../../../lib/dailyTotal';
import type { AgentSpendLimits } from '../../../store/settingsDraftStore';

/** The select's value for "Other amount…", which swaps it for the field. */
const OTHER = 'other';
const NONE = 'none';

/**
 * Agent spending's first row (GM - Design, 2026-10-31): the daily total
 * everything that isn't the person shares, the umbrella over the rows below.
 * $5 is preselected while the person hasn't picked one; "Other amount…"
 * opens an inline field ($ … / day) that saves on Enter or blur, and Escape
 * goes back. The usage line and the meter read `spentUsd`, the last 24 hours.
 */
export function DailyTotalRow({ limits, spentUsd, disabled, onChange }: {
  limits: AgentSpendLimits;
  /** What everything that isn't the person spent in the last 24 hours; null while it loads. */
  spentUsd: number | null;
  disabled: boolean;
  onChange: (next: AgentSpendLimits) => void;
}) {
  const limit = dailyLimit(limits.dailyTotalUsd);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const select = useRef<HTMLSelectElement | null>(null);
  // Enter saves, and the blur that follows must not save again; Escape's must not save at all.
  const settled = useRef(false);
  // Enter and Escape hand focus back to the select; a blur leaves it where the person moved it.
  const refocus = useRef(false);

  useEffect(() => {
    if (editing) input.current?.focus();
    else if (refocus.current) {
      refocus.current = false;
      select.current?.focus();
    }
  }, [editing]);

  const save = (value: number | null) => onChange({ ...limits, dailyTotalUsd: value });
  const open = () => {
    settled.current = false;
    setDraft(limit === null ? '' : String(limit));
    setEditing(true);
  };
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const value = parseDailyAmount(draft);
    setEditing(false);
    if (value !== null && value !== limit) save(value);
  };
  const back = () => {
    settled.current = true;
    setEditing(false);
  };

  const current = limit === null ? NONE : String(limit);
  const custom = limit !== null && !(DAILY_TOTAL_CHOICES as readonly number[]).includes(limit);
  const line = spentUsd === null ? null : dailyUsageLine(spentUsd, limit);

  return (
    <div className="settings-pref" data-testid="settings-daily-total">
      <span className="settings-pref__text">
        <label className="settings-pref__title" htmlFor={editing ? 'settings-agent-daily-amount' : 'settings-agent-daily'}>
          Daily total
        </label>
        <span className="settings-pref__description" id="settings-agent-daily-help">
          Shared by everything that isn&rsquo;t you: agent chats, agents outside Nebula, scripts and tabs not opened
          from your link. Counts the last 24 hours.
          {line && (
            <span className="settings-agent-spent" data-testid="settings-agent-daily-spent">{' '}{line}</span>
          )}
        </span>
      </span>
      {editing ? (
        <span className="settings-daily__field">
          <span aria-hidden="true">$</span>
          <input ref={input} id="settings-agent-daily-amount" className="settings-daily__input" type="text"
            inputMode="decimal" aria-describedby="settings-agent-daily-help" value={draft} disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); refocus.current = true; commit(); }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); refocus.current = true; back(); }
            }} />
          <span aria-hidden="true">/ day</span>
        </span>
      ) : (
        <select ref={select} id="settings-agent-daily" className="settings__select settings__select--compact"
          aria-describedby="settings-agent-daily-help" value={current} disabled={disabled}
          onChange={(event) => {
            const { value } = event.target;
            if (value === OTHER) { open(); return; }
            save(value === NONE ? null : Number(value));
          }}>
          {custom && <option value={current}>{limitUsd(limit)} / day</option>}
          {DAILY_TOTAL_CHOICES.map((choice) => (
            <option key={choice} value={String(choice)}>{limitUsd(choice)} / day</option>
          ))}
          <option value={OTHER}>Other amount&hellip;</option>
          <option value={NONE}>No limit</option>
        </select>
      )}
      {spentUsd !== null && line && dailyMeterShown(spentUsd, limit) && (
        <div className="settings-daily__meter" role="meter" aria-label="Daily total used"
          aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(spentUsd, limit)} aria-valuetext={line}>
          <span className="settings-daily__meter-fill"
            style={{ ['--daily-fill' as string]: Math.round(Math.min(1, spentUsd / limit) * 10_000) / 10_000 } as CSSProperties} />
        </div>
      )}
    </div>
  );
}
