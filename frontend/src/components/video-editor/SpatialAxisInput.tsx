type SpatialAxis = 'x' | 'y' | 'z';

interface SpatialAxisInputProps {
  axis: SpatialAxis;
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  /** The canvas lock (its fieldset disables it too; review 4 LOW-4 asks each control to carry it). */
  disabled?: boolean;
}

export function SpatialAxisInput({ axis, label, value, onValueChange, disabled }: SpatialAxisInputProps) {
  return (
    <label>
      {label}
      <input
        type="number"
        data-spatial-axis={axis}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(Number(e.target.value))}
      />
    </label>
  );
}
