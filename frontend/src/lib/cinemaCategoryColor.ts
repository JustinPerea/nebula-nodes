import { CATEGORY_COLORS } from '../constants/ports';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

/** The Cinema node's category colour: the shared selected style in Cinema
 * (the selected shot, film look and variation; the design's one-selection rule,
 * PR #200), never the accent. */
export const CINEMA_CATEGORY_COLOR = CATEGORY_COLORS[NODE_DEFINITIONS['cinema-scene']?.category ?? 'cinematic'] ?? CATEGORY_COLORS.cinematic;
