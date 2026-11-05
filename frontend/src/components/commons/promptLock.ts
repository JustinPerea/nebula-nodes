import { createContext } from 'react';
import type { PersonLock } from '../../hooks/usePersonLock';

/**
 * PR #204 round 14 (GM r23 4): the lock a prompt's OK takes, when what it confirms is the
 * person's (CommonsView's New collection: "create collections"). A demote leaves the prompt on
 * screen with the typed name and focus where they are; OK locks, its line under it, and unlocks
 * in place on the promote. No lock: OK is always live (the detail's prompts).
 */
export const PromptLockContext = createContext<PersonLock | null>(null);
