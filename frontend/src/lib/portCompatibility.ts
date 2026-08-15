import type { PortDataType } from '../types';

export const PORT_COLORS: Record<PortDataType, string> = {
  Image: '#4CAF50',
  Video: '#F44336',
  Text: '#9C27B0',
  Array: '#2196F3',
  Audio: '#FFC107',
  Mask: '#8BC34A',
  SVG: '#795548',
  Mesh: '#00BCD4',
  Character: '#a78bfa',
  Moodboard: '#f59e0b',
  CameraRig: '#64b5f6',
  ReferenceSet: '#ec407a',
  Any: '#9E9E9E',
};

export const COMPATIBILITY: Record<PortDataType, PortDataType[]> = {
  Text: ['Text', 'Any'],
  Image: ['Image', 'Mask', 'Any'],
  Video: ['Video', 'Any'],
  Audio: ['Audio', 'Any'],
  Mask: ['Mask', 'Image', 'Any'],
  Array: ['Array', 'Any'],
  SVG: ['SVG', 'Any'],
  Mesh: ['Mesh', 'Any'],
  Character: ['Character', 'Any'],
  Moodboard: ['Moodboard', 'Any'],
  CameraRig: ['CameraRig', 'Any'],
  ReferenceSet: ['ReferenceSet', 'Any'],
  Any: ['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Mesh', 'Character', 'Moodboard', 'CameraRig', 'ReferenceSet', 'Any'],
};

export function isPortCompatible(
  sourceType: PortDataType,
  targetType: PortDataType
): boolean {
  return COMPATIBILITY[sourceType]?.includes(targetType) ?? false;
}
