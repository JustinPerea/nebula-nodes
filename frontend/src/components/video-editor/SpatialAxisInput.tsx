type SpatialAxis = 'x' | 'y' | 'z';

interface SpatialAxisInputProps {
  axis: SpatialAxis;
  label: string;
  value: number;
  onValueChange: (value: number) => void;
}

export function SpatialAxisInput({ axis, label, value, onValueChange }: SpatialAxisInputProps) {
  return (
    <label>
      {label}
      <input
        type="number"
        data-spatial-axis={axis}
        value={value}
        onChange={(e) => onValueChange(Number(e.target.value))}
      />
    </label>
  );
}
