import type { PortDataType } from '../types';

export const CATEGORY_COLORS: Record<string, string> = {
  'image-gen': '#1565C0',
  'video-gen': '#B71C1C',
  'text-gen': '#4A148C',
  'audio-gen': '#FF6F00',
  '3d-gen': '#00ACC1',
  'transform': '#004D40',
  'analyzer': '#1B5E20',
  'utility': '#424242',
  'universal': '#E65100',
};

export const PORT_DATA_TYPES: PortDataType[] = [
  'Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Mesh', 'Any',
];
