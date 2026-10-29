import { CATEGORY_COLORS } from '../constants/ports';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

/** The Cinema node's category colour: the shared selected style in Cinema
 * (the selected shot, film look and variation; GM's one-selection rule,
 * fix rounds 1 and 2 of PR #200), never the accent. */
export const CINEMA_CATEGORY_COLOR = CATEGORY_COLORS[NODE_DEFINITIONS['cinema-scene']?.category ?? 'cinematic'] ?? CATEGORY_COLORS.cinematic;
