/**
 * Fired when Settings changes a personal agent (added, removed, switched on or
 * off, downloaded), so the chat reloads its list. The name lives here, not in
 * settings/PersonalAgentsSection.tsx: ChatPanel is on the startup path and the
 * section loads with Settings' lazy Preferences tab, so importing the name from
 * the section pulled all of it into the first load.
 */
export const PERSONAL_AGENTS_CHANGED_EVENT = 'nebula:personal-agents-changed';
