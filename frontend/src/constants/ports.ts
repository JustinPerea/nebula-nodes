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
  'cinematic': '#d9a441',
  'character': '#a78bfa',
  'moodboard': '#f59e0b',
};

export const PORT_DATA_TYPES: PortDataType[] = [
  'Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Mesh', 'Character', 'Moodboard', 'Any',
];

/** Stable output-port id for a cinema-scene shot. Used by CinemaSceneNode's
 *  per-shot Handles and by graphStore's dynamic-port rewrite so handles, edges
 *  and the connection validator all agree on the same id. Lives here (a
 *  store-free module) to avoid an import cycle between the node and the store. */
export function shotPortId(shotId: string): string {
  return `shot_${shotId}`;
}
