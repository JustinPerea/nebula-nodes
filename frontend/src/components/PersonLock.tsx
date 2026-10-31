import { LineText } from './LineText';
import type { PersonLock } from '../hooks/usePersonLock';
import '../styles/personLock.css';

export type { LockProps, PersonLock } from '../hooks/usePersonLock';

/** The lock's line under its controls, while it shows. One per lock. */
export function PersonLockLine({ lock, className }: { lock: PersonLock; className?: string }) {
  if (!lock.shown) return null;
  return (
    <p id={lock.id} className={`person-lock-line${className ? ` ${className}` : ''}`}>
      <LineText text={lock.line} />
    </p>
  );
}
