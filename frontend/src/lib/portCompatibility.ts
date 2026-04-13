import type { PortDataType } from '../types';

export const PORT_COLORS: Record<PortDataType, string> = {
  Image: '#4CAF50',
  Video: '#F44336',
  Text: '#9C27B0',
  Array: '#2196F3',
  Audio: '#FFC107',
  Mask: '#8BC34A',
  SVG: '#795548',
  Any: '#9E9E9E',
};

const COMPATIBILITY: Record<PortDataType, PortDataType[]> = {
  Text: ['Text', 'Any'],
  Image: ['Image', 'Mask', 'Any'],
  Video: ['Video', 'Any'],
  Audio: ['Audio', 'Any'],
  Mask: ['Mask', 'Image', 'Any'],
  Array: ['Array', 'Any'],
  SVG: ['SVG', 'Any'],
  Any: ['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Any'],
};

export function isPortCompatible(
  sourceType: PortDataType,
  targetType: PortDataType
): boolean {
  return COMPATIBILITY[sourceType]?.includes(targetType) ?? false;
}
