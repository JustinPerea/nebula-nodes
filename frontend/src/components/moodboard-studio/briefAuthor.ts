// Who wrote a board's brief override, for Moodboard Studio's label.

/** Who wrote the override the person sees: the saved board's author while
 * the text is still what was saved, else the person (it's their unsaved edit,
 * and the backend stamps it as theirs when it saves). The backend decides
 * `by` from the person gate and refuses one sent by a client. */
export function overrideAuthor(
  saved: { text: string; by?: 'person' | 'agent' } | null | undefined,
  draft: { text: string } | null,
): 'person' | 'agent' {
  if (saved?.by === 'agent' && draft && saved.text.trim() === draft.text.trim()) return 'agent';
  return 'person';
}
