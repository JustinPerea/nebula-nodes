import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  DAILY_AMOUNT_INVALID, DAILY_TOTAL_CHOICES, dailyAmountDraft, dailyLimit, dailyMeterShown, dailyUsageLine, limitUsd,
  parseDailyAmount,
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
 * goes back (the field claims it, so the sheet stays open). What can't be
 * saved keeps the field open with a line saying why. The usage line and the
 * meter read `spentUsd`, the last 24 hours.
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
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const select = useRef<HTMLSelectElement | null>(null);
  // Enter saves, and the blur that follows must not save again; Escape's must not save at all.
  const settled = useRef(false);
  // Enter and Escape hand focus back to the select; a blur leaves it where the person moved it.
  const refocus = useRef(false);

  // Back to the select once it is there and enabled: after Enter saves, it is
  // disabled while the save is pending, and focus waits for it (review 1, L1).
  useEffect(() => {
    if (editing) input.current?.focus();
    else if (refocus.current && !disabled) {
      refocus.current = false;
      select.current?.focus();
    }
  }, [editing, disabled]);

  const save = (value: number | null) => onChange({ ...limits, dailyTotalUsd: value });
  const open = () => {
    settled.current = false;
    setDraft(limit === null ? '' : dailyAmountDraft(limit));
    setInvalid(false);
    setEditing(true);
  };
  /** Saves a valid amount and closes the field; anything else (junk, empty,
   * $0, past the most) is never saved, and the field stays open saying why. */
  const commit = () => {
    if (settled.current) return;
    const value = parseDailyAmount(draft);
    if (value === null) {
      refocus.current = false;
      setInvalid(true);
      return;
    }
    settled.current = true;
    setInvalid(false);
    setEditing(false);
    if (value !== limit) save(value);
  };
  const back = () => {
    settled.current = true;
    setInvalid(false);
    setEditing(false);
  };

  const current = limit === null ? NONE : String(limit);
  const custom = limit !== null && !(DAILY_TOTAL_CHOICES as readonly number[]).includes(limit);
  const line = spentUsd === null ? null : dailyUsageLine(spentUsd, limit);
  // The meter shows only with a limit and something spent (GM).
  const meter = spentUsd !== null && dailyMeterShown(spentUsd, limit) ? limit : null;

  return (
    <div className="settings-pref settings-daily" data-testid="settings-daily-total">
      <span className="settings-pref__text">
        <label className="settings-pref__title" htmlFor={editing ? 'settings-agent-daily-amount' : 'settings-agent-daily'}>
          Daily total
        </label>
        <span className="settings-pref__description" id="settings-agent-daily-help">
          Agent chats, agents outside Nebula, scripts and tabs not opened from your link all count toward it. Your own
          runs don&rsquo;t.
        </span>
        {/* Its own line under the help, and the meter right under it, the
            text column's width (GM - Design, 2026-10-31). */}
        {line && (
          <span className="settings-daily__usage settings-agent-spent" data-testid="settings-agent-daily-spent">{line}</span>
        )}
        {meter !== null && spentUsd !== null && line !== null && (
          <span className="settings-daily__meter" role="meter" aria-label="Daily total used"
            aria-valuemin={0} aria-valuemax={meter} aria-valuenow={Math.min(spentUsd, meter)} aria-valuetext={line}>
            <span className="settings-daily__meter-fill"
              style={{ ['--daily-fill' as string]: Math.round(Math.min(1, spentUsd / meter) * 10_000) / 10_000 } as CSSProperties} />
          </span>
        )}
      </span>
      {editing ? (
        <span className="settings-daily__edit">
          {/* Escape goes back to the select and no further: the sheet closes on
              Escape from a native listener (usePanelFocus) that runs before
              React's bubble handlers, so the field claims it in the capture
              phase, as KeyRow, StorageTab and ProvidersTab do. */}
          <span className="settings-daily__field" data-claims-escape
            onKeyDownCapture={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              refocus.current = true;
              back();
            }}>
            <span aria-hidden="true">$</span>
            <input ref={input} id="settings-agent-daily-amount" className="settings-daily__input" type="text"
              inputMode="decimal" value={draft} disabled={disabled}
              aria-describedby={invalid ? 'settings-agent-daily-invalid settings-agent-daily-help' : 'settings-agent-daily-help'}
              aria-invalid={invalid || undefined}
              onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); refocus.current = true; commit(); }
              }} />
            <span aria-hidden="true">/ day</span>
          </span>
          {invalid && (
            <span className="settings-daily__invalid" id="settings-agent-daily-invalid" role="status">
              {DAILY_AMOUNT_INVALID}
            </span>
          )}
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
    </div>
  );
}
