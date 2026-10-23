import { createContext } from 'react';

/**
 * The floating Inspector's foot: the box under its scrolling body where the
 * Run / Duplicate / Delete row sits, so the row is always whole (GM - Design,
 * 2026-10-23: "so its foot row is always whole"). NodeInspectorPopover
 * provides the box; without one (the Inspector rendered on its own) the row
 * stays in place (InspectorFoot.tsx).
 */
export const InspectorFootContext = createContext<HTMLElement | null>(null);
