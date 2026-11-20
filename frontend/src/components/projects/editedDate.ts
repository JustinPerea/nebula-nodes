import { writtenDate } from '../../lib/commonsFormat';
/** The date a project shows beside its name (Projects home's card, and the kept canvas's delete chooser). */
export function editedDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Saved project';
  return `Edited ${writtenDate(date.toISOString())}`;
}
