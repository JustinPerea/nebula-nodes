import { useUIStore } from '../store/uiStore';
import { SKINS, type SkinId } from '../lib/skins';

/**
 * Skin picker — radio-card list rendered inside the Settings panel.
 *
 * Visible skin options are sourced from `SKINS`. Selection is stored in the
 * UI store; the body class is applied as a side-effect of `setSkin`. CSS for
 * each skin lives in its own file and is responsible for staying scoped to
 * its body class so it can't leak.
 */
export function SkinPicker() {
  const skin = useUIStore((s) => s.skin);
  const setSkin = useUIStore((s) => s.setSkin);

  return (
    <div className="skin-picker">
      {SKINS.map((s) => (
        <SkinOption
          key={s.id}
          id={s.id}
          label={s.label}
          description={s.description}
          reference={s.reference}
          active={skin === s.id}
          onSelect={() => setSkin(s.id)}
        />
      ))}
    </div>
  );
}

interface SkinOptionProps {
  id: SkinId;
  label: string;
  description: string;
  reference?: string;
  active: boolean;
  onSelect: () => void;
}

function SkinOption({ label, description, reference, active, onSelect }: SkinOptionProps) {
  return (
    <button
      type="button"
      className={`skin-picker__option${active ? ' skin-picker__option--active' : ''}`}
      onClick={onSelect}
      title={reference ?? undefined}
    >
      <span className="skin-picker__row">
        <span className="skin-picker__radio" aria-hidden="true">
          <span className="skin-picker__radio-dot" />
        </span>
        <span className="skin-picker__label">{label}</span>
      </span>
      <span className="skin-picker__description">{description}</span>
    </button>
  );
}
