import { AudioLines, Box, Image as ImageIcon, Import, Type, Video, Workflow, Wrench, type LucideIcon } from 'lucide-react';
import type { NodeBrowseType } from './nodeBrowsing';

/** One icon per browse type, shared by the Nodes panel and node headers. */
export const NODE_BROWSE_ICONS: Record<NodeBrowseType, LucideIcon> = {
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  text: Type,
  import: Import,
  '3d': Box,
  workflow: Workflow,
  tools: Wrench,
};
