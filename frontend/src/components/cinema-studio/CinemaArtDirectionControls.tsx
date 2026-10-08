import { useId } from 'react';
import { CINEMA_LOOK_PRESETS, defaultCinemaLook, normalizeCinemaHex } from '../../lib/cinemaArtDirection';
import type { CinemaLook, CinemaPalette } from '../../lib/cinemaArtDirection';

interface ControlsProps<T> {
  value: T;
  onChange: (update: (current: T) => T) => void;
  labelPrefix: string;
}

export function CinemaPaletteControls({ value, onChange, labelPrefix }: ControlsProps<CinemaPalette>) {
  const id = useId();
  return <>
    <div className="cinema-shared-controls__swatches">
      {value.swatches.map((hex, index) => <div key={index} className="cinema-shared-controls__swatch">
        <input type="color" value={normalizeCinemaHex(hex) ?? '#000000'} aria-label={`${labelPrefix} swatch ${index + 1}`}
          onChange={(event) => {
            const color = event.target.value;
            onChange((current) => ({ ...current, swatches: current.swatches.map((swatch, i) => i === index ? color : swatch) }));
          }} />
        <button type="button" className="cinema-shared-controls__swatch-remove" title="Remove swatch"
          aria-label={`Remove ${labelPrefix.toLowerCase()} swatch ${index + 1}`}
          onClick={() => onChange((current) => ({ ...current, swatches: current.swatches.filter((_, i) => i !== index) }))}>×</button>
      </div>)}
      <button type="button" className="cinema-shared-controls__swatch-add" title="Add swatch"
        aria-label={`Add ${labelPrefix.toLowerCase()} swatch`}
        onClick={() => onChange((current) => ({ ...current, swatches: [...current.swatches, '#808080'] }))}>+</button>
    </div>
    <div className="cinema-shared-controls__inline">
      <label htmlFor={`${id}-strength`} className="cinema-shared-controls__sub">Strength</label>
      <input id={`${id}-strength`} type="range" min={0} max={1} step={0.05} value={value.strength}
        aria-label={`${labelPrefix} palette strength`}
        onChange={(event) => { const strength = Number(event.target.value); onChange((current) => ({ ...current, strength })); }} />
      <span className="cinema-shared-controls__value" aria-hidden="true">{Math.round(value.strength * 100)}%</span>
      <select className="cinema-shared-controls__select cinema-shared-controls__select--sm" value={value.method}
        aria-label={`${labelPrefix} palette method`}
        onChange={(event) => { const method = event.target.value as CinemaPalette['method']; onChange((current) => ({ ...current, method })); }}>
        {!['lab-transfer', 'reinhard', 'histogram'].includes(value.method) && <option value={value.method}>{value.method}</option>}
        <option value="lab-transfer">Lab</option><option value="reinhard">Reinhard</option><option value="histogram">Histogram</option>
      </select>
    </div>
  </>;
}

const LOOK_SLIDERS: Array<{ key: keyof CinemaLook; label: string; min: number; max: number }> = [
  { key: 'grain', label: 'Grain', min: 0, max: 1 },
  { key: 'halation', label: 'Halation', min: 0, max: 1 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1 },
];

export function CinemaLookControls({ value, onChange, labelPrefix }: ControlsProps<CinemaLook>) {
  const id = useId();
  const defaults = defaultCinemaLook();
  return <>
    <div className="cinema-shared-controls__chips" role="group" aria-label={`${labelPrefix} film look preset`}>
      {CINEMA_LOOK_PRESETS.map((preset) => <button key={preset.id} type="button"
        className={`cinema-shared-controls__chip${(value.preset ?? 'custom') === preset.id ? ' cinema-shared-controls__chip--active' : ''}`}
        aria-pressed={(value.preset ?? 'custom') === preset.id}
        onClick={() => onChange((current) => preset.id === 'custom'
          ? { ...defaultCinemaLook(), ...current, preset: 'custom' } : { preset: preset.id })}>{preset.label}</button>)}
    </div>
    {value.preset && !CINEMA_LOOK_PRESETS.some((preset) => preset.id === value.preset) && <p className="cinema-shot-panel__inheritance">Saved look: {value.preset}</p>}
    {(!value.preset || value.preset === 'custom') && <div className="cinema-shared-controls__sliders">
      {LOOK_SLIDERS.map((slider) => <div key={slider.key} className="cinema-shared-controls__slider-row">
        <label htmlFor={`${id}-${slider.key}`} className="cinema-shared-controls__sub">{slider.label}</label>
        <input id={`${id}-${slider.key}`} type="range" min={slider.min} max={slider.max} step={0.05}
          aria-label={`${labelPrefix} ${slider.label.toLowerCase()}`} value={Number(value[slider.key] ?? defaults[slider.key] ?? 0)}
          onChange={(event) => { const amount = Number(event.target.value); onChange((current) => ({ ...current, [slider.key]: amount })); }} />
        <span className="cinema-shared-controls__value" aria-hidden="true">{Number(value[slider.key] ?? defaults[slider.key] ?? 0).toFixed(2)}</span>
      </div>)}
    </div>}
  </>;
}
