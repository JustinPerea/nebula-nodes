import { useId, useState, type ReactNode } from 'react';
import type { MoodboardBrief, MoodboardClash, MoodboardClashMode, MoodboardPinnedColors } from '../../types';
import { BRIEF_LIMITS } from './briefLimits';

// The person's side of a board's brief (design-canvas gap 14): Direction,
// Avoid and pinned colours, plus the brief generators get and its optional
// hand-written override. The backend composes the brief
// (services/moodboard_brief.py); this file only shows and edits it.
// Gap 18: the backend also says which measured colours the brief left out
// and why (`leftOut`, `mayClash`, `kept`, `pinnedClashes`); this file lists
// them and sends the person's Keep anyway / Leave out back as a choice.

export type ColorChoice = 'keep' | 'leaveOut' | 'reset';

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(value: string): string | null {
  const match = HEX_RE.exec(value.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return `#${digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits}`;
}

export function BriefPanel({
  brief,
  override,
  author = 'person',
  saving,
  busy,
  onEdit,
  onEditDone,
  onKeep,
  onRegenerate,
  onColorChoice,
  onLeaveOutAll,
}: {
  brief: MoodboardBrief | null;
  override: { text: string } | null;
  author?: 'person' | 'agent';
  saving: boolean;
  busy: boolean;
  onEdit: (text: string) => void;
  /** The brief's text box lost focus, or Write your own was pressed: one undo step (Q83). */
  onEditDone?: () => void;
  onKeep: () => void;
  onRegenerate: () => void;
  onColorChoice?: (choice: ColorChoice, hex: string) => void;
  onLeaveOutAll?: (hexes: string[]) => void;
}) {
  const stale = Boolean(override && brief?.override.active && brief.override.stale);
  const byAgent = author === 'agent';
  return (
    <div className="moodboard-brief">
      <div className="moodboard-brief__head">
        <span className="moodboard-swatches__label">Brief sent to generators</span>
        <span className="moodboard-brief__source">{override?.text.trim() ? (byAgent ? 'Written by an agent' : 'Written by you') : 'Generated'}</span>
      </div>
      {stale && (
        <div className="moodboard-brief__stale" role="status">
          <span>{byAgent ? 'Board changed since an agent wrote this.' : 'Board changed since you edited this.'}</span>
          <button type="button" onClick={onKeep} disabled={busy}>Keep</button>
          <button type="button" onClick={onRegenerate} disabled={busy}>Regenerate</button>
        </div>
      )}
      {override ? (
        <>
          <label className="moodboard-field">
            <span>{byAgent ? "An agent's brief" : 'Your brief'}</span>
            <textarea rows={5} value={override.text} maxLength={BRIEF_LIMITS.override}
              onChange={(event) => onEdit(event.target.value)} onBlur={onEditDone} />
          </label>
          {!stale && (
            <button type="button" className="moodboard-brief__action" onClick={onRegenerate} disabled={busy}>
              Use the generated brief
            </button>
          )}
        </>
      ) : (
        <>
          <p className="moodboard-brief__text">
            {brief?.styleBrief || (saving ? 'Saving…' : 'Analyze to build the brief.')}
          </p>
          <button
            type="button"
            className="moodboard-brief__action"
            onClick={() => { onEdit(brief?.generatedStyleBrief ?? ''); onEditDone?.(); }}
            disabled={busy}
          >
            Write your own
          </button>
        </>
      )}
      {brief && (
        <dl className="moodboard-brief__extras">
          <dt>Negative prompt</dt>
          <dd>{brief.negativePrompt}</dd>
          {brief.avoidPrompt && (
            <>
              <dt>Added to the prompt for GPT Image, Nano Banana and Krea 2</dt>
              <dd>{brief.avoidPrompt}</dd>
            </>
          )}
        </dl>
      )}
      {brief && <BriefClashes brief={brief} busy={busy} onColorChoice={onColorChoice} onLeaveOutAll={onLeaveOutAll} />}
    </div>
  );
}

const ROLE_LABEL: Record<MoodboardClash['role'], string> = { palette: 'palette', accent: 'accent', pinned: 'pinned' };

/** Where the board's words and its measured colours disagree, as the
 *  backend found it. Nothing on a backend that doesn't check. */
function BriefClashes({
  brief,
  busy,
  onColorChoice,
  onLeaveOutAll,
}: {
  brief: MoodboardBrief;
  busy: boolean;
  onColorChoice?: (choice: ColorChoice, hex: string) => void;
  onLeaveOutAll?: (hexes: string[]) => void;
}) {
  if (!brief.leftOut) return null;
  if (brief.clashMode === 'keep-all') {
    return <p className="moodboard-clashes__off">Clash check is off for this board.</p>;
  }
  const flagMode = brief.clashMode === 'flag';
  const mayClash = (brief.mayClash ?? []).filter((item) => item.hex);
  const choose = (choice: ColorChoice, hex: string) => onColorChoice?.(choice, hex);
  return (
    <div className="moodboard-clashes">
      <ClashList label="Left out of the brief" items={brief.leftOut} hint="Generators don't get these."
        action={(item) => item.why === 'choice'
          ? { label: `Undo leaving ${item.hex} out`, text: 'Undo', run: () => choose('reset', item.hex!) }
          : { label: `Keep ${item.hex} anyway`, text: 'Keep anyway', run: () => choose('keep', item.hex!) }}
        busy={busy} />
      <ClashList label="Kept anyway" items={brief.kept ?? []} hint="You kept these. They aren't pinned."
        action={(item) => ({ label: `Undo keeping ${item.hex}`, text: 'Undo', run: () => choose('reset', item.hex!) })}
        busy={busy} />
      <ClashList label={flagMode ? 'Flagged' : 'May clash'} items={mayClash}
        hint={flagMode ? 'These may clash with your words. They still go.' : 'Still sent. They may clash with your words.'}
        action={(item) => ({ label: `Leave ${item.hex} out`, text: 'Leave out', run: () => choose('leaveOut', item.hex!) })}
        busy={busy}
        footer={flagMode && mayClash.length > 1 && onLeaveOutAll ? (
          <button type="button" className="moodboard-clashes__all" disabled={busy}
            onClick={() => onLeaveOutAll(mayClash.map((item) => item.hex!))}>Leave out all flagged</button>
        ) : null} />
      <ClashList label="Pinned, so it still goes" items={brief.pinnedClashes ?? []}
        hint="You pinned these. They go even though they clash." busy={busy} />
      <ClashList label="Whole palette" items={brief.paletteClashes ?? []} busy={busy} />
    </div>
  );
}

/** Every reason, the first one first: a colour off because the board sends
 *  no measured colours may also clash with the words, and Keep anyway
 *  shouldn't hide that. */
function reasonText(item: MoodboardClash): string {
  const reasons = (item.reasons ?? []).filter(Boolean);
  return (reasons.length ? reasons : [item.reason]).join(' · ');
}

function ClashList({
  label,
  items,
  hint,
  action,
  footer,
  busy,
}: {
  label: string;
  items: MoodboardClash[];
  hint?: string;
  action?: (item: MoodboardClash) => { label: string; text: string; run: () => void };
  footer?: ReactNode;
  busy: boolean;
}) {
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section className="moodboard-clashes__group" aria-labelledby={headingId}>
      <div className="moodboard-clashes__head">
        <span id={headingId} className="moodboard-swatches__label">{label}</span>
        {hint && <span className="moodboard-clashes__hint">{hint}</span>}
      </div>
      <ul className="moodboard-clashes__list" aria-label={label}>
        {items.map((item) => {
          const button = item.hex && action ? action(item) : null;
          return (
            <li key={`${item.hex ?? 'palette'}-${item.role}`} className={`moodboard-clash moodboard-clash--${item.level}`}>
              {item.hex
                ? <span className="moodboard-chip__swatch" style={{ backgroundColor: item.hex }} aria-hidden="true" />
                : <span className="moodboard-clash__palette" aria-hidden="true" />}
              <span className="moodboard-clash__hex">{item.hex ?? 'All colors'}</span>
              <span className="moodboard-clash__role">{item.hex ? ROLE_LABEL[item.role] : 'palette'}</span>
              <span className="moodboard-clash__reason">{reasonText(item)}</span>
              {button && (
                <button type="button" className="moodboard-clash__action" aria-label={button.label} disabled={busy}
                  onClick={button.run}>{button.text}</button>
              )}
            </li>
          );
        })}
      </ul>
      {footer}
    </section>
  );
}

const CLASH_MODES: { value: MoodboardClashMode; label: string; hint: string }[] = [
  { value: 'leave-out', label: 'Leave clashing colors out', hint: 'They are listed with the reason. You can keep any of them.' },
  { value: 'flag', label: 'Flag clashes, leave nothing out', hint: 'Every measured color goes. Clashes are listed for you to leave out.' },
  { value: 'no-measured', label: 'Send no measured colors', hint: 'With a Direction, generators get your words and pins, no measured colors.' },
  { value: 'keep-all', label: 'Off: send every measured color', hint: 'No clash list. Pins and keep-out colors still apply.' },
];

export function BriefFields({
  direction,
  avoid,
  pinnedColors,
  clashMode,
  onChange,
  onTextDone,
}: {
  direction: string;
  avoid: string[];
  pinnedColors: MoodboardPinnedColors;
  /** Absent on an older backend: no Advanced section then. */
  clashMode?: MoodboardClashMode;
  onChange: (fields: {
    direction?: string; avoid?: string[]; pinnedColors?: MoodboardPinnedColors; clashMode?: MoodboardClashMode;
  }) => void;
  /** Direction lost focus: its edit is one undo step (Q83). */
  onTextDone?: () => void;
}) {
  const [avoidText, setAvoidText] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const advancedId = useId();
  const avoidFull = avoid.length >= BRIEF_LIMITS.avoidItems;
  const addAvoid = () => {
    const items = avoidText.split(',').map((item) => item.trim().slice(0, BRIEF_LIMITS.avoidItem)).filter(Boolean);
    const known = new Set(avoid.map((item) => item.toLowerCase()));
    const next = [...avoid];
    for (const item of items) {
      if (next.length >= BRIEF_LIMITS.avoidItems) break;
      if (!known.has(item.toLowerCase())) { next.push(item); known.add(item.toLowerCase()); }
    }
    if (next.length !== avoid.length) onChange({ avoid: next });
    setAvoidText('');
  };
  return (
    <section className="moodboard-analysis moodboard-direction">
      <div className="moodboard-analysis__head">
        <div>
          <span className="moodboard-analysis__label">Direction</span>
          <span className="moodboard-analysis__hint">
            Yours to set. Analyzing again keeps it.
          </span>
        </div>
      </div>
      <div className="moodboard-analysis__body">
        <label className="moodboard-field">
          <span>What the board is for</span>
          <textarea
            rows={2}
            value={direction}
            maxLength={BRIEF_LIMITS.direction}
            placeholder="Say what you want, e.g. warm editorial product shots with soft daylight."
            onChange={(event) => onChange({ direction: event.target.value })}
            onBlur={onTextDone}
          />
        </label>
        <div className="moodboard-field">
          <span>Avoid</span>
          {avoid.length > 0 && (
            <ul className="moodboard-chips" aria-label="Avoid list">
              {avoid.map((item) => (
                <li key={item} className="moodboard-chip">
                  <span>{item}</span>
                  <button type="button" aria-label={`Remove ${item}`}
                    onClick={() => onChange({ avoid: avoid.filter((other) => other !== item) })}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="moodboard-inline">
            <input
              value={avoidText}
              aria-label="Add to the avoid list"
              disabled={avoidFull}
              placeholder={avoidFull ? `The list holds ${BRIEF_LIMITS.avoidItems} items. Remove one to add another.`
                : 'Something to keep out, e.g. neon signage'}
              onChange={(event) => setAvoidText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addAvoid(); } }}
            />
            <button type="button" onClick={addAvoid} disabled={avoidFull || !avoidText.trim()}>Add</button>
          </div>
        </div>
        <PinnedColorRow
          label="Colors that must appear"
          colors={pinnedColors.include}
          other={pinnedColors.exclude}
          onChange={(include) => onChange({ pinnedColors: { ...pinnedColors, include } })}
        />
        <PinnedColorRow
          label="Colors to keep out"
          colors={pinnedColors.exclude}
          other={pinnedColors.include}
          onChange={(exclude) => onChange({ pinnedColors: { ...pinnedColors, exclude } })}
        />
        {clashMode && (
          <div className="moodboard-advanced" data-open={advanced ? 'true' : 'false'}>
            <button type="button" className="moodboard-advanced__toggle" aria-expanded={advanced}
              aria-controls={advancedId} onClick={() => setAdvanced((open) => !open)}>
              Advanced
            </button>
            {advanced && (
              <div id={advancedId} className="moodboard-advanced__body" role="radiogroup"
                aria-label="When your words clash with a measured color">
                <span className="moodboard-advanced__title">When your words clash with a measured color</span>
                {CLASH_MODES.map((mode) => (
                  <label key={mode.value} className="moodboard-advanced__option">
                    <input type="radio" name={`${advancedId}-clash`} value={mode.value}
                      checked={clashMode === mode.value}
                      onChange={() => onChange({ clashMode: mode.value })} />
                    <span className="moodboard-advanced__label">
                      {mode.label}
                      {mode.value === 'leave-out' && <span className="moodboard-advanced__default"> (default)</span>}
                    </span>
                    <span className="moodboard-advanced__hint">{mode.hint}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function PinnedColorRow({
  label,
  colors,
  other,
  onChange,
}: {
  label: string;
  colors: string[];
  other: string[];
  onChange: (colors: string[]) => void;
}) {
  const [value, setValue] = useState('');
  const hex = normalizeHex(value);
  const conflict = Boolean(hex && other.includes(hex));
  const full = colors.length >= BRIEF_LIMITS.pinned;
  const add = () => {
    if (!hex || conflict || full || colors.includes(hex)) return;
    onChange([...colors, hex]);
    setValue('');
  };
  return (
    <div className="moodboard-field">
      <span>{label}</span>
      {colors.length > 0 && (
        <ul className="moodboard-chips" aria-label={label}>
          {colors.map((color) => (
            <li key={color} className="moodboard-chip">
              <span className="moodboard-chip__swatch" style={{ backgroundColor: color }} />
              <span>{color}</span>
              <button type="button" aria-label={`Remove ${color}`}
                onClick={() => onChange(colors.filter((other) => other !== color))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="moodboard-inline">
        <input type="color" aria-label={`${label}: pick`} value={hex ?? '#000000'}
          onChange={(event) => setValue(event.target.value)} />
        <input aria-label={`${label}: hex`} value={value} placeholder="#rrggbb, or pick one" onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" onClick={add} disabled={!hex || conflict || full || colors.includes(hex)}>Add</button>
      </div>
      {conflict && <span className="moodboard-inline__error">That color is in the other list.</span>}
      {full && <span className="moodboard-inline__error">This list holds {BRIEF_LIMITS.pinned} colors. Remove one to add another.</span>}
    </div>
  );
}

