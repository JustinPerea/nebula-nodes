/** Local time written like "12:00 AM" (GM, error copy round 3f: "{time}
 * should be local time, written like "12:00 AM""), the same in every locale:
 * the browser's own format is "00:00" in many, and puts a narrow no-break
 * space before "AM" in newer ones. */
export function clockTime(date: Date): string {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}
