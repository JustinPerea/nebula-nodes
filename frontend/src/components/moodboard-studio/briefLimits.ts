// The backend's limits on a board's brief fields (backend
// services/moodboard_brief.py), so Studio stops at them instead of sending
// a save the backend would refuse.
export const BRIEF_LIMITS = { direction: 4000, avoidItems: 40, avoidItem: 200, pinned: 12, override: 20000 } as const;
