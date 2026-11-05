/**
 * PR #204 round 18 (GM r28 2): the notice stack is centred above the bottom bar, and it never
 * draws over an open side panel: it moves clear of one, or narrows to fit. The region measures
 * the side panels that reach down to its band (the notices' line) while it holds a notice, and
 * writes how much each side takes as --notice-left-clearance and --notice-right-clearance on the
 * region; noticeRegion.css centres the stack on the window (the bar's centre) inside what is left.
 * The docked Agent log keeps its own --agent-log-clearance (AgentLog measures it).
 */

/** The panels that stand at a side of the window, down to the bottom: the drawers (Nodes,
 * Assets, History, Settings), the chat, the Inspector and the Updates list. */
export const SIDE_PANELS = '.workspace-dock-panel, .chat-panel, .panel--inspector, .agent-notes-panel';

/** The room kept between a panel and a notice. */
export const SIDE_PANEL_GAP = 8;

export interface SideClearance { left: number; right: number }

/** What the open side panels take from each side of the region's band, in px (0 for none). */
export function sideClearance(region: Element, width = window.innerWidth): SideClearance {
  const band = region.querySelector('[data-notice-band]')?.getBoundingClientRect();
  const out = { left: 0, right: 0 };
  if (!band || band.height <= 0) return out;
  for (const panel of document.querySelectorAll(SIDE_PANELS)) {
    if (region.contains(panel) || panel.classList.contains('panel--exiting')) continue;
    const box = panel.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || box.bottom <= band.top || box.top >= band.bottom) continue;
    if (box.left + box.width / 2 < width / 2) out.left = Math.max(out.left, Math.ceil(box.right + SIDE_PANEL_GAP));
    else out.right = Math.max(out.right, Math.ceil(width - box.left + SIDE_PANEL_GAP));
  }
  return out;
}

/** Keeps the region's clearances current while it holds a notice; returns the stop. */
export function watchSidePanels(region: HTMLElement): () => void {
  let frame = 0;
  let watching: (() => void) | null = null;
  const write = (name: string, px: number) => {
    if (px > 0) region.style.setProperty(name, `${px}px`);
    else region.style.removeProperty(name);
  };
  const measure = () => {
    frame = 0;
    const { left, right } = sideClearance(region);
    write('--notice-left-clearance', left);
    write('--notice-right-clearance', right);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const holds = () => region.querySelector('[data-notice-slot] > *') !== null;
  const start = () => {
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const track = () => { sizes?.disconnect(); for (const panel of document.querySelectorAll(SIDE_PANELS)) sizes?.observe(panel); };
    // A panel opening, closing or changing class (its exit) moves the line; one that resizes, too.
    const page = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'childList')) track();
      schedule();
    });
    page.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', schedule);
    document.addEventListener('animationend', schedule, true);
    document.addEventListener('transitionend', schedule, true);
    track();
    // The first notice takes its place at once: the region moves with no notice in it, never
    // sliding the arriving one sideways.
    region.style.transition = 'none';
    measure();
    void region.offsetWidth;
    region.style.removeProperty('transition');
    return () => {
      page.disconnect(); sizes?.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('animationend', schedule, true);
      document.removeEventListener('transitionend', schedule, true);
    };
  };
  // Only while a notice shows: with none there is nothing to keep clear.
  const sync = () => {
    if (holds() && !watching) watching = start();
    else if (!holds() && watching) { watching(); watching = null; write('--notice-left-clearance', 0); write('--notice-right-clearance', 0); }
  };
  const items = new MutationObserver(sync);
  for (const slot of region.querySelectorAll('[data-notice-slot]')) items.observe(slot, { childList: true });
  sync();
  return () => {
    items.disconnect();
    watching?.();
    if (frame) cancelAnimationFrame(frame);
  };
}
