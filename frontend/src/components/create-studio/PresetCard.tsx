import type { Preset } from '../../lib/createPresets';

// Deterministic hue from the preset id so each card gets a stable gradient.
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function PresetCard({ preset, onApply }: { preset: Preset; onApply: (p: Preset) => void }) {
  const hue = hueOf(preset.id);
  return (
    <button
      type="button"
      className="preset-card"
      onClick={() => onApply(preset)}
      style={{ ['--preset-hue' as string]: `${hue}` }}
      title={preset.prompt}
    >
      {preset.thumbnail ? (
        <img className="preset-card__thumb" src={preset.thumbnail} alt="" />
      ) : (
        <span className="preset-card__gradient" aria-hidden="true" />
      )}
      <span className="preset-card__name">{preset.name}</span>
      <span className="preset-card__category">{preset.category}</span>
    </button>
  );
}
